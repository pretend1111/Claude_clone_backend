const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const { XMLParser } = require('fast-xml-parser');

const MAX_TEXT_LENGTH = 100000;

/**
 * 从 XML 节点中递归提取所有文本
 */
function extractText(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';

  // a:t 是 PPTX 中的文本节点
  if (node['a:t'] !== undefined) {
    const t = node['a:t'];
    return typeof t === 'string' ? t : (typeof t === 'number' ? String(t) : '');
  }

  let text = '';
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        text += extractText(item);
      }
    } else {
      text += extractText(child);
    }
  }
  return text;
}

/**
 * 解析 .pptx 文件
 * @param {string} filePath
 * @returns {Promise<{text: string, metadata: object}>}
 */
async function parsePptx(filePath) {
  try {
    const directory = await unzipper.Open.file(filePath);
    const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: false });

    // 找到所有 slide 文件并排序
    const slideFiles = directory.files
      .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f.path))
      .sort((a, b) => {
        const numA = parseInt(a.path.match(/slide(\d+)/)[1]);
        const numB = parseInt(b.path.match(/slide(\d+)/)[1]);
        return numA - numB;
      });

    const slides = [];
    let imageCount = 0;

    for (let i = 0; i < slideFiles.length; i++) {
      const buf = await slideFiles[i].buffer();
      const xml = buf.toString('utf-8');
      const parsed = parser.parse(xml);

      // 提取文本
      const slideText = extractText(parsed).trim();
      // 粗略统计图片引用
      const imgMatches = xml.match(/<a:blip/gi) || [];
      imageCount += imgMatches.length;

      if (slideText) {
        slides.push(`## 第 ${i + 1} 页\n\n${slideText}`);
      } else {
        slides.push(`## 第 ${i + 1} 页\n\n（无文字内容）`);
      }
    }

    let text = slides.join('\n\n');
    if (!text) {
      text = '（空演示文稿，无内容）';
    }

    if (imageCount > 0) {
      text += `\n\n> 注意：演示文稿中包含约 ${imageCount} 张图片，建议转为 PDF 上传以保留图片。`;
    }

    let truncated = false;
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + '\n\n（内容过长，已截取前 100,000 字符）';
      truncated = true;
    }

    return {
      text,
      metadata: {
        format: 'pptx',
        slideCount: slideFiles.length,
        imageCount,
        truncated,
      },
    };
  } catch (err) {
    return {
      text: `[PPTX 解析失败] ${err.message}`,
      metadata: { format: 'pptx', error: err.message },
    };
  }
}

module.exports = { parsePptx };
