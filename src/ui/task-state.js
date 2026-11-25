/** Presentation only: the server remains the authority for task transitions. */
export function terminalPresentation(event = {}) {
  const stopped = event.status === 'cancelled' || event.cancelled === true || event.code === 'cancelled' || event.message === '已停止';
  if (stopped) return { state: 'stopped', title: '已停止', message: '已停止后续执行。已完成的操作和已取得的结果不会自动撤销。' };
  if (event.result?.incompleteReason === 'citations_only') return {
    state: 'error', title: '缺少回答正文', message: '模型仅返回来源编号，没有给出回答正文。',
  };
  if (event.result?.truncated) return {
    state: 'error', title: '输出已截断', message: '已达到输出上限，以上为部分回答。可以调整问题或输出预算后重新发送。',
  };
  return { state: 'error', title: '任务失败', message: `任务失败：${event.message || '请求未完成'}` };
}

export function canResumeTask(task) {
  return task?.status === 'failed' && !task.checkpoint?.rewoundAt;
}

export function taskScopeSignature(mode, preferences = {}) {
  if (mode !== 'knowledge') return 'agent';
  return JSON.stringify(['discipline', 'jointResearch', 'localWeight', 'authorityFocus', 'includePreprints'].map(key => preferences[key] ?? null));
}
