const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const config = require('../config');
const { getDb } = require('../db/init');
const { getSystemPrompt } = require('../lib/systemPrompt');
const contextManager = require('../lib/contextManager');
const keyPool = require('../lib/keyPool');
const billing = require('../lib/billing');
const quotaEngine = require('../lib/quotaEngine');
const { registry: toolRegistry, executor: toolExecutor } = require('../tools');
const { parseFile, needsParsing, getFormatLabel } = require('../tools/file-parsers');

const router = express.Router();

async function generateThinkingSummary(thinkingContent) {
  if (!thinkingContent || thinkingContent.length < 50) return null;

  let poolKey = null;
  try {
    poolKey = keyPool.acquire();
    const apiKey = poolKey ? poolKey.api_key : config.API_KEY;
    const baseUrl = poolKey ? poolKey.base_url : config.API_BASE_URL;
    const url = `${baseUrl}/v1/messages`;

    // 截断过长的思考内容以节省 token
    const truncatedThinking = thinkingContent.length > 15000 
      ? thinkingContent.slice(0, 15000) + '...' 
      : thinkingContent;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: `请将以下思考过程总结为一句话（中文，20字以内），描述模型分析了什么或考虑了什么。例如"分析了兼容性问题并诊断了原因"。不要使用"我"或"模型"作为主语，直接以动词开头。不要包含任何标点符号（句号除外）。\n\n思考内容：\n${truncatedThinking}`
          }
        ]
      })
    });

    if (response.ok) {
      const data = await response.json();
      if (data.content && Array.isArray(data.content)) {
        const textBlock = data.content.find((block) => block.type === 'text' && block.text);
        if (textBlock && textBlock.text) {
          return textBlock.text.replace(/^["']|["']$/g, '').trim();
        }
      }
    }
  } catch (err) {
    console.error('Failed to generate thinking summary:', err);
  } finally {
    if (poolKey) keyPool.release(poolKey.id);
  }
  return null;
}

/**
 * 流式请求一轮：实时转发 thinking 事件给前端（spinning logo），
 * 缓冲 text 事件，累积 tool_use，返回完整消息对象。
 * 兼容中转 API（即使 stream:true 也能正常工作）。
 */
async function streamToolRound(res, fetchUrl, fetchHeaders, reqBody, controller, isClientClosed, emitMessageStart, pendingTasks, onThinkingSummary) {
  const bodyStr = JSON.stringify({ ...reqBody, stream: true });
  const _fetchStart = Date.now();
  console.log(`[Chat] streamToolRound: url=${fetchUrl}, bodySize=${Math.round(bodyStr.length/1024)}KB, model=${reqBody.model}`);
  const response = await fetch(fetchUrl, {
    method: 'POST',
    headers: fetchHeaders,
    body: bodyStr,
    signal: controller.signal,
  });
  console.log(`[Chat][Timing] API响应头到达: ${Date.now() - _fetchStart}ms, status=${response.status}`);

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Chat] upstream error: status=${response.status}, body=${errText.substring(0, 300)}`);
    return { ok: false, status: response.status, errorText: errText };
  }

  const message = { id: '', model: '', role: 'assistant', content: [], stop_reason: null, usage: {} };
  const inputAccumulators = {};
  const blockTypeMap = {};
  let messageDeltaEvent = null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let _firstChunk = true;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (_firstChunk && value) {
        console.log(`[Chat][Timing] 首个SSE数据块到达: ${Date.now() - _fetchStart}ms`);
        _firstChunk = false;
      }
      if (done || isClientClosed()) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }

        if (parsed.type === 'message_start' && parsed.message) {
          message.id = parsed.message.id || '';
          message.model = parsed.message.model || '';
          if (parsed.message.usage) Object.assign(message.usage, parsed.message.usage);
          if (emitMessageStart) res.write(`data: ${JSON.stringify(parsed)}\n\n`);
          continue;
        }

        if (parsed.type === 'content_block_start' && parsed.content_block) {
          const idx = parsed.index;
          const block = { ...parsed.content_block };
          const bt = block.type;
          blockTypeMap[idx] = bt;
          if (bt === 'tool_use') { block.input = {}; inputAccumulators[idx] = ''; }
          if (bt === 'thinking') block.thinking = '';
          if (bt === 'text') block.text = '';
          message.content[idx] = block;
          // 实时转发 thinking 和 text
          if (bt === 'thinking' || bt === 'text') res.write(`data: ${JSON.stringify(parsed)}\n\n`);
          continue;
        }

        if (parsed.type === 'content_block_delta' && parsed.delta) {
          const idx = parsed.index;
          const block = message.content[idx];
          if (!block) continue;
          const bt = blockTypeMap[idx];
          if (parsed.delta.type === 'thinking_delta') {
            block.thinking = (block.thinking || '') + (parsed.delta.thinking || '');
          } else if (parsed.delta.type === 'text_delta') {
            block.text = (block.text || '') + (parsed.delta.text || '');
          } else if (parsed.delta.type === 'input_json_delta') {
            inputAccumulators[idx] = (inputAccumulators[idx] || '') + (parsed.delta.partial_json || '');
          }
          if (bt === 'thinking' || bt === 'text') res.write(`data: ${JSON.stringify(parsed)}\n\n`);
          continue;
        }

        if (parsed.type === 'content_block_stop') {
          const idx = parsed.index;
          const bt = blockTypeMap[idx];
          
          // 如果 thinking 块结束，触发摘要生成
          if (bt === 'thinking' && message.content[idx] && message.content[idx].thinking) {
            const thinkingText = message.content[idx].thinking;
            if (pendingTasks) {
              const task = generateThinkingSummary(thinkingText).then(summary => {
                if (summary) {
                  res.write(`data: ${JSON.stringify({ type: 'thinking_summary', summary })}\n\n`);
                  if (onThinkingSummary) onThinkingSummary(summary);
                }
              });
              pendingTasks.push(task);
            }
          }

          if (bt === 'thinking' || bt === 'text') res.write(`data: ${JSON.stringify(parsed)}\n\n`);
          continue;
        }

        if (parsed.type === 'message_delta' && parsed.delta) {
          if (parsed.delta.stop_reason) message.stop_reason = parsed.delta.stop_reason;
          if (parsed.usage) Object.assign(message.usage, parsed.usage);
          messageDeltaEvent = parsed;
          continue;
        }
        // message_stop, ping 等忽略
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  for (const [idx, jsonStr] of Object.entries(inputAccumulators)) {
    if (jsonStr && message.content[idx]) {
      try { message.content[idx].input = JSON.parse(jsonStr); } catch { message.content[idx].input = {}; }
    }
  }
  message.content = message.content.filter(Boolean);
  return { ok: true, message, messageDeltaEvent };
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

async function generateTitle(conversationId, userMsg, assistantMsg) {
  let poolKey = null;
  try {
    poolKey = keyPool.acquire();
    const apiKey = poolKey ? poolKey.api_key : config.API_KEY;
    const baseUrl = poolKey ? poolKey.base_url : config.API_BASE_URL;
    const url = `${baseUrl}/v1/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [
          {
            role: 'user',
            content: `请根据这段对话生成一个简短的标题（最多5-7个字，不要用引号），概括对话的主题而不是直接复制用户的话：\n\n用户：${userMsg}\n助手：${assistantMsg}\n\n标题：`
          }
        ]
      })
    });

    console.log('[Title] API response status:', response.status);

    if (response.ok) {
      const data = await response.json();
      console.log('[Title] API response status:', response.status);

      // 从 content 数组中找到 text 类型的内容（thinking 模型会先返回 thinking block）
      let title = null;
      if (data.content && Array.isArray(data.content)) {
        const textBlock = data.content.find((block) => block.type === 'text' && block.text);
        if (textBlock && textBlock.text) {
          title = textBlock.text.replace(/^["']|["']$/g, '').trim();
        }
      }

      if (title) {
        console.log('[Title] Extracted title:', title);
        const db = getDb();
        db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conversationId);
        console.log(`[Title] Generated for ${conversationId}: ${title}`);
        if (poolKey) keyPool.recordSuccess(poolKey.id, 0, 0);
      } else {
        console.error('[Title] No text content in response:', JSON.stringify(data).substring(0, 500));
      }
    } else {
      const errorText = await response.text();
      console.error('[Title] API error:', response.status, errorText);
      if (poolKey) keyPool.recordError(poolKey.id, `Title API ${response.status}`);
    }
  } catch (err) {
    console.error('Failed to generate title:', err);
    if (poolKey) keyPool.recordError(poolKey.id, err.message);
  } finally {
    if (poolKey) keyPool.release(poolKey.id);
  }
}

router.post('/', async (req, res, next) => {
  const _t0 = Date.now();
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

    // 三层额度检查（总额度 + 窗口 + 周预算）
    console.log(`[Chat][Timing] 验证阶段: ${Date.now() - _t0}ms`);
    const quotaCheck = quotaEngine.checkQuota(req.userId);
    if (!quotaCheck.allowed) {
      return res.status(403).json({ error: quotaCheck.message, code: quotaCheck.reason, quota: quotaCheck.quota });
    }

    const normalizedAttachments = Array.isArray(attachments) ? attachments : [];

    if (normalizedAttachments.length > config.UPLOAD_MAX_FILES_PER_MESSAGE) {
      return res.status(400).json({ error: `每条消息最多 ${config.UPLOAD_MAX_FILES_PER_MESSAGE} 个附件` });
    }

    // 验证 fileId 引用并查询附件信息
    const validatedAttachments = [];
    for (const item of normalizedAttachments) {
      if (!item || typeof item !== 'object' || typeof item.fileId !== 'string') {
        return res.status(400).json({ error: 'attachments 格式错误，需要 { fileId: string }' });
      }
      const att = db
        .prepare('SELECT id, user_id, file_type, file_name, file_path, file_size, mime_type FROM attachments WHERE id = ?')
        .get(item.fileId);
      if (!att) {
        return res.status(404).json({ error: `附件 ${item.fileId} 不存在` });
      }
      if (att.user_id !== req.userId) {
        return res.status(403).json({ error: '无权使用该附件' });
      }
      validatedAttachments.push(att);
    }

    const messageId = uuidv4();
    const hasAttachments = validatedAttachments.length > 0 ? 1 : 0;

    const tx = db.transaction(() => {
      db.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, has_attachments) VALUES (?, ?, ?, ?, ?)'
      ).run(messageId, conversationId, 'user', message, hasAttachments);

      db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);

      for (const att of validatedAttachments) {
        db.prepare('UPDATE attachments SET message_id = ? WHERE id = ?').run(messageId, att.id);
      }
    });

    tx();

    // === 自动 compaction 检查 ===
    console.log(`[Chat][Timing] 消息存储完成: ${Date.now() - _t0}ms`);
    let compactionResult = null;
    try {
      compactionResult = await contextManager.checkAndCompact(conversationId, req.userId);
    } catch (compactErr) {
      console.error('[Context] Compaction check failed:', compactErr);
    }

    // 组装历史消息
    console.log(`[Chat][Timing] compaction检查完成: ${Date.now() - _t0}ms`);
    const historyMessages = db
      .prepare(
        `
          SELECT id, role, content, has_attachments, is_summary, created_at
          FROM messages
          WHERE conversation_id = ? AND compacted = 0
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
            SELECT message_id, file_type, file_name, file_path, mime_type
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
          file_type: row.file_type,
          file_name: row.file_name,
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
      if (row.content && row.content.trim()) {
        parts.push({ type: 'text', text: row.content });
      }
      const attachmentList = attachmentsByMessageId.get(row.id) || [];
      // 如果有非图片附件，添加提示让模型知道这些是用户上传的文件
      const hasDocAttachments = attachmentList.some(a => a.file_type === 'document' || a.file_type === 'text');
      if (hasDocAttachments) {
        parts.push({ type: 'text', text: '\n\n---\n以下是用户上传的文件内容（无需搜索，直接基于文件内容回答）：' });
      }
      for (const attachment of attachmentList) {
        if (attachment.file_type === 'image') {
          const base64 = safeReadFileBase64(attachment.file_path);
          if (!base64) { console.warn(`[Chat] 图片读取失败: ${attachment.file_path}`); continue; }
          console.log(`[Chat] 图片附件: ${attachment.file_name}, base64=${Math.round(base64.length/1024)}KB, mime=${attachment.mime_type}`);
          parts.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: attachment.mime_type,
              data: base64,
            },
          });
        } else if (attachment.file_type === 'document') {
          // PDF → document block；Office 文档 → 解析为文本
          if (needsParsing(attachment.file_path, attachment.mime_type)) {
            try {
              const result = await parseFile(attachment.file_path, attachment.mime_type);
              const label = getFormatLabel(attachment.file_path);
              parts.push({
                type: 'text',
                text: `[附件] 文件名：${attachment.file_name}（${label}）\n\n${result.text}`,
              });
            } catch (e) {
              parts.push({
                type: 'text',
                text: `📄 文件：${attachment.file_name}（解析失败：${e.message}）`,
              });
            }
          } else {
            const base64 = safeReadFileBase64(attachment.file_path);
            if (!base64) continue;
            parts.push({
              type: 'document',
              source: {
                type: 'base64',
                media_type: attachment.mime_type,
                data: base64,
              },
            });
          }
        } else if (attachment.file_type === 'text') {
          try {
            const textContent = fs.readFileSync(attachment.file_path, 'utf-8');
            parts.push({
              type: 'text',
              text: `文件：${attachment.file_name}\n\`\`\`\n${textContent}\n\`\`\``,
            });
          } catch (e) {
            // 文件读取失败，跳过
          }
        }
      }

      // 确保 content 数组中至少有一个 text block（部分中转 API 要求）
      const hasText = parts.some(p => p.type === 'text');
      if (!hasText && parts.length > 0) {
        parts.push({ type: 'text', text: '（用户发送了图片，请查看并等待用户的进一步指示。如果用户没有其他文字说明，简要描述图片内容即可。不要调用任何工具。）' });
      }

      anthropicMessages.push({ role: row.role, content: parts });
    }

    const prunedMessages = contextManager.pruneMessages(anthropicMessages);
    console.log(`[Chat][Timing] 消息组装+附件处理完成: ${Date.now() - _t0}ms, 消息数=${anthropicMessages.length}`);

    // === 图片压缩：中转 API 请求体不能超过约 10MB ===
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB base64 上限
    let totalImageBytes = 0;
    const allImageRefs = []; // { msg, partIndex, data_length }
    for (const msg of prunedMessages) {
      if (!Array.isArray(msg.content)) continue;
      for (let i = 0; i < msg.content.length; i++) {
        const part = msg.content[i];
        if (part.type === 'image' && part.source && part.source.data) {
          totalImageBytes += part.source.data.length;
          allImageRefs.push({ msg, partIndex: i, data_length: part.source.data.length });
        }
      }
    }
    if (totalImageBytes > MAX_IMAGE_BYTES && allImageRefs.length > 0) {
      console.log(`[Chat] 图片总大小 ${Math.round(totalImageBytes/1024)}KB 超限，压缩 ${allImageRefs.length} 张图片...`);
      try {
        const images = allImageRefs.map(ref => {
          const part = ref.msg.content[ref.partIndex];
          return { data: part.source.data, media_type: part.source.media_type };
        });
        const input = JSON.stringify({ images, max_total_bytes: MAX_IMAGE_BYTES });
        const { execFileSync } = require('child_process');
        const output = execFileSync('python3.11', [
          path.join(__dirname, '..', '..', 'scripts', 'compress_images.py')
        ], { input, maxBuffer: 50 * 1024 * 1024, timeout: 30000 });
        const result = JSON.parse(output);
        // 回写压缩后的数据
        for (let i = 0; i < allImageRefs.length; i++) {
          const ref = allImageRefs[i];
          const compressed = result.images[i];
          ref.msg.content[ref.partIndex].source.data = compressed.data;
          ref.msg.content[ref.partIndex].source.media_type = compressed.media_type;
        }
        const newTotal = result.images.reduce((s, img) => s + img.data.length, 0);
        console.log(`[Chat] 图片压缩完成: ${Math.round(totalImageBytes/1024)}KB -> ${Math.round(newTotal/1024)}KB`);
      } catch (err) {
        console.error('[Chat] 图片压缩失败，回退到移除策略:', err.message);
        // 回退：从最早的消息移除图片
        for (const msg of prunedMessages) {
          if (totalImageBytes <= MAX_IMAGE_BYTES) break;
          if (!Array.isArray(msg.content)) continue;
          msg.content = msg.content.filter(part => {
            if (part.type === 'image' && part.source && part.source.data && totalImageBytes > MAX_IMAGE_BYTES) {
              totalImageBytes -= part.source.data.length;
              return false;
            }
            return true;
          });
        }
      }
    }

    // === 步骤 A：初始化 ===
    const model = conversation.model || 'claude-opus-4-6-thinking';
    const controller = new AbortController();
    let clientClosed = false;
    const pendingTasks = []; // 用于追踪异步任务（如 thinking 摘要生成）

    // 从密钥池获取密钥，池为空时回退到 config
    const poolKey = keyPool.acquire(conversationId);
    const activeApiKey = poolKey ? poolKey.api_key : config.API_KEY;
    const activeBaseUrl = poolKey ? poolKey.base_url : config.API_BASE_URL;
    const url = `${activeBaseUrl}/v1/messages`;
    console.log(`[Chat][Timing] 使用密钥: poolKey=${poolKey ? poolKey.id : 'none'}, baseUrl=${activeBaseUrl}, apiKey=${activeApiKey.substring(0, 10)}...`);
    const systemPrompt = getSystemPrompt(req.userId, model);
    const toolDefinitions = toolRegistry.getToolDefinitions();
    const hasTools = toolRegistry.hasTools();
    const workingMessages = [...prunedMessages];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;

    // === 步骤 B：设置 SSE 响应头 ===
    console.log(`[Chat][Timing] 初始化完成，准备发起API请求: ${Date.now() - _t0}ms`);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    if (compactionResult && compactionResult.compacted) {
      res.write(`data: ${JSON.stringify({
        type: 'system',
        event: 'compaction',
        message: '对话历史已自动压缩',
        tokensSaved: compactionResult.tokensSaved,
        messagesCompacted: compactionResult.messagesCompacted,
      })}\n\n`);
    }

    req.on('close', () => {
      clientClosed = true;
      controller.abort();
    });

    let assistantMessage = '';
    let usageData = null;
    let createdDocument = null;
    let thinkingContent = '';
    let thinkingSummary = null;
    let citationSources = [];
    let searchLogs = [];

    try {
      // === 步骤 C：流式工具循环 ===
      const maxRounds = config.TOOL_LOOP_MAX_ROUNDS || 10;
      let loopRound = 0;

      {
        // === 流式工具循环（实时转发 thinking，缓冲 text）===
        const fetchHeaders = {
          'content-type': 'application/json',
          'x-api-key': activeApiKey,
          'anthropic-version': '2023-06-01',
        };

        while (loopRound < maxRounds) {
          loopRound++;
          if (clientClosed) break;

          const includeTools = hasTools && loopRound < maxRounds;
          const reqBody = {
            model,
            max_tokens: config.MAX_OUTPUT_TOKENS,
            system: systemPrompt,
            messages: workingMessages,
            thinking: { type: 'enabled', budget_tokens: config.THINKING_BUDGET_TOKENS },
          };
          if (includeTools) reqBody.tools = toolDefinitions;

          console.log(`[Chat] 工具循环第 ${loopRound} 轮, includeTools=${includeTools}`);
          const _roundStart = Date.now();

          // 带重试的流式请求（502/503 等临时错误自动重试）
          const RETRYABLE_LOOP = new Set([429, 500, 502, 503, 522, 524]);
          let roundResult = null;

          for (let attempt = 0; attempt <= 4; attempt++) {
            if (clientClosed) break;
            if (attempt > 0) {
              const delay = Math.min(2000 * attempt, 8000);
              await new Promise(r => setTimeout(r, delay));
              console.log(`[Chat] 重试 ${attempt}/4, 等待 ${delay}ms`);
            }
            roundResult = await streamToolRound(
              res, url, fetchHeaders, reqBody, controller,
              () => clientClosed, loopRound === 1,
              pendingTasks,
              (summary) => { thinkingSummary = summary; }
            );
            if (roundResult.ok) break;
            console.error(`[Chat] 请求失败 (attempt ${attempt + 1}):`, roundResult.status, (roundResult.errorText || '').substring(0, 200));
            if (!RETRYABLE_LOOP.has(roundResult.status)) break;
          }

          if (!roundResult || !roundResult.ok) {
            if (poolKey && roundResult && roundResult.status !== 400) keyPool.recordError(poolKey.id, `upstream ${roundResult.status}`);
            res.write(`data: ${JSON.stringify({ type: 'error', error: '上游接口错误', detail: roundResult ? roundResult.errorText : '' })}\n\n`);
            break;
          }

          const apiResult = roundResult.message;
          if (apiResult.usage) {
            totalInputTokens += apiResult.usage.input_tokens || 0;
            totalOutputTokens += apiResult.usage.output_tokens || 0;
            totalCacheCreationTokens += apiResult.usage.cache_creation_input_tokens || 0;
            totalCacheReadTokens += apiResult.usage.cache_read_input_tokens || 0;
          }

          const stopReason = apiResult.stop_reason;
          const contentBlocks = apiResult.content || [];

          // 流被中转/上游提前断开（stop_reason 未收到）或 max_tokens 截断
          if (!stopReason || stopReason === 'max_tokens') {
            console.warn(`[Chat] 异常停止: stop_reason=${stopReason}, contentBlocks=${contentBlocks.length}`);
            // 尽量把已有内容刷给前端（text 已实时转发）
            if (roundResult.messageDeltaEvent) {
              res.write(`data: ${JSON.stringify(roundResult.messageDeltaEvent)}\n\n`);
            }
            const reason = !stopReason
              ? '上游连接中断（可能是中转 API 超时），模型思考时间过长导致连接被断开。建议缩短问题复杂度或拆分问题。'
              : '模型输出达到 token 上限，回答被截断。';
            res.write(`data: ${JSON.stringify({ type: 'error', error: reason })}\n\n`);
            // 仍然收集已有文本
            for (const block of contentBlocks) {
              if (block.type === 'text') {
                assistantMessage += block.text.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '');
              }
              if (block.type === 'thinking' && block.thinking) {
                thinkingContent += (thinkingContent ? '\n\n' : '') + block.thinking;
              }
            }
            usageData = { input_tokens: totalInputTokens, output_tokens: totalOutputTokens, cache_creation_tokens: totalCacheCreationTokens, cache_read_tokens: totalCacheReadTokens };
            break;
          }

          if (stopReason === 'tool_use') {
            const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use');
            console.log(`[Chat] 模型请求工具调用: ${toolUseBlocks.map(b => b.name).join(', ')}, API耗时: ${Date.now() - _roundStart}ms`);

            for (const tu of toolUseBlocks) {
              if (tu.name === 'search_internet' && tu.input && tu.input.query) {
                res.write(`data: ${JSON.stringify({ type: 'status', message: `正在搜索：${tu.input.query}` })}\n\n`);
              }
              if (tu.name === 'create_document' && tu.input && tu.input.title) {
                const fmt = tu.input.format || 'markdown';
                const fmtLabel = fmt === 'docx' ? 'Word 文档' : fmt === 'pptx' ? 'PPT 演示文稿' : '文档';
                res.write(`data: ${JSON.stringify({ type: 'status', message: `正在创建${fmtLabel}：${tu.input.title}` })}\n\n`);
              }
            }

            workingMessages.push({ role: 'assistant', content: contentBlocks });
            const toolContext = { userId: req.userId };
            const _toolStart = Date.now();
            const toolResults = await toolExecutor.executeAll(toolUseBlocks, toolContext);
            console.log(`[Chat][Timing] 工具执行耗时: ${Date.now() - _toolStart}ms, 工具: ${toolUseBlocks.map(b => b.name).join(', ')}`);

            for (let i = 0; i < toolResults.length; i++) {
              const tr = toolResults[i];
              const tu = toolUseBlocks[i];

              if (tr._meta && tr._meta.sources && tr._meta.sources.length > 0) {
                const sources = tr._meta.sources;
                const query = (tu.name === 'search_internet') ? tu.input.query : null;
                
                citationSources.push(...sources);
                if (query) {
                  searchLogs.push({ query, results: sources });
                }
                res.write(`data: ${JSON.stringify({ type: 'search_sources', sources, query })}\n\n`);
              }

              if (tr._meta && tr._meta._document) {
                createdDocument = tr._meta._document;
                res.write(`data: ${JSON.stringify({ type: 'document_created', document: tr._meta._document })}\n\n`);
              }
            }

            const cleanResults = toolResults.map(({ _meta, ...rest }) => rest);
            workingMessages.push({ role: 'user', content: cleanResults });
            continue;
          }

          // 兼容中转站自行处理 tool_use 的情况
          // （stop_reason=end_turn 但 contentBlocks 中仍包含 tool_use 块，说明中转站做了搜索但没走标准 tool_use 流程）
          const relayToolBlocks = contentBlocks.filter((b) => b.type === 'tool_use');
          if (relayToolBlocks.length > 0) {
            console.log(`[Chat] 中转站自行处理了工具调用: ${relayToolBlocks.map(b => b.name).join(', ')}`);
            try {
              const toolContext = { userId: req.userId };
              const toolResults = await toolExecutor.executeAll(relayToolBlocks, toolContext);
              for (let i = 0; i < toolResults.length; i++) {
                const tr = toolResults[i];
                const tu = relayToolBlocks[i];
                if (tr._meta && tr._meta.sources && tr._meta.sources.length > 0) {
                  const sources = tr._meta.sources;
                  const query = (tu.name === 'search_internet') ? tu.input.query : null;
                  citationSources.push(...sources);
                  if (query) {
                    searchLogs.push({ query, results: sources });
                  }
                  res.write(`data: ${JSON.stringify({ type: 'search_sources', sources, query })}\n\n`);
                }
                if (tr._meta && tr._meta._document) {
                  createdDocument = tr._meta._document;
                  res.write(`data: ${JSON.stringify({ type: 'document_created', document: tr._meta._document })}\n\n`);
                }
              }
            } catch (e) {
              console.error('[Chat] 中转站工具补偿执行失败:', e.message);
            }
          }

          // end_turn — text 已实时转发，无需额外刷新

          // 发送 message_delta + message_stop
          if (roundResult.messageDeltaEvent) {
            res.write(`data: ${JSON.stringify(roundResult.messageDeltaEvent)}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);

          for (const block of contentBlocks) {
            if (block.type === 'text') {
              assistantMessage += block.text.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '');
            }
            if (block.type === 'thinking' && block.thinking) {
              thinkingContent += (thinkingContent ? '\n\n' : '') + block.thinking;
            }
          }
          usageData = { input_tokens: totalInputTokens, output_tokens: totalOutputTokens, cache_creation_tokens: totalCacheCreationTokens, cache_read_tokens: totalCacheReadTokens };
          break;
        }
      }
    } finally {
      // === 步骤 E：保存到数据库 + 释放密钥池 ===
      
      // 等待所有异步任务完成（如 thinking 摘要）
      if (pendingTasks && pendingTasks.length > 0) {
        try {
          await Promise.all(pendingTasks);
        } catch (e) {
          console.error('[Chat] Error waiting for pending tasks:', e);
        }
      }

      res.end();

      // 释放密钥池并记录结果
      if (poolKey) {
        keyPool.release(poolKey.id);
        if (assistantMessage) {
          keyPool.recordSuccess(poolKey.id, totalInputTokens, totalOutputTokens, totalCacheCreationTokens, totalCacheReadTokens);
        }
      }

      if (assistantMessage) {
        try {
          const msgId = uuidv4();
          const documentJson = createdDocument ? JSON.stringify(createdDocument) : null;
          const thinkingValue = thinkingContent || null;
          const citationsJson = citationSources.length > 0 ? JSON.stringify(citationSources) : null;
          const searchLogsJson = searchLogs.length > 0 ? JSON.stringify(searchLogs) : null;
          db.prepare(
            'INSERT INTO messages (id, conversation_id, role, content, has_attachments, document_json, thinking, thinking_summary, citations_json, search_logs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).run(msgId, conversationId, 'assistant', assistantMessage, 0, documentJson, thinkingValue, thinkingSummary, citationsJson, searchLogsJson);

          if (usageData) {
            contextManager.saveTokenUsage(msgId, messageId, usageData);

            // User quota: always 1x (fair billing regardless of which key)
            const userCost = billing.calculateCost(model, usageData, 1.0);
            const dollarUnits = quotaEngine.recordUsage(req.userId, userCost);

            // Site cost: actual key multiplier (for profit tracking)
            const groupMultiplier = poolKey ? (poolKey.group_multiplier || 1.0) : 1.0;
            const siteCost = billing.calculateCost(model, usageData, groupMultiplier);
            const siteCostUnits = billing.dollarToUnits(siteCost);

            console.log(`[Billing] model=${model}, input=${usageData.input_tokens}, output=${usageData.output_tokens}, cache_create=${usageData.cache_creation_tokens}, cache_read=${usageData.cache_read_tokens}, group=${groupMultiplier}, userCost=$${userCost.toFixed(6)}, siteCost=$${siteCost.toFixed(6)}`);

            if (poolKey && siteCostUnits > 0) {
              keyPool.recordCostUnits(poolKey.id, siteCostUnits);
            }
          }

          db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);

          const count = db.prepare('SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?').get(conversationId).count;
          console.log('[Title] Message count for', conversationId, ':', count);
          if (count <= 2) {
            console.log('[Title] Triggering title generation...');
            generateTitle(conversationId, message, assistantMessage);
          } else {
            console.log('[Title] Skipping title generation, count:', count);
          }
        } catch (dbErr) {
          console.error('Failed to persist assistant message:', dbErr);
        }
      }
    }

    return undefined;
  } catch (err) {
    console.error('[chat] error', err);
    if (poolKey) {
      keyPool.recordError(poolKey.id, err.message || 'unknown');
      keyPool.release(poolKey.id);
    }
    if (err && err.name === 'AbortError') {
      return undefined;
    }
    return next(err);
  }
});

module.exports = router;
