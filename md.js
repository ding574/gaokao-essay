// 极简 Markdown 渲染器（只支持方案里用到的语法：标题、表格、列表、引用、加粗、行内代码、分割线）
// 不依赖任何外部库，离线可用

const SPECIAL = /^(?:#{1,6}\s|\||>|---+\s*$|\s*(?:[-*]|\d+\.)\s)/;

function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return t;
}

function splitRow(row) {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isSeparator(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s+/g, '')));
}

export function mdToHtml(md) {
  if (!md) return '';
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      i += 1;
      continue;
    }

    // 表格
    if (t.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      let header = null;
      let body = rows;
      if (rows.length >= 2 && isSeparator(rows[1])) {
        header = rows[0];
        body = rows.slice(2);
      }
      out.push(
        '<div class="tbl"><table>' +
          (header ? `<thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` : '') +
          `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>` +
          '</table></div>',
      );
      continue;
    }

    // 标题
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const n = Math.min(h[1].length, 4);
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      i += 1;
      continue;
    }

    // 分割线
    if (/^---+$/.test(t)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    // 引用
    if (t.startsWith('>')) {
      const q = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        q.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${mdToHtml(q.join('\n'))}</blockquote>`);
      continue;
    }

    // 列表
    const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      const ordered = /^\d+\./.test(li[1]);
      const items = [];
      while (i < lines.length) {
        const m2 = lines[i].match(/^\s*([-*]|\d+\.)\s+(.*)$/);
        if (!m2) break;
        items.push(`<li>${inline(m2[2])}</li>`);
        i += 1;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    // 段落
    const para = [];
    while (i < lines.length) {
      const l2 = lines[i];
      if (!l2.trim() || SPECIAL.test(l2)) break;
      para.push(l2.trim());
      i += 1;
    }
    if (para.length === 0) {
      // 兜底，避免死循环
      out.push(`<p>${inline(t)}</p>`);
      i += 1;
      continue;
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}
