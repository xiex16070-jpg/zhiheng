const workspaceId = value => typeof value === 'string' && /^(?:default|[a-f0-9]{32})$/.test(value) ? value : null;

/** Decorate legacy API responses without rewriting stored results or consulting the active project. */
export function taskWithArtifactWorkspace(task, conversation, userId) {
  if (!task || task.userId !== userId || !Array.isArray(task.result?.artifacts)) return task;
  const ownedConversation = conversation?.id === task.conversationId && conversation.userId === userId ? conversation : null;
  const historicalWorkspace = workspaceId(task.checkpoint?.workspaceId) || workspaceId(ownedConversation?.workspaceId) || 'default';
  let changed = false;
  const artifacts = task.result.artifacts.map(artifact => {
    if (!artifact || typeof artifact !== 'object' || artifact.workspaceId != null) return artifact;
    changed = true;
    return { ...artifact, workspaceId: historicalWorkspace };
  });
  return changed ? { ...task, result: { ...task.result, artifacts } } : task;
}
