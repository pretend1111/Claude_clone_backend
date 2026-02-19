const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle,
  Table: DocxTable, TableRow, TableCell, WidthType, ShadingType,
  Header, Footer, PageNumber, PageBreak: DocxPageBreak,
  ExternalHyperlink, TabStopType, TabStopPosition, Tab,
  TableOfContents, StyleLevel, SectionType,
  convertInchesToTwip, LevelFormat,
} = require('docx');

// ─── 18 PPTX Color Schemes ───────────────────────────────────────────────────
const COLOR_SCHEMES = {
  ocean:       { primary: '1A5276', secondary: '2E86C1', accent: '3498DB', text: 'FFFFFF', background: '1A5276', textDark: '2C3E50' },
  forest:      { primary: '1E8449', secondary: '27AE60', accent: '2ECC71', text: 'FFFFFF', background: '1E8449', textDark: '1B4332' },
  sunset:      { primary: 'E74C3C', secondary: 'E67E22', accent: 'F39C12', text: 'FFFFFF', background: 'E74C3C', textDark: '641E16' },
  lavender:    { primary: '6C3483', secondary: '8E44AD', accent: 'BB8FCE', text: 'FFFFFF', background: '6C3483', textDark: '4A235A' },
  slate:       { primary: '2C3E50', secondary: '34495E', accent: 'D97757', text: 'FFFFFF', background: '2C3E50', textDark: '1C2833' },
  coral:       { primary: 'C0392B', secondary: 'E74C3C', accent: 'F1948A', text: 'FFFFFF', background: 'C0392B', textDark: '641E16' },
  teal:        { primary: '008080', secondary: '20B2AA', accent: '48D1CC', text: 'FFFFFF', background: '008080', textDark: '004D4D' },
  midnight:    { primary: '1B2631', secondary: '2C3E50', accent: '5DADE2', text: 'FFFFFF', background: '1B2631', textDark: '0D1117' },
  rose:        { primary: 'C2185B', secondary: 'E91E63', accent: 'F48FB1', text: 'FFFFFF', background: 'C2185B', textDark: '880E4F' },
  emerald:     { primary: '00695C', secondary: '00897B', accent: '4DB6AC', text: 'FFFFFF', background: '00695C', textDark: '004D40' },
  amber:       { primary: 'FF8F00', secondary: 'FFA000', accent: 'FFD54F', text: 'FFFFFF', background: 'FF8F00', textDark: 'E65100' },
  indigo:      { primary: '283593', secondary: '3949AB', accent: '7986CB', text: 'FFFFFF', background: '283593', textDark: '1A237E' },
  charcoal:    { primary: '37474F', secondary: '546E7A', accent: 'D97757', text: 'FFFFFF', background: '37474F', textDark: '263238' },
  burgundy:    { primary: '7B1FA2', secondary: '9C27B0', accent: 'CE93D8', text: 'FFFFFF', background: '7B1FA2', textDark: '4A148C' },
  steel:       { primary: '455A64', secondary: '607D8B', accent: '90A4AE', text: 'FFFFFF', background: '455A64', textDark: '263238' },
  professional:{ primary: '1565C0', secondary: '1976D2', accent: '42A5F5', text: 'FFFFFF', background: '1565C0', textDark: '0D47A1' },
  warm:        { primary: 'D97757', secondary: 'E8956A', accent: 'F5C6A8', text: 'FFFFFF', background: 'D97757', textDark: '5D3A2A' },
  minimal:     { primary: '424242', secondary: '616161', accent: 'BDBDBD', text: 'FFFFFF', background: '424242', textDark: '212121' },
};

function getScheme(name) {
  return COLOR_SCHEMES[name] || COLOR_SCHEMES.warm;
}

// ─── PPTX Generator ──────────────────────────────────────────────────────────

/**
 * Generate PPTX with 5 layout types and color schemes.
 * @param {Array} slides - slide objects with layout, title, content, etc.
 * @param {string} title - presentation title
 * @param {string} [colorScheme] - color scheme name
 * @returns {Promise<Buffer>}
 */
async function generatePptx(slides, title, colorScheme) {
  const PptxGenJS = require('pptxgenjs');
  const pres = new PptxGenJS();
  pres.title = title || 'Presentation';
  pres.layout = 'LAYOUT_WIDE';

  const c = getScheme(colorScheme);
  const totalSlides = slides.length;

  for (let i = 0; i < totalSlides; i++) {
    const s = slides[i];
    const layout = s.layout || 'content';
    const slide = pres.addSlide();

    if (layout === 'cover') {
      renderCover(slide, pres, s, c, totalSlides);
    } else if (layout === 'section') {
      renderSection(slide, pres, s, c, i, totalSlides);
    } else if (layout === 'two_column') {
      renderTwoColumn(slide, pres, s, c, i, totalSlides);
    } else if (layout === 'summary') {
      renderSummary(slide, pres, s, c, i, totalSlides);
    } else {
      renderContent(slide, pres, s, c, i, totalSlides);
    }

    if (s.notes) slide.addNotes(s.notes);
  }

  return pres.write({ outputType: 'nodebuffer' });
}

function addSlideNumber(slide, idx, total) {
  slide.addText(`${idx + 1} / ${total}`, {
    x: 11.0, y: 6.85, w: 2.0, h: 0.3,
    fontSize: 9, color: '999999', align: 'right', fontFace: 'Arial',
  });
}

function parseBullets(content) {
  if (!content) return [];
  return content.split('\n').filter(l => l.trim()).map(b => b.replace(/^[-*•]\s*/, ''));
}

// ── Cover slide ──
function renderCover(slide, pres, s, c) {
  slide.background = { fill: c.primary };
  // Decorative accent bar
  slide.addShape(pres.ShapeType ? pres.ShapeType.rect : 'rect', {
    x: 0, y: 0, w: '100%', h: 0.08, fill: { color: c.accent },
  });
  // Bottom accent
  slide.addShape(pres.ShapeType ? pres.ShapeType.rect : 'rect', {
    x: 0, y: 7.42, w: '100%', h: 0.08, fill: { color: c.accent },
  });
  // Title
  slide.addText(s.title || '', {
    x: 1.2, y: 2.0, w: 10.8, h: 1.5,
    fontSize: 36, bold: true, color: c.text, fontFace: 'Arial',
    align: 'center', valign: 'middle',
  });
  // Subtitle / content
  if (s.content) {
    slide.addText(s.content.split('\n')[0] || '', {
      x: 2.0, y: 3.6, w: 9.2, h: 0.8,
      fontSize: 18, color: c.accent, fontFace: 'Arial',
      align: 'center', valign: 'middle',
    });
  }
  // Date line
  const dateStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' });
  slide.addText(dateStr, {
    x: 2.0, y: 5.0, w: 9.2, h: 0.5,
    fontSize: 12, color: c.accent, fontFace: 'Arial', align: 'center',
  });
}

// ── Section divider slide ──
function renderSection(slide, pres, s, c, idx, total) {
  slide.background = { fill: c.secondary };
  slide.addShape(pres.ShapeType ? pres.ShapeType.rect : 'rect', {
    x: 1.0, y: 3.2, w: 2.0, h: 0.06, fill: { color: c.accent },
  });
  slide.addText(s.title || '', {
    x: 1.0, y: 1.8, w: 11.2, h: 1.2,
    fontSize: 32, bold: true, color: c.text, fontFace: 'Arial',
  });
  if (s.content) {
    slide.addText(s.content.split('\n')[0] || '', {
      x: 1.0, y: 3.6, w: 11.2, h: 1.0,
      fontSize: 16, color: c.accent, fontFace: 'Arial',
    });
  }
  addSlideNumber(slide, idx, total);
}

// ── Content slide (enhanced default) ──
function renderContent(slide, pres, s, c, idx, total) {
  slide.background = { fill: 'FFFFFF' };
  // Top accent bar
  slide.addShape(pres.ShapeType ? pres.ShapeType.rect : 'rect', {
    x: 0, y: 0, w: '100%', h: 0.06, fill: { color: c.primary },
  });
  // Left accent strip
  slide.addShape(pres.ShapeType ? pres.ShapeType.rect : 'rect', {
    x: 0, y: 0, w: 0.06, h: '100%', fill: { color: c.accent },
  });
  // Title
  slide.addText(s.title || '', {
    x: 0.8, y: 0.4, w: 11.5, h: 0.8,
    fontSize: 28, bold: true, color: c.textDark, fontFace: 'Arial',
  });
  // Underline
  slide.addShape(pres.ShapeType ? pres.ShapeType.rect : 'rect', {
    x: 0.8, y: 1.25, w: 3.0, h: 0.04, fill: { color: c.primary },
  });
  // Bullets
  const bullets = parseBullets(s.content);
  if (bullets.length) {
    const items = bullets.map(b => ({
      text: b,
      options: { fontSize: 16, color: '444444', fontFace: 'Arial', bullet: { code: '2022', color: c.primary }, breakLine: true },
    }));
    slide.addText(items, { x: 0.8, y: 1.6, w: 11.5, h: 4.8, valign: 'top' });
  }
  addSlideNumber(slide, idx, total);
}

// ── Two-column slide ──
function renderTwoColumn(slide, pres, s, c, idx, total) {
  slide.background = { fill: 'FFFFFF' };
  slide.addShape(pres.ShapeType ? pres.ShapeType.rect : 'rect', {
    x: 0, y: 0, w: '100%', h: 0.06, fill: { color: c.primary },
  });
  // Title
  slide.addText(s.title || '', {
    x: 0.8, y: 0.4, w: 11.5, h: 0.8,
    fontSize: 28, bold: true, color: c.textDark, fontFace: 'Arial',
  });
  slide.addShape(pres.ShapeType ? pres.ShapeType.rect : 'rect', {
    x: 0.8, y: 1.25, w: 3.0, h: 0.04, fill: { color: c.primary },
  });

  const leftContent = s.left_content || '';
  const rightContent = s.right_content || '';

  // Left column
  const leftBullets = parseBullets(leftContent);
  if (leftBullets.length) {
    const items = leftBullets.map(b => ({
      text: b,
      options: { fontSize: 14, color: '444444', fontFace: 'Arial', bullet: { code: '2022', color: c.primary }, breakLine: true },
    }));
    slide.addText(items, { x: 0.8, y: 1.6, w: 5.5, h: 4.8, valign: 'top' });
  }
  // Divider
  slide.addShape(pres.ShapeType ? pres.ShapeType.rect : 'rect', {
    x: 6.5, y: 1.6, w: 0.03, h: 4.5, fill: { color: 'DDDDDD' },
  });
  // Right column
  const rightBullets = parseBullets(rightContent);
  if (rightBullets.length) {
    const items = rightBullets.map(b => ({
      text: b,
      options: { fontSize: 14, color: '444444', fontFace: 'Arial', bullet: { code: '2022', color: c.accent }, breakLine: true },
    }));
    slide.addText(items, { x: 6.8, y: 1.6, w: 5.5, h: 4.8, valign: 'top' });
  }
  addSlideNumber(slide, idx, total);
}

// ── Summary slide ──
function renderSummary(slide, pres, s, c, idx, total) {
  slide.background = { fill: c.primary };
  slide.addShape(pres.ShapeType ? pres.ShapeType.rect : 'rect', {
    x: 0, y: 0, w: '100%', h: 0.08, fill: { color: c.accent },
  });
  slide.addText(s.title || 'Summary', {
    x: 1.0, y: 0.6, w: 11.2, h: 1.0,
    fontSize: 30, bold: true, color: c.text, fontFace: 'Arial', align: 'center',
  });
  const bullets = parseBullets(s.content);
  if (bullets.length) {
    const items = bullets.map(b => ({
      text: b,
      options: { fontSize: 18, color: c.accent, fontFace: 'Arial', bullet: { code: '2713', color: c.accent }, breakLine: true, lineSpacing: 36 },
    }));
    slide.addText(items, { x: 1.5, y: 2.0, w: 10.2, h: 4.0, valign: 'top' });
  }
  addSlideNumber(slide, idx, total);
}

// ─── DOCX Generator ──────────────────────────────────────────────────────────

// Design constants
const DOCX_COLORS = {
  primary: '1F3864',    // Deep navy
  secondary: '2E75B6',  // Medium blue
  accent: '4472C4',     // Accent blue
  text: '333333',       // Body text
  lightText: '666666',  // Secondary text
  muted: '999999',      // Muted text
  border: 'D6DCE4',     // Table/line borders
  headerBg: '2E75B6',   // Table header bg
  altRow: 'F2F7FB',     // Alternating row
  codeBg: 'F6F8FA',     // Code background
  quoteBorder: '4472C4',// Blockquote border
  quoteBg: 'EDF2F9',    // Blockquote bg
  coverLine: '2E75B6',  // Cover decorative line
};

const FONT = { body: 'Calibri', heading: 'Calibri Light', mono: 'Consolas' };
const PT = (n) => n * 2; // half-points

/**
 * Custom styles for the document
 */
function buildStyles() {
  return {
    default: {
      document: {
        run: { font: FONT.body, size: PT(11), color: DOCX_COLORS.text },
        paragraph: { spacing: { after: 160, line: 276 } }, // 1.15x line spacing
      },
      heading1: {
        run: { font: FONT.heading, size: PT(20), bold: true, color: DOCX_COLORS.primary },
        paragraph: { spacing: { before: 360, after: 200 } },
      },
      heading2: {
        run: { font: FONT.heading, size: PT(16), bold: true, color: DOCX_COLORS.secondary },
        paragraph: { spacing: { before: 280, after: 160 } },
      },
      heading3: {
        run: { font: FONT.heading, size: PT(13), bold: true, color: DOCX_COLORS.text },
        paragraph: { spacing: { before: 200, after: 120 } },
      },
      heading4: {
        run: { font: FONT.heading, size: PT(11.5), bold: true, italics: true, color: DOCX_COLORS.lightText },
        paragraph: { spacing: { before: 160, after: 100 } },
      },
    },
    paragraphStyles: [
      {
        id: 'CoverTitle',
        name: 'Cover Title',
        basedOn: 'Normal',
        run: { font: FONT.heading, size: PT(32), bold: true, color: DOCX_COLORS.primary },
        paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 120 } },
      },
      {
        id: 'CoverSubtitle',
        name: 'Cover Subtitle',
        basedOn: 'Normal',
        run: { font: FONT.body, size: PT(14), color: DOCX_COLORS.lightText },
        paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 80 } },
      },
      {
        id: 'TOCHeading',
        name: 'TOC Heading',
        basedOn: 'Normal',
        run: { font: FONT.heading, size: PT(16), bold: true, color: DOCX_COLORS.primary },
        paragraph: { spacing: { before: 240, after: 200 } },
      },
    ],
  };
}

/* DOCX_GENERATE_PLACEHOLDER */

/**
 * Parse inline markdown to TextRun array.
 * Supports: **bold**, *italic*, `code`, [link](url), plain text
 */
function parseInlineRuns(text) {
  const runs = [];
  // Match: [text](url), **bold**, *italic*, `code`, plain
  const regex = /(\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|([^[*`]+))/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m[2] && m[3]) {
      // Link
      runs.push(new ExternalHyperlink({
        children: [new TextRun({ text: m[2], color: DOCX_COLORS.accent, underline: { type: 'single' }, font: FONT.body, size: PT(11) })],
        link: m[3],
      }));
    } else if (m[4]) {
      runs.push(new TextRun({ text: m[4], bold: true }));
    } else if (m[5]) {
      runs.push(new TextRun({ text: m[5], italics: true }));
    } else if (m[6]) {
      runs.push(new TextRun({ text: m[6], font: FONT.mono, size: PT(10), shading: { type: ShadingType.CLEAR, fill: DOCX_COLORS.codeBg } }));
    } else if (m[7]) {
      runs.push(new TextRun({ text: m[7] }));
    }
  }
  return runs.length ? runs : [new TextRun({ text })];
}

/**
 * Build cover page paragraphs
 */
function buildCoverPage(title) {
  const dateStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  return [
    // Top spacing
    new Paragraph({ spacing: { before: 3600 } }),
    // Decorative line above title
    new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: DOCX_COLORS.coverLine, space: 8 } },
      spacing: { after: 400 },
      children: [],
    }),
    // Title
    new Paragraph({
      style: 'CoverTitle',
      children: [new TextRun({ text: title || 'Document' })],
    }),
    // Decorative line below title
    new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: DOCX_COLORS.coverLine, space: 8 } },
      spacing: { before: 400, after: 600 },
      children: [],
    }),
    // Date
    new Paragraph({
      style: 'CoverSubtitle',
      children: [new TextRun({ text: dateStr })],
    }),
  ];
}

/**
 * Build header and footer
 */
function buildHeaderFooter(title) {
  const header = new Header({
    children: [
      new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: DOCX_COLORS.border, space: 4 } },
        spacing: { after: 120 },
        children: [
          new TextRun({ text: title || '', font: FONT.body, size: PT(9), color: DOCX_COLORS.muted, italics: true }),
        ],
        alignment: AlignmentType.RIGHT,
      }),
    ],
  });
  const footer = new Footer({
    children: [
      new Paragraph({
        border: { top: { style: BorderStyle.SINGLE, size: 1, color: DOCX_COLORS.border, space: 4 } },
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: '— ', size: PT(9), color: DOCX_COLORS.muted }),
          new TextRun({ children: [PageNumber.CURRENT], size: PT(9), color: DOCX_COLORS.muted }),
          new TextRun({ text: ' —', size: PT(9), color: DOCX_COLORS.muted }),
        ],
      }),
    ],
  });
  return { header, footer };
}

/* DOCX_FLUSH_HELPERS_PLACEHOLDER */

const THIN_BORDER = { style: BorderStyle.SINGLE, size: 1, color: DOCX_COLORS.border };

/**
 * Parse markdown table lines into a DocxTable
 */
function buildMarkdownTable(tableLines) {
  const parsed = tableLines.map(l =>
    l.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
  );
  const headerRow = parsed[0] || [];
  const dataRows = parsed.filter((_, i) => i > 0 && !/^[-:\s]+$/.test(tableLines[i]));

  const rows = [];
  // Header row
  rows.push(new TableRow({
    tableHeader: true,
    children: headerRow.map(h => new TableCell({
      shading: { fill: DOCX_COLORS.headerBg, type: ShadingType.CLEAR },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({
        spacing: { before: 0, after: 0 },
        children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', font: FONT.body, size: PT(10) })],
        alignment: AlignmentType.CENTER,
      })],
      borders: { top: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER },
    })),
  }));
  // Data rows
  dataRows.forEach((row, ri) => {
    rows.push(new TableRow({
      children: headerRow.map((_, ci) => new TableCell({
        shading: ri % 2 === 0 ? { fill: DOCX_COLORS.altRow, type: ShadingType.CLEAR } : {},
        margins: { top: 40, bottom: 40, left: 100, right: 100 },
        children: [new Paragraph({
          spacing: { before: 0, after: 0 },
          children: parseInlineRuns(row[ci] || ''),
        })],
        borders: { top: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER },
      })),
    }));
  });

  if (!rows.length) return null;
  return new DocxTable({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

/**
 * Build a code block paragraph
 */
function buildCodeBlock(codeLines) {
  return new Paragraph({
    border: {
      top: { style: BorderStyle.SINGLE, size: 1, color: DOCX_COLORS.border },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: DOCX_COLORS.border },
      left: { style: BorderStyle.SINGLE, size: 1, color: DOCX_COLORS.border },
      right: { style: BorderStyle.SINGLE, size: 1, color: DOCX_COLORS.border },
    },
    shading: { fill: DOCX_COLORS.codeBg, type: ShadingType.CLEAR },
    spacing: { before: 120, after: 120, line: 260 },
    indent: { left: 200, right: 200 },
    children: codeLines.map((cl, i) => {
      const parts = [new TextRun({ text: cl || ' ', font: FONT.mono, size: PT(9.5), color: DOCX_COLORS.text })];
      if (i < codeLines.length - 1) parts.push(new TextRun({ break: 1 }));
      return parts;
    }).flat(),
  });
}

/**
 * Build blockquote paragraphs
 */
function buildBlockquote(lines) {
  return lines.map(bLine => new Paragraph({
    border: { left: { style: BorderStyle.SINGLE, size: 8, color: DOCX_COLORS.quoteBorder, space: 8 } },
    shading: { fill: DOCX_COLORS.quoteBg, type: ShadingType.CLEAR },
    indent: { left: 300 },
    spacing: { before: 40, after: 40, line: 276 },
    children: [
      new TextRun({ text: bLine, italics: true, color: DOCX_COLORS.lightText, font: FONT.body, size: PT(10.5) }),
    ],
  }));
}

/* DOCX_MAIN_FUNCTION_PLACEHOLDER */

/**
 * Professional Markdown → DOCX conversion.
 * Features: custom styles, cover page, TOC, headers/footers, tables, blockquotes,
 * code blocks, nested lists, links, page breaks.
 */
async function generateDocx(markdownContent, title) {
  const lines = markdownContent.split('\n');
  const bodyChildren = [];
  let inCodeBlock = false;
  let codeLines = [];
  let tableLines = [];
  let inBlockquote = false;
  let blockquoteLines = [];

  function flushCode() {
    if (!codeLines.length) return;
    bodyChildren.push(buildCodeBlock(codeLines));
    codeLines = [];
  }
  function flushQuote() {
    if (!blockquoteLines.length) return;
    bodyChildren.push(...buildBlockquote(blockquoteLines));
    blockquoteLines = [];
  }
  function flushTable() {
    if (!tableLines.length) return;
    const t = buildMarkdownTable(tableLines);
    if (t) {
      bodyChildren.push(new Paragraph({ spacing: { before: 80, after: 0 }, children: [] }));
      bodyChildren.push(t);
      bodyChildren.push(new Paragraph({ spacing: { before: 0, after: 80 }, children: [] }));
    }
    tableLines = [];
  }

  // Detect list indent level: count leading spaces / 2 (or 4)
  function getListLevel(line) {
    const match = line.match(/^(\s*)/);
    const spaces = match ? match[1].length : 0;
    return Math.min(Math.floor(spaces / 2), 4);
  }

  const headingMap = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      if (inBlockquote) flushQuote();
      if (tableLines.length) flushTable();
      if (inCodeBlock) { flushCode(); inCodeBlock = false; }
      else { inCodeBlock = true; }
      continue;
    }
    if (inCodeBlock) { codeLines.push(line); continue; }

    const trimmed = line.trim();

    // Table
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (inBlockquote) flushQuote();
      tableLines.push(trimmed);
      continue;
    } else if (tableLines.length) {
      flushTable();
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      inBlockquote = true;
      blockquoteLines.push(trimmed.replace(/^>\s*/, ''));
      continue;
    } else if (inBlockquote) {
      flushQuote();
      inBlockquote = false;
    }

    // Empty line
    if (!trimmed) {
      bodyChildren.push(new Paragraph({ spacing: { before: 0, after: 80 }, children: [] }));
      continue;
    }

    // Horizontal rule → page break
    if (/^[-*_]{3,}$/.test(trimmed)) {
      bodyChildren.push(new Paragraph({ pageBreakBefore: true, children: [] }));
      continue;
    }

    // Headings
    const hm = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (hm) {
      const lvl = hm[1].length;
      bodyChildren.push(new Paragraph({
        heading: headingMap[lvl],
        children: parseInlineRuns(hm[2]),
      }));
      continue;
    }

    // Unordered list (with nesting)
    const ulm = line.match(/^(\s*)[-*+]\s+(.+)/);
    if (ulm) {
      const level = getListLevel(line);
      bodyChildren.push(new Paragraph({
        bullet: { level },
        spacing: { before: 0, after: 40 },
        children: parseInlineRuns(ulm[2]),
      }));
      continue;
    }

    // Ordered list (with nesting)
    const olm = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olm) {
      const level = getListLevel(line);
      bodyChildren.push(new Paragraph({
        numbering: { reference: 'default-numbering', level },
        spacing: { before: 0, after: 40 },
        children: parseInlineRuns(olm[2]),
      }));
      continue;
    }

    // Normal paragraph
    bodyChildren.push(new Paragraph({ children: parseInlineRuns(trimmed) }));
  }

  // Flush remaining
  if (inCodeBlock) flushCode();
  if (inBlockquote) flushQuote();
  if (tableLines.length) flushTable();

  /* DOCX_ASSEMBLE_PLACEHOLDER */

  // ── Assemble document ──
  const coverChildren = buildCoverPage(title);
  const { header, footer } = buildHeaderFooter(title);

  // TOC section
  const tocChildren = [
    new Paragraph({
      style: 'TOCHeading',
      children: [new TextRun({ text: '目录' })],
    }),
    new TableOfContents('Table of Contents', {
      hyperlink: true,
      headingStyleRange: '1-3',
    }),
  ];

  const pageMargin = {
    top: convertInchesToTwip(1),
    bottom: convertInchesToTwip(0.8),
    left: convertInchesToTwip(1.2),
    right: convertInchesToTwip(1),
  };

  const doc = new Document({
    features: { updateFields: true },
    styles: buildStyles(),
    numbering: {
      config: [{
        reference: 'default-numbering',
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 360, hanging: 360 } } } },
          { level: 1, format: LevelFormat.LOWER_LETTER, text: '%2)', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
          { level: 2, format: LevelFormat.LOWER_ROMAN, text: '%3.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 1080, hanging: 360 } } } },
          { level: 3, format: LevelFormat.DECIMAL, text: '(%4)', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
          { level: 4, format: LevelFormat.LOWER_LETTER, text: '(%5)', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 1800, hanging: 360 } } } },
        ],
      }],
    },
    sections: [
      // Cover page (no header/footer)
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: { margin: pageMargin },
        },
        children: coverChildren,
      },
      // TOC page
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: { margin: pageMargin },
        },
        headers: { default: header },
        footers: { default: footer },
        children: tocChildren,
      },
      // Body
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: { margin: pageMargin },
        },
        headers: { default: header },
        footers: { default: footer },
        children: bodyChildren,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

module.exports = { generateDocx, generatePptx };
