const DAY_MS = 86400000;

export function dayKey(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

/** Acumula segundos procesados en el mapa usage (clave YYYY-MM-DD). */
export function addUsage(usage, when, seconds) {
  const key = dayKey(when);
  const slot = usage[key] || { seconds: 0, files: 0 };
  slot.seconds = Math.round((slot.seconds + Math.max(0, Number(seconds) || 0)) * 100) / 100;
  slot.files += 1;
  usage[key] = slot;
  return slot;
}

export function windowTotals(usage, start, end) {
  const from = dayKey(start);
  const to = dayKey(end);
  let seconds = 0;
  let files = 0;
  for (const [key, slot] of Object.entries(usage || {})) {
    if (key >= from && key < to) {
      seconds += Number(slot.seconds) || 0;
      files += Number(slot.files) || 0;
    }
  }
  return { seconds: Math.round(seconds * 100) / 100, files };
}

/**
 * Ventana del ciclo de facturación. Usa la fecha del próximo cobro si existe;
 * si no, usa el día de corte configurado.
 */
export function cycleBounds(nextBillDate, cycleDay = 1, now = new Date()) {
  const next = nextBillDate ? new Date(`${nextBillDate}T00:00:00Z`) : null;
  if (next && !Number.isNaN(next.getTime())) {
    const start = new Date(next);
    start.setUTCMonth(start.getUTCMonth() - 1);
    return { start, end: next };
  }
  const day = Math.min(Math.max(Math.round(Number(cycleDay) || 1), 1), 28);
  const today = now instanceof Date ? now : new Date(now);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const afterCut = today.getUTCDate() >= day;
  const end = new Date(Date.UTC(y, afterCut ? m + 1 : m, day));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, day));
  return { start, end };
}

export function estimateRemaining(remainingSeconds, avgSeconds) {
  if (remainingSeconds == null || !avgSeconds) return null;
  return Math.max(0, Math.floor(remainingSeconds / avgSeconds));
}

export function daysLeft(end, now = new Date()) {
  const diff = new Date(end).getTime() - new Date(now).getTime();
  return Math.max(0, Math.ceil(diff / DAY_MS));
}
