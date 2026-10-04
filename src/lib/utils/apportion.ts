// Deterministic cent apportioning keeps the totals exact and stable across peers.
export function apportionCents(totalCents: number, keys: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  // a duplicate key would otherwise divide by keys.length but only write one entry,
  // silently understating that key's share of the total
  const uniqueKeys = Array.from(new Set(keys));
  if (uniqueKeys.length === 0) return result;
  if (!Number.isFinite(totalCents)) {
    for (const key of uniqueKeys) result[key] = 0;
    return result;
  }

  const total = Math.round(totalCents);
  const negative = total < 0;
  const abs = Math.abs(total);

  const base = Math.floor(abs / uniqueKeys.length);
  let remainder = abs - base * uniqueKeys.length;

  // Deterministic order so two peers holding the same expense agree, regardless
  // of the order their category arrays happen to be in.
  const ordered = [...uniqueKeys].sort();
  for (const key of uniqueKeys) result[key] = base;
  for (const key of ordered) {
    if (remainder <= 0) break;
    result[key] += 1;
    remainder -= 1;
  }

  if (negative) {
    for (const key of uniqueKeys) result[key] = -result[key];
  }
  return result;
}

