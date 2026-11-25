/**
 * Original interface artwork for the Zhiheng agent workbench.
 * 24-unit grid, 1.6-unit round strokes; inherits the surrounding text colour.
 * All geometry is local and static. Caller text is escaped before interpolation.
 */
import { escapeHtml } from '../agent/text.js';

const paths = Object.freeze({
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/><path d="m19 3 .7 1.8L21.5 5.5l-1.8.7L19 8l-.7-1.8-1.8-.7 1.8-.7L19 3Z"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 7.2 8 9 4.6-1.8 8-4.5 8-9V6l-8-3Z"/><path d="m8.5 12 2.4 2.4 4.6-4.8"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M18 9v1c0 4-5 4-12 4"/>',
  panels: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M13 4v16M3 8h10"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.8 8.2-2.2 5.4-5.4 2.2 2.2-5.4 5.4-2.2Z"/><circle cx="12" cy="12" r=".7" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  workspace: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8m-4-3v3M3 8h18M7 4v4"/>',
  upload: '<path d="M12 15V4m-4 4 4-4 4 4M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"/>',
  folder: '<path d="M3.5 7.5V6A1.5 1.5 0 0 1 5 4.5h4l2.5 3H19A1.5 1.5 0 0 1 20.5 9v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18V7.5Z"/><path d="M3.5 10.5h17"/>',
  learning: '<path d="M4 5.5h4.2c1.7 0 3 .7 3.8 1.8.8-1.1 2.1-1.8 3.8-1.8H20v13h-4.2c-1.6 0-2.8.6-3.8 1.7-1-1.1-2.2-1.7-3.8-1.7H4v-13ZM12 7.3v12.9"/><path d="m6.7 10.5 1.1 1.1 2-2M14.5 11h2.8M6.7 15h2.6M14.5 15h2.8"/>',
  activity: '<path d="M4 6.5v12A1.5 1.5 0 0 0 5.5 20h14M3 13h5l2.7-7 3.6 12 2.6-7H21"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5V4m0 16v1.5M2.5 12H4m16 0h1.5M5.3 5.3l1.1 1.1m11.2 11.2 1.1 1.1M5.3 18.7l1.1-1.1M17.6 6.4l1.1-1.1"/>',
  moon: '<path d="M20.1 14.2A8.4 8.4 0 0 1 9.8 3.9a8.5 8.5 0 1 0 10.3 10.3Z"/>',
  send: '<path d="M12 19V5m-5.5 5.5L12 5l5.5 5.5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>',
  'thumb-up': '<path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3Z"/><path d="m7 11 4-7a2 2 0 0 1 2.9 2.2L13 10h5.4a2 2 0 0 1 2 2.4l-1.4 6A2 2 0 0 1 17 20H7"/>',
  'thumb-down': '<path d="M7 13V4H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h3Z"/><path d="m7 13 4 7a2 2 0 0 0 2.9-2.2L13 14h5.4a2 2 0 0 0 2-2.4l-1.4-6A2 2 0 0 0 17 4H7"/>',
  retry: '<path d="M4.5 9a8 8 0 1 1 .1 6.2M4.5 4.5V9H9"/>',
  download: '<path d="M12 4v11m-4-4 4 4 4-4M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.7"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  warning: '<path d="m10.6 4.4-8 13.9a1.6 1.6 0 0 0 1.4 2.4h16a1.6 1.6 0 0 0 1.4-2.4l-8-13.9a1.6 1.6 0 0 0-2.8 0Z"/><path d="M12 9v5"/><circle cx="12" cy="17.2" r=".8" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.3 2"/>',
  loader: '<path d="M20.5 12a8.5 8.5 0 1 1-8.5-8.5"/>',
  pause: '<path d="M9 5v14M15 5v14" stroke-width="2.6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.2 15.2 5.3 5.3"/>',
  quote: '<path d="M9.5 6.5H5A1.5 1.5 0 0 0 3.5 8v5h6V6.5ZM9.5 13c0 3-1.8 4.5-4.5 5M20.5 6.5H16A1.5 1.5 0 0 0 14.5 8v5h6V6.5ZM20.5 13c0 3-1.8 4.5-4.5 5"/>',
  book: '<path d="M4 5h4.2c1.6 0 2.9.6 3.8 1.8.9-1.2 2.2-1.8 3.8-1.8H20v14h-4.2c-1.6 0-2.9.6-3.8 1.6-1-1-2.2-1.6-3.8-1.6H4V5ZM12 6.8v13.8"/><path d="M6.8 9h2M15.2 9h2"/>',
  document: '<path d="M14 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5L14 3.5ZM14 3.5v5h5M8.5 12h7M8.5 16h5"/>',
  settings: '<path d="M4 7h4m5 0h7M4 17h9m5 0h2"/><circle cx="10.5" cy="7" r="2.5"/><circle cx="15.5" cy="17" r="2.5"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M5.8 8h.4m-.4 4h.4m-.4 4h.4"/>',
  chat: '<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M6.5 8.5h11M6.5 12.5h7"/>',
  database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  inference: '<circle cx="5" cy="12" r="2.2"/><circle cx="18.5" cy="5" r="2.2"/><circle cx="18.5" cy="19" r="2.2"/><path d="M7.2 12h3.3a3 3 0 0 0 3-3V8a3 3 0 0 1 3-3m-6 7a3 3 0 0 1 3 3v1a3 3 0 0 0 3 3"/>',
  external: '<path d="M14 4h6v6m-9 3 9-9M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l.9 13h10.2L18 7M10 11v5M14 11v5"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  'chevron-down': '<path d="m5 9 7 7 7-7"/>',
  archive: '<rect x="3.5" y="3.5" width="17" height="5" rx="1.2"/><path d="M5 8.5v10.7a1.3 1.3 0 0 0 1.3 1.3h11.4a1.3 1.3 0 0 0 1.3-1.3V8.5M9.5 12.5h5"/>',
  pin: '<g transform="rotate(35 12 12)"><path d="M8.5 3.5h7M9.5 3.5v5L7 12v2h10v-2l-2.5-3.5v-5M12 14v6.5"/></g>',
  undo: '<path d="m8 5-5 5 5 5M3 10h10.5a6 6 0 0 1 0 12H11"/>',
  refresh: '<path d="M20 8a8.5 8.5 0 0 0-14.6-2L3 9m0-5v5h5M4 16a8.5 8.5 0 0 0 14.6 2l2.4-3m0 5v-5h-5"/>',
  edit: '<path d="m14.5 5 4.5 4.5M4 15.5 15.8 3.7a1.7 1.7 0 0 1 2.4 0l2.1 2.1a1.7 1.7 0 0 1 0 2.4L8.5 20H4v-4.5ZM12 20h8"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m6.5 8 4 4-4 4M13.5 16h4"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v6M10.5 11H12"/><circle cx="12" cy="7.5" r=".8" fill="currentColor" stroke="none"/>',
  'file-code': '<path d="M14 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5L14 3.5ZM14 3.5v5h5"/><path d="m10 12-2 2 2 2m4-4 2 2-2 2"/>',
  user: '<circle cx="12" cy="7.5" r="3.5"/><path d="M5 20v-1.5a7 7 0 0 1 14 0V20"/>',
  flask: '<path d="M8.5 3.5h7M10 3.5V9L4.7 18.3A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.3-2.2L14 9V3.5M7 14.5h10"/><circle cx="11" cy="17.5" r=".8" fill="currentColor" stroke="none"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx=".8"/><path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3M18 9h3m-3 6h3"/>',
  heart: '<path d="M12 20S3.5 14.6 3.5 8.8A4.6 4.6 0 0 1 12 6.3a4.6 4.6 0 0 1 8.5 2.5C20.5 14.6 12 20 12 20Z"/>',
  leaf: '<path d="M20.5 3.5C11 2.7 3.9 7 4.7 13.5c.5 4.2 4.2 6.3 8 4.9 5.5-2 7.8-7.1 7.8-14.9ZM3.5 21 16 8.5M10 14.5v-5m0 5h5"/>',
  building: '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M3 21h18M10 21v-4h4v4M8.5 7h1m5 0h1M8.5 10.5h1m5 0h1M8.5 14h1m5 0h1"/>',
  chart: '<path d="M3 20.5h18"/><rect x="5" y="13" width="3" height="7.5" rx=".5"/><rect x="10.5" y="9" width="3" height="11.5" rx=".5"/><rect x="16" y="4" width="3" height="16.5" rx=".5"/>',
});

export const ICON_NAMES = Object.freeze(Object.keys(paths));

function pixelSize(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(8, Math.min(256, number)) : fallback;
}

/** Decorative by default; pass title only when this SVG itself needs a name. */
export function icon(name, { size = 18, className = '', title = '' } = {}) {
  const key = Object.hasOwn(paths, name) ? name : 'document';
  const label = title ? `role="img" aria-label="${escapeHtml(title)}"` : 'aria-hidden="true"';
  const length = pixelSize(size, 18);
  return `<svg class="ui-icon${className ? ` ${escapeHtml(className)}` : ''}" data-icon="${key}" xmlns="http://www.w3.org/2000/svg" width="${length}" height="${length}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" focusable="false" ${label}>${title ? `<title>${escapeHtml(title)}</title>` : ''}${paths[key]}</svg>`;
}

const mark = '<rect width="32" height="32" rx="10" fill="#152e3c"/><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M16 6c-4 0-7 12-3 15 3 2 10 3 12 0" stroke="#c9ebe7" stroke-width="2.1"/><path d="M25 21c2-4-7-13-12-11-3 1-7 7-7 10" stroke="#79b7b9" stroke-width="2.1"/><path d="M6 20c2 4 14 1 15-4 0-3-3-9-6-10" stroke="#f0d2ad" stroke-width="2.1"/></g><path d="m16 12 4 4-4 4-4-4Z" fill="#f4f7f5"/>';

/** Original three-orbit prism: research, creation and coordinated action. */
export function brandMark({ size = 28, className = '' } = {}) {
  const length = pixelSize(size, 28);
  return `<svg class="brand-symbol${className ? ` ${escapeHtml(className)}` : ''}" xmlns="http://www.w3.org/2000/svg" width="${length}" height="${length}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">${mark}</svg>`;
}
