// Local-only text → PDF for a pasted résumé. The bytes stay in the owner-only
// state directory. Nothing here is sent to telemetry or community Workers.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 72;
const FONT_SIZE = 11;
const LINE_HEIGHT = 14;
const MAX_CHARS_PER_LINE = 90;

const WINANSI_SUBSTITUTES = new Map([
  ['\u2018', "'"],
  ['\u2019', "'"],
  ['\u201A', "'"],
  ['\u201C', '"'],
  ['\u201D', '"'],
  ['\u201E', '"'],
  ['\u2013', '-'],
  ['\u2014', '--'],
  ['\u2022', '*'],
  ['\u00B7', '*'],
  ['\u2026', '...'],
  ['\u00A0', ' '],
  ['\u200B', ''],
  ['\t', '  '],
]);

export function encodeWinAnsi(text) {
  const source = typeof text === 'string' ? text : '';
  let replacedCharacters = 0;
  let out = '';
  for (const ch of source) {
    if (WINANSI_SUBSTITUTES.has(ch)) {
      out += WINANSI_SUBSTITUTES.get(ch);
      continue;
    }
    const code = ch.codePointAt(0);
    if (code === 10 || code === 13) {
      out += ch;
      continue;
    }
    if (code >= 32 && code <= 126) {
      out += ch;
      continue;
    }
    if (code >= 160 && code <= 255) {
      out += ch;
      continue;
    }
    out += '?';
    replacedCharacters += 1;
  }
  return { text: out, replacedCharacters };
}

function wrapLine(line) {
  if (line.length <= MAX_CHARS_PER_LINE) return [line.length ? line : ' '];
  const lines = [];
  let rest = line;
  while (rest.length > MAX_CHARS_PER_LINE) {
    const window = rest.slice(0, MAX_CHARS_PER_LINE);
    const breakAt = window.lastIndexOf(' ');
    const take = breakAt >= 40 ? breakAt : MAX_CHARS_PER_LINE;
    lines.push(rest.slice(0, take).trimEnd() || ' ');
    rest = rest.slice(take).trimStart();
  }
  if (rest) lines.push(rest);
  return lines;
}

export function wrapResumeLines(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const wrapped = [];
  for (const line of normalized.split('\n')) wrapped.push(...wrapLine(line));
  return wrapped;
}

function pdfLiteral(text) {
  let out = '(';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`;
    else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return `${out})`;
}

function pageContent(lines) {
  const commands = ['BT', `/F1 ${FONT_SIZE} Tf`, `${MARGIN} ${PAGE_HEIGHT - MARGIN} Td`];
  for (const [index, line] of lines.entries()) {
    if (index > 0) commands.push(`0 -${LINE_HEIGHT} Td`);
    commands.push(`${pdfLiteral(line)} Tj`);
  }
  commands.push('ET');
  return commands.join('\n');
}

function paginate(lines) {
  const usable = PAGE_HEIGHT - MARGIN * 2;
  const perPage = Math.max(1, Math.floor(usable / LINE_HEIGHT));
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  return pages.length ? pages : [[' ']];
}

function ascii(value) {
  return Buffer.from(value, 'ascii');
}

/**
 * Build a PDF 1.4 buffer from résumé text. Helvetica / WinAnsi only; unsupported
 * characters become `?`. Callers must not put this text in telemetry.
 */
export function textToPdf(text) {
  const encoded = encodeWinAnsi(text);
  const pages = paginate(wrapResumeLines(encoded.text));
  const pageCount = pages.length;
  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;
  const firstPageId = 4;
  const contentId = (pageIndex) => firstPageId + pageCount + pageIndex;
  const kids = pages.map((_, index) => `${firstPageId + index} 0 R`).join(' ');
  const objects = [];
  const add = (id, body) => {
    objects[id] = ascii(`${id} 0 obj\n${body}\nendobj\n`);
  };

  add(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  add(pagesId, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  add(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  for (const [index] of pages.entries()) {
    add(
      firstPageId + index,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents ${contentId(index)} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
  }
  for (const [index, pageLines] of pages.entries()) {
    const stream = pageContent(pageLines);
    add(contentId(index), `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`);
  }

  const header = ascii('%PDF-1.4\n');
  const offsets = [0];
  const parts = [header];
  let cursor = header.length;
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = cursor;
    parts.push(objects[id]);
    cursor += objects[id].length;
  }
  const xrefLines = ['xref', `0 ${offsets.length}`, '0000000000 65535 f '];
  for (let id = 1; id < offsets.length; id += 1) {
    xrefLines.push(`${String(offsets[id]).padStart(10, '0')} 00000 n `);
  }
  const xref = ascii(`${xrefLines.join('\n')}\n`);
  const trailer = ascii(`trailer\n<< /Size ${offsets.length} /Root ${catalogId} 0 R >>\nstartxref\n${cursor}\n%%EOF\n`);
  return {
    bytes: Buffer.concat([...parts, xref, trailer]),
    replacedCharacters: encoded.replacedCharacters,
    pageCount,
  };
}
