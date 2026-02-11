const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const config = require('../config');
const { getDb } = require('../db/init');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.UPLOAD_MAX_FILE_SIZE },
});

function classifyFile(mimetype, originalname) {
  if (config.UPLOAD_ALLOWED_IMAGE_TYPES.includes(mimetype)) {
    return 'image';
  }
  if (config.UPLOAD_ALLOWED_DOCUMENT_TYPES.includes(mimetype)) {
    return 'document';
  }
  const ext = path.extname(originalname || '').toLowerCase();
  // 按扩展名兜底判断 Office 文档
  const docExtensions = ['.docx', '.xlsx', '.pptx', '.odt', '.rtf', '.epub'];
  if (docExtensions.includes(ext)) {
    return 'document';
  }
  if (config.UPLOAD_ALLOWED_TEXT_EXTENSIONS.includes(ext)) {
    return 'text';
  }
  // 常见文本 MIME 类型也归为 text
  if (mimetype && (mimetype.startsWith('text/') || mimetype === 'application/json' || mimetype === 'application/xml')) {
    return 'text';
  }
  return null;
}

function getExtFromMime(mimetype, originalname) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf',
  };
  if (map[mimetype]) return map[mimetype];
  const ext = path.extname(originalname || '');
  if (ext) return ext.toLowerCase();
  return '.bin';
}

// POST / — 上传单个文件
router.post('/', upload.single('file'), (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '未提供文件' });
    }

    const { mimetype, originalname, buffer, size } = req.file;
    const fileType = classifyFile(mimetype, originalname);

    if (!fileType) {
      return res.status(400).json({ error: '不支持的文件类型' });
    }

    const db = getDb();
    const user = db
      .prepare('SELECT storage_used, storage_quota FROM users WHERE id = ?')
      .get(req.userId);

    if (!user) {
      return res.status(401).json({ error: '用户不存在' });
    }

    const currentUsed = Number(user.storage_used) || 0;
    const quota = Number(user.storage_quota) || 0;
    if (currentUsed + size > quota) {
      return res.status(413).json({ error: '存储空间不足' });
    }

    // 写入磁盘
    const uploadsDir = path.join(__dirname, '..', '..', 'data', 'uploads', req.userId);
    fs.mkdirSync(uploadsDir, { recursive: true });

    const fileId = uuidv4();
    const ext = getExtFromMime(mimetype, originalname);
    const fileName = `${fileId}${ext}`;
    const filePath = path.join(uploadsDir, fileName);
    fs.writeFileSync(filePath, buffer);

    // 写入数据库
    db.prepare(`
      INSERT INTO attachments (id, message_id, user_id, file_type, file_name, file_path, file_size, mime_type)
      VALUES (?, '', ?, ?, ?, ?, ?, ?)
    `).run(fileId, req.userId, fileType, originalname || fileName, filePath, size, mimetype);

    db.prepare(
      'UPDATE users SET storage_used = storage_used + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(size, req.userId);

    return res.json({
      fileId,
      fileName: originalname || fileName,
      fileType,
      mimeType: mimetype,
      size,
    });
  } catch (err) {
    return next(err);
  }
});

// GET /:fileId/raw — 返回文件二进制流
router.get('/:fileId/raw', (req, res, next) => {
  try {
    const { fileId } = req.params;
    const db = getDb();

    const attachment = db
      .prepare('SELECT file_path, mime_type, file_name, user_id FROM attachments WHERE id = ?')
      .get(fileId);

    if (!attachment) {
      return res.status(404).json({ error: '文件不存在' });
    }
    if (attachment.user_id !== req.userId) {
      return res.status(403).json({ error: '无权访问该文件' });
    }

    if (!fs.existsSync(attachment.file_path)) {
      return res.status(404).json({ error: '文件已被删除' });
    }

    res.setHeader('Content-Type', attachment.mime_type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(attachment.file_name)}"`);

    const stream = fs.createReadStream(attachment.file_path);
    stream.pipe(res);
    return undefined;
  } catch (err) {
    return next(err);
  }
});

// multer 错误处理
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `文件大小超过限制（最大 ${config.UPLOAD_MAX_FILE_SIZE / 1024 / 1024}MB）` });
    }
    return res.status(400).json({ error: err.message });
  }
  return next(err);
});

module.exports = router;
