/**
 * Returns a Playwright selector constrained to visible elements when doing so
 * preserves the caller's selector semantics. Comma-separated selector lists
 * are deliberately left alone: appending `:visible` would constrain only the
 * final member of that list.
 */
export function visibleSelectorCandidate(selector) {
  if (typeof selector !== 'string') return null;
  const trimmed = selector.trim();
  if (!trimmed || trimmed.includes(',') || trimmed.includes(':visible')) return null;
  return `${trimmed}:visible`;
}
