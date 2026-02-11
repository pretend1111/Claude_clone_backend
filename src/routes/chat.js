const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const config = require('../config');
const { getDb } = require('../db/init');
const { getSystemPrompt } = require('../lib/systemPrompt');
const contextManager = require('../lib/contextManager');
const { registry: toolRegistry, executor: toolExecutor } = require('../tools');
const { parseFile, needsParsing, getFormatLabel } = require('../tools/file-parsers');

const router = express.Router();

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
  try {
    const url = `${config.API_BASE_URL}/v1/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.API_KEY,
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
      } else {
        console.error('[Title] No text content in response:', JSON.stringify(data).substring(0, 500));
      }
    } else {
      const errorText = await response.text();
      console.error('[Title] API error:', response.status, errorText);
    }
  } catch (err) {
    console.error('Failed to generate title:', err);
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
    let compactionResult = null;
    try {
      compactionResult = await contextManager.checkAndCompact(conversationId, req.userId);
    } catch (compactErr) {
      console.error('[Context] Compaction check failed:', compactErr);
    }

    // 组装历史消息
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
      parts.push({ type: 'text', text: row.content || '' });
      const attachmentList = attachmentsByMessageId.get(row.id) || [];
      // 如果有非图片附件，添加提示让模型知道这些是用户上传的文件
      const hasDocAttachments = attachmentList.some(a => a.file_type === 'document' || a.file_type === 'text');
      if (hasDocAttachments) {
        parts.push({ type: 'text', text: '\n\n---\n以下是用户上传的文件内容（无需搜索，直接基于文件内容回答）：' });
      }
      for (const attachment of attachmentList) {
        if (attachment.file_type === 'image') {
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

      anthropicMessages.push({ role: row.role, content: parts });
    }

    const prunedMessages = contextManager.pruneMessages(anthropicMessages);

    // === 步骤 A：初始化 ===
    const model = conversation.model || 'claude-opus-4-6-thinking';
    const controller = new AbortController();
    let clientClosed = false;

    const url = `${config.API_BASE_URL}/v1/messages`;
    const systemPrompt = getSystemPrompt();
    const toolDefinitions = toolRegistry.getToolDefinitions();
    const hasTools = toolRegistry.hasTools();
    const hasLocalTools = toolRegistry.hasLocalTools();
    const workingMessages = [...prunedMessages];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // === 步骤 B：设置 SSE 响应头 ===
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

    try {
      // === 步骤 C：判断走流式还是工具循环 ===
      const maxRounds = config.TOOL_LOOP_MAX_ROUNDS || 10;
      let loopRound = 0;
      let needStreamFinal = false;
      // 没有本地工具时跳过非流式工具循环，直接走流式（服务端工具在流式中也能工作）
      const skipToolLoop = !hasLocalTools;

      if (!skipToolLoop) {
        // === 本地工具循环（非流式）===
        while (loopRound < maxRounds) {
          loopRound++;
          if (clientClosed) break;

          const includeTools = hasTools && loopRound < maxRounds;
          const reqBody = {
            model,
            max_tokens: config.MAX_OUTPUT_TOKENS,
            stream: false,
            system: systemPrompt,
            messages: workingMessages,
          };
          if (includeTools) {
            reqBody.tools = toolDefinitions;
          }

          console.log(`[Chat] 工具循环第 ${loopRound} 轮, includeTools=${includeTools}`);

          const loopResponse = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': config.API_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(reqBody),
            signal: controller.signal,
          });

          if (!loopResponse.ok) {
            const errorText = await loopResponse.text();
            console.error(`[Chat] 上游非流式请求失败:`, loopResponse.status, errorText);
            res.write(`data: ${JSON.stringify({ type: 'error', error: '上游接口错误', detail: errorText })}\n\n`);
            break;
          }

          const apiResult = await loopResponse.json();

          if (apiResult.usage) {
            totalInputTokens += apiResult.usage.input_tokens || 0;
            totalOutputTokens += apiResult.usage.output_tokens || 0;
          }

          const stopReason = apiResult.stop_reason;
          const contentBlocks = apiResult.content || [];

          if (stopReason === 'tool_use') {
            // 只处理本地 tool_use，不处理 server_tool_use
            const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use');
            const toolNames = toolUseBlocks.map((b) => b.name);
            console.log(`[Chat] 模型请求工具调用: ${toolNames.join(', ')}`);

            res.write(`data: ${JSON.stringify({
              type: 'status',
              event: 'tool_use',
              tools: toolNames,
            })}\n\n`);

            workingMessages.push({ role: 'assistant', content: contentBlocks });

            const toolResults = await toolExecutor.executeAll(toolUseBlocks);

            res.write(`data: ${JSON.stringify({
              type: 'status',
              event: 'tool_result',
              results: toolResults.map((r) => ({
                tool_use_id: r.tool_use_id,
                is_error: r.is_error || false,
              })),
            })}\n\n`);

            workingMessages.push({ role: 'user', content: toolResults });
            continue;
          }

          // end_turn 或其他
          if (loopRound === 1) {
            emitNonStreamAsSSE(res, apiResult);
            for (const block of contentBlocks) {
              if (block.type === 'text') {
                assistantMessage += block.text;
              }
            }
            usageData = { input_tokens: totalInputTokens, output_tokens: totalOutputTokens };
          } else {
            needStreamFinal = true;
          }
          break;
        }
      }

      // === 步骤 D：流式请求 ===
      // skipToolLoop=true 时直接走这里；工具循环后 needStreamFinal=true 也走这里
      if ((skipToolLoop || needStreamFinal) && !clientClosed) {
        const streamBody = {
          model,
          max_tokens: config.MAX_OUTPUT_TOKENS,
          stream: true,
          system: systemPrompt,
          messages: workingMessages,
        };
        // 流式请求也带 tools（让服务端工具生效）
        if (hasTools) {
          streamBody.tools = toolDefinitions;
        }

        console.log('[Chat] 发起流式请求, hasTools=%s, skipToolLoop=%s', hasTools, skipToolLoop);

        const streamResponse = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': config.API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(streamBody),
          signal: controller.signal,
        });

        if (!streamResponse.ok) {
          const errorText = await streamResponse.text();
          console.error('[Chat] 流式请求失败:', streamResponse.status, errorText);
          res.write(`data: ${JSON.stringify({ type: 'error', error: '上游接口错误', detail: errorText })}\n\n`);
        } else if (streamResponse.body) {
          const reader = streamResponse.body.getReader();
          const decoder = new TextDecoder();
          let sseBuffer = '';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (clientClosed) break;

              if (value) {
                res.write(value);

                sseBuffer += decoder.decode(value, { stream: true });
                // 按完整行切分，保留不完整的最后一行
                const parts = sseBuffer.split('\n');
                sseBuffer = parts.pop() || '';

                for (const line of parts) {
                  if (!line.startsWith('data: ')) continue;
                  const data = line.slice(6).trim();
                  if (data === '[DONE]') continue;
                  try {
                    const parsed = JSON.parse(data);
                    if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.type === 'text_delta') {
                      assistantMessage += parsed.delta.text;
                    }
                    if (parsed.type === 'message_delta' && parsed.usage) {
                      totalInputTokens += parsed.usage.input_tokens || 0;
                      totalOutputTokens += parsed.usage.output_tokens || 0;
                    }
                    // 服务端工具：检测 server_tool_use block 开始，发送搜索状态通知
                    if (parsed.type === 'content_block_start' && parsed.content_block && parsed.content_block.type === 'server_tool_use') {
                      const query = (parsed.content_block.input && parsed.content_block.input.query) || '';
                      res.write(`data: ${JSON.stringify({
                        type: 'status',
                        message: `正在搜索：${query}`,
                      })}\n\n`);
                    }
                    // 搜索结果：提取 citations 来源信息，发送给前端
                    if (parsed.type === 'content_block_start' && parsed.content_block && parsed.content_block.type === 'web_search_tool_result') {
                      const searchResults = parsed.content_block.content;
                      if (Array.isArray(searchResults)) {
                        const sources = searchResults
                          .filter((r) => r.type === 'web_search_result')
                          .map((r) => ({ url: r.url, title: r.title }));
                        if (sources.length > 0) {
                          res.write(`data: ${JSON.stringify({
                            type: 'search_sources',
                            sources,
                          })}\n\n`);
                        }
                      }
                    }
                  } catch (e) {
                    // ignore parse error
                  }
                }
              }
            }
          } finally {
            try { reader.releaseLock(); } catch (e) { }
          }
        }
        usageData = { input_tokens: totalInputTokens, output_tokens: totalOutputTokens };
      }
    } finally {
      // === 步骤 E：保存到数据库 ===
      res.end();

      if (assistantMessage) {
        try {
          const msgId = uuidv4();
          db.prepare(
            'INSERT INTO messages (id, conversation_id, role, content, has_attachments) VALUES (?, ?, ?, ?, ?)'
          ).run(msgId, conversationId, 'assistant', assistantMessage, 0);

          if (usageData) {
            contextManager.saveTokenUsage(msgId, messageId, usageData);
            contextManager.updateUserTokenUsage(req.userId, usageData.input_tokens || 0, usageData.output_tokens || 0);
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
    if (err && err.name === 'AbortError') {
      return undefined;
    }
    return next(err);
  }
});

/**
 * 将非流式 API 响应转为 SSE 事件发送给客户端
 */
function emitNonStreamAsSSE(res, apiResult) {
  const contentBlocks = apiResult.content || [];

  // message_start
  res.write(`data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: apiResult.id,
      type: 'message',
      role: 'assistant',
      model: apiResult.model,
    },
  })}\n\n`);

  // 逐个 content block
  for (let i = 0; i < contentBlocks.length; i++) {
    const block = contentBlocks[i];

    if (block.type === 'thinking') {
      res.write(`data: ${JSON.stringify({
        type: 'content_block_start',
        index: i,
        content_block: { type: 'thinking', thinking: '' },
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'content_block_delta',
        index: i,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'content_block_stop',
        index: i,
      })}\n\n`);
    } else if (block.type === 'server_tool_use') {
      // 服务端工具调用 — 发送搜索状态通知
      const query = (block.input && block.input.query) || '';
      res.write(`data: ${JSON.stringify({
        type: 'status',
        message: `正在搜索：${query}`,
      })}\n\n`);
    } else if (block.type === 'web_search_tool_result') {
      // 搜索结果 — 不发给前端，模型会自己消化
    } else if (block.type === 'text') {
      res.write(`data: ${JSON.stringify({
        type: 'content_block_start',
        index: i,
        content_block: { type: 'text', text: '' },
      })}\n\n`);
      // 带 citations 的 text block，将 citations 放入 delta 透传
      const delta = { type: 'text_delta', text: block.text };
      if (block.citations) {
        delta.citations = block.citations;
      }
      res.write(`data: ${JSON.stringify({
        type: 'content_block_delta',
        index: i,
        delta,
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'content_block_stop',
        index: i,
      })}\n\n`);
    }
  }

  // message_delta with usage
  res.write(`data: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: apiResult.usage || {},
  })}\n\n`);

  // message_stop
  res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
}

module.exports = router;
