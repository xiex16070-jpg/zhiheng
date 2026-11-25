import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectSkillDocument, exportSkillDocument } from '../src/server/agent-skill-format.mjs';

const document = (header, body = '# 说明\n') => '---\n' + header + '\n---\n' + body;
const check = (fields, directory = 'paper-review') => inspectSkillDocument(document(fields), directory);
const base = 'name: paper-review\ndescription: 审核论文';

test('parses quoted, folded, literal and nested YAML and preserves the original Markdown body', () => {
  const raw = [
    '\uFEFF---', 'name: "paper-review"', 'description: >-', '  Review papers:', '  compare evidence.',
    'license: "MIT # literal"', 'compatibility: |-', '  Requires git.', '  Runs offline.',
    'allowed-tools: "Read Bash(git:*)"', 'metadata:', '  version: "1.0"', '---',
    '# 标题', '', '---', '正文', '',
  ].join('\r\n');
  const parsed = inspectSkillDocument(raw, 'paper-review');
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.frontmatter, {
    name: 'paper-review', description: 'Review papers: compare evidence.',
    license: 'MIT # literal', compatibility: 'Requires git.\nRuns offline.',
    'allowed-tools': 'Read Bash(git:*)', metadata: { version: '1.0' },
  });
  assert.equal(parsed.body, '# 标题\r\n\r\n---\r\n正文\r\n');
});

test('uses the standard description and compatibility limits in Unicode code points', () => {
  const fields = 'name: paper-review\ndescription: ' + '📚'.repeat(1024);
  assert.equal(check(fields + '\ncompatibility: ' + '界'.repeat(500)).valid, true);
  assert.equal(check(fields + '长').issues[0].code, 'invalid_description');
  assert.equal(check(base + '\ncompatibility: ' + '界'.repeat(501)).issues[0].code, 'invalid_compatibility');
  assert.equal(check('name: paper-review\ndescription: "   "').valid, false);
});

test('checks Unicode names, repeated separators, directory mismatch and the 64 character boundary', () => {
  const named = (name, directory = name) => check('name: ' + JSON.stringify(name) + '\ndescription: yes, read papers', directory);
  for (const name of ['文学-研究', 'école-2', 'a'.repeat(64)]) assert.equal(named(name).valid, true);
  assert.equal(named('école-2', 'e\u0301cole-2').valid, true);
  for (const name of ['A', 'a--b', 'a_b', 'a.b', '-a', 'a-', 'a'.repeat(65)]) {
    assert.ok(named(name).issues.some(i => i.code === 'invalid_name'));
  }
  assert.ok(named('x', 'y').issues.some(i => i.code === 'directory_mismatch'));
});

test('rejects duplicate keys, complex mappings and schema/type errors without echoing values', () => {
  const privateValue = 'SYNTHETIC_PRIVATE_VALUE';
  for (const fields of [
    base + '\nname: ' + privateValue,
    base + '\n' + privateValue + ': ignored',
    base + '\nmetadata:\n  tag:\n    nested: ' + privateValue,
    base + '\nlicense: !private ' + privateValue,
    base + '\ncompatibility: [' + privateValue + ']',
    base + '\nallowed-tools: [' + privateValue + ']',
    'description: ' + privateValue,
  ]) {
    const parsed = check(fields);
    assert.equal(parsed.valid, false);
    assert.ok(parsed.issues.length);
    assert.ok(!JSON.stringify(parsed.issues).includes(privateValue));
  }
  const meta = check(base + '\nmetadata:\n  "__proto__": safe');
  assert.equal(meta.frontmatter.metadata.__proto__, 'safe');
  assert.equal(({}).safe, undefined);
});

test('bounds input and rejects an unclosed header and excessive alias expansion', () => {
  assert.equal(inspectSkillDocument('preamble\n' + document(base)).valid, false);
  assert.equal(inspectSkillDocument('---\n' + base).issues[0].code, 'frontmatter_delimiters');
  assert.equal(check(base + '\n#' + '字'.repeat(12000)).issues[0].code, 'frontmatter_size');
  assert.equal(inspectSkillDocument(document(base, '字'.repeat(200000))).issues[0].code, 'document_size');
  const aliases = 'metadata:\n  first: &first [x, x, x, x]\n  second: &second [*first, *first, *first, *first]\n  third: [*second, *second, *second, *second]';
  assert.equal(check(base + '\n' + aliases).issues[0].code, 'invalid_yaml');
});

test('exports actual native description and body, only adding the release category when supplied', () => {
  const body = '\n# 证据\r\n\n---\n\n最后一行';
  const skill = {
    name: 'paper-review', frontmatter: {
      description: 'Review: "rules" # literal', version: '0.1', author: 'agent',
      previous_source_sha256: 'private', tags: 'private', metadata: { user: 'private' },
    }, scopeId: 'private', raw: 'private', body,
  };
  const result = inspectSkillDocument(exportSkillDocument(skill, { category: 'research' }), skill.name);
  assert.deepEqual(result, {
    valid: true, issues: [], body,
    frontmatter: { name: skill.name, description: skill.frontmatter.description, metadata: { 'zhiheng-category': 'research' } },
  });
  const plain = inspectSkillDocument(exportSkillDocument(skill), skill.name);
  assert.deepEqual(Object.keys(plain.frontmatter).sort(), ['description', 'name']);
  assert.throws(() => exportSkillDocument({ ...skill, name: 'legacy_id' }), e =>
    e.code === 'skill_not_portable' && e.issues.some(issue => issue.code === 'invalid_name'));
});

test('round-trips the repository citation-export skill and its actual research category', async () => {
  const raw = await readFile(new URL('../skill-library/citation-export/SKILL.md', import.meta.url), 'utf8');
  const source = inspectSkillDocument(raw, 'citation-export');
  assert.deepEqual(source.issues.map(i => i.code), ['unsupported_field']); // Legacy top-level category.
  const category = /^category: ([^\r\n]+)$/m.exec(raw)[1];
  const exported = exportSkillDocument({ ...source, name: source.frontmatter.name }, { category });
  const restored = inspectSkillDocument(exported, 'citation-export');
  assert.equal(restored.valid, true);
  assert.deepEqual(restored.frontmatter, { ...source.frontmatter, metadata: { 'zhiheng-category': category } });
  assert.equal(restored.body, source.body);
});
