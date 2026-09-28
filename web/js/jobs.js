// In-memory history: never retain response bodies, tokens or results.
export function createJobs() {
  let entries = [];
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn());
  return {
    list: () => entries.map((e) => ({ ...e })),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start(id, label) {
      const existing = entries.find((e) => e.id === id);
      if (existing) return existing;
      const entry = { id, label, started: Date.now(), ended: null, state: 'Queued', message: '' };
      entries.push(entry);
      emit();
      return entry;
    },
    update(entry, task, done) {
      if (!entries.includes(entry) || (entry.ended !== null && !done)) return;
      entry.state = String(task.State || 'Running');
      entry.message = String(
        task.FailureReason ||
          task.Message ||
          task.LastMessage ||
          (Array.isArray(task.Console) ? task.Console.at(-1) : task.Console) ||
          entry.message ||
          '',
      );
      if (done) entry.ended = Date.now();
      const finished = entries.filter((e) => e.ended !== null);
      const discard = new Set(finished.slice(0, Math.max(0, finished.length - 20)));
      entries = entries.filter((e) => !discard.has(e));
      emit();
    },
    clear() {
      entries = [];
      emit();
    },
  };
}
export const jobs = createJobs();
