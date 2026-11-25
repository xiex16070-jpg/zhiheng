#!/usr/bin/env node
/**
 * Publish the deployed local-model profile as the single source of truth for the
 * model lab: the exact base system prompt, the tool schemas the local profile
 * offers, generation budgets and their hashes. Training data, evaluation prompts
 * and the Ollama Modelfile should all be generated from this file, so the
 * adapter is trained on the prompt and tools it will actually see.
 *
 *   node scripts/export-model-profile.mjs --out ../zhiheng-model-lab/profiles/local-qwen
 *
 * Writes profile.json and Modelfile.template. The template deliberately has no
 * TEMPLATE block: the chat template (with tool-call support) must be copied from
 * the converted base model (e.g. `ollama show --modelfile qwen3:8b`), not guessed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

process.env.MYSQL_ENABLED ??= 'false';
process.env.REDIS_ENABLED ??= 'false';
const { getToolSchemas } = await import('../src/server/tools.mjs');
const { LOCAL_QWEN_SYSTEM_PROMPT, LOCAL_QWEN_PROMPT_SHA256, LOCAL_QWEN_MAX_TOKENS, LOCAL_QWEN_CONTEXT, localQwenTools, localQwenSystem } = await import('../src/server/local-qwen.mjs');
const { buildLocalModelProfile } = await import('../src/server/model-profile.mjs');

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : null;
if (!out || args.includes('--help')) {
  console.log('用法：node scripts/export-model-profile.mjs --out <目录>');
  process.exit(args.includes('--help') ? 0 : 2);
}

const sha = (text) => createHash('sha256').update(text).digest('hex');
if (sha(LOCAL_QWEN_SYSTEM_PROMPT) !== LOCAL_QWEN_PROMPT_SHA256) throw new Error('LOCAL_QWEN_PROMPT_SHA256 与提示词正文不一致');
const profile = buildLocalModelProfile(getToolSchemas({}));
const tools = profile.tools;
// Agent and literature variants differ only by the runtime suffix; publish both
// rendered with default preferences so the lab can reproduce them exactly.
const variants = profile.variants;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'profile.json'), JSON.stringify(profile, null, 2) + '\n');
const system = variants.agent.system.replace(/"""/g, '\\"\\"\\"');
fs.writeFileSync(path.join(out, 'Modelfile.template'), `# Generated from logic-kb-agent local-qwen profile ${variants.agent.systemSha.slice(0, 12)}; tools ${variants.agent.toolsSha.slice(0, 12)}.
# Fill FROM / ADAPTER, then paste the base model's chat TEMPLATE (with tool calls) before importing.
FROM <path-to-qwen3-8b-gguf>
# ADAPTER <path-to-lora-gguf>
PARAMETER num_ctx ${LOCAL_QWEN_CONTEXT}
PARAMETER num_predict ${LOCAL_QWEN_MAX_TOKENS}
PARAMETER temperature 0
PARAMETER stop "<|im_end|>"
SYSTEM """${system}"""
`);
console.log(`profile ${variants.agent.systemSha.slice(0, 12)} · ${tools.length} tools → ${out}`);
