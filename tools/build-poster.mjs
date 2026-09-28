/**
 * Builds the SAIF 2026 scientific poster as a true vector PDF.
 *
 *   node tools/build-poster.mjs
 *
 * Follows the official template: 36 x 48 inches portrait at 100% scale, the
 * dark teal gradient reserved for the 18-and-above age group, and the six
 * required sections. Vector throughout - the template forbids exporting as
 * PNG/JPEG because image compression prints blurry at this size.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import QRCode from 'qrcode';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

// ---- canvas -----------------------------------------------------------------
const W = 36 * 72; // 2592 pt
const H = 48 * 72; // 3456 pt
const MARGIN = 96;
const GUTTER = 54;
const COL = (W - MARGIN * 2 - GUTTER) / 2;

// ---- palette (sampled from the template's 18+ swatch) -----------------------
const hex = (h) => rgb(
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
);
const BG_TOP = '#0e3f3c';
const BG_BOTTOM = '#96aaa2';
const CARD = hex('#f7f7f0');
const INK = hex('#14211f');
const HEAD = hex('#0e3f3c');
const MUTED = hex('#5a6b68');
const ACCENT = hex('#00707c');
const WHITE = rgb(1, 1, 1);

const REPO = 'https://github.com/OsamaQh4/hajiz-dlp-gateway';

const doc = await PDFDocument.create();
doc.setTitle('Hajiz - AI-Powered Data Loss Prevention Gateway for Enterprise AI');
doc.setAuthor('Osama Alqahtani');
doc.setSubject('SAIF 2026 - Cybersecurity & Defense Technologies');

const page = doc.addPage([W, H]);

/**
 * The template asks for IBM Plex Sans. Embedding it rather than relying on a
 * standard font also removes any chance of a metrics mismatch at print size -
 * the PDF carries the exact glyphs and advance widths.
 */
doc.registerFontkit(fontkit);
const fontFile = (name) => fs.readFileSync(path.join(here, 'fonts', `IBMPlexSans-${name}.ttf`));
const reg = await doc.embedFont(fontFile('Regular'), { subset: true });
const bold = await doc.embedFont(fontFile('SemiBold'), { subset: true });
const heavy = await doc.embedFont(fontFile('Bold'), { subset: true });
const oblique = await doc.embedFont(fontFile('Italic'), { subset: true });

// ---- primitives -------------------------------------------------------------

/** pdf-lib has no gradients, so paint one as a stack of thin bands. */
function gradient(top, bottom, bands = 420) {
  const t = [1, 3, 5].map((i) => parseInt(top.slice(i, i + 2), 16));
  const b = [1, 3, 5].map((i) => parseInt(bottom.slice(i, i + 2), 16));
  const h = H / bands;
  for (let i = 0; i < bands; i += 1) {
    const k = i / (bands - 1);
    const c = t.map((v, j) => (v + (b[j] - v) * k) / 255);
    page.drawRectangle({
      x: 0, y: H - (i + 1) * h - 0.5, width: W, height: h + 1,
      color: rgb(c[0], c[1], c[2]),
    });
  }
}

function card(x, y, w, h, opts = {}) {
  page.drawRectangle({
    x, y, width: w, height: h,
    color: opts.color ?? CARD,
    borderColor: opts.borderColor,
    borderWidth: opts.borderWidth ?? 0,
  });
}

function wrap(text, font, size, maxWidth) {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

/** @returns {number} the y position after the drawn text */
function text(str, { x, y, size, font = reg, color = INK, width = COL, leading = 1.34, align = 'left' }) {
  let cursor = y;
  for (const line of wrap(str, font, size, width)) {
    let dx = x;
    if (align === 'center') dx = x + (width - font.widthOfTextAtSize(line, size)) / 2;
    if (align === 'right') dx = x + width - font.widthOfTextAtSize(line, size);
    page.drawText(line, { x: dx, y: cursor, size, font, color });
    cursor -= size * leading;
  }
  return cursor;
}

function bullets(items, { x, y, size, width, gap = 10, color = INK }) {
  let cursor = y;
  for (const item of items) {
    page.drawCircle({ x: x + 7, y: cursor + size * 0.32, size: 4.5, color: ACCENT });
    cursor = text(item, { x: x + 26, y: cursor, size, width: width - 26, color });
    cursor -= gap;
  }
  return cursor;
}

function sectionHeading(label, { x, y, width }) {
  page.drawText(label, { x, y, size: 46, font: heavy, color: HEAD });
  page.drawRectangle({ x, y: y - 20, width, height: 3, color: ACCENT });
  return y - 58;
}

// ---- background -------------------------------------------------------------
gradient(BG_TOP, BG_BOTTOM);

// ---- header -----------------------------------------------------------------
let y = H - MARGIN;

const QR_SIZE = 250;
const qrPng = await QRCode.toBuffer(REPO, {
  type: 'png', width: 900, margin: 1,
  color: { dark: '#0e3f3cff', light: '#f7f7f0ff' },
});
const qrImage = await doc.embedPng(qrPng);

// Title block, leaving room on the right for the QR / flag / booth boxes.
const titleWidth = W - MARGIN * 2 - QR_SIZE - 300;
y = text('Hajiz', { x: MARGIN, y: y - 92, size: 112, font: heavy, color: WHITE, width: titleWidth });
y = text('AI-Powered Data Loss Prevention Gateway for Enterprise AI', {
  x: MARGIN, y: y - 14, size: 54, font: bold, color: hex('#cfe3df'), width: titleWidth, leading: 1.2,
});
y = text('Security & Innovation Fair (SAIF) 2026   |   Cybersecurity & Defense Technologies', {
  x: MARGIN, y: y - 26, size: 30, color: hex('#a9c6c1'), width: titleWidth,
});

y -= 40;
page.drawText('Student Name:', { x: MARGIN, y, size: 30, font: bold, color: hex('#a9c6c1') });
page.drawText('Osama Alqahtani', { x: MARGIN + reg.widthOfTextAtSize('Student Name:  ', 30) + 10, y, size: 30, font: reg, color: WHITE });
page.drawText('ID:', { x: MARGIN + 640, y, size: 30, font: bold, color: hex('#a9c6c1') });
// Left blank on purpose - the ID is issued on qualification, so leave room to
// write it on the printed poster.
page.drawLine({
  start: { x: MARGIN + 640 + 54, y: y - 6 },
  end: { x: MARGIN + 640 + 54 + 330, y: y - 6 },
  thickness: 2, color: hex('#7fa39d'),
});

// QR + flag + booth, top-right corner.
const qrX = W - MARGIN - QR_SIZE;
const qrY = H - MARGIN - QR_SIZE - 6;
card(qrX - 14, qrY - 58, QR_SIZE + 28, QR_SIZE + 96, { color: CARD });
page.drawImage(qrImage, { x: qrX, y: qrY, width: QR_SIZE, height: QR_SIZE });
text('Source code, benchmark\nand documentation', {
  x: qrX - 14, y: qrY - 22, size: 21, width: QR_SIZE + 28, color: MUTED, align: 'center', leading: 1.25,
});

const boxW = 250;
const boxX = qrX - boxW - 30;
card(boxX, qrY + 40, boxW, QR_SIZE - 40, { color: CARD });
text('Country Flag', { x: boxX, y: qrY + QR_SIZE - 24, size: 26, font: bold, width: boxW, color: HEAD, align: 'center' });

const flagImage = await doc.embedPng(fs.readFileSync(path.join(here, 'Flag_of_Saudi_Arabia.png')));
const flagW = boxW - 44;
const flagH = flagW * (flagImage.height / flagImage.width);
page.drawImage(flagImage, {
  x: boxX + (boxW - flagW) / 2,
  y: qrY + 40 + (QR_SIZE - 40 - 52 - flagH) / 2,
  width: flagW,
  height: flagH,
});

/** A ruled line to fill in by hand once the value is assigned. */
function writeLine(x, y, w) {
  page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: 1.5, color: hex('#9aa8a5') });
}

card(boxX, qrY - 58, boxW, 86, { color: CARD });
text('Booth Number', { x: boxX, y: qrY - 4, size: 26, font: bold, width: boxW, color: HEAD, align: 'center' });
writeLine(boxX + 34, qrY - 40, boxW - 68);

// ---- body grid --------------------------------------------------------------
const BODY_TOP = H - MARGIN - 520;
const FOOTER_H = 150;
const BODY_BOTTOM = MARGIN + FOOTER_H + 30;
const ROW_GAP = 40;
// Rows are sized to their content rather than split evenly - the first two
// carry most of the text, and an equal split left the bottom row half empty.
const AVAILABLE = BODY_TOP - BODY_BOTTOM - ROW_GAP * 2;
const ROW_H = [0.375, 0.345, 0.28].map((f) => AVAILABLE * f);

const colX = [MARGIN, MARGIN + COL + GUTTER];
const rowY = [
  BODY_TOP,
  BODY_TOP - ROW_H[0] - ROW_GAP,
  BODY_TOP - ROW_H[0] - ROW_H[1] - ROW_GAP * 2,
];

const PAD = 40;
const cellInner = COL - PAD * 2;

function cell(ci, ri) {
  const x = colX[ci];
  const top = rowY[ri];
  card(x, top - ROW_H[ri], COL, ROW_H[ri]);
  return { x: x + PAD, y: top - PAD - 30, w: cellInner, bottom: top - ROW_H[ri] + PAD };
}

// ---- 1. Introduction --------------------------------------------------------
{
  const c = cell(0, 0);
  let cy = sectionHeading('Introduction', { x: c.x, y: c.y, width: c.w });
  cy = text(
    'Organizations want their people using Claude, ChatGPT and Copilot. Security teams cannot allow it, because a prompt is an unlogged, unclassified, free-text egress channel straight out of the perimeter.',
    { x: c.x, y: cy, size: 27, width: c.w },
  );
  cy -= 22;
  cy = bullets([
    'Block everything and you get shadow AI on personal devices - zero visibility, worse leakage.',
    'Allow everything and customer PII, source code and undisclosed deals leave with no record.',
    'Classic DLP was built for files and email. It cannot judge a sentence such as "our unreleased platform has an auth bypass" - no pattern matches it, yet it is the most damaging thing an employee could paste.',
  ], { x: c.x, y: cy, size: 26, width: c.w });
  cy -= 14;
  text(
    'In Saudi Arabia the PDPL and NCA controls make cross-border transfer of personal data a legal question, not a preference - so where the inspection itself runs matters as much as what it detects.',
    { x: c.x, y: cy, size: 26, font: oblique, width: c.w, color: ACCENT },
  );
}

// ---- 2. Methodology ---------------------------------------------------------
{
  const c = cell(1, 0);
  let cy = sectionHeading('Methodology', { x: c.x, y: c.y, width: c.w });
  cy = text('A gateway in the egress path inspects every outbound prompt and file before it leaves the tenant.', {
    x: c.x, y: cy, size: 27, width: c.w,
  });
  cy -= 26;

  // Inline flow diagram.
  const dY = cy - 96;
  const boxes = [
    ['Employee', 'VDI / IDE'],
    ['Tier A', 'regex + checksums'],
    ['Tier B', 'LLM judge'],
    ['Policy', '4 actions'],
    ['Vault', 'placeholders'],
  ];
  const bw = (c.w - 4 * 16) / 5;
  boxes.forEach((b, i) => {
    const bx = c.x + i * (bw + 16);
    page.drawRectangle({ x: bx, y: dY, width: bw, height: 96, color: hex('#e4ece9'), borderColor: ACCENT, borderWidth: 1.5 });
    text(b[0], { x: bx, y: dY + 60, size: 23, font: bold, width: bw, color: HEAD, align: 'center' });
    text(b[1], { x: bx, y: dY + 30, size: 18, width: bw, color: MUTED, align: 'center' });
    if (i < 4) {
      page.drawLine({
        start: { x: bx + bw + 3, y: dY + 48 }, end: { x: bx + bw + 13, y: dY + 48 },
        thickness: 2.5, color: ACCENT,
      });
    }
  });
  cy = dY - 34;

  cy = bullets([
    'Tier A - deterministic. Saudi national ID and Iqama (Luhn check digit), IBAN (mod-97), payment cards, provider API keys, private keys, connection strings, internal hosts, and the organization\'s own codename watchlist. Sub-millisecond; it carries most traffic.',
    'Tier B - semantic. An LLM judge runs only when there is prose long enough to hide meaning a pattern cannot see. It returns spans, classes, confidence and a rationale under a strict schema; its input is wrapped as untrusted data, and every span it reports is located in the text by the gateway, so hallucinated spans are discarded.',
    'Policy engine - allow, pseudonymize, escalate to a human, or block; per-group overrides in one readable YAML file.',
    'Token vault - session-stable placeholders, AES-256-GCM, never leaving the tenant. A hash-chained audit log records classes and decisions, never the values it protected.',
  ], { x: c.x, y: cy, size: 25, width: c.w, gap: 12 });
}

// ---- 3. Results -------------------------------------------------------------
{
  const c = cell(0, 1);
  let cy = sectionHeading('Results', { x: c.x, y: c.y, width: c.w });
  cy = text('Measured over a 33-prompt labeled corpus (15 deliberately benign), three consecutive runs, 99 judge calls.', {
    x: c.x, y: cy, size: 25, width: c.w, color: MUTED,
  });
  cy -= 30;

  const rows = [
    ['', 'Tier A', 'Tier B'],
    ['Precision', '100.0%', '91.7%'],
    ['Recall', '100.0%', '100.0%'],
    ['False alarms on 15 clean prompts', '0', '0'],
    ['Median latency', '0.12 ms', '1.4 s'],
    ['Degraded / failed calls', '-', '0 of 99'],
  ];
  const cw = [c.w * 0.5, c.w * 0.25, c.w * 0.25];
  rows.forEach((r, i) => {
    const ry = cy - i * 46;
    if (i === 0) {
      page.drawRectangle({ x: c.x, y: ry - 10, width: c.w, height: 42, color: hex('#e4ece9') });
    } else if (i % 2 === 0) {
      page.drawRectangle({ x: c.x, y: ry - 10, width: c.w, height: 42, color: hex('#eeeee6') });
    }
    r.forEach((v, j) => {
      const cx = c.x + cw.slice(0, j).reduce((a, b) => a + b, 0);
      page.drawText(v, {
        x: j === 0 ? cx + 10 : cx + cw[j] / 2 - bold.widthOfTextAtSize(v, 26) / 2,
        y: ry, size: 26, font: i === 0 || j > 0 ? bold : reg,
        color: i === 0 ? HEAD : INK,
      });
    });
  });
  cy -= rows.length * 46 + 16;

  cy = bullets([
    'Combined across both tiers: precision 96.6%, recall 93.3%, F1 94.9%.',
    'Stability: 30 of 30 expectations were found in every run, with identical findings each time - a control that catches a different subset each run is unusable for audit even at a good average rate.',
    'Tier B recall is span-level. The gap to strict-class recall is category disagreement, not missed data, and every such error resolved toward human review rather than under-protection.',
  ], { x: c.x, y: cy, size: 25, width: c.w, gap: 11 });

  cy -= 6;
  text(
    'Stated plainly: this corpus is small and hand-built. It is a regression harness and a starting point for evaluation, not a claim about production accuracy.',
    { x: c.x, y: cy, size: 23, font: oblique, width: c.w, color: MUTED },
  );
}

// ---- 4. Innovation ----------------------------------------------------------
{
  const c = cell(1, 1);
  let cy = sectionHeading('Innovation', { x: c.x, y: c.y, width: c.w });
  cy = text('Every product in this space masks. Masking destroys the answer, so people route around the tool. This one substitutes reversibly.', {
    x: c.x, y: cy, size: 27, width: c.w,
  });
  cy -= 28;

  const exH = 232;
  page.drawRectangle({ x: c.x, y: cy - exH, width: c.w, height: exH, color: hex('#e9efec'), borderColor: ACCENT, borderWidth: 1.5 });
  let ey = cy - 40;
  ey = text('Employee types:', { x: c.x + 22, y: ey, size: 21, font: bold, width: c.w - 44, color: MUTED });
  ey = text('"Customer Ahmed Al-Otaibi (ID 1098765439) reports that Project Falcon fails auth on login."', {
    x: c.x + 22, y: ey - 6, size: 23, width: c.w - 44, color: hex('#8c2f2f'),
  });
  ey = text('Model receives:', { x: c.x + 22, y: ey - 18, size: 21, font: bold, width: c.w - 44, color: MUTED });
  ey = text('"Customer PERSON_1 (ID ID_1) reports that PROJECT_1 fails auth on login."', {
    x: c.x + 22, y: ey - 6, size: 23, width: c.w - 44, color: hex('#1d6b4f'),
  });
  ey = text('Employee sees: the full answer, with every real value restored - including mid-stream.', {
    x: c.x + 22, y: ey - 22, size: 21, font: oblique, width: c.w - 44, color: INK,
  });
  cy -= exH + 26;

  bullets([
    'Reversible pseudonymization. One value keeps one placeholder for a whole session, so multi-turn conversations stay coherent and the mapping never leaves the tenant.',
    'Context-dependent sensitivity. The same facility name is substituted beside a redundancy figure and ignored in a first-aid invitation - a matched pair in the corpus. Sensitivity belongs to the combination, not the word.',
    'Data residency by design. The judge is pluggable and runs on the organization\'s own hardware for PDPL compliance. The gateway verifies this itself and labels any judge on a public host as a stand-in rather than flattering the deployment.',
    'Human-in-the-loop where it matters. Low-confidence findings, and spans too broad to substitute safely, are held for a reviewer rather than acted on silently.',
  ], { x: c.x, y: cy, size: 25, width: c.w, gap: 12 });
}

// ---- 5. Conclusion ----------------------------------------------------------
{
  const c = cell(0, 2);
  let cy = sectionHeading('Conclusion', { x: c.x, y: c.y, width: c.w });
  cy = bullets([
    'A working functional prototype shows that enterprises do not have to choose between using frontier AI and protecting what they know. Productivity and protection can be decoupled.',
    'The deterministic tier carries most traffic at 0.12 ms and never varies; the semantic tier is reserved for the leakage no pattern can see. That split is what makes an inline AI control viable at all.',
    'Zero false alarms across 15 clean prompts is the number that decides adoption. A control that cries wolf on ordinary work is removed within a week.',
    'Classification errors resolved toward human review rather than under-protection - for a security control, the correct direction to be wrong.',
  ], { x: c.x, y: cy, size: 26, width: c.w, gap: 13 });
}

// ---- 6. Future Work & References -------------------------------------------
{
  const c = cell(1, 2);
  let cy = sectionHeading('Future Work & References', { x: c.x, y: c.y, width: c.w });
  cy = bullets([
    'TLS-inspecting interception so browser-based AI tools are covered, not only API traffic.',
    'A two-stage semantic tier: a small fast classifier gates the expensive span extractor, cutting the latency most prompts pay.',
    'On-premises judge benchmarking, and coverage for PDF, DOCX and images via OCR.',
    'Enterprise integration: SIEM connectors, SSO and RBAC, GPO/PAC deployment.',
    'A larger evaluation corpus written independently of the detector, to replace the hand-built harness.',
  ], { x: c.x, y: cy, size: 25, width: c.w, gap: 11 });

  cy -= 16;
  cy = text('References', { x: c.x, y: cy, size: 30, font: bold, width: c.w, color: HEAD });
  cy -= 8;
  text(
    'Saudi Personal Data Protection Law (PDPL), SDAIA.   |   NCA Essential Cybersecurity Controls (ECC-1:2018).   |   OWASP Top 10 for Large Language Model Applications.   |   ISO 13616 (IBAN) and ISO/IEC 7812 (Luhn) checksum standards.   |   Full source, benchmark corpus and reproducible results: github.com/OsamaQh4/hajiz-dlp-gateway',
    { x: c.x, y: cy, size: 22, width: c.w, color: MUTED, leading: 1.4 },
  );
}

// ---- footer -----------------------------------------------------------------
{
  const fy = MARGIN;
  card(MARGIN, fy, W - MARGIN * 2, FOOTER_H);
  let cy = fy + FOOTER_H - 46;
  cy = text('Acknowledgments Statement', { x: MARGIN + PAD, y: cy, size: 28, font: bold, width: W - MARGIN * 2 - PAD * 2, color: HEAD });
  text(
    'Independently developed and self-funded, with no institutional, laboratory, or commercial sponsorship. With the prototype complete and independently validated, the author welcomes research partners, pilot deployment sites, and sponsorship to carry it to production readiness.',
    { x: MARGIN + PAD, y: cy - 12, size: 24, width: W - MARGIN * 2 - PAD * 2, color: INK, leading: 1.3 },
  );
}

// ---- write ------------------------------------------------------------------
const out = path.join(ROOT, 'docs', 'SAIF-2026-poster-hajiz.pdf');
fs.writeFileSync(out, await doc.save());
const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`\n  wrote ${path.relative(ROOT, out)}  (${W / 72} x ${H / 72} in, ${kb} KB)`);
console.log(`  QR target: ${REPO}\n`);
