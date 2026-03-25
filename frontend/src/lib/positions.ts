/** Simmer sometimes returns status "active" with zero shares after a close — treat as not open. */
const MIN_SHARES = 0.01;

export function positionHasMaterialShares(p: { shares_yes?: number; shares_no?: number }): boolean {
  const sy = Number(p.shares_yes ?? 0);
  const sn = Number(p.shares_no ?? 0);
  return sy >= MIN_SHARES || sn >= MIN_SHARES;
}

/** Dashboard / list: show only positions that are open AND still hold size. */
export function isEffectivelyOpenPosition(p: { status?: string; shares_yes?: number; shares_no?: number }): boolean {
  const st = (p.status ?? "").toLowerCase();
  if (["resolved", "gone", "sold", "closed", "empty"].includes(st)) return false;
  if (!positionHasMaterialShares(p)) return false;
  if (st === "active" || st === "open") return true;
  // Legacy API: missing status — only count as open if there are shares
  if (!st) return true;
  return false;
}
