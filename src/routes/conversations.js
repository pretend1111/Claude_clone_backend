const express = require('express');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../db/init');

const router = express.Router();

function ensureConversationOwner(conversation, userId, res) {
  if (!conversation) {
    res.status(404).json({ error: '对话不存在' });
    return false;
  }

  if (conversation.user_id !== userId) {
    res.status(403).json({ error: '无权访问该对话' });
    return false;
  }

  return true;
}

router.get('/', (req, res, next) => {
  const db = getDb();
  try {
    const conversations = db
      .prepare(
        `
          SELECT id, title, model, updated_at
          FROM conversations
          WHERE user_id = ?
          ORDER BY updated_at DESC
        `
      )
      .all(req.userId);

    return res.json(conversations);
  } catch (err) {
    return next(err);
  }
});

router.post('/', (req, res, next) => {
  const { title, model } = req.body || {};
  const conversationId = uuidv4();

  const db = getDb();
  try {
    const columns = ['id', 'user_id'];
    const placeholders = ['?', '?'];
    const values = [conversationId, req.userId];

    if (typeof title === 'string') {
      columns.push('title');
      placeholders.push('?');
      values.push(title);
    }

    if (typeof model === 'string') {
      columns.push('model');
      placeholders.push('?');
      values.push(model);
    }

    db.prepare(`INSERT INTO conversations (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`).run(
      ...values
    );

    const conversation = db
      .prepare('SELECT id, title, model, created_at, updated_at FROM conversations WHERE id = ?')
      .get(conversationId);

    return res.json(conversation);
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', (req, res, next) => {
  const { id } = req.params;
  const db = getDb();

  try {
    const conversation = db
      .prepare('SELECT id, user_id, title, model, created_at, updated_at FROM conversations WHERE id = ?')
      .get(id);

    if (!ensureConversationOwner(conversation, req.userId, res)) return undefined;

    const messages = db
      .prepare(
        `
          SELECT id, role, content, has_attachments, created_at
          FROM messages
          WHERE conversation_id = ?
          ORDER BY created_at ASC
        `
      )
      .all(id)
      .map((message) => ({ ...message, attachments: [] }));

    const messageIdsNeedingAttachments = messages
      .filter((message) => message.has_attachments === 1)
      .map((message) => message.id);

    if (messageIdsNeedingAttachments.length > 0) {
      const placeholders = messageIdsNeedingAttachments.map(() => '?').join(',');
      const attachments = db
        .prepare(
          `
            SELECT rowid AS id, message_id, file_type, file_name, file_path, mime_type
            FROM attachments
            WHERE message_id IN (${placeholders})
            ORDER BY created_at ASC
          `
        )
        .all(...messageIdsNeedingAttachments);

      const attachmentsByMessageId = new Map();
      for (const attachment of attachments) {
        if (!attachmentsByMessageId.has(attachment.message_id)) {
          attachmentsByMessageId.set(attachment.message_id, []);
        }
        attachmentsByMessageId.get(attachment.message_id).push({
          id: attachment.id,
          file_type: attachment.file_type,
          file_name: attachment.file_name,
          file_path: attachment.file_path,
          mime_type: attachment.mime_type,
        });
      }

      for (const message of messages) {
        if (message.has_attachments === 1) {
          message.attachments = attachmentsByMessageId.get(message.id) || [];
        }
      }
    }

    const result = {
      id: conversation.id,
      title: conversation.title,
      model: conversation.model,
      created_at: conversation.created_at,
      updated_at: conversation.updated_at,
      messages,
    };

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id', (req, res, next) => {
  const { id } = req.params;
  const { title, model } = req.body || {};

  const updates = [];
  const values = [];

  if (typeof title === 'string') {
    updates.push('title = ?');
    values.push(title);
  }

  if (typeof model === 'string') {
    updates.push('model = ?');
    values.push(model);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: '未提供可更新字段' });
  }

  const db = getDb();

  try {
    const conversation = db
      .prepare('SELECT id, user_id FROM conversations WHERE id = ?')
      .get(id);

    if (!ensureConversationOwner(conversation, req.userId, res)) return undefined;

    db.prepare(
      `
        UPDATE conversations
        SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    ).run(...values, id);

    const updated = db
      .prepare('SELECT id, title, model, created_at, updated_at FROM conversations WHERE id = ?')
      .get(id);

    return res.json(updated);
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  const { id } = req.params;
  const db = getDb();

  try {
    const conversation = db
      .prepare('SELECT id, user_id FROM conversations WHERE id = ?')
      .get(id);

    if (!ensureConversationOwner(conversation, req.userId, res)) return undefined;

    const attachmentRows = db
      .prepare(
        `
          SELECT a.file_path, a.file_size
          FROM attachments a
          JOIN messages m ON a.message_id = m.id
          WHERE m.conversation_id = ?
        `
      )
      .all(id);

    let totalDeletedSize = 0;
    for (const row of attachmentRows) {
      totalDeletedSize += Number(row.file_size) || 0;
      if (!row.file_path) continue;
      try {
        fs.unlinkSync(row.file_path);
      } catch (err) {
        if (!err || err.code !== 'ENOENT') {
          throw err;
        }
      }
    }

    const deleteTx = db.transaction(() => {
      db.prepare(
        `
          DELETE FROM attachments
          WHERE message_id IN (
            SELECT id FROM messages WHERE conversation_id = ?
          )
        `
      ).run(id);

      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
      db.prepare('DELETE FROM conversations WHERE id = ?').run(id);

      db.prepare(
        `
          UPDATE users
          SET storage_used = CASE
            WHEN storage_used - ? < 0 THEN 0
            ELSE storage_used - ?
          END,
          updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `
      ).run(totalDeletedSize, totalDeletedSize, req.userId);
    });

    deleteTx();

    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

