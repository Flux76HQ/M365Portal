// Gives the main thread back to the browser between two steps of the start-up (T-A-173).
//
// Total Blocking Time counts every main-thread task over 50 ms, and on the 4x throttled phone profile a
// real task of 13 ms already counts. The start-up is therefore many short tasks: each step ends, the
// browser may paint and handle input, and the next step is a new task. `scheduler.yield()` keeps the
// continuation's priority where the browser has it; elsewhere a macrotask from `setTimeout` does the job.

/** A promise that resolves in a new task. */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
