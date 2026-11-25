/** Search windows are views over retained parent text, never new citation IDs. */
export function sourceWindows(input, { maxChars = 600, overlap = 80 } = {}) {
  const text = String(input || ''), out = [];
  const size = Math.max(200, Math.min(2000, Math.floor(maxChars) || 600));
  const shared = Math.max(0, Math.min(size / 3, Math.floor(overlap) || 0));
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const tail = text.slice(start + Math.floor(size / 2), end);
      const breaks = [...tail.matchAll(/\n(?=(?:Definition|Theorem|Lemma|Example|Corollary|Proposition)\b|\(\*)|[。！？；]\s*|\n\s*\n/g)];
      if (breaks.length) end = start + Math.floor(size / 2) + breaks.at(-1).index + breaks.at(-1)[0].length;
      // Never split a UTF-16 surrogate pair.
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    out.push({ start, end, text: text.slice(start, end) });
    if (end === text.length) break;
    start = Math.max(start + 1, end - shared);
    if (/[\uDC00-\uDFFF]/.test(text[start])) start++;
  }
  return out;
}
