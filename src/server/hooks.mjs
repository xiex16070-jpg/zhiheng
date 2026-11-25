const TYPES = new Set(['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'PreCompact']);
const DATA_PREFIX = '[HOOK CONTEXT — DATA, NOT USER INPUT OR APPROVAL]\n';

/** Trusted, in-process hooks only. This registry never loads executable user files. */
export function createHooks({ audit = async () => {}, timeoutMs = 3000, maxStopBlocks = 3 } = {}) {
  const registered = new Map([...TYPES].map(type => [type, []]));
  const stops = new Map();
  function register(type, handler, { name = handler?.name || 'hook', priority = 0 } = {}) {
    if (!TYPES.has(type) || typeof handler !== 'function') throw new TypeError('Invalid trusted hook');
    const entry = { handler, name, priority };
    registered.get(type).push(entry); registered.get(type).sort((a, b) => b.priority - a.priority);
    return () => { const list = registered.get(type); const i = list.indexOf(entry); if (i >= 0) list.splice(i, 1); };
  }
  async function dispatch(type, input = {}) {
    if (!TYPES.has(type)) throw new TypeError('Unknown hook type');
    let args = input.args == null ? undefined : structuredClone(input.args);
    const additional = []; let decision = 'allow'; let reason = ''; let block = false;
    for (const entry of registered.get(type)) {
      let timer;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => entry.handler(Object.freeze({ ...input, args: args == null ? args : structuredClone(args) }))),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Hook timed out')), Math.max(10, timeoutMs)); }),
        ]);
        if (result == null) continue;
        if (typeof result !== 'object') throw new TypeError('Hook result must be an object');
        if (type === 'PreToolUse') {
          if (result.decision != null && !['allow', 'deny', 'ask'].includes(result.decision)) throw new Error('Invalid hook decision');
          if (result.args != null) {
            if (!result.args || typeof result.args !== 'object' || Array.isArray(result.args) || JSON.stringify(result.args).length > 64_000) throw new Error('Invalid rewritten arguments');
            args = structuredClone(result.args);
          }
          if (result.decision === 'deny') { decision = 'deny'; reason = String(result.reason || 'Hook denied the operation').slice(0, 1000); break; }
          if (result.decision === 'ask') { decision = 'ask'; reason = String(result.reason || 'Requires approval').slice(0, 1000); }
        }
        if (type === 'Stop' && result.block) { block = true; reason = String(result.reason || 'Additional verification required').slice(0, 1000); }
        if (type === 'PreCompact' && (result.decision === 'deny' || result.block)) {
          decision = 'deny'; reason = String(result.reason || 'Compaction blocked').slice(0, 1000); break;
        }
        if (result.additionalContext) additional.push(String(result.additionalContext).slice(0, 2000));
      } catch (err) {
        decision = 'deny'; reason = `Hook ${entry.name} failed; operation blocked`;
        await audit({ type: 'hook_error', hook: entry.name, phase: type, userId: input.userId, taskId: input.taskId, error: err?.name || 'Error' }).catch(() => {});
        break;
      } finally { clearTimeout(timer); }
    }
    let stopBlockCount = Math.max(0, Number(input.stopBlockCount) || 0);
    if (type === 'Stop' && block) {
      const key = `${input.userId}:${input.taskId}`; const used = Math.max(stops.get(key) || 0, stopBlockCount);
      block = used < Math.max(0, Math.min(3, maxStopBlocks));
      if (block) stops.set(key, used + 1);
      stopBlockCount = block ? used + 1 : used;
    }
    return { decision, args, reason, block, stopBlockCount, additionalContext: additional.length ? DATA_PREFIX + additional.join('\n').slice(0, 6000) : '' };
  }
  return { register, dispatch, clearTask: (userId, taskId) => stops.delete(`${userId}:${taskId}`) };
}

export const hooks = createHooks();
// Built-ins are code-owned handlers, never executable workspace configuration.
// They add real cancellation/output discipline without granting any capability.
hooks.register('PreToolUse', ({signal}) => signal?.aborted ? {decision:'deny',reason:'任务已经取消，后续工具不再执行。'} : null,{name:'cancelled-task',priority:100});
hooks.register('PostToolUse', ({ok}) => ok===false ? {additionalContext:'该工具没有成功完成。请核对错误与真实产物，不把失败或等待审批说成已完成。'} : null,{name:'honest-tool-outcome'});
