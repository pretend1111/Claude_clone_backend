const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');
const { generateDocx, generatePptx } = require('./docGenerators');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'documents');
const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';

/**
 * Call a Python script with JSON input via stdin.
 * @param {string} scriptName - e.g. 'generate_xlsx.py'
 * @param {object} jsonInput
 * @returns {Promise<object>}
 */
function callPythonScript(scriptName, jsonInput) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    const child = execFile(PYTHON_BIN, [scriptPath], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        // Python script may output JSON error to stdout before exiting
        let detail = stderr || err.message;
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) detail = parsed.error;
        } catch {}
        reject(new Error(`Python script error: ${detail}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          reject(new Error(`Python script error: ${result.error}`));
          return;
        }
        resolve(result);
      } catch {
        reject(new Error(`Invalid JSON from Python: ${stdout}`));
      }
    });
    child.stdin.write(JSON.stringify(jsonInput));
    child.stdin.end();
  });
}

/**
 * 创建文档（支持 markdown / docx / pptx / xlsx / pdf）
 */
async function createDocument(input, context) {
  const { title, content, format = 'markdown', slides, colorScheme, sheets, sections } = input;
  const userId = context && context.userId;

  if (!title || typeof title !== 'string') {
    throw new Error('文档标题不能为空');
  }
  if (!userId) {
    throw new Error('缺少用户信息');
  }

  const docId = uuidv4();
  const userDir = path.join(DATA_DIR, userId);
  fs.mkdirSync(userDir, { recursive: true });

  if (format === 'pptx') {
    if (!Array.isArray(slides) || slides.length === 0) {
      throw new Error('PPTX 格式需要提供 slides 数组');
    }
    const buffer = await generatePptx(slides, title, colorScheme);
    const filename = `${docId}.pptx`;
    fs.writeFileSync(path.join(userDir, filename), buffer);
    return {
      id: docId, title, filename, format: 'pptx',
      url: `/api/documents/${docId}/raw`,
      slides, colorScheme,
    };
  }

  if (format === 'xlsx') {
    if (!Array.isArray(sheets) || sheets.length === 0) {
      throw new Error('XLSX 格式需要提供 sheets 数组');
    }
    const filename = `${docId}.xlsx`;
    const outputPath = path.join(userDir, filename);
    await callPythonScript('generate_xlsx.py', { outputPath, title, sheets });
    return {
      id: docId, title, filename, format: 'xlsx',
      url: `/api/documents/${docId}/raw`,
      sheets,
    };
  }

  if (format === 'pdf') {
    if (!Array.isArray(sections) || sections.length === 0) {
      throw new Error('PDF 格式需要提供 sections 数组');
    }
    const filename = `${docId}.pdf`;
    const outputPath = path.join(userDir, filename);
    await callPythonScript('generate_pdf.py', { outputPath, title, sections });
    return {
      id: docId, title, filename, format: 'pdf',
      url: `/api/documents/${docId}/raw`,
      content: sections.map(s => s.content || '').join('\n\n'),
      sections,
    };
  }

  // markdown / docx both require content
  if (!content || typeof content !== 'string') {
    throw new Error('文档内容不能为空');
  }

  if (format === 'docx') {
    const buffer = await generateDocx(content, title);
    const filename = `${docId}.docx`;
    fs.writeFileSync(path.join(userDir, filename), buffer);
    return {
      id: docId,
      title,
      filename,
      format: 'docx',
      url: `/api/documents/${docId}/raw`,
      content,
    };
  }

  // Default: markdown
  const filename = `${docId}.md`;
  fs.writeFileSync(path.join(userDir, filename), content, 'utf-8');
  return {
    id: docId,
    title,
    filename,
    format: 'markdown',
    url: `/api/documents/${docId}/raw`,
    content,
  };
}

module.exports = { createDocument, DATA_DIR };
