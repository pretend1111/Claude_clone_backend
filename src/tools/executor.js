const registry = require('./registry');
const config = require('../config');

function withTimeout(promise, ms, toolName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`工具 "${toolName}" 执行超时 (${ms}ms)`));
    }, ms);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function executeOne(toolUseBlock, context) {
  const { id: toolUseId, name, input } = toolUseBlock;
  const tool = registry.getTool(name);

  if (!tool) {
    console.error(`[Tools] 未找到工具: ${name}`);
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `工具 "${name}" 未注册`,
      is_error: true,
    };
  }

  try {
    const timeout = config.TOOL_EXECUTION_TIMEOUT || 30000;
    const result = await withTimeout(tool.execute(input, context), timeout, name);

    // 支持返回 { content, sources, _document } 或纯字符串
    let content;
    let meta = {};
    if (result && typeof result === 'object' && result.content !== undefined) {
      content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      if (result.sources) meta.sources = result.sources;
      if (result._document) meta._document = result._document;
    } else {
      content = typeof result === 'string' ? result : JSON.stringify(result);
    }

    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content,
      _meta: meta,
    };
  } catch (err) {
    console.error(`[Tools] 工具 "${name}" 执行失败:`, err.message);
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `工具执行失败: ${err.message}。请告知用户文档生成失败并说明原因。`,
      is_error: true,
    };
  }
}

async function executeAll(toolUseBlocks, context) {
  return Promise.all(toolUseBlocks.map((block) => executeOne(block, context)));
}

module.exports = {
  executeOne,
  executeAll,
};
