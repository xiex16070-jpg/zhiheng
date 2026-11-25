/** Shared, non-executable destinations for settings and capability navigation. */
export const CONFIGURATION_SECTIONS = Object.freeze([
  { id: 'overview', label: '常用入口', icon: 'panels', selector: '#configuration-overview' },
  { id: 'appearance', label: '界面外观', icon: 'sun', selector: '#configuration-appearance' },
  { id: 'permissions', label: '项目权限', icon: 'shield', selector: '#settings-file-permissions' },
  { id: 'runtime', label: '执行环境', icon: 'terminal', selector: '#runtime-settings' },
  { id: 'context', label: '上下文', icon: 'layers', selector: '#context-insights' },
  { id: 'teams', label: '智能体团队', icon: 'branch', selector: '#settings-teams-slot' },
  { id: 'judge', label: '独立审核', icon: 'shield', selector: '#judge-settings' },
  { id: 'search', label: '网站与学术', icon: 'search', selector: '#web-search-settings' },
  { id: 'extensions', label: 'MCP 与工具', icon: 'workspace', selector: '#extensions-settings' },
  { id: 'integrations', label: '研究集成', icon: 'learning', selector: '#integration-settings' },
  { id: 'preferences', label: '回答偏好', icon: 'settings', selector: '#settings-preferences-slot' },
].map(Object.freeze));

export const CONFIGURATION_TARGETS = Object.freeze({
  ...Object.fromEntries(CONFIGURATION_SECTIONS.map(item => [item.id, Object.freeze({ section: item.id, selector: item.selector })])),
  commands: Object.freeze({ section: 'runtime', selector: '[data-runtime="execEnabled"]' }),
  processes: Object.freeze({ section: 'runtime', selector: '[data-runtime="sessionEnabled"]' }),
  browser: Object.freeze({ section: 'runtime', selector: '[data-runtime="desktopEnabled"]' }),
  latex: Object.freeze({ section: 'runtime', selector: '#runtime-math' }),
  'context-budget': Object.freeze({ section: 'runtime', selector: '#runtime-context' }),
  joint: Object.freeze({ section: 'preferences', selector: '#joint-settings' }),
  zotero: Object.freeze({ section: 'integrations', selector: '#integration-settings', panel: 'zotero' }),
  image: Object.freeze({ section: 'integrations', selector: '#integration-settings', panel: 'image' }),
  packs: Object.freeze({ section: 'integrations', selector: '#integration-settings', panel: 'packs' }),
});

export function resolveConfigurationSection(id) {
  return Object.hasOwn(CONFIGURATION_TARGETS, id) ? CONFIGURATION_TARGETS[id] : null;
}
