/** In-memory engine status for dashboard display. */

let lastCycleAt: string | null = null;
let lastAction: string | null = null;
let lastReason: string | null = null;
let lastDecision: Record<string, unknown> | null = null;
let lastSimmerCallAt: string | null = null;

export function setLastCycle(action: string, reason?: string, decision?: Record<string, unknown>) {
  lastCycleAt = new Date().toISOString();
  lastAction = action;
  lastReason = reason ?? null;
  lastDecision = decision ?? null;
}

export function setLastSimmerCall() {
  lastSimmerCallAt = new Date().toISOString();
}

export function getNextCycleAt(): string {
  const now = new Date();
  const min = now.getMinutes();
  const nextMin = (Math.floor(min / 15) + 1) * 15;
  const next = new Date(now);
  next.setMinutes(nextMin % 60, 0, 0);
  if (nextMin >= 60) next.setHours(next.getHours() + 1);
  return next.toISOString();
}

export function getStatus() {
  return {
    last_cycle_at: lastCycleAt,
    last_action: lastAction,
    last_reason: lastReason,
    last_decision: lastDecision,
    last_simmer_call_at: lastSimmerCallAt,
    next_cycle_at: getNextCycleAt(),
  };
}
