// Client addresses and the key a client is known by (FR-A-045, FR-A-046): one place that turns the
// text of an address into a canonical form, so that the same client is the same key whatever the
// spelling (`::ffff:203.0.113.9`, `2001:DB8::1`, `2001:0db8:0:0:0:0:0:1`).
//
// The key is the IPv4 address, or the /64 prefix of an IPv6 address: a single IPv6 subscriber owns a
// whole /64 and could otherwise pick a new bucket for every request by rotating the low 64 bits.
import { isIP } from 'node:net';

/** The key of a request whose peer is unknown or not an address (an in-process call). */
export const UNKNOWN_CLIENT_KEY = 'unknown';

const HEXTET = /^[0-9a-f]{1,4}$/;

/** The eight 16-bit groups of an IPv6 address (lower case, no zone), or `undefined`. */
function hextetsOf(address: string): number[] | undefined {
  let text = address;
  // An embedded IPv4 tail (`::ffff:203.0.113.9`) is two groups.
  if (text.includes('.')) {
    const colon = text.lastIndexOf(':');
    const octets = text
      .slice(colon + 1)
      .split('.')
      .map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
      return undefined;
    }
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, colon + 1)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string | undefined): number[] | undefined => {
    if (part === undefined || part === '') return [];
    const parsed = part.split(':').map((group) => (HEXTET.test(group) ? parseInt(group, 16) : NaN));
    return parsed.some(Number.isNaN) ? undefined : parsed;
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  return missing >= 1 ? [...head, ...new Array<number>(missing).fill(0), ...tail] : undefined;
}

/** RFC 5952: lower case, no leading zeros, the first longest run of two or more zero groups as `::`. */
function formatHextets(hextets: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < 8;) {
    if (hextets[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < 8 && hextets[end] === 0) end += 1;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const text = (part: readonly number[]): string =>
    part.map((group) => group.toString(16)).join(':');
  if (bestLength < 2) return text(hextets);
  return `${text(hextets.slice(0, bestStart))}::${text(hextets.slice(bestStart + bestLength))}`;
}

/**
 * The canonical text of an IP address: IPv4 as dotted decimal, IPv6 as RFC 5952, an IPv4-mapped
 * IPv6 address (`::ffff:a.b.c.d`) unwrapped to its IPv4 form, a zone id (`%eth0`) dropped.
 * Returns `undefined` when the text is not an address (a host name, a socket path, `1.2.3.4:80`).
 */
export function normalizeIp(address: string): string | undefined {
  const zone = address.indexOf('%');
  const bare = zone < 0 ? address : address.slice(0, zone);
  const family = isIP(bare);
  if (family === 4) return bare;
  if (family !== 6) return undefined;
  const hextets = hextetsOf(bare.toLowerCase());
  if (hextets === undefined) return undefined;
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = hextets;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${String(g6 >> 8)}.${String(g6 & 255)}.${String(g7 >> 8)}.${String(g7 & 255)}`;
  }
  return formatHextets(hextets);
}

/** The key of a client: its IPv4 address or IPv6 /64 prefix, or `unknown` (one shared key). */
export function clientKeyOf(address: string | undefined): string {
  if (address === undefined) return UNKNOWN_CLIENT_KEY;
  const normal = normalizeIp(address);
  if (normal === undefined) return UNKNOWN_CLIENT_KEY;
  if (!normal.includes(':')) return normal;
  const hextets = hextetsOf(normal);
  if (hextets === undefined) return UNKNOWN_CLIENT_KEY;
  return `${hextets
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}
