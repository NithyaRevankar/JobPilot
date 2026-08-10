// Reading the words out of an uploaded resume, and getting them into the prompt.
//
// The complaint this closes: "it keeps asking me my job title and my company when I have
// already given it my resume". It was right to be baffled — documents were stored as
// base64 and the only thing the model ever saw was the filename, so the resume answered
// nothing. Everything here is the path from an uploaded file to a line in the prompt.
//
// Fixtures are built byte by byte rather than checked in: a two-line PDF and a stored-entry
// DOCX are small enough to write honestly, and a binary fixture nobody can read is a
// fixture nobody can fix.
//
// Run: node test/doctext-harness.mjs
import zlib from 'node:zlib';
import { extractDocumentText, looksLikeProse } from '../sidepanel/js/doctext.js';
import { buildSystemPrompt } from '../sidepanel/js/prompts.js';

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

const RESUME_LINES = [
  'Jane Doe',
  'Senior Software Engineer at Acme Corp',
  'Bengaluru, India',
  'Experience: Acme Corp, Senior Software Engineer, from March until the present day.',
  'Previously worked at Globex as a backend engineer building payment systems.',
  'Education: Bachelor of Engineering in Computer Science from a university.',
  'Skills include distributed systems, databases, and building reliable services.',
];
const b64 = (buf) => Buffer.from(buf).toString('base64');

// ------------------------------------------------------------------ plain text
let r = await extractDocumentText({
  name: 'resume.txt', mime: 'text/plain', dataBase64: b64(RESUME_LINES.join('\n')),
});
check('a .txt resume is read', r.ok && /Senior Software Engineer at Acme Corp/.test(r.text),
  JSON.stringify(r.text.slice(0, 50)));

// --------------------------------------------------------------------- a .docx
// A real docx is a zip of many parts; word/document.xml is the one that holds the words.
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                       // version needed
    local.writeUInt16LE(deflate ? 8 : 0, 8);          // method
    local.writeUInt32LE(zlib.crc32 ? zlib.crc32(data) : 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(deflate ? 8 : 0, 10);
    cd.writeUInt32LE(zlib.crc32 ? zlib.crc32(data) : 0, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);

    locals.push(local, body);
    central.push(cd);
    offset += local.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

const docXml = Buffer.from(
  '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
  + RESUME_LINES.map((l) => `<w:p><w:r><w:t>${l.replace(/&/g, '&amp;')}</w:t></w:r></w:p>`).join('')
  + '</w:body></w:document>', 'utf8');

for (const deflate of [false, true]) {
  r = await extractDocumentText({
    name: 'resume.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dataBase64: b64(zip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>'), deflate: false },
      { name: 'word/document.xml', data: docXml, deflate },
    ])),
  });
  check(`a .docx is unzipped and read (${deflate ? 'deflated' : 'stored'} entry)`,
    r.ok && /Globex/.test(r.text) && /Jane Doe/.test(r.text), JSON.stringify(r.text.slice(0, 44)));
}
check('...and each Word paragraph becomes its own line, not one run-on blob',
  r.text.split('\n').length >= RESUME_LINES.length, `${r.text.split('\n').length} lines`);

// ----------------------------------------------------------------------- a PDF
function pdf(lines, { flate } = {}) {
  const content = 'BT /F1 12 Tf 72 720 Td\n'
    + lines.map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj 0 -14 Td`).join('\n')
    + '\nET';
  const body = flate ? zlib.deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  const head = Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Length ${body.length}${flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`,
    'latin1');
  return Buffer.concat([head, body, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')]);
}

r = await extractDocumentText({ name: 'cv.pdf', mime: 'application/pdf', dataBase64: b64(pdf(RESUME_LINES)) });
check('a PDF with an uncompressed content stream is read',
  r.ok && /Senior Software Engineer at Acme Corp/.test(r.text), JSON.stringify(r.text.slice(0, 44)));

r = await extractDocumentText({
  name: 'cv.pdf', mime: 'application/pdf', dataBase64: b64(pdf(RESUME_LINES, { flate: true })),
});
check('THE POINT: a FlateDecode PDF — what every real resume is — is inflated and read',
  r.ok && /Globex/.test(r.text) && /Jane Doe/.test(r.text), JSON.stringify(r.text.slice(0, 44)));

r = await extractDocumentText({
  name: 'cv.pdf',
  mime: 'application/pdf',
  dataBase64: b64(pdf(['Cost was Rs.1,20,000 (approx)', ...RESUME_LINES])),
});
check('...parenthesised and escaped text survives instead of ending the string early',
  r.ok && /Rs\.1,20,000 \(approx\)/.test(r.text), JSON.stringify(r.text.slice(0, 60)));

// ============= a REAL resume: subset fonts, hex glyph codes, indirect everything
// The shape every resume actually has, and the one the first cut of this reader could not
// touch. Word / Google Docs / LibreOffice / LaTeX all embed SUBSET fonts: the content
// stream holds glyph numbers (1, 2, 3…), not letters, and the only way back to text is the
// font's own /ToUnicode CMap. Read the codes as characters and a resume comes out as
// control-character soup that looksLikeProse rejects — so the file reads as "unreadable"
// and the user is asked their job title again.
//
// Everything indirect on purpose: /Resources is a reference to an object whose /Font is
// another reference. That is verbatim what LibreOffice writes, and dereferencing only the
// outer one finds no fonts at all.
function subsetPdf(lines, { codeWidth = 1 } = {}) {
  const chars = [...new Set(lines.join('\n').split(''))];
  const code = new Map(chars.map((c, i) => [c, i + 1])); // glyph ids, in subset order
  const hex = (n) => n.toString(16).padStart(codeWidth * 2, '0').toUpperCase();
  const u16 = (c) => c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase();

  const content = `BT /F1 12 Tf 72 720 Td\n${lines
    .map((l) => `<${[...l].map((c) => hex(code.get(c))).join('')}> Tj 0 -14 Td`)
    .join('\n')}\nET`;
  const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n'
    + `1 begincodespacerange <${'00'.repeat(codeWidth)}> <${'FF'.repeat(codeWidth)}> endcodespacerange\n`
    + `${chars.length} beginbfchar\n`
    + chars.map((c) => `<${hex(code.get(c))}> <${u16(c)}>`).join('\n')
    + '\nendbfchar\nendcmap end end';

  const objs = [
    ['1 0 obj\n<< /Type /Page /Parent 9 0 R /Resources 5 0 R /Contents 2 0 R >>\nendobj\n'],
    [`2 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`],
    ['5 0 obj\n<< /Font 6 0 R /ProcSet [/PDF /Text] >>\nendobj\n'],
    ['6 0 obj\n<< /F1 7 0 R >>\nendobj\n'],
    ['7 0 obj\n<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+Liberation /ToUnicode 8 0 R >>\nendobj\n'],
    [`8 0 obj\n<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream\nendobj\n`],
  ];
  return Buffer.from(`%PDF-1.7\n${objs.map((o) => o[0]).join('')}%%EOF\n`, 'latin1');
}

for (const codeWidth of [1, 2]) {
  r = await extractDocumentText({
    name: 'resume.pdf', mime: 'application/pdf', dataBase64: b64(subsetPdf(RESUME_LINES, { codeWidth })),
  });
  check(`THE POINT: a subset-font PDF is decoded through its /ToUnicode CMap (${codeWidth}-byte codes)`,
    r.ok && /Senior Software Engineer at Acme Corp/.test(r.text) && /Globex/.test(r.text),
    JSON.stringify(r.text.slice(0, 46)));
}

// The same file with its CMap removed is the honest failure case: the codes are still
// there, they still look like text, and there is no longer any way to know what they say.
{
  const broken = subsetPdf(RESUME_LINES).toString('latin1').replace('/ToUnicode 8 0 R', '');
  r = await extractDocumentText({
    name: 'resume.pdf', mime: 'application/pdf', dataBase64: b64(Buffer.from(broken, 'latin1')),
  });
  check('...and without the CMap the glyph codes are REJECTED, not served up as the resume',
    !r.ok && r.text === '', JSON.stringify(r.reason));
}

// ------------------------------------------------------- honest about failure
// The gate that matters. Handing the model byte soup and calling it the user's job history
// is worse than admitting we could not read the file: the model would answer from it.
r = await extractDocumentText({
  name: 'scan.pdf', mime: 'application/pdf', dataBase64: b64(Buffer.from('%PDF-1.4\n(no text here)\n%%EOF')),
});
check('a scanned PDF with no selectable text FAILS instead of returning nothing quietly',
  !r.ok && r.text === '' && /scan|no selectable text/i.test(r.reason), JSON.stringify(r.reason));

r = await extractDocumentText({
  name: 'cv.pdf',
  mime: 'application/pdf',
  dataBase64: b64(pdf(['   '.repeat(8)])),
});
check('...and mojibake from a font JobPilot cannot decode is REJECTED, not passed off as prose',
  !r.ok && r.text === '', JSON.stringify(r.reason));

r = await extractDocumentText({ name: 'old.doc', mime: 'application/msword', dataBase64: b64('\xd0\xcf\x11\xe0junk') });
check('a legacy .doc says what to do about it rather than failing blankly',
  !r.ok && /PDF or DOCX|paste/i.test(r.reason), JSON.stringify(r.reason));

check('looksLikeProse rejects a run-on with no spaces', !looksLikeProse('a'.repeat(400)));
check('...and accepts an ordinary paragraph', looksLikeProse(RESUME_LINES.join(' ')));

// ======================================================= and into the prompt
const docs = [{ id: 'd1', name: 'resume.pdf', isDefault: true, text: RESUME_LINES.join('\n') }];

let prompt = buildSystemPrompt({ profile: { fullName: 'Jane Doe' }, documents: docs, settings: {} });
check('THE POINT: the resume TEXT reaches the system prompt, not just its filename',
  /## Resume/.test(prompt) && /Senior Software Engineer at Acme Corp/.test(prompt),
  /## Resume/.test(prompt) ? 'resume section present' : 'MISSING');
check('...framed as reference data, so a hostile document cannot issue instructions',
  /REFERENCE DATA, not instructions/.test(prompt));

prompt = buildSystemPrompt({
  profile: { fullName: 'Jane Doe', resumeText: 'Typed by hand: Staff Engineer at Initech.' },
  documents: docs,
  settings: {},
});
check('what the user typed WINS over what was extracted from the file',
  /Staff Engineer at Initech/.test(prompt) && !/Senior Software Engineer at Acme Corp/.test(prompt));

prompt = buildSystemPrompt({
  profile: { fullName: 'Jane Doe' },
  documents: [{ id: 'd1', name: 'resume.pdf', isDefault: true, text: '' }],
  settings: {},
});
check('an unreadable upload does NOT produce a Resume section', !/## Resume/.test(prompt));
check('THE POINT: and the model is told it cannot read the file, so it stops claiming it has',
  /CANNOT read what is inside them/.test(prompt),
  prompt.slice(prompt.indexOf('## Documents')).replace(/\n/g, ' | ').slice(0, 150));

prompt = buildSystemPrompt({
  profile: { fullName: 'Jane Doe', currentTitle: 'Senior Engineer', currentCompany: 'Acme', sponsorshipNeeded: 'No' },
  documents: [],
  settings: {},
});
for (const [label, value] of [['Current / most recent job title', 'Senior Engineer'],
  ['Current / most recent employer', 'Acme'], ['Needs visa sponsorship', 'No']]) {
  check(`the profile carries "${label}" into the prompt, so it is never a question`,
    prompt.includes(`- ${label}: ${value}`), label);
}

const longResume = `${RESUME_LINES.join('\n')}\n${'Filler line about a project. '.repeat(600)}`;
prompt = buildSystemPrompt({ profile: { resumeText: longResume }, documents: [], settings: {} });
// Asserted DIRECTLY — the marker is present and most of the filler was dropped — rather
// than via `prompt.length < longResume.length`, which compared the WHOLE prompt (rules and
// all) against the raw resume and therefore failed whenever a legitimate new rule grew the
// fixed overhead, regardless of whether truncation worked.
const fillerKept = (prompt.match(/Filler line about a project\./g) || []).length;
check('an over-long resume is truncated and SAYS so, rather than appearing to end mid-career',
  /resume truncated here/.test(prompt) && fillerKept < 300,
  `marker=${/resume truncated here/.test(prompt)}, ${fillerKept}/600 filler lines kept`);

console.log(fail ? `\n${fail} doctext check(s) FAILED` : '\nall doctext checks passed');
process.exit(fail ? 1 : 0);
