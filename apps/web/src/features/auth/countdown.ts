// The time left, written the same in every language: minutes, a colon and two digits of seconds
// (`2:00`, `14:59`, `1:02:03` for more than an hour). Digits and a colon are neutral, so the countdown
// needs no catalogue entry; the sentence around it comes from the catalogue.

/** Whole seconds left, rounded up, never below zero. */
export function secondsLeft(untilMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
}

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${String(minutes)}:${rest}`;
}
