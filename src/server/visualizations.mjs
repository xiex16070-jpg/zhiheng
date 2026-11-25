import crypto from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { writeArtifact } from './workspace.mjs';

export const VISUALIZATION_SCHEMA = { type: 'function', function: {
  name: 'create_visualization',
  description: '创建隔离的 HTML/SVG 可视化产物，用于对比图表、流程和解释。输入正文片段，使用 details/summary 实现展开，button 的 data-toggle 指向区域 id 实现显隐。禁用任意脚本、外部资源、表单和网络；不要提交完整页面。产物保存到工作区并显示预览。',
  parameters: { type: 'object', additionalProperties: false, required: ['title', 'html'], properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 }, html: { type: 'string', minLength: 1, maxLength: 524288 },
    height: { type: 'integer', minimum: 180, maximum: 800 },
  } },
} };

export function visualizationDocument(fragment, title) {
  if (Buffer.byteLength(fragment) > 524288 || /<\s*\/?\s*(?:html|head|body)\b/i.test(fragment)) throw new Error('请提供 512 KiB 以内的正文片段。');
  const content = sanitizeHtml(fragment, {
    allowedTags: ['div','section','article','header','footer','p','h1','h2','h3','h4','span','strong','em','small','br','hr','ul','ol','li','table','thead','tbody','tr','th','td','code','pre','details','summary','button','label','output','svg','g','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','title','desc'],
    allowedAttributes: { '*': ['id','class','aria-label','role','hidden'], button: ['data-toggle','type'], details: ['open'], svg: ['viewBox','width','height','xmlns'],
      g: ['transform','fill','stroke'], path: ['d','fill','stroke','stroke-width'], rect: ['x','y','width','height','rx','fill','stroke'],
      circle: ['cx','cy','r','fill','stroke'], ellipse: ['cx','cy','rx','ry','fill','stroke'], line: ['x1','x2','y1','y2','stroke','stroke-width'],
      polyline: ['points','fill','stroke'], polygon: ['points','fill','stroke'], text: ['x','y','fill','font-size','text-anchor'], tspan: ['x','y','dx','dy'] },
    parser: { lowerCaseAttributeNames: false }, allowedEmptyAttributes: ['hidden', 'open'],
    allowedSchemes: [], allowProtocolRelative: false,
  });
  const nonce = crypto.randomBytes(18).toString('base64');
  const cleanTitle = sanitizeHtml(title, { allowedTags: [], allowedAttributes: {} });
  // No model-authored JS/CSS is executed. Only this fixed, non-networked interaction
  // handler receives a nonce. An opaque sandbox origin adds a second boundary.
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${cleanTitle}</title><style nonce="${nonce}">:root{color-scheme:light dark;font:15px/1.65 system-ui;color:#253e39;background:#f7f6f0}body{margin:0;padding:28px}h1,h2,h3{line-height:1.25}section,article,details{border:1px solid #c9d4cb;border-radius:14px;padding:20px;margin:12px 0}button,summary{cursor:pointer;color:inherit}button{border:1px solid #8ba79c;border-radius:9px;padding:9px 14px;background:transparent}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #c9d4cb;text-align:left}svg{max-width:100%;height:auto}pre{white-space:pre-wrap} .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}.muted{opacity:.7}.accent{color:#87632b}@media(prefers-color-scheme:dark){:root{color:#e7e9de;background:#182b27}}[hidden]{display:none!important}</style></head><body>${content}<script nonce="${nonce}">document.addEventListener('click',e=>{const b=e.target.closest('button[data-toggle]');if(!b)return;const t=document.getElementById(b.dataset.toggle);if(t){t.hidden=!t.hidden;b.setAttribute('aria-expanded',String(!t.hidden))}});</script></body></html>`;
}

export async function createVisualization(args, ctx) {
  const doc = visualizationDocument(args.html, args.title);
  const result = await writeArtifact(ctx.userId, ctx.fileMutationPath || `visualizations/${crypto.randomUUID()}.html`, Buffer.from(doc), { signal: ctx.signal });
  if (!result.ok) throw new Error(result.message);
  return { text: JSON.stringify({ ...result, title: args.title }), summary: '可视化已生成', evidence: [],
    artifact: { kind: 'viz', sha256: crypto.createHash('sha256').update(doc).digest('hex'), path: result.path, bytes: result.bytes, title: args.title, height: args.height || 420 } };
}
