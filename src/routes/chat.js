const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const config = require('../config');
const { getDb } = require('../db/init');

const router = express.Router();

const TOKEN_LIMIT = 80000;
const MIN_KEEP_MESSAGES = 20; // 10 轮（user+assistant）
const IMAGE_TOKEN_ESTIMATE = 1000;

function estimateTextTokens(text) {
  if (!text) return 0;

  const str = String(text);
  const chineseChars = (str.match(/[\u4e00-\u9fff]/g) || []).length;
  const englishWords = (str.match(/\b[\p{L}\p{N}]+\b/gu) || []).length;
  return chineseChars * 2 + englishWords;
}

function estimateContentTokens(content) {
  if (typeof content === 'string') {
    return estimateTextTokens(content);
  }

  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      total += estimateTextTokens(part.text);
      continue;
    }
    if (part.type === 'image') {
      total += IMAGE_TOKEN_ESTIMATE;
    }
  }

  return total;
}

function pruneAnthropicMessages(messages) {
  const enriched = messages.map((msg) => ({ ...msg, _tokens: estimateContentTokens(msg.content) }));
  let total = enriched.reduce((sum, msg) => sum + msg._tokens, 0);

  while (enriched.length > MIN_KEEP_MESSAGES && total > TOKEN_LIMIT) {
    const removed = enriched.shift();
    total -= removed._tokens;
  }

  return enriched.map(({ _tokens, ...msg }) => msg);
}

function getExtFromMediaType(mediaType, fileName) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };

  if (mediaType && map[mediaType]) return map[mediaType];
  if (typeof fileName === 'string') {
    const ext = path.extname(fileName).replace('.', '').toLowerCase();
    if (ext) return ext;
  }
  return 'bin';
}

function stripDataUrlPrefix(base64) {
  if (typeof base64 !== 'string') return '';
  const idx = base64.indexOf(',');
  if (base64.startsWith('data:') && idx !== -1) {
    return base64.slice(idx + 1);
  }
  return base64;
}

function safeReadFileBase64(filePath) {
  try {
    return fs.readFileSync(filePath).toString('base64');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

router.post('/', async (req, res, next) => {
  const { conversation_id: conversationId, message, attachments } = req.body || {};

  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    return res.status(400).json({ error: 'conversation_id 不能为空' });
  }
  if (typeof message !== 'string') {
    return res.status(400).json({ error: 'message 参数错误' });
  }

  const db = getDb();

  try {
    const conversation = db
      .prepare('SELECT id, user_id, model FROM conversations WHERE id = ?')
      .get(conversationId);

    if (!conversation) {
      return res.status(404).json({ error: '对话不存在' });
    }
    if (conversation.user_id !== req.userId) {
      return res.status(403).json({ error: '无权访问该对话' });
    }

    const user = db
      .prepare('SELECT token_used, token_quota, storage_used, storage_quota FROM users WHERE id = ?')
      .get(req.userId);

    if (!user) {
      return res.status(401).json({ error: '用户不存在' });
    }

    if (Number(user.token_used) >= Number(user.token_quota)) {
      return res.status(429).json({ error: '配额已用完' });
    }

    const normalizedAttachments = Array.isArray(attachments) ? attachments : [];
    const preparedAttachments = [];
    let totalUploadSize = 0;

    for (const item of normalizedAttachments) {
      if (!item || typeof item !== 'object') {
        return res.status(400).json({ error: 'attachments 参数错误' });
      }
      if (item.type !== 'image') {
        return res.status(400).json({ error: '仅支持 image 附件' });
      }
      if (typeof item.media_type !== 'string' || !item.media_type.startsWith('image/')) {
        return res.status(400).json({ error: 'media_type 参数错误' });
      }
      if (typeof item.data !== 'string' || item.data.length === 0) {
        return res.status(400).json({ error: 'data 参数错误' });
      }

      const raw = stripDataUrlPrefix(item.data);
      const buffer = Buffer.from(raw, 'base64');
      if (!buffer || buffer.length === 0) {
        return res.status(400).json({ error: '附件数据解码失败' });
      }

      totalUploadSize += buffer.length;
      preparedAttachments.push({
        file_type: 'image',
        file_name: typeof item.file_name === 'string' ? item.file_name : 'image',
        mime_type: item.media_type,
        buffer,
      });
    }

    const currentStorageUsed = Number(user.storage_used) || 0;
    const storageQuota = Number(user.storage_quota) || 0;
    if (preparedAttachments.length > 0 && currentStorageUsed + totalUploadSize > storageQuota) {
      return res.status(413).json({ error: '存储空间不足' });
    }

    const dataDir = path.join(__dirname, '..', '..', 'data');
    const uploadsDir = path.join(dataDir, 'uploads');
    const userUploadsDir = path.join(uploadsDir, req.userId);
    fs.mkdirSync(userUploadsDir, { recursive: true });

    const writtenFiles = [];
    for (const attachment of preparedAttachments) {
      const ext = getExtFromMediaType(attachment.mime_type, attachment.file_name);
      const filename = `${uuidv4()}.${ext}`;
      const filePath = path.join(userUploadsDir, filename);
      fs.writeFileSync(filePath, attachment.buffer);
      writtenFiles.push(filePath);
      attachment.file_path = filePath;
      attachment.file_size = attachment.buffer.length;
      delete attachment.buffer;
    }

    const messageId = uuidv4();
    const hasAttachments = preparedAttachments.length > 0 ? 1 : 0;

    try {
      const tx = db.transaction(() => {
        db.prepare(
          'INSERT INTO messages (id, conversation_id, role, content, has_attachments) VALUES (?, ?, ?, ?, ?)'
        ).run(messageId, conversationId, 'user', message, hasAttachments);

        db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);

        for (const attachment of preparedAttachments) {
          db.prepare(
            `
              INSERT INTO attachments (
                message_id, user_id, file_type, file_name, file_path, file_size, mime_type
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `
          ).run(
            messageId,
            req.userId,
            attachment.file_type,
            attachment.file_name,
            attachment.file_path,
            attachment.file_size,
            attachment.mime_type
          );
        }

        if (preparedAttachments.length > 0) {
          db.prepare(
            `
              UPDATE users
              SET storage_used = storage_used + ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `
          ).run(totalUploadSize, req.userId);
        }
      });

      tx();
    } catch (err) {
      for (const filePath of writtenFiles) {
        try {
          fs.unlinkSync(filePath);
        } catch (unlinkErr) {
          if (!unlinkErr || unlinkErr.code !== 'ENOENT') {
            // ignore
          }
        }
      }
      throw err;
    }

    // 组装历史消息
    const historyMessages = db
      .prepare(
        `
          SELECT id, role, content, has_attachments, created_at
          FROM messages
          WHERE conversation_id = ?
          ORDER BY created_at ASC
        `
      )
      .all(conversationId);

    const messageIdsNeedingAttachments = historyMessages
      .filter((row) => row.has_attachments === 1)
      .map((row) => row.id);

    const attachmentsByMessageId = new Map();
    if (messageIdsNeedingAttachments.length > 0) {
      const placeholders = messageIdsNeedingAttachments.map(() => '?').join(',');
      const attachmentRows = db
        .prepare(
          `
            SELECT message_id, file_path, mime_type
            FROM attachments
            WHERE message_id IN (${placeholders})
            ORDER BY created_at ASC
          `
        )
        .all(...messageIdsNeedingAttachments);

      for (const row of attachmentRows) {
        if (!attachmentsByMessageId.has(row.message_id)) {
          attachmentsByMessageId.set(row.message_id, []);
        }
        attachmentsByMessageId.get(row.message_id).push({
          file_path: row.file_path,
          mime_type: row.mime_type,
        });
      }
    }

    const anthropicMessages = [];
    for (const row of historyMessages) {
      if (row.has_attachments !== 1) {
        anthropicMessages.push({ role: row.role, content: row.content || '' });
        continue;
      }

      const parts = [];
      parts.push({ type: 'text', text: row.content || '' });
      const attachmentList = attachmentsByMessageId.get(row.id) || [];
      for (const attachment of attachmentList) {
        const base64 = safeReadFileBase64(attachment.file_path);
        if (!base64) continue;
        parts.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: attachment.mime_type,
            data: base64,
          },
        });
      }

      anthropicMessages.push({ role: row.role, content: parts });
    }

    const prunedMessages = pruneAnthropicMessages(anthropicMessages);

    const model = conversation.model || 'claude-opus-4-6-thinking';
    const controller = new AbortController();
    let clientClosed = false;

    const url = `${config.API_BASE_URL}/v1/messages`;
    const body = JSON.stringify({
      model,
      max_tokens: 4096,
      stream: true,
      messages: prunedMessages,
    });

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body,
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const errorText = await upstream.text();
      return res.status(502).json({ error: '上游接口错误', detail: errorText });
    }

    if (!upstream.body) {
      return res.status(502).json({ error: '上游接口无响应体' });
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // 只在已经开始 SSE 输出后才监听 close，避免等待上游响应期间误触发 abort
    req.on('close', () => {
      clientClosed = true;
      controller.abort();
    });

    const reader = upstream.body.getReader();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (clientClosed) break;
        if (!value) continue;

        const ok = res.write(Buffer.from(value));
        if (!ok) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (err) {
        // ignore
      }
      res.end();
    }

    return undefined;
  } catch (err) {
    console.error('[chat] error', err);
    if (err && err.name === 'AbortError') {
      return undefined;
    }
    return next(err);
  }
});

module.exports = router;
