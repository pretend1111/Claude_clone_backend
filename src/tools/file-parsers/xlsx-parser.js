const XLSX = require('xlsx');

const MAX_TEXT_LENGTH = 100000;
const MAX_ROWS_PER_SHEET = 500;

/**
 * 解析 .xlsx 文件，将每个 sheet 转为 Markdown 表格
 * @param {string} filePath
 * @returns {Promise<{text: string, metadata: object}>}
 */
async function parseXlsx(filePath) {
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetNames = workbook.SheetNames;
    const parts = [];
    let totalRows = 0;

    for (const name of sheetNames) {
      const sheet = workbook.Sheets[name];
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      if (!data || data.length === 0) continue;

      const rowCount = data.length;
      totalRows += rowCount;
      const truncated = rowCount > MAX_ROWS_PER_SHEET;
      const rows = truncated ? data.slice(0, MAX_ROWS_PER_SHEET) : data;

      // 构建 Markdown 表格
      const header = rows[0] || [];
      if (header.length === 0) continue;

      const headerRow = '| ' + header.map(c => String(c).replace(/\|/g, '\\|')).join(' | ') + ' |';
      const sepRow = '| ' + header.map(() => '---').join(' | ') + ' |';
      const bodyRows = rows.slice(1).map(row => {
        const cells = header.map((_, i) => String(row[i] ?? '').replace(/\|/g, '\\|'));
        return '| ' + cells.join(' | ') + ' |';
      });

      let sheetText = `## Sheet: ${name}\n\n${headerRow}\n${sepRow}\n${bodyRows.join('\n')}`;
      if (truncated) {
        sheetText += `\n\n...（共 ${rowCount} 行，已截取前 ${MAX_ROWS_PER_SHEET} 行）`;
      }
      parts.push(sheetText);
    }

    let text = parts.join('\n\n');
    if (!text) {
      text = '（空工作簿，无数据）';
    }

    let isTruncated = false;
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + '\n\n（内容过长，已截取前 100,000 字符）';
      isTruncated = true;
    }

    return {
      text,
      metadata: {
        format: 'xlsx',
        sheetCount: sheetNames.length,
        totalRows,
        truncated: isTruncated,
      },
    };
  } catch (err) {
    return {
      text: `[XLSX 解析失败] ${err.message}`,
      metadata: { format: 'xlsx', error: err.message },
    };
  }
}

module.exports = { parseXlsx };
