const unzipper = require('unzipper');
const { XMLParser } = require('fast-xml-parser');

const MAX_TEXT_LENGTH = 100000;

/**
 * 从 XML 节点递归提取纯文本
 */
function extractTextFromXml(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  let text = '';
  for (const key of Object.keys(node)) {
    if (key.startsWith('@_')) continue; // 跳过属性
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        text += extractTextFromXml(item);
      }
    } else {
      text += extractTextFromXml(child);
    }
  }
  return text;
}

/**
 * 解析 .odt 文件（OpenDocument Text）
 */
async function parseOdt(filePath) {
  try {
    const directory = await unzipper.Open.file(filePath);
    const contentFile = directory.files.find(f => f.path === 'content.xml');
    if (!contentFile) {
      return { text: '[ODT 解析失败] 未找到 content.xml', metadata: { format: 'odt', error: 'no content.xml' } };
    }

    const buf = await contentFile.buffer();
    const xml = buf.toString('utf-8');
    const parser = new XMLParser({ ignoreAttributes: true, preserveOrder: false });
    const parsed = parser.parse(xml);

    let text = extractTextFromXml(parsed).trim();
    text = text.replace(/\n{3,}/g, '\n\n');

    let truncated = false;
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + '\n\n（内容过长，已截取前 100,000 字符）';
      truncated = true;
    }

    return { text: text || '（空文档）', metadata: { format: 'odt', truncated } };
  } catch (err) {
    return { text: `[ODT 解析失败] ${err.message}`, metadata: { format: 'odt', error: err.message } };
  }
}

/**
 * 解析 .epub 文件
 */
async function parseEpub(filePath) {
  try {
    const directory = await unzipper.Open.file(filePath);
    const parser = new XMLParser({ ignoreAttributes: true, preserveOrder: false });

    // 找到所有 HTML/XHTML 章节文件
    const htmlFiles = directory.files
      .filter(f => /\.(x?html?|htm)$/i.test(f.path) && !f.path.includes('toc'))
      .sort((a, b) => a.path.localeCompare(b.path));

    const chapters = [];
    for (const file of htmlFiles) {
      const buf = await file.buffer();
      let html = buf.toString('utf-8');
      // 简单 HTML → 文本
      html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      html = html.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n## $1\n');
      html = html.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
      html = html.replace(/<br\s*\/?>/gi, '\n');
      html = html.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
      html = html.replace(/<[^>]+>/g, '');
      html = html.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      html = html.replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"');
      html = html.replace(/\n{3,}/g, '\n\n').trim();
      if (html) chapters.push(html);
    }

    let text = chapters.join('\n\n---\n\n');
    if (!text) text = '（空电子书）';

    let truncated = false;
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + '\n\n（内容过长，已截取前 100,000 字符）';
      truncated = true;
    }

    return {
      text,
      metadata: { format: 'epub', chapterCount: chapters.length, truncated },
    };
  } catch (err) {
    return { text: `[EPUB 解析失败] ${err.message}`, metadata: { format: 'epub', error: err.message } };
  }
}

/**
 * 解析 .rtf 文件（简单提取纯文本）
 */
async function parseRtf(filePath) {
  try {
    const fs = require('fs');
    const raw = fs.readFileSync(filePath, 'latin1');

    // 简单 RTF → 纯文本：移除控制字和组
    let text = raw;
    // 移除 RTF header
    text = text.replace(/\{\\fonttbl[\s\S]*?\}/g, '');
    text = text.replace(/\{\\colortbl[\s\S]*?\}/g, '');
    text = text.replace(/\{\\stylesheet[\s\S]*?\}/g, '');
    text = text.replace(/\{\\info[\s\S]*?\}/g, '');
    // 处理换行
    text = text.replace(/\\par\b/g, '\n');
    text = text.replace(/\\line\b/g, '\n');
    text = text.replace(/\\tab\b/g, '\t');
    // 移除控制字
    text = text.replace(/\\[a-z]+\d*\s?/gi, '');
    // 移除花括号
    text = text.replace(/[{}]/g, '');
    // 清理
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    let truncated = false;
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + '\n\n（内容过长，已截取前 100,000 字符）';
      truncated = true;
    }

    return { text: text || '（空文档）', metadata: { format: 'rtf', truncated } };
  } catch (err) {
    return { text: `[RTF 解析失败] ${err.message}`, metadata: { format: 'rtf', error: err.message } };
  }
}

module.exports = { parseOdt, parseEpub, parseRtf };
