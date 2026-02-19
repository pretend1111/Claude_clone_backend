const path = require('path');
const { parseDocx } = require('./docx-parser');
const { parseXlsx } = require('./xlsx-parser');
const { parsePptx } = require('./pptx-parser');
const { parseOdt, parseEpub, parseRtf } = require('./other-parser');

// MIME type → 解析器映射
const MIME_PARSERS = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': parseDocx,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': parseXlsx,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': parsePptx,
  'application/vnd.oasis.opendocument.text': parseOdt,
  'application/rtf': parseRtf,
  'application/epub+zip': parseEpub,
};

// 扩展名 → 解析器映射（备用）
const EXT_PARSERS = {
  '.docx': parseDocx,
  '.xlsx': parseXlsx,
  '.pptx': parsePptx,
  '.odt': parseOdt,
  '.rtf': parseRtf,
  '.epub': parseEpub,
};

// 格式说明
const FORMAT_LABELS = {
  '.docx': 'Word 文档',
  '.xlsx': 'Excel 表格',
  '.pptx': 'PowerPoint 演示文稿',
  '.odt': 'OpenDocument 文档',
  '.rtf': 'RTF 文档',
  '.epub': '电子书',
};

/**
 * 判断文件是否需要解析（非纯文本、非图片、非 PDF）
 */
function needsParsing(filePath, mimeType) {
  const ext = path.extname(filePath || '').toLowerCase();
  return !!(MIME_PARSERS[mimeType] || EXT_PARSERS[ext]);
}

/**
 * 获取格式说明标签
 */
function getFormatLabel(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return FORMAT_LABELS[ext] || '文档';
}

/**
 * 统一解析入口
 * @param {string} filePath 文件路径
 * @param {string} mimeType MIME 类型
 * @returns {Promise<{text: string, metadata: object}>}
 */
async function parseFile(filePath, mimeType) {
  const ext = path.extname(filePath || '').toLowerCase();
  const parser = MIME_PARSERS[mimeType] || EXT_PARSERS[ext];

  if (!parser) {
    return {
      text: `[不支持的文档格式: ${ext || mimeType}]`,
      metadata: { error: 'unsupported format' },
    };
  }

  return parser(filePath);
}

module.exports = { parseFile, needsParsing, getFormatLabel };
