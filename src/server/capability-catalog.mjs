/** Product-facing capability state. Configuration is not a successful service probe. */
export function buildCapabilityCatalog({ schemas = [], browser = false, latex = false,
  extensions = [], learning = true, automaticLearning = true, settingsReadable = true } = {}) {
  const names = new Set(schemas.map(s => s.function?.name).filter(Boolean));
  const has = name => names.has(name);
  const local = name => has(name) ? 'available' : 'disabled';
  const remote = name => has(name) && settingsReadable ? 'configured' : 'needs_setup';
  const connected = extensions.filter(e => e.enabled);
  const browserEnabled = connected.some(e => e.kind === 'browser' && e.tools?.some(t => t.allowed));
  const row = (id, group, title, description, state, note, action, prompt, tools) =>
    ({ id, group, title, description, state, note, action, prompt, tools: tools.filter(n => names.has(n)) });
  const items = [
    row('evidence', 'research', '检索与引用', '查找原文，逐字核对引用，保留证据位置。', local('search_knowledge'), '引用校验不等于所有结论均已完成语义验证。', 'knowledge', '请围绕我的研究问题检索知识库，区分原文事实、推断与尚缺的证据，并给出可定位的引用。', ['search_knowledge','read_source','verify_quote']),
    row('logic', 'research', '中文逻辑验算', '让规则、事实和假设接受可复现的检验。', local('logic_evaluate'), '验算结果取决于输入规则与事实，不替代事实核查。', 'logic', '请把我的问题中的前提和待证结论分开，确认足够事实后用知衡规则验算，并解释未能推出的结论。', ['logic_evaluate','logic_run_assumptions','logic_evaluate_grounded']),
    row('web', 'research', '网站搜索', '获取时效信息，再阅读原始页面。', remote('web_search'), has('web_search') ? '已配置搜索服务；本次打开面板未发起联网测试。' : '在设置中保存搜索服务 Key 后可用。', 'settings-search', '请优先搜索相关官方文档或原始研究，阅读来源正文，注明日期与证据不足的部分。', ['web_search','web_fetch']),
    row('scholar', 'research', '学术文献', '按问题查找论文与开放学术元数据。', has('scholar_search') ? 'configured' : 'disabled', '各文献源可能独立限流；元数据与摘要不能冒充全文。', 'settings-search', '请检索与研究问题相关的学术文献，标明出版时间、预印本状态和能够实际读到的内容。', ['scholar_search']),
    row('conclusions', 'research', '验证结论', '复查对话中沉淀的结论，保留关联原文。', local('search_knowledge'), '候选需回源核对并人工确认；模型复查意见不是事实证明，引用仍须来自原文。', 'knowledge-conclusions', '请检索与问题相关的已确认结论，并回到关联原文核对适用条件；不要把历史总结直接当作证据。', ['search_knowledge','read_source','verify_quote']),
    row('delegate', 'execution', '并行调研', '把可独立的核查交给有界只读子任务。', local('delegate_task'), '子任务不继承写入或审批权限，调用量计入任务预算。团队模型与本机代理需分别配置。', 'settings-teams', '请将这个问题拆成可独立验证的角度，分别委派只读调研，合并证据并指出冲突；不要重复同一检索。', ['delegate_task','ask_user','update_plan']),
    row('background', 'execution', '后台任务', '模型可启动独立任务，并查询进度或取消。', local('start_background_task'), '每次主任务最多启动两个后台任务；仍受项目文件权限与审批约束。', 'activity', '请判断是否有可独立完成的耗时工作，必要时直接启动后台任务，并提供真实进度与最终交付物。', ['start_background_task','get_background_task','cancel_background_task','update_plan','ask_user']),
    row('workspace', 'execution', '项目与文件', '按项目组织会话，预览、搜索和修改文件。', local('read_file'), '默认修改前确认；可信项目可直接写入，只读项目禁止修改。', 'workspace', '请先检查当前项目的文件结构，再列出与我的任务有关的资料；修改前先读取对应内容。', ['read_file','list_files','search_files','find_files','patch_file','write_file']),
    row('commands', 'execution', '命令与进程', '受审批约束的命令执行和有界输出。', local('run_command'), has('run_command') ? '已启用命令执行；工作区路径约束不是操作系统沙箱。' : '在设置的执行环境中开启；每条命令仍遵循审批。', 'settings-commands', '请先说明需要执行的命令和预期结果，再按当前权限发起审批；不要绕过拒绝。', ['run_command','exec_start','exec_write','exec_poll','exec_close']),
    row('office', 'delivery', 'Word · 表格 · 演示', '生成可下载的 DOCX、XLSX 与 PPTX。', local('create_document'), '表格导出为静态值；不运行 Office 宏。', 'workspace', '请根据已核对的资料制作适合交付的文档、表格或演示文件，保留引用清单，并检查生成结果。', ['create_document','read_document']),
    row('pdf', 'delivery', 'PDF 报告', '中文排版、表格与本地图片汇成报告。', browser && has('create_document') ? 'available' : 'needs_setup', browser ? '已检测浏览器排版引擎；生成结果仍需检查。' : '需要安装 Chromium 排版引擎，可先生成 DOCX。', 'settings-extensions', '请依据已核实的内容制作 PDF 报告，加入来源清单，生成后读取或预览检查页数与内容。', ['create_document','read_document']),
    row('pdf-edit', 'delivery', 'PDF 表单与拆合', '查看表单字段，填写或拆分、合并页面。', local('pdf_inspect'), '另存为新文件；不能据此承诺任意改写 PDF 正文。', 'workspace', '请先检查工作区 PDF 的页数和表单字段，再按我的要求填写、拆分或合并，保留原件。', ['pdf_inspect','pdf_fill','pdf_split','pdf_merge']),
    row('visualization', 'delivery', '交互图解', '把证据关系与研究结论放入可展开的图解。', local('create_visualization'), '支持受控 HTML/SVG 和固定交互，不运行任意脚本。', 'workspace', '请把已核验的结论整理为清晰的交互图解，保留来源与限制，只有需要展开的内容使用显隐交互。', ['create_visualization']),
    row('notebook', 'delivery', 'Notebook', '阅读与修订单元源码，保留原始文件。', local('notebook_read'), '不执行代码单元；编辑后会清空旧运行输出。', 'workspace', '请检查工作区 Notebook 的单元结构与数据处理逻辑，指出问题；需要修改时另存并清空旧输出。', ['notebook_read','notebook_edit']),
    row('latex', 'delivery', '数学排版', '通过可信本地引擎编译受限 LaTeX 文档。', latex ? 'configured' : 'needs_setup', latex ? '已检测 Tectonic 文件，尚未执行编译验证。' : '在设置的数学排版中配置 Tectonic 路径并检测引擎。', 'settings-latex', '请先检查 LaTeX 编译是否可用；可用时用安全数学排版子集制作文档，否则采用现有 PDF 报告功能。', ['latex_compile']),
    row('desktop', 'connections', '本机浏览器', '经确认，在本机默认浏览器打开指定网站。', local('desktop_open_url'), '仅派发打开请求；不读取或控制你的桌面，也不声称网页已加载。', 'settings-browser', '请在本机默认浏览器中打开我指定的公开网站，先确认精确 URL。', ['desktop_open_url']),
    row('browser', 'connections', '隔离浏览器', '读取页面、切换标签、下载和打印。', browser && browserEnabled ? 'available' : 'needs_setup', browser && !browserEnabled ? '排版引擎已就绪；请在插件设置中启用浏览器及所需工具。' : '独立浏览器会话，不接管你的桌面或私人登录状态。', 'settings-extensions', '请在隔离浏览器中阅读我指定的公开页面并核对资料，涉及交互或下载时按要求申请审批。', ['list_extensions','extension_tools','call_extension']),
    row('mcp', 'connections', 'MCP 工具与资源', '查询 Context7 版本化技术文档，或连接研究数据库和其他服务。', connected.length ? 'configured' : 'needs_setup', connected.length ? '已启用 ' + connected.length + ' 个插件；具体工具和资源需分别授权。' : '先连接可信 MCP 服务，再启用所需工具或只读资源。', 'settings-extensions', '请查看当前已启用的插件能力，仅使用已授权的工具或资源完成任务；外部结果必须核对来源。', ['list_extensions','extension_tools','call_extension','extension_resources','read_extension_resource']),
    row('vision', 'connections', '图像阅读', '让声明支持视觉的模型阅读工作区图片。', remote('view_image'), '以已保存模型配置为准；尚未验证识图质量。', 'model', '请读取我指定的工作区图片，描述可见内容；无法辨认的细节要明确说明，不要猜测。', ['view_image']),
    row('image', 'connections', '图像创作', '独立配置图像服务，产物保存在工作区。', remote('generate_image'), '生成前需要审批提示词外发与费用，配置不代表服务已实测。', 'settings-image', '请根据我的视觉需求先拟定图像方案，再通过已配置的图像接口生成并保存到工作区。', ['generate_image']),
    row('zotero', 'connections', 'Zotero 文献库', '查询本机条目，导出选定文献的 BibTeX。', remote('zotero_search'), '仅本机只读访问；已启用不代表本机服务正在运行。', 'settings-zotero', '请查询本机 Zotero 中与问题相关的条目，说明实际可获取的内容，按需导出 BibTeX。', ['zotero_search','zotero_export']),
    row('learning', 'execution', '记忆与技能', '确认经验后留存，按实际任务观察技能表现。', ['list_skills','search_history','remember'].some(has) ? 'available' : 'disabled', !learning ? '技能注入和自动审查已关闭；已列出的历史检索与手动记忆仍可使用，记忆需要确认。' : !automaticLearning ? '自动学习审查已关闭；技能读取、历史检索和待确认记忆仍可使用。' : '自动提炼的记忆需要确认；技能统计是关联记录，不是因果结论。', 'learning', '请先查找适用技能与相关历史，再开展任务；值得长期保留的经验请交由我确认。', ['list_skills','skill_view','search_history','remember']),
  ];
  return { version: 1, basis: 'saved_configuration', networkProbed: false,
    note: '基于已保存配置与本机依赖生成，不进行联网探测。实际任务还受模型、研究范围与审批约束。',
    groups: [{ id: 'research', title: '阅读与求证' }, { id: 'execution', title: '计划与执行' }, { id: 'delivery', title: '产物与表达' }, { id: 'connections', title: '连接与扩展' }],
    items, counts: Object.fromEntries(['available','configured','needs_setup','disabled'].map(state => [state, items.filter(i => i.state === state).length])) };
}
