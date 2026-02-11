// 本地工具（需要 execute 函数）
const localToolMap = new Map();
// 服务端工具（Anthropic 服务端执行，如 web_search）
const serverTools = [];

function register(toolDef) {
  if (!toolDef || typeof toolDef.name !== 'string') {
    throw new Error('[Tools] 工具定义缺少 name 字段');
  }
  if (typeof toolDef.execute !== 'function') {
    throw new Error(`[Tools] 工具 "${toolDef.name}" 缺少 execute 函数`);
  }
  if (!toolDef.input_schema || typeof toolDef.input_schema !== 'object') {
    throw new Error(`[Tools] 工具 "${toolDef.name}" 缺少 input_schema`);
  }
  localToolMap.set(toolDef.name, toolDef);
}

function registerServerTool(toolDef) {
  if (!toolDef || typeof toolDef.type !== 'string') {
    throw new Error('[Tools] 服务端工具定义缺少 type 字段');
  }
  if (typeof toolDef.name !== 'string') {
    throw new Error('[Tools] 服务端工具定义缺少 name 字段');
  }
  serverTools.push(toolDef);
}

function getTool(name) {
  return localToolMap.get(name) || null;
}

function getToolDefinitions() {
  const defs = [];
  // 本地工具：name + description + input_schema
  for (const tool of localToolMap.values()) {
    defs.push({
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.input_schema,
    });
  }
  // 服务端工具：原样输出（type + name + 可选参数）
  for (const st of serverTools) {
    defs.push({ ...st });
  }
  return defs;
}

function hasTools() {
  return localToolMap.size > 0 || serverTools.length > 0;
}

function hasLocalTools() {
  return localToolMap.size > 0;
}

function getToolNames() {
  const names = Array.from(localToolMap.keys());
  for (const st of serverTools) {
    names.push(st.name + ' (server)');
  }
  return names;
}

module.exports = {
  register,
  registerServerTool,
  getTool,
  getToolDefinitions,
  hasTools,
  hasLocalTools,
  getToolNames,
};
