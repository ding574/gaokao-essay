// 高考作文训练 · 服务端
// 零依赖，Node 18+。功能：题库、自主出题（去重）、题目解析、素材库、作文批改、助手

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMPTS } from './prompts.mjs';
import { VERBATIM_EXTRA } from './verbatim-extra.mjs';
import { MATERIALS } from './materials.mjs';

const EXTRA = Object.fromEntries(VERBATIM_EXTRA.map((p) => [p.id, p]));
const PROMPTS_ALL = PROMPTS.map((p) => (EXTRA[p.id] ? { ...p, ...EXTRA[p.id] } : p));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 30);
const CALL_TIMEOUT = 240_000;

// ── 数据持久化 ────────────────────────────────────────────────
const STORE_PATH = path.join(__dirname, 'data', 'generated.json');
let store = { prompts: [], materials: [] };
try {
  store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  if (!Array.isArray(store.prompts)) store.prompts = [];
  if (!Array.isArray(store.materials)) store.materials = [];
} catch { /* 首次运行没有文件 */ }

function saveStore() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.error('[store] 写入失败', err);
  }
}

// ── 工具 ──────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 80000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function callModel(messages, maxTokens = 3000, temperature = 0.8) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: maxTokens, stream: false }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`模型接口返回 ${res.status}：${detail}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('模型没有返回内容');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ── 去重：字符二元组 Jaccard ───────────────────────────────────
function normalize(text) {
  return String(text || '').replace(/[\s\p{P}\p{S}]/gu, '');
}

function bigrams(text) {
  const chars = [...normalize(text)];
  const set = new Set();
  for (let i = 0; i < chars.length - 1; i += 1) set.add(chars[i] + chars[i + 1]);
  return set;
}

function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter += 1; });
  return inter / (A.size + B.size - inter);
}

function maxSimilarity(title, list) {
  let best = 0;
  for (const item of list) {
    const s = similarity(title, item.title);
    if (s > best) best = s;
  }
  return best;
}

// ── 访问控制与限流 ────────────────────────────────────────────
const rateState = new Map();

function clientIp(req) {
  const forward = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forward || req.socket.remoteAddress || 'unknown';
}

function takeRate(ip) {
  const now = Date.now();
  let entry = rateState.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 3600_000 };
    rateState.set(ip, entry);
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT;
}

function guard(req, res) {
  if (ACCESS_CODE && req.headers['x-access-code'] !== ACCESS_CODE) {
    json(res, 401, { error: '需要访问口令', needCode: true });
    return false;
  }
  if (!takeRate(clientIp(req))) {
    json(res, 429, { error: `这个小时次数用完了（上限 ${RATE_LIMIT} 次）` });
    return false;
  }
  return true;
}

// ── 题库 ──────────────────────────────────────────────────────
function allPrompts() {
  return [...PROMPTS_ALL, ...store.prompts];
}

function handlePrompts(url, res) {
  const q = (url.searchParams.get('q') || '').trim();
  const year = (url.searchParams.get('year') || '').trim();
  const type = (url.searchParams.get('type') || '').trim();
  let list = allPrompts();
  if (year) list = list.filter((p) => String(p.year) === year);
  if (type) list = list.filter((p) => p.type === type);
  if (q) {
    list = list.filter((p) => (p.title + p.material + (p.themes || []).join('')).includes(q));
  }
  list.sort((a, b) => (b.year || 0) - (a.year || 0));
  return json(res, 200, { total: list.length, prompts: list });
}

// ── 自主出题（去重）───────────────────────────────────────────
function trendContext() {
  const byYear = {};
  for (const p of allPrompts()) {
    if (!p.year) continue;
    byYear[p.year] = byYear[p.year] || [];
    byYear[p.year].push(p.title);
  }
  const lines = Object.keys(byYear).sort().map((y) => `${y}：${byYear[y].slice(0, 6).join('、')}`);
  return lines.join('\n');
}

async function handleGenerate(req, res) {
  let body = {};
  try { body = JSON.parse((await readBody(req)).replace(/^\uFEFF/, '')); } catch { /* 允许空 */ }
  const direction = String(body.direction || '').slice(0, 60);
  const count = Math.min(3, Math.max(1, Number(body.count) || 1));

  if (!API_KEY) {
    const demo = {
      id: 'demo-' + Date.now(),
      year: 'AI',
      region: '模拟',
      type: '材料作文',
      title: '演示题目：慢与快',
      material: '（演示模式）有人说这个时代太快，慢下来才有深度；也有人说慢就是落后。你怎么看？',
      themes: ['快与慢', '时代节奏'],
      ai: true,
    };
    return json(res, 200, { prompts: [demo], dedupe: { maxSimilarity: 0 } });
  }

  const existing = allPrompts().map((p) => ({ title: p.title }));
  const recent = existing.slice(-40).map((p) => p.title).join('；');
  const results = [];

  for (let attempt = 0; attempt < count; attempt += 1) {
    let created = null;
    for (let retry = 0; retry < 3 && !created; retry += 1) {
      let text = '';
      try {
        text = await callModel(
          [
            { role: 'system', content: '你是高考作文命题研究者。只输出 JSON，不要解释。' },
            {
              role: 'user',
              content: `你熟悉近十年高考作文命题趋势。下面是历年题目：\n${trendContext()}\n\n已有题目（不得重复或近似）：${recent}\n\n${direction ? '本次命题方向：' + direction + '。' : ''}
请命一道新的高考作文题，要求：
1. 符合近年趋势（情境化、思辨性、贴近时代），但角度必须与已有题目不同；
2. 材料 80–150 字，有具体情境或观点冲突；
3. 输出 JSON：{"title":"题目名（≤12字）","material":"材料正文","type":"材料作文/任务驱动/漫画作文/命题作文","themes":["主题1","主题2"],"trend":"体现的趋势（一句话）"}`,
            },
          ],
          1200,
          0.95,
        );
      } catch (err) {
        console.error('[generate] 模型失败', err);
        break;
      }

      const match = text.match(/\{[\s\S]*\}/);
      if (!match) continue;
      let obj = null;
      try { obj = JSON.parse(match[0]); } catch { continue; }
      const title = String(obj.title || '').slice(0, 40);
      const material = String(obj.material || '').slice(0, 600);
      if (!title || !material) continue;

      const sim = maxSimilarity(title, existing.concat(results.map((r) => ({ title: r.title }))));
      if (sim > 0.5) {
        console.warn('[generate] 重复，重试', title, sim);
        continue;
      }

      created = {
        id: 'ai-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        year: 'AI',
        region: '智能命题',
        type: String(obj.type || '材料作文').slice(0, 12),
        title,
        material,
        themes: Array.isArray(obj.themes) ? obj.themes.slice(0, 4).map((t) => String(t).slice(0, 16)) : [],
        trend: String(obj.trend || '').slice(0, 120),
        ai: true,
        createdAt: new Date().toISOString(),
        similarity: Number(sim.toFixed(2)),
      };
    }
    if (created) {
      store.prompts.push(created);
      saveStore();
      results.push(created);
    }
  }

  if (!results.length) return json(res, 500, { error: '出题失败，请重试' });
  return json(res, 200, { prompts: results });
}

// ── 题目解析 ──────────────────────────────────────────────────
const LENSES = ['矛盾追问', '概念辨析', '现象归因', '价值排序'];

async function handleAnalyze(req, res) {
  let body = {};
  try { body = JSON.parse((await readBody(req)).replace(/^\uFEFF/, '')); } catch { /* 允许空 */ }
  const title = String(body.title || '').slice(0, 80);
  const material = String(body.material || '').slice(0, 1200);
  if (!material && !title) return json(res, 400, { error: '缺少题目内容' });
  const lens = LENSES.includes(body.lens) ? body.lens : LENSES[Math.floor(Math.random() * LENSES.length)];

  if (!API_KEY) {
    return json(res, 200, { lens, analysis: demoAnalysis(title || '示例题目', material, lens) });
  }

  try {
    const analysis = await callModel(
      [
        { role: 'system', content: '你是资深高考作文阅卷老师与教研员。只输出 markdown 正文，不寒暄。' },
        {
          role: 'user',
          content: `请解析这道高考作文题，用「${lens}」这个分析视角贯穿。

题目：${title}
材料：${material}

输出结构（必须）：
## 一、审题关键
- 材料的核心事实/矛盾是什么
- 命题人真正想问什么（用一句话概括）
- 容易跑偏的两个方向

## 二、材料解析
逐层拆解材料：表层信息 → 隐含立场 → 可讨论空间。

## 三、多角度立意（四个，彼此不同）
每个角度写：中心论点（一句话）+ 两个分论点 + 适合的文体。
避免“万能立意”，必须扣住本题材料。

## 四、结构设计
给一个可操作的开头—主体—结尾框架，标出每部分要写什么。

## 五、可用素材
4 条，写明“素材 + 用在哪一段 + 怎么扣题”。不要编造名言。

## 六、避坑提醒
3 条最常见的失分点。

要求：具体、可操作；不要写套话；不要重复常见的“万能模板”。`,
        },
      ],
      4500,
      0.85,
    );
    return json(res, 200, { lens, analysis: analysis.trim() });
  } catch (err) {
    console.error('[analyze]', err);
    return json(res, 500, { error: err?.message || '解析失败' });
  }
}

function demoAnalysis(title, material, lens) {
  return [
    `> 演示模式（视角：${lens}）`,
    '',
    '## 一、审题关键',
    `- 题目：${title}`,
    '- 核心矛盾：材料中两种观点/做法之间的张力',
    '- 命题意图：在具体情境中考查思辨与价值判断',
    '',
    '## 二、材料解析',
    '- 表层：材料陈述了一个现象或一组观点',
    '- 深层：背后是对“个人选择与时代要求”的讨论',
    '',
    '## 三、多角度立意',
    '1. 角度一：……',
    '2. 角度二：……',
    '',
    '## 四、结构设计',
    '开头—分论点一—分论点二—升华—结尾',
    '',
    '## 五、可用素材',
    '- 素材 + 用法',
    '',
    '## 六、避坑提醒',
    '- 不要脱离材料空谈',
  ].join('\n');
}

// ── 素材库 ────────────────────────────────────────────────────
function allMaterials() {
  return [...MATERIALS, ...store.materials];
}

function handleMaterials(url, res) {
  const q = (url.searchParams.get('q') || '').trim();
  const category = (url.searchParams.get('category') || '').trim();
  let list = allMaterials();
  if (category) list = list.filter((m) => m.category === category);
  if (q) list = list.filter((m) => (m.text + (m.themes || []).join('')).includes(q));
  return json(res, 200, { total: list.length, materials: list });
}

async function handleMaterialGenerate(req, res) {
  let body = {};
  try { body = JSON.parse((await readBody(req)).replace(/^\uFEFF/, '')); } catch { /* 允许空 */ }
  const category = String(body.category || '').slice(0, 10) || '人物';

  if (!API_KEY) {
    return json(res, 200, {
      materials: [{ id: 'demo-m' + Date.now(), category, text: '（演示模式）示例素材：某人某事，体现某种精神。', themes: ['示例'], ai: true }],
    });
  }

  try {
    const text = await callModel(
      [
        { role: 'system', content: '你是作文素材编辑。只输出 JSON 数组，不要解释。' },
        {
          role: 'user',
          content: `请生成 3 条「${category}」类作文素材，用于高考议论文。

要求：
1. 真实可考：人物、事件、名言必须是真实存在的，不确定的不要写；
2. 每条 40–80 字，说明“谁做了什么/说了什么”，不写空泛评价；
3. 标注适用主题 2–3 个；
4. 输出 JSON 数组：[{"text":"素材内容","themes":["主题"],"note":"需要核实的点（没有则空字符串）"}]

避免与常见素材重复（袁隆平、张桂梅、苏轼除外最多各一条）。`,
        },
      ],
      1800,
      0.9,
    );
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('模型输出格式不对');
    const arr = JSON.parse(match[0]).slice(0, 3);
    const added = arr
      .filter((x) => x && x.text)
      .map((x, i) => ({
        id: 'ai-m-' + Date.now() + '-' + i,
        category,
        text: String(x.text).slice(0, 200),
        themes: Array.isArray(x.themes) ? x.themes.slice(0, 4).map((t) => String(t).slice(0, 12)) : [],
        note: String(x.note || '').slice(0, 100),
        ai: true,
        createdAt: new Date().toISOString(),
      }));
    store.materials.push(...added);
    saveStore();
    return json(res, 200, { materials: added });
  } catch (err) {
    console.error('[material]', err);
    return json(res, 500, { error: err?.message || '素材生成失败' });
  }
}

// ── 作文批改 ──────────────────────────────────────────────────
async function handleReview(req, res) {
  let body = {};
  try { body = JSON.parse((await readBody(req)).replace(/^\uFEFF/, '')); } catch { /* 允许空 */ }
  const essay = String(body.essay || '').slice(0, 6000);
  const title = String(body.title || '').slice(0, 80);
  if (essay.length < 50) return json(res, 400, { error: '文章太短，至少 50 字' });

  if (!API_KEY) {
    return json(res, 200, {
      review: '> 演示模式：配置密钥后这里会给出逐段批改。\n\n## 优点\n- 结构完整\n\n## 不足\n- 论点与材料结合不够\n\n## 修改建议\n- 第二段补一个具体例子',
    });
  }

  try {
    const review = await callModel(
      [
        { role: 'system', content: '你是高考作文阅卷老师。只输出 markdown 正文，不寒暄。' },
        {
          role: 'user',
          content: `请批改这篇学生作文${title ? `（题目：${title}）` : ''}。

文章：
${essay}

输出结构：
## 总评（100 字内，给一个分数区间，如 42–46/60，说明依据）

## 优点
3 条，每条必须引用原文一句话作证据。

## 不足
3 条，每条指出问题 + 引用原文 + 说明为什么失分。

## 逐段建议
按段落给“改哪句、怎么改”，至少 3 处。

## 升格示范
挑一个最弱的分论点，重写一段（150 字内），示范如何扣题。

要求：严格、具体，不写“语言优美”这类空话；不编造原文没有的内容。`,
        },
      ],
      4000,
      0.6,
    );
    return json(res, 200, { review: review.trim() });
  } catch (err) {
    console.error('[review]', err);
    return json(res, 500, { error: err?.message || '批改失败' });
  }
}

// ── 助手对话 ──────────────────────────────────────────────────
async function handleChat(req, res) {
  let body = {};
  try { body = JSON.parse((await readBody(req)).replace(/^\uFEFF/, '')); } catch { /* 允许空 */ }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-10) : [];
  const usable = messages
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, 3000) }));
  if (!usable.length) return json(res, 400, { error: '说点什么再发送吧' });

  if (!API_KEY) {
    return json(res, 200, { reply: '> 演示模式：配置 `DEEPSEEK_API_KEY` 后这里会正常回答。\n\n你可以问：审题、立意、结构、素材、语言升格、批改。' });
  }

  try {
    const reply = await callModel(
      [
        {
          role: 'system',
          content: `你是高考作文训练助手，服务高中生和语文老师。
1. 先给能直接用的答案，再解释；能分点就分点。
2. 谈立意时必须给出“论点 + 两个分论点 + 一个例子”。
3. 批改时引用原文，不编造。
4. 不确定的名言、数据要标注“需核实”。
5. 中文，markdown。`,
        },
        ...usable,
      ],
      3000,
      0.85,
    );
    return json(res, 200, { reply: reply.trim() });
  } catch (err) {
    console.error('[chat]', err);
    return json(res, 500, { error: err?.message || '助手调用失败' });
  }
}

// ── 静态文件 ──────────────────────────────────────────────────
async function serveStatic(res, relPath) {
  try {
    const file = path.join(__dirname, relPath);
    const data = await fs.promises.readFile(file);
    const ext = path.extname(file);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    json(res, 404, { error: '文件不存在' });
  }
}

// ── 路由 ──────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveStatic(res, 'index.html');
    }
    if (req.method === 'GET' && url.pathname === '/md.js') {
      return serveStatic(res, 'md.js');
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      return json(res, 200, {
        prompts: allPrompts().length,
        materials: allMaterials().length,
        years: [...new Set(allPrompts().map((p) => p.year))].length,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/prompts') return handlePrompts(url, res);
    if (req.method === 'GET' && url.pathname === '/api/materials') return handleMaterials(url, res);
    if (req.method === 'POST' && url.pathname === '/api/generate') {
      if (!guard(req, res)) return;
      return handleGenerate(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/analyze') {
      if (!guard(req, res)) return;
      return handleAnalyze(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/materials/generate') {
      if (!guard(req, res)) return;
      return handleMaterialGenerate(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/review') {
      if (!guard(req, res)) return;
      return handleReview(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      if (!guard(req, res)) return;
      return handleChat(req, res);
    }
    return json(res, 404, { error: '页面不存在' });
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) json(res, 500, { error: '服务器内部错误' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  高考作文训练站已启动');
  console.log(`  地址：http://127.0.0.1:${PORT}`);
  console.log(`  模式：${API_KEY ? `真实生成（${MODEL}）` : '演示模式（未设置 DEEPSEEK_API_KEY）'}`);
  console.log(`  题库：${allPrompts().length} 题；素材：${allMaterials().length} 条`);
  console.log('  停止：Ctrl + C');
  console.log('');
});
