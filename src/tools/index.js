const registry = require('./registry');
const executor = require('./executor');

// 注册服务端工具（Anthropic 服务端执行，不需要本地 execute）
registry.registerServerTool({
  type: 'web_search_20250305',
  name: 'web_search',
});

console.log(`[Tools] 已注册 ${registry.getToolNames().length} 个工具: ${registry.getToolNames().join(', ') || '无'}`);

module.exports = {
  registry,
  executor,
};
