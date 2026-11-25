const privateKey = /^(?:api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token|cookie|credential|headers)$/i;
export function redactStepDetail(value, depth = 0) {
  if (depth > 8) return '[nested value omitted]';
  if (typeof value === 'string') return value.slice(0,16000).replace(/\b(?:Bearer\s+\S+|(?:sk-|tvly-)[\w-]{12,})/gi,'[redacted]').replace(/([?&](?:api_?key|token|secret|password)=)[^&#\s]+/gi,'$1[redacted]');
  if (Array.isArray(value)) return value.slice(0,100).map(x=>redactStepDetail(x,depth+1));
  if(value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0,100).map(([key, val])=>[key,privateKey.test(key)?'[redacted]':redactStepDetail(val,depth+1)]));
  return value;
}
export function publicSteps(steps) { return steps.map(({id,name,status,detail,ms,attempt,createdAt})=>({id,name,status,detail:redactStepDetail(detail),ms,attempt,createdAt})); }
