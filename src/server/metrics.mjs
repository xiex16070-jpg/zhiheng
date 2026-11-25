/**
 * 指标采集：Redis 计数器（实时）+ MySQL 采样点（趋势）。
 * 记录任务数、失败数、模型调用、检索耗时、审批积压等。
 */

import { cache } from './cache.mjs';
import { getStore } from './store.mjs';

const COUNTER_KEY = 'metrics:counters';
const LATENCY_KEY = (name) => `metrics:lat:${name}`;

export async function incr(name, by = 1) {
  try {
    await cache.hincrby(COUNTER_KEY, name, by);
  } catch {
    /* 指标失败不影响主流程 */
  }
}

export async function observe(name, ms) {
  try {
    await cache.rpush(LATENCY_KEY(name), Math.round(ms), 3600);
    await getStore().addMetric(`latency.${name}`, ms);
  } catch {
    /* 同上 */
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

export async function snapshot() {
  const counters = await cache.hgetall(COUNTER_KEY).catch(() => ({}));
  const num = (k) => Number(counters[k] || 0);

  const lat = async (name) => {
    const list = await cache.lrange(LATENCY_KEY(name), 0, -1).catch(() => []);
    const values = list.map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    return {
      count: values.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      max: values.length ? values[values.length - 1] : 0,
    };
  };

  return {
    counters: {
      tasks_total: num('tasks_total'),
      tasks_completed: num('tasks_completed'),
      tasks_failed: num('tasks_failed'),
      llm_calls: num('llm_calls'),
      llm_errors: num('llm_errors'),
      llm_retries: num('llm_retries'),
      rag_queries: num('rag_queries'),
      approvals_created: num('approvals_created'),
      approvals_approved: num('approvals_approved'),
      approvals_rejected: num('approvals_rejected'),
      rate_limited: num('rate_limited'),
    },
    latency: {
      rag: await lat('rag'),
      llm: await lat('llm'),
      task: await lat('task'),
    },
  };
}
