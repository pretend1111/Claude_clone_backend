const registry = require('./registry');
const executor = require('./executor');
const searxng = require('./searxng');
const { createDocument } = require('./createDocument');

// 注册本地搜索工具（通过 SearXNG 执行搜索）
// 注意：工具名不能用 "web_search"，部分中转 API 会拦截该名称并自行处理
registry.register({
  name: 'search_internet',
  description: '搜索互联网获取实时信息。适用场景：用户询问近期新闻、实时数据、当前价格、最新政策、你不确定或可能已过时的事实。不要用于：常识性问题、历史事实、概念解释等你已经掌握的知识。',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词，保持简短精确，1-6个词',
      },
    },
    required: ['query'],
  },
  async execute(input) {
    const query = input.query || '';
    if (!query) return { content: '搜索关键词为空。', sources: [] };
    const raw = await searxng.callSearxng(query);
    return {
      content: searxng.formatSearchResults(raw),
      sources: searxng.extractSources(raw),
    };
  },
});

// 注册文档创建工具（支持 markdown / docx / pptx / xlsx / pdf）
registry.register({
  name: 'create_document',
  description: '创建文档。支持五种格式：markdown（默认）、docx（Word）、pptx（PowerPoint）、xlsx（Excel）、pdf。当用户要求撰写、起草、生成完整文档时使用。markdown/docx 需提供 content；pptx 需提供 slides 数组；xlsx 需提供 sheets 数组；pdf 需提供 sections 数组。',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: '文档标题',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'docx', 'pptx', 'xlsx', 'pdf'],
        description: '文档格式。默认 markdown。用户要求 Word 时用 docx，PPT 用 pptx，Excel/表格 用 xlsx，PDF 用 pdf。',
      },
      content: {
        type: 'string',
        description: '文档的完整 Markdown 内容（markdown 和 docx 格式必填）',
      },
      colorScheme: {
        type: 'string',
        description: 'PPTX 配色方案名称。可选值：ocean, forest, sunset, lavender, slate, coral, teal, midnight, rose, emerald, amber, indigo, charcoal, burgundy, steel, professional, warm, minimal',
      },
      slides: {
        type: 'array',
        description: 'PPT 幻灯片数组（pptx 格式必填）',
        items: {
          type: 'object',
          properties: {
            layout: {
              type: 'string',
              enum: ['cover', 'section', 'content', 'two_column', 'summary'],
              description: '幻灯片布局类型。cover=封面页, section=分节过渡页, content=标准内容页(默认), two_column=双栏, summary=总结页',
            },
            title: { type: 'string', description: '幻灯片标题' },
            content: { type: 'string', description: '幻灯片内容，每行一个要点' },
            left_content: { type: 'string', description: '双栏布局左侧内容（two_column 布局用）' },
            right_content: { type: 'string', description: '双栏布局右侧内容（two_column 布局用）' },
            notes: { type: 'string', description: '演讲者备注（可选）' },
          },
          required: ['title'],
        },
      },
      sheets: {
        type: 'array',
        description: 'Excel 工作表数组（xlsx 格式必填）',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '工作表名称' },
            headers: { type: 'array', items: { type: 'string' }, description: '列标题' },
            rows: { type: 'array', items: { type: 'array' }, description: '数据行，每行为数组' },
            columnWidths: { type: 'array', items: { type: 'number' }, description: '列宽数组（可选）' },
            formulas: {
              type: 'array',
              description: 'Excel 公式数组（可选）',
              items: {
                type: 'object',
                properties: {
                  cell: { type: 'string', description: '单元格引用，如 C2' },
                  formula: { type: 'string', description: 'Excel 公式，如 =SUM(A2:B2)' },
                },
              },
            },
          },
          required: ['name', 'headers', 'rows'],
        },
      },
      sections: {
        type: 'array',
        description: 'PDF 内容段落数组（pdf 格式必填）',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['heading', 'paragraph', 'table', 'list', 'pagebreak'],
              description: '段落类型',
            },
            content: { description: '文本内容（heading/paragraph 为字符串，list 为字符串数组）' },
            level: { type: 'number', description: '标题级别 1-3（heading 类型用）' },
            headers: { type: 'array', items: { type: 'string' }, description: '表头（table 类型用）' },
            rows: { type: 'array', items: { type: 'array' }, description: '表格数据行（table 类型用）' },
            ordered: { type: 'boolean', description: '是否有序列表（list 类型用）' },
          },
          required: ['type'],
        },
      },
    },
    required: ['title'],
  },
  async execute(input, context) {
    const doc = await createDocument(input, context);
    return {
      content: '文档已创建',
      _document: doc,
    };
  },
});

console.log(`[Tools] 已注册 ${registry.getToolNames().length} 个工具: ${registry.getToolNames().join(', ') || '无'}`);

module.exports = {
  registry,
  executor,
};
