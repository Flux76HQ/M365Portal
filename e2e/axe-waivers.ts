// The axe waiver file (FR-A-150): waivers live only in `axe-waivers.json`, with a rule, a reason and
// an expiry date. `loadWaivers` is the guard: it THROWS for a waiver without a reason, with a bad or
// past expiry date, or for a malformed file, so a waiver cannot silently outlive its reason.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Waiver {
  /** The axe rule id, for example `color-contrast`. */
  readonly rule: string;
  readonly reason: string;
  /** `YYYY-MM-DD`; the waiver is valid through that day. */
  readonly expires: string;
  /** When present, the waiver applies on these paths only. */
  readonly routes?: readonly string[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `today` is `YYYY-MM-DD` (UTC). Returns the waivers; throws on any invalid or expired one. */
export function loadWaivers(raw: unknown, today: string): readonly Waiver[] {
  if (!isRecord(raw) || !Array.isArray(raw.waivers)) {
    throw new Error('axe waivers: the file must be an object with a "waivers" array');
  }
  const waivers: Waiver[] = [];
  raw.waivers.forEach((entry: unknown, index: number) => {
    const where = `axe waiver #${String(index + 1)}`;
    if (!isRecord(entry)) throw new Error(`${where}: must be an object`);
    const { rule, reason, expires, routes } = entry;
    if (typeof rule !== 'string' || rule.trim() === '')
      throw new Error(`${where}: rule is missing`);
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`${where} (${rule}): reason is missing`);
    }
    if (typeof expires !== 'string' || !DATE.test(expires) || Number.isNaN(Date.parse(expires))) {
      throw new Error(`${where} (${rule}): expires must be a date like 2026-12-31`);
    }
    if (expires < today) {
      throw new Error(`${where} (${rule}): expired on ${expires} (today is ${today})`);
    }
    if (
      routes !== undefined &&
      !(Array.isArray(routes) && routes.every((r) => typeof r === 'string'))
    ) {
      throw new Error(`${where} (${rule}): routes must be a list of paths`);
    }
    waivers.push({
      rule,
      reason,
      expires,
      ...(routes === undefined ? {} : { routes: routes as string[] }),
    });
  });
  return waivers;
}

export function readWaiverFile(
  path = fileURLToPath(new URL('./axe-waivers.json', import.meta.url)),
): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** Today in UTC as `YYYY-MM-DD`. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Whether a waiver covers a violation of `rule` on `route`. */
export function isWaived(waivers: readonly Waiver[], rule: string, route: string): boolean {
  return waivers.some(
    (waiver) =>
      waiver.rule === rule && (waiver.routes === undefined || waiver.routes.includes(route)),
  );
}
