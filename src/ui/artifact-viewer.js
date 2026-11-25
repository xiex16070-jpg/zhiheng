import { createArtifactPreview } from './artifact-preview.js';

let saved = localStorage.getItem('csl.theme');
const media = matchMedia('(prefers-color-scheme: dark)');
const theme = () => { document.documentElement.dataset.theme = ['light','dark'].includes(saved) ? saved : media.matches ? 'dark' : 'light'; };
theme(); media.addEventListener('change', theme);
window.addEventListener('storage', event => { if (event.key === 'csl.theme') { saved = event.newValue; theme(); } });
const params = new URLSearchParams(location.search);
const preview = createArtifactPreview({ host: document.getElementById('preview-app'), standalone: true });
if (params.get('path')) preview.open({ path: params.get('path'), workspaceId: params.get('workspace') || 'default' });
else document.getElementById('preview-app').textContent = '请从项目文件或对话产物打开预览。';
window.addEventListener('pagehide', () => preview.destroy(), { once: true });
