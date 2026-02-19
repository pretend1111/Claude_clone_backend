const mammoth = require('mammoth');

const MAX_TEXT_LENGTH = 100000;

/**
 * 解析 .docx 文件，提取文本内容并保留结构
 * @param {string} filePath
 * @returns {Promise<{text: string, metadata: object}>}
 */
async function parseDocx(filePath) {
  try {
    // 用 mammoth 转为 HTML
    const result = await mammoth.convertToHtml({ path: filePath });
    const html = result.value || '';

    // 统计图片数量
    const imgCount = (html.match(/<img\b/gi) || []).length;

    // HTML → Markdown 风格纯文本
    let text = html;

    // 标题
    text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
    text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
    text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
    text = text.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
    text = text.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n');
    text = text.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n');

    // 表格处理
    text = text.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (match, tableContent) => {
      const rows = [];
      const rowMatches = tableContent.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
      for (const rowHtml of rowMatches) {
        const cells = [];
        const cellMatches = rowHtml.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
        for (const cellHtml of cellMatches) {
          const cellText = cellHtml.replace(/<[^>]+>/g, '').trim();
          cells.push(cellText);
        }
        rows.push(cells);
      }
      if (rows.length === 0) return '';
      const header = '| ' + rows[0].join(' | ') + ' |';
      const separator = '| ' + rows[0].map(() => '---').join(' | ') + ' |';
      const body = rows.slice(1).map(r => '| ' + r.join(' | ') + ' |').join('\n');
      return header + '\n' + separator + '\n' + body + '\n\n';
    });

    // 列表
    text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
    text = text.replace(/<\/?[ou]l[^>]*>/gi, '\n');

    // 段落和换行
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');

    // 加粗和斜体
    text = text.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**');
    text = text.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*');

    // 移除图片标签
    text = text.replace(/<img[^>]*>/gi, '');

    // 移除剩余 HTML 标签
    text = text.replace(/<[^>]+>/g, '');

    // 解码 HTML 实体
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&nbsp;/g, ' ');

    // 清理多余空行
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    // 截断
    let truncated = false;
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + '\n\n（内容过长，已截取前 100,000 字符）';
      truncated = true;
    }

    // 图片提示
    if (imgCount > 0) {
      text += `\n\n> 注意：文档中包含 ${imgCount} 张图片，建议转为 PDF 上传以保留图片。`;
    }

    const warnings = result.messages
      .filter(m => m.type === 'warning')
      .map(m => m.message);

    return {
      text,
      metadata: {
        format: 'docx',
        imageCount: imgCount,
        warnings,
        truncated,
      },
    };
  } catch (err) {
    return {
      text: `[DOCX 解析失败] ${err.message}`,
      metadata: { format: 'docx', error: err.message },
    };
  }
}

module.exports = { parseDocx };
