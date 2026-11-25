import { DEFAULT_PREFERENCES } from './config.mjs';
import { listDisciplines, ragStatus } from './rag.mjs';
import { isSectionId, listSections } from './kb.mjs';

export const preferenceOptions = {
  logicAlgorithm: ['naive', 'semi-naive', 'magic-sets'],
  style: ['concise', 'balanced', 'detailed'],
  inference: ['off', 'balanced', 'active'],
  learning: ['on', 'off'],
};

const valid = {
  followups: value => typeof value === 'boolean',
  logicAlgorithm: value => preferenceOptions.logicAlgorithm.includes(value),
  style: (value) => preferenceOptions.style.includes(value),
  inference: (value) => preferenceOptions.inference.includes(value),
  learning: (value) => preferenceOptions.learning.includes(value),
  citeQuotes: (value) => typeof value === 'boolean',
  showTrace: (value) => typeof value === 'boolean',
  jointResearch: value => typeof value === 'boolean',
  localWeight: value => Number.isInteger(value) && value >= 10 && value <= 90 && value % 10 === 0,
  authorityFocus: value => ['mixed', 'academic', 'official', 'technical'].includes(value),
  includePreprints: value => typeof value === 'boolean',
  topK: (value) => Number.isInteger(value) && value >= 1 && value <= 100,
  discipline: (value) => typeof value === 'string' &&
    (!value || isSectionId(value) || listDisciplines().some((discipline) => discipline.name === value)),
};

// An entire patch succeeds or fails together. Never echo a model-supplied field/value.
export function preferencePatchError(patch, { fromTool = false } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
    return '请选择至少一项偏好。';
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(valid, key) || (fromTool && ['followups', 'topK', 'showTrace', 'logicAlgorithm', 'jointResearch', 'localWeight', 'authorityFocus', 'includePreprints'].includes(key))) {
      return '包含不支持的偏好字段。';
    }
    if (!valid[key](value)) return `偏好 ${key} 的取值无效。`;
  }
  return '';
}

export function effectivePreferences(stored) {
  const preferences = { ...DEFAULT_PREFERENCES };
  for (const key of Object.keys(preferences)) {
    const value = stored?.[key];
    if (key === 'discipline' && typeof value === 'string') {
      // Preserve the stored choice while the corpus is unavailable. A retired
      // discipline becomes inactive on a populated corpus without a GET writing over a concurrent edit.
      if (!ragStatus().papers || valid.discipline(value)) preferences.discipline = value;
    } else if (valid[key](value)) {
      preferences[key] = value;
    }
  }
  return preferences;
}

export async function userPreferenceError(userId, patch, options) {
  const message = preferencePatchError(patch, options);
  if (message || !isSectionId(patch.discipline)) return message;
  return (await listSections(userId)).some(s => s.id === patch.discipline) ? '' : '分区不存在。';
}
