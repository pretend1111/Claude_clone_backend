const express = require('express');
const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('../tools/createDocument');

const router = express.Router();

// UUID v4 格式校验，防止路径穿越
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EXT_CONFIG = {
  '.md':   { contentType: 'text/markdown; charset=utf-8' },
  '.docx': { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.pptx': { contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  '.xlsx': { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.pdf':  { contentType: 'application/pdf' },
};

/**
 * GET /:docId/raw — 返回文档文件（自动检测 .md / .docx / .pptx）
 */
router.get('/:docId/raw', (req, res) => {
  const { docId } = req.params;

  if (!UUID_RE.test(docId)) {
    return res.status(400).json({ error: '无效的文档 ID' });
  }

  const userId = req.userId;
  const userDir = path.join(DATA_DIR, userId);

  // Try each supported extension
  for (const [ext, cfg] of Object.entries(EXT_CONFIG)) {
    const filePath = path.join(userDir, `${docId}${ext}`);
    if (fs.existsSync(filePath)) {
      res.setHeader('Content-Type', cfg.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${docId}${ext}"`);
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  return res.status(404).json({ error: '文档不存在' });
});

module.exports = router;
