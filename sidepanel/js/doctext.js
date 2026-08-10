// doctext.js — read the TEXT out of an uploaded document.
//
// Why this exists. Documents were stored as base64 and handed to upload_file, and the only
// thing that ever reached the model was the FILENAME. So the agent, holding a resume that
// says "Senior Engineer at Acme, 2019–present", still had to stop and ask "current job
// title? current company?" — on every application, forever. The user had done the one thing
// the product told them to do and it bought them nothing.
//
// Best-effort by design, and honest when it fails. A PDF built from a subset font with a
// custom encoding cannot be read without the font tables, and guessing produces plausible
// mojibake — which is worse than nothing, because it would be fed to the model as fact.
// Everything here is gated on looksLikeProse(): if the output does not read as language,
// it is thrown away and the caller tells the user to paste the text instead.
//
// Zero dependencies, per the project rule. Inflate comes from DecompressionStream, which
// Chrome has had since 80.

/** How much of a document we keep. A resume is 2–6k characters; 20k is a long CV. */
export const TEXT_CAP = 20000;

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Inflate, keeping whatever came out before any complaint.
 *
 * DecompressionStream is strict: one byte after the end of the compressed data and it
 * throws "trailing junk", discarding a perfectly good inflate. PDFs hit that constantly —
 * the newline a producer writes between the stream data and `endstream` is trailing junk
 * by that definition, and so is any padding. A truncated stream fails the same way and is
 * worth the same treatment: half a resume beats none. Only a stream that produced NOTHING
 * is a real failure, and that one still throws.
 */
async function inflate(bytes, format) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const chunks = [];
  let total = 0;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      chunks.push(chunk.value);
      total += chunk.value.length;
    }
  } catch (err) {
    if (!total) throw err;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * Does this read as human language?
 *
 * The gate between "we extracted the resume" and "we extracted the font's byte soup and are
 * about to tell the model it is the user's job history". Cheap and blunt on purpose: real
 * prose is mostly letters and spaces, and has words in it.
 */
export function looksLikeProse(text) {
  const s = String(text || '');
  if (s.length < 40) return false;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (letters / s.length < 0.5) return false;
  // Real text has spaces. Extraction that lost them produces one enormous run-on token.
  const words = s.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z'’.-]{1,}$/.test(w));
  return words.length >= 12;
}

function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    // A NUL survives a UTF-16 file decoded as UTF-8, and PDF streams are full of them.
    .replace(/\0/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, TEXT_CAP);
}

// ------------------------------------------------------------------------ docx
// A .docx is a ZIP holding word/document.xml. Read the central directory rather than
// scanning for local headers: a local header's sizes may be zero with the real ones parked
// in a data descriptor after the data, which is exactly the shape Word writes.

function findEocd(b) {
  // The end-of-central-directory record is at the tail, after a comment of up to 64k.
  for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i;
  }
  return -1;
}

async function unzipEntry(bytes, wanted) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes);
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();

  for (let i = 0; i < count && at + 46 <= bytes.length; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) return null; // not a central header — give up
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));

    if (name === wanted) {
      // The local header repeats the name and extra fields, at its own lengths.
      const lNameLen = view.getUint16(localAt + 26, true);
      const lExtraLen = view.getUint16(localAt + 28, true);
      const from = localAt + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(from, from + compressed);
      if (method === 0) return raw;
      if (method === 8) return await inflate(raw, 'deflate-raw');
      return null; // some other compression method — not worth carrying a decoder for
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function docxXmlToText(xml) {
  return xml
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&'); // last, so &amp;lt; does not become <
}

async function readDocx(bytes) {
  const entry = await unzipEntry(bytes, 'word/document.xml');
  if (!entry) return '';
  return docxXmlToText(new TextDecoder().decode(entry));
}

// ------------------------------------------------------------------------- pdf
// Enough of the format to get the words out of an ordinary text-based resume: find the
// content streams, inflate the FlateDecode ones, and pull the strings out of the text
// operators. No font tables, so a PDF whose fonts carry a custom encoding comes out as
// nonsense — which looksLikeProse() then rejects.
//
// A scanned resume is an image and has no text at all. That is not a failure to fix here.

function pdfUnescape(s) {
  return s.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (_, c) => {
    switch (c) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case '(': return '(';
      case ')': return ')';
      case '\\': return '\\';
      default: return String.fromCharCode(parseInt(c, 8));
    }
  });
}

const hexToBytes = (hex) => {
  const h = hex.replace(/\s+/g, '');
  let s = '';
  for (let i = 0; i + 1 < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return s;
};

/** Big-endian UTF-16 hex ("0041002E") → the characters it stands for. */
function utf16beFromHex(hex) {
  const h = hex.replace(/\s+/g, '');
  let s = '';
  for (let i = 0; i + 3 < h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
  // An odd single byte pair is a 1-byte destination, which some producers do write.
  return s || (h.length >= 2 ? String.fromCharCode(parseInt(h.slice(0, 2), 16)) : '');
}

/**
 * A /ToUnicode CMap: "this font's code 3 is the letter S".
 *
 * The piece without which none of this works on a real resume. Word, Google Docs, LaTeX
 * and every resume builder embed SUBSET fonts, where the codes in the content stream are
 * positions in that subset — 1, 2, 3… — and not letters at all. Reading the codes as
 * characters is how a resume comes out as control-character soup. The CMap is the font's
 * own translation table, and it is in the file precisely so text can be recovered.
 *
 * @returns {{width:number, map:Map<number,string>}|null}
 */
function parseCMap(text) {
  const map = new Map();
  let width = 2;
  for (const block of text.match(/beginbfchar[\s\S]*?endbfchar/g) || []) {
    for (const m of block.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]*)>/g)) {
      const src = m[1].replace(/\s+/g, '');
      width = Math.max(1, Math.ceil(src.length / 2));
      map.set(parseInt(src, 16), utf16beFromHex(m[2]));
    }
  }
  for (const block of text.match(/beginbfrange[\s\S]*?endbfrange/g) || []) {
    // <lo> <hi> <dst>  — consecutive codes onto consecutive characters.
    for (const m of block.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]*)>/g)) {
      const lo = parseInt(m[1].replace(/\s+/g, ''), 16);
      const hi = parseInt(m[2].replace(/\s+/g, ''), 16);
      width = Math.max(1, Math.ceil(m[1].replace(/\s+/g, '').length / 2));
      const base = utf16beFromHex(m[3]);
      if (!base || hi - lo > 65535) continue;
      const head = base.slice(0, -1);
      const tail = base.charCodeAt(base.length - 1);
      for (let c = lo; c <= hi; c++) map.set(c, head + String.fromCharCode(tail + (c - lo)));
    }
    // <lo> <hi> [<d1> <d2> …] — each code named individually.
    for (const m of block.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(m[1].replace(/\s+/g, ''), 16);
      width = Math.max(1, Math.ceil(m[1].replace(/\s+/g, '').length / 2));
      let c = lo;
      for (const d of m[3].matchAll(/<([0-9A-Fa-f\s]*)>/g)) map.set(c++, utf16beFromHex(d[1]));
    }
  }
  return map.size ? { width, map } : null;
}

/** Codes → characters through a CMap, reading `width` bytes at a time. */
function viaCMap(bytes, cmap) {
  let out = '';
  for (let i = 0; i + cmap.width <= bytes.length; i += cmap.width) {
    let code = 0;
    for (let k = 0; k < cmap.width; k++) code = (code << 8) | bytes.charCodeAt(i + k);
    const ch = cmap.map.get(code);
    if (ch != null) out += ch;
  }
  return out;
}

/**
 * The text of one content stream.
 *
 * @param {Map<string,object>} fonts  resource name (without the slash) → CMap for this page.
 */
function pdfStreamText(content, fonts) {
  const out = [];
  let cmap = null;
  const re = /\/([^\s/<>[\]()]+)\s+[\d.]+\s+Tf|\((?:\\.|[^\\()])*\)|<([0-9A-Fa-f\s]*)>|\bT[Jj]\b|\bTd\b|\bTD\b|\bT\*|\bETQ?\b/g;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    const tok = m[0];
    if (m[1] !== undefined) {
      // A font switch. An unknown name clears the map rather than keeping the previous
      // font's — decoding one font's codes with another font's table is exactly the
      // confident nonsense this whole path has to avoid.
      cmap = fonts ? fonts.get(m[1]) || null : null;
    } else if (tok.startsWith('(')) {
      const s = pdfUnescape(tok.slice(1, -1));
      out.push(cmap ? viaCMap(s, cmap) : s);
    } else if (m[2] !== undefined) {
      const s = hexToBytes(m[2]);
      out.push(cmap ? viaCMap(s, cmap) : s);
    } else if (tok === 'Td' || tok === 'TD' || tok === 'T*' || tok.startsWith('ET')) {
      out.push('\n'); // a new text position is, near enough, a new line
    }
  }
  return out.join('');
}

/** A FRESH matcher every time. A shared /g regex carries `lastIndex` between callers, and
 *  a helper that rewinds it mid-loop turns the caller's scan into an infinite one. */
const streamMark = () => /\bstream\r?\n?/g;

/**
 * Every `N 0 obj … endobj` in the file, by object number.
 *
 * A scan, not an xref walk. It reads a linearised file, an incrementally-updated one and a
 * damaged one alike, and this is a best-effort text grab, not a renderer. Objects packed
 * inside an /ObjStm are not visible to it; those files fall back to the flat scan below.
 */
function indexObjects(raw) {
  const objs = new Map();
  for (const m of raw.matchAll(/(?:^|[^0-9])(\d{1,7})\s+(\d{1,5})\s+obj\b/g)) {
    const start = m.index + m[0].indexOf(m[1]);
    const end = raw.indexOf('endobj', start);
    objs.set(Number(m[1]), { start, bodyAt: start + m[0].length - m[0].indexOf(m[1]), end: end < 0 ? raw.length : end });
  }
  return objs;
}

/** The raw (still-encoded) payload of the stream inside one object, or null. */
function streamRangeOf(raw, bytes, obj) {
  const re = streamMark();
  re.lastIndex = obj.start;
  const m = re.exec(raw);
  if (!m || m.index > obj.end) return null;
  const from = m.index + m[0].length;
  const to = raw.indexOf('endstream', from);
  if (to < 0) return null;
  const header = raw.slice(obj.start, m.index);
  // `/Length N` is authoritative when the producer wrote it as a direct integer (rather
  // than `/Length 12 0 R`, an indirect reference). Otherwise drop the end-of-line bytes a
  // producer puts before `endstream`: they are not part of the data, and a strict inflater
  // rejects the entire stream because of them.
  const declared = /\/Length\s+(\d+)\s*(?:\/|>>|\r|\n)/.exec(header);
  let end = declared && from + Number(declared[1]) <= to ? from + Number(declared[1]) : to;
  while (end > from && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end--;
  return { header, from, end, to };
}

async function decodeStream(raw, bytes, range) {
  if (!range) return null;
  if (/\/(DCT|JPX|CCITT|JBIG2)Decode/.test(range.header)) return null; // an image
  if (!/\/FlateDecode/.test(range.header)) return raw.slice(range.from, range.to);
  try {
    return new TextDecoder('latin1').decode(await inflate(bytes.subarray(range.from, range.end), 'deflate'));
  } catch {
    return null;
  }
}

/** `/Contents 4 0 R` or `/Contents [4 0 R 5 0 R]` → the object numbers. */
function refsIn(text) {
  return [...text.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
}

function dictValue(dict, key) {
  // The key must END where we say it does: a bare indexOf('/Font') also finds
  // /FontDescriptor, and would hand back that object's descriptor as the font list.
  const found = new RegExp(`/${key}(?![A-Za-z0-9])`).exec(dict);
  if (!found) return '';
  const at = found.index;
  const rest = dict.slice(at + key.length + 1);
  if (/^\s*<</.test(rest)) {
    // An inline dictionary — take it with its nesting balanced.
    let depth = 0;
    const from = rest.indexOf('<<');
    for (let i = from; i < rest.length - 1; i++) {
      if (rest[i] === '<' && rest[i + 1] === '<') { depth++; i++; } else if (rest[i] === '>' && rest[i + 1] === '>') {
        depth--; i++;
        if (!depth) return rest.slice(from, i + 1);
      }
    }
    return rest.slice(from);
  }
  return (/^\s*(\[[^\]]*\]|[^/\]>]*)/.exec(rest) || ['', ''])[1].trim();
}

async function readPdf(bytes) {
  // Latin1 so byte offsets and string indices stay in step — the stream payloads are
  // binary and must be sliced out by index, not re-encoded.
  const raw = new TextDecoder('latin1').decode(bytes);
  const objs = indexObjects(raw);
  const body = (n) => (objs.has(n) ? raw.slice(objs.get(n).start, objs.get(n).end) : '');

  /**
   * A dictionary entry, following the reference if it is one.
   *
   * Any entry may be either inline or an indirect reference, at the producer's whim, and
   * LibreOffice writes BOTH on the same page: `/Resources 143 0 R` pointing at an object
   * whose `/Font 142 0 R` points at another. Dereferencing only the outer one found the
   * resources, then read "142 0 R" as the font list, found no fonts in it, and decoded the
   * page with no translation table at all — which is a resume that comes out as mojibake.
   */
  const entry = (dict, key) => {
    const value = dictValue(dict, key);
    const ref = /^(\d+)\s+\d+\s+R$/.exec(value);
    if (!ref || !objs.has(Number(ref[1]))) return value;
    const target = body(Number(ref[1]));
    // The referenced object either IS the dictionary, or holds it under the same key.
    return dictValue(target, key) || target;
  };

  // Every font's translation table, by object number, resolved once.
  const cmapCache = new Map();
  const cmapFor = async (fontNum) => {
    if (cmapCache.has(fontNum)) return cmapCache.get(fontNum);
    let parsed = null;
    const ref = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(body(fontNum));
    if (ref && objs.has(Number(ref[1]))) {
      const text = await decodeStream(raw, bytes, streamRangeOf(raw, bytes, objs.get(Number(ref[1]))));
      if (text) parsed = parseCMap(text);
    }
    cmapCache.set(fontNum, parsed);
    return parsed;
  };

  const pieces = [];
  // Page by page, so each content stream is decoded with ITS OWN page's fonts. A document
  // that reused /F1 for a different font on page two would otherwise come out as mojibake
  // from page two onwards.
  for (const [, obj] of objs) {
    const text = raw.slice(obj.start, obj.end);
    if (!/\/Type\s*\/Page\b/.test(text)) continue;

    // Resources are inheritable: a page that declares none uses its /Pages parent's.
    let fontDict = entry(entry(text, 'Resources'), 'Font');
    if (!fontDict) {
      const parent = /^(\d+)\s+\d+\s+R$/.exec(dictValue(text, 'Parent'));
      if (parent) fontDict = entry(entry(body(Number(parent[1])), 'Resources'), 'Font');
    }
    const fonts = new Map();
    for (const f of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const cmap = await cmapFor(Number(f[2]));
      if (cmap) fonts.set(f[1], cmap);
    }

    for (const num of refsIn(dictValue(text, 'Contents'))) {
      if (!objs.has(num)) continue;
      const content = await decodeStream(raw, bytes, streamRangeOf(raw, bytes, objs.get(num)));
      if (content && /\bT[Jj]\b/.test(content)) pieces.push(pdfStreamText(content, fonts));
    }
    if (pieces.join('').length > TEXT_CAP * 2) break;
  }
  if (pieces.join('').trim()) return pieces.join('\n');

  // Nothing came out page-first: the file may pack its objects into an /ObjStm, or be
  // damaged, or (like a hand-written fixture) have no page tree at all. Fall back to the
  // flat scan — no font tables, so only fonts that draw plain ASCII survive it.
  const scan = streamMark();
  const flat = [];
  for (let m = scan.exec(raw); m; m = scan.exec(raw)) {
    const to = raw.indexOf('endstream', m.index);
    if (to < 0) break;
    // PAST the whole word. Resuming at `endstream` matched the "stream" inside it, so every
    // stream after the first was sliced from the middle of one object to the end of the
    // next — which is why a real PDF inflated exactly one of its eight streams.
    scan.lastIndex = to + 'endstream'.length;
    const range = streamRangeOf(raw, bytes, { start: Math.max(0, m.index - 400), end: to });
    const content = await decodeStream(raw, bytes, range);
    if (content && /\bT[Jj]\b/.test(content)) flat.push(pdfStreamText(content, null));
    if (flat.join('').length > TEXT_CAP * 2) break;
  }
  return flat.join('\n');
}

// ----------------------------------------------------------------------- entry

const TEXTUAL = /^text\/|\/(json|csv|markdown|rtf)$/i;

/**
 * Pull the text out of an uploaded document.
 *
 * @param {{name?:string, mime?:string, dataBase64:string}} doc
 * @returns {Promise<{text:string, ok:boolean, reason:string}>} `ok` false means the caller
 *   must ask the user to paste the text — never that it may use `text` anyway.
 */
export async function extractDocumentText(doc) {
  const name = String((doc && doc.name) || '');
  const mime = String((doc && doc.mime) || '');
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  let bytes;
  try {
    bytes = base64ToBytes(doc.dataBase64);
  } catch {
    return { text: '', ok: false, reason: 'the file could not be read back from storage' };
  }

  let text = '';
  try {
    if (ext === 'pdf' || mime === 'application/pdf') {
      text = await readPdf(bytes);
    } else if (ext === 'docx' || /wordprocessingml/.test(mime)) {
      text = await readDocx(bytes);
    } else if (TEXTUAL.test(mime) || ['txt', 'md', 'markdown', 'csv', 'rtf'].includes(ext)) {
      text = new TextDecoder().decode(bytes);
      if (ext === 'rtf' || /rtf/.test(mime)) {
        text = text.replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/\\par[d]?\b/g, '\n').replace(/\\[a-z]+-?\d*\s?/gi, '').replace(/[{}]/g, '');
      }
    } else if (ext === 'doc' || mime === 'application/msword') {
      // Legacy binary .doc is a compound-file container; there is no honest quick read.
      return { text: '', ok: false, reason: 'old .doc files cannot be read — save it as PDF or DOCX, or paste the text' };
    } else {
      return { text: '', ok: false, reason: `JobPilot cannot read text out of a ${ext || mime || 'file'} of this type` };
    }
  } catch {
    return { text: '', ok: false, reason: 'the file is damaged or in a format JobPilot cannot read' };
  }

  const clean = tidy(text);
  if (!looksLikeProse(clean)) {
    return {
      text: '',
      ok: false,
      reason: clean
        ? 'the text came out unreadable (the file uses embedded fonts JobPilot cannot decode)'
        : 'there is no selectable text in this file (it looks like a scan or an image)',
    };
  }
  return { text: clean, ok: true, reason: '' };
}
