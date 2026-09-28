// Pure timing policy, shared by both JWT clients. All delays are milliseconds.
export const IDLE_MS = 8 * 60 * 60 * 1000;
export function sessionSchedule(expiresIn, lastActivity, now = Date.now()) {
  const idle = Math.max(0, lastActivity + IDLE_MS - now);
  if (!idle) return { expired: true, delay: 0 };
  // Unreadable tokens retain reactive refresh without creating a tight timer loop.
  const refresh = Number.isFinite(expiresIn) ? Math.max(1000, (expiresIn - 10) * 1000) : idle;
  return { expired: false, delay: Math.min(idle, refresh) };
}
