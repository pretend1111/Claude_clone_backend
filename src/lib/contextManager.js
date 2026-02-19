const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const { getDb } = require('../db/init');

// === getConversationTokenCount ===
function getConversationTokenCount(conversationId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT COUNT(*) as messageCount,
              COALESCE(SUM(input_tokens), 0) as totalInput,
              COALESCE(SUM(output_tokens), 0) as totalOutput
       FROM messages
       WHERE conversation_id = ? AND compacted = 0`
    )
    .get(conversationId);

  return {
    totalTokens: rows.totalInput + rows.totalOutput,
    messageCount: rows.messageCount,
  };
}

// === saveTokenUsage ===
function saveTokenUsage(assistantMessageId, userMessageId, usage) {
  const db = getDb();
  const tx = db.transaction(() => {
    if (usage.input_tokens && userMessageId) {
      db.prepare('UPDATE messages SET input_tokens = ?, cache_creation_tokens = ?, cache_read_tokens = ? WHERE id = ?')
        .run(usage.input_tokens, usage.cache_creation_tokens || 0, usage.cache_read_tokens || 0, userMessageId);
    }
    if (usage.output_tokens && assistantMessageId) {
      db.prepare('UPDATE messages SET output_tokens = ? WHERE id = ?')
        .run(usage.output_tokens, assistantMessageId);
    }
  });
  tx();
}

// === updateUserTokenUsage ===
function updateUserTokenUsage(userId, dollarUnits) {
  const db = getDb();
  if (dollarUnits <= 0) return;
  db.prepare(
    'UPDATE users SET token_used = token_used + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(dollarUnits, userId);
}

// === pruneMessages ===
function pruneMessages(anthropicMessages) {
  if (!anthropicMessages || anthropicMessages.length === 0) return anthropicMessages;

  const pruneEndIndex = anthropicMessages.length - config.PRUNING_AGE_ROUNDS * 2;
  if (pruneEndIndex <= 0) return anthropicMessages;

  return anthropicMessages.map((msg, index) => {
    if (index >= pruneEndIndex) return msg;

    // assistant 消息：截断超长代码块
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      const pruned = pruneCodeBlocks(msg.content);
      return { ...msg, content: pruned };
    }

    // 含图片的消息：替换图片为占位文本
    if (Array.isArray(msg.content)) {
      const prunedParts = msg.content.map((part) => {
        if (part && part.type === 'image') {
          return { type: 'text', text: '[图片已省略]' };
        }
        if (part && part.type === 'text') {
          return { type: 'text', text: pruneCodeBlocks(part.text || '') };
        }
        return part;
      });
      return { ...msg, content: prunedParts };
    }

    return msg;
  });
}

function pruneCodeBlocks(text) {
  if (!text) return text;
  return text.replace(/```[\s\S]*?```/g, (match) => {
    if (match.length <= config.PRUNING_CODE_BLOCK_LIMIT) return match;
    const keepLen = Math.floor(match.length * 0.4);
    return match.slice(0, keepLen) + '\n... [代码已截断] ...\n```';
  });
}

// === 后备 token 估算 ===
function estimateTokensFallback(text) {
  if (!text) return 0;
  const str = String(text);
  let tokens = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) {
      tokens += 1.5;
    } else {
      tokens += 0.3;
    }
  }
  return Math.ceil(tokens);
}

// === checkAndCompact ===
async function checkAndCompact(conversationId, userId) {
  const { totalTokens, messageCount } = getConversationTokenCount(conversationId);

  let effectiveTokenCount = totalTokens;

  // 如果没有 token 数据但有消息，使用后备估算
  if (totalTokens === 0 && messageCount > 0) {
    const db = getDb();
    const messages = db
      .prepare(
        'SELECT content FROM messages WHERE conversation_id = ? AND compacted = 0'
      )
      .all(conversationId);

    effectiveTokenCount = messages.reduce(
      (sum, msg) => sum + estimateTokensFallback(msg.content),
      0
    );
  }

  console.log(
    `[Context] Conversation ${conversationId}: ${effectiveTokenCount} tokens, ${messageCount} messages, trigger: ${config.COMPACTION_TRIGGER}`
  );

  if (effectiveTokenCount < config.COMPACTION_TRIGGER) {
    return { compacted: false };
  }

  return performCompaction(conversationId, userId);
}

// === performCompaction ===
async function performCompaction(conversationId, userId, customInstruction) {
  const db = getDb();

  const allMessages = db
    .prepare(
      `SELECT id, role, content, created_at
       FROM messages
       WHERE conversation_id = ? AND compacted = 0
       ORDER BY created_at ASC`
    )
    .all(conversationId);

  const keepCount = config.COMPACTION_KEEP_ROUNDS * 2;

  if (allMessages.length <= keepCount) {
    return { compacted: false, message: '消息数量不足，无需压缩' };
  }

  const toCompact = allMessages.slice(0, allMessages.length - keepCount);
  const lastCompactedMsg = toCompact[toCompact.length - 1];

  // 组装待压缩文本
  let compactText = '';
  for (const msg of toCompact) {
    const role = msg.role === 'user' ? '用户' : '助手';
    const content =
      msg.content && msg.content.length > 8000
        ? msg.content.slice(0, 8000) + '...[截断]'
        : msg.content || '';
    compactText += `[${role}]: ${content}\n\n`;
  }

  const instruction =
    customInstruction ||
    '请将以下对话历史压缩为一份简洁的摘要，保留关键信息、决策和上下文。摘要应该让读者能够理解对话的完整脉络。用中文回复。';

  const summaryPrompt = `${instruction}\n\n---\n\n${compactText}`;

  // 调用中转 API 生成摘要
  const url = `${config.API_BASE_URL}/v1/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.COMPACTION_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: summaryPrompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Compaction API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  // 从 thinking 模型响应中提取 text 内容
  let summary = '';
  if (data.content && Array.isArray(data.content)) {
    const textBlock = data.content.find(
      (block) => block.type === 'text' && block.text
    );
    if (textBlock) {
      summary = textBlock.text;
    }
  }

  if (!summary) {
    throw new Error('Compaction API returned no text content');
  }

  // 估算节省的 token 数
  const compactedTokens = toCompact.reduce(
    (sum, msg) => sum + (msg.input_tokens || 0) + (msg.output_tokens || 0),
    0
  );
  const summaryTokens = estimateTokensFallback(summary);
  const tokensSaved = compactedTokens > 0 ? compactedTokens - summaryTokens : 0;

  // 数据库事务：标记旧消息 + 插入摘要
  const compactIds = toCompact.map((msg) => msg.id);
  const summaryId = uuidv4();

  const tx = db.transaction(() => {
    for (const id of compactIds) {
      db.prepare('UPDATE messages SET compacted = 1 WHERE id = ?').run(id);
    }

    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, has_attachments, is_summary, compacted, created_at)
       VALUES (?, ?, 'assistant', ?, 0, 1, 0, ?)`
    ).run(summaryId, conversationId, summary, lastCompactedMsg.created_at);
  });

  tx();

  console.log(
    `[Context] Compacted ${compactIds.length} messages for conversation ${conversationId}, saved ~${tokensSaved} tokens`
  );

  return {
    compacted: true,
    summary,
    tokensSaved: Math.max(tokensSaved, 0),
    messagesCompacted: compactIds.length,
  };
}

// === manualCompact ===
async function manualCompact(conversationId, userId, customInstruction) {
  return performCompaction(conversationId, userId, customInstruction);
}

module.exports = {
  getConversationTokenCount,
  checkAndCompact,
  manualCompact,
  pruneMessages,
  saveTokenUsage,
  updateUserTokenUsage,
};
