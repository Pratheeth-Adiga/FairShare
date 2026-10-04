import type { PeerId, SplitType, ExpenseItem } from '@/types';

export interface SplitResult {
  [userId: string]: number;
}

export interface ItemizedParams {
  items: ExpenseItem[];
}

// Cheap deterministic string hash used only to pick a rotation/tie-break offset -
// not a security primitive.
function hashString(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return h;
}

// Hamilton apportionment: give the leftover cents to whoever has the largest
// fractional remainder first, seed-broken (e.g. expense id) so ties don't
// always land on the same member.
function distributeRemainder(
  bases: [string, number][],
  fractions: [string, number][],
  remainderCents: number,
  seed: string
): SplitResult {
  const splits: SplitResult = {};
  for (const [uid, base] of bases) splits[uid] = base;

  const order = fractions
    .map(([uid, frac], i) => ({ uid, frac, tiebreak: hashString(seed + uid + i) }))
    .sort((a, b) => b.frac - a.frac || a.tiebreak - b.tiebreak);

  if (order.length === 0 || !Number.isFinite(remainderCents) || remainderCents === 0) {
    return splits;
  }

  if (remainderCents > 0) {
    // Round-robin so remainders larger than the member count are fully allocated.
    for (let i = 0; i < remainderCents; i++) {
      splits[order[i % order.length]!.uid] += 1;
    }
    return splits;
  }

  // Reclaim negative remainders from the smallest fractions without going below zero.
  let toReclaim = -remainderCents;
  const reversed = [...order].reverse();
  while (toReclaim > 0) {
    let reclaimedThisPass = 0;
    for (const { uid } of reversed) {
      if (toReclaim === 0) break;
      if (splits[uid]! > 0) {
        splits[uid]! -= 1;
        toReclaim--;
        reclaimedThisPass++;
      }
    }
    // Everything is already at zero - nothing left to take.
    if (reclaimedThisPass === 0) break;
  }
  return splits;
}

// Reject invalid weights before they can create a document that fails schema validation.
function assertNonNegativeWeights(params: Record<string, number>, kind: string): void {
  for (const [uid, value] of Object.entries(params)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${kind} for ${uid} must be a non-negative finite number (got ${value})`);
    }
  }
}

function calculateWeightedSplits(
  amountCents: number,
  params: Record<string, number>,
  seed: string,
  kind: string
): SplitResult {
  assertNonNegativeWeights(params, kind);
  const totalWeight = Object.values(params).reduce((total, value) => total + value, 0);
  if (totalWeight === 0) return {};

  const bases: [string, number][] = [];
  const fractions: [string, number][] = [];
  let allocated = 0;
  for (const [uid, weight] of Object.entries(params)) {
    const exact = amountCents * weight / totalWeight;
    const base = Math.floor(exact);
    bases.push([uid, base]);
    fractions.push([uid, exact - base]);
    allocated += base;
  }
  return distributeRemainder(bases, fractions, amountCents - allocated, seed);
}

export function calculateSplits(
  amountCents: number,
  splitType: SplitType,
  members: PeerId[],
  params?: Record<string, number> | ItemizedParams,
  seed?: string
): SplitResult {
  if (!Number.isFinite(amountCents) || amountCents < 0) {
    throw new Error(`amountCents must be a finite, non-negative number (got ${amountCents})`);
  }
  const memberCount = members.length;
  if (memberCount === 0) return {};

  switch (splitType) {
    case 'equal': {
      const base = Math.floor(amountCents / memberCount);
      const remainder = amountCents % memberCount;
      const offset = seed ? hashString(seed) % memberCount : 0;
      const splits: SplitResult = {};
      for (let index = 0; index < memberCount; index++) {
        const memberIndex = (index + offset) % memberCount;
        splits[members[memberIndex]] = base + (index < remainder ? 1 : 0);
      }
      return splits;
    }

    case 'exact': {
      const exactParams = params as Record<string, number>;
      if (!exactParams) return {};
      // Same reasoning as shares/by_weight: a negative exact amount round-trips
      // into a document that `splitSchema` will refuse to load back.
      assertNonNegativeWeights(exactParams, 'Exact amount');
      return { ...exactParams };
    }

    case 'percentage': {
      const pctParams = params as Record<string, number>;
      if (!pctParams) return {};
      const totalPct = Object.values(pctParams).reduce((a, b) => a + b, 0);
      if (Math.abs(totalPct - 100) > 0.01) {
        throw new Error(`Percentages must sum to 100 (got ${totalPct})`);
      }
      const bases: [string, number][] = [];
      const fractions: [string, number][] = [];
      let allocated = 0;
      for (const [uid, pct] of Object.entries(pctParams)) {
        if (pct < 0) throw new Error('Percentages cannot be negative');
        const exact = amountCents * pct / 100;
        const base = Math.floor(exact);
        bases.push([uid, base]);
        fractions.push([uid, exact - base]);
        allocated += base;
      }
      return distributeRemainder(bases, fractions, amountCents - allocated, seed || 'percentage');
    }

    case 'shares': {
      const shareParams = params as Record<string, number>;
      if (!shareParams) return {};
      return calculateWeightedSplits(amountCents, shareParams, seed || 'shares', 'Share');
    }

    case 'by_weight': {
      const weightParams = params as Record<string, number>;
      if (!weightParams) return {};
      return calculateWeightedSplits(amountCents, weightParams, seed || 'by_weight', 'Weight');
    }

    case 'itemized': {
      const itemParams = params as ItemizedParams;
      if (!itemParams?.items) return {};
      const memberSet = new Set(members);
      const splits: SplitResult = {};
      for (const m of members) splits[m] = 0;
      for (const item of itemParams.items) {
        // Only split among assignees who are still group members (prevents phantom
        // balances for peers removed from the group after the item was assigned).
        const assignees = item.assignees.filter(a => memberSet.has(a));
        if (assignees.length === 0) continue;
        const perPerson = Math.floor(item.amount / assignees.length);
        const remainder = item.amount % assignees.length;
        const offset = hashString((seed || 'itemized') + item.name) % assignees.length;
        for (let i = 0; i < assignees.length; i++) {
          const idx = (i + offset) % assignees.length;
          const uid = assignees[idx];
          splits[uid] = (splits[uid] || 0) + perPerson + (i < remainder ? 1 : 0);
        }
      }
      return splits;
    }

    default:
      return {};
  }
}

