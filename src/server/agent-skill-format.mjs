import { parseDocument, stringify } from 'yaml';

const FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
export const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_FRONTMATTER_BYTES = 32 * 1024;
const characterCount = text => [...text].length;
const diagnostic = (code, field, message) => ({ code, field, message });

function splitDocument(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_DOCUMENT_BYTES) {
    return { issue: diagnostic('document_size', 'frontmatter', '技能入口须为有界的 UTF-8 文本，最大 512 KiB。') };
  }
  const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(raw);
  if (opening) {
    const rest = raw.slice(opening[0].length);
    const end = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
    if (end) {
      const header = rest.slice(0, end.index);
      if (Buffer.byteLength(header) > MAX_FRONTMATTER_BYTES) {
        return { issue: diagnostic('frontmatter_size', 'frontmatter', 'YAML 头部超过 32 KiB 预检上限。') };
      }
      return { header, body: rest.slice(end.index + end[0].length) };
    }
  }
  return { issue: diagnostic('frontmatter_delimiters', 'frontmatter', '请在文件开头使用独立的 --- 行包围技能元数据。') };
}

function readHeader(header) {
  try {
    const document = parseDocument(header, {
      schema: 'core', stringKeys: true, uniqueKeys: true, resolveKnownTags: false,
      prettyErrors: false, logLevel: 'silent',
    });
    if (document.errors.length || document.warnings.length) return null;
    const data = document.toJS({ mapAsMap: true, maxAliasCount: 16 });
    return data instanceof Map ? data : null;
  } catch {
    return null;
  }
}

function validateFields(data, directoryName) {
  const issues = [];
  const frontmatter = {};
  if ([...data.keys()].some(key => !FIELDS.has(key))) {
    issues.push(diagnostic('unsupported_field', 'frontmatter', '含有标准未定义的顶层字段；扩展信息可放在 metadata 中。'));
  }
  for (const key of FIELDS) {
    if (!data.has(key) || key === 'metadata') continue;
    const value = data.get(key);
    if (typeof value === 'string') frontmatter[key] = value;
    else issues.push(diagnostic('field_type', key, `${key} 须为字符串。`));
  }
  const name = frontmatter.name;
  const normalized = name?.normalize('NFKC');
  if (!normalized || characterCount(normalized) > 64 || normalized !== normalized.toLowerCase()
      || !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(normalized)) {
    issues.push(diagnostic('invalid_name', 'name', '名称须为 1 至 64 个小写字母或数字，可用单个连字符分隔。'));
  } else if (typeof directoryName === 'string' && normalized !== directoryName.normalize('NFKC')) {
    issues.push(diagnostic('directory_mismatch', 'name', '名称与技能所在目录不一致。'));
  }
  if (!frontmatter.description?.trim() || characterCount(frontmatter.description) > 1024) {
    issues.push(diagnostic('invalid_description', 'description', '描述须为非空文本，最多 1024 个字符。'));
  }
  if ('compatibility' in frontmatter && (!frontmatter.compatibility.trim() || characterCount(frontmatter.compatibility) > 500)) {
    issues.push(diagnostic('invalid_compatibility', 'compatibility', '兼容性说明须为非空文本，最多 500 个字符。'));
  }
  if (data.has('metadata')) {
    const meta = data.get('metadata');
    if (meta instanceof Map && [...meta].every(([key, value]) => typeof key === 'string' && typeof value === 'string')) {
      frontmatter.metadata = Object.fromEntries(meta);
    } else {
      issues.push(diagnostic('invalid_metadata', 'metadata', 'metadata 须由字符串键和字符串值组成。'));
    }
  }
  return { frontmatter, issues };
}

/** Pure inspection. Diagnostics do not echo arbitrary YAML, which may contain private data. */
export function inspectSkillDocument(raw, directoryName) {
  const { header, body = '', issue } = splitDocument(raw);
  const data = issue ? null : readHeader(header);
  if (!data) {
    return { valid: false, frontmatter: {}, body, issues: [issue || diagnostic('invalid_yaml', 'frontmatter', 'YAML 头部无法安全解析为单个映射，请检查语法、重复键或别名。')] };
  }
  const { frontmatter, issues } = validateFields(data, directoryName);
  return { valid: issues.length === 0, frontmatter, body, issues };
}

/** Convert a skill already resolved by readSkill. Only the verified release category is public metadata. */
export function exportSkillDocument(skill, { category } = {}) {
  const stored = skill.frontmatter || {};
  const data = new Map([['name', skill.name], ['description', stored.description]]);
  // The native store permits unquoted descriptions containing punctuation such as "a: b".
  // Preserve its actual routing text; never reconstruct an exported header from raw lines.
  if (category) data.set('metadata', new Map([['zhiheng-category', category]]));
  const { frontmatter, issues } = validateFields(data, skill.name);
  if (typeof skill.body !== 'string') issues.push(diagnostic('missing_body', 'body', '没有可导出的技能正文。'));
  if (issues.length) {
    throw Object.assign(new Error('当前技能无法按 Agent Skills 标准导出。'), { code: 'skill_not_portable', issues });
  }
  return '---\n' + stringify(frontmatter, { lineWidth: 0 }) + '---\n' + skill.body;
}
