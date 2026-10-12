// The labels of the designated Owner (P13, P15, P18): the UPN and the display name, for people to
// confirm who becomes Owner (FR-B-219 h). They are never stored and never decide anything. The sources,
// in order: the bootstrap identity while it is signed in, a small cache, then an app-only `getUser`
// once the connection works. A failure is `null` labels, not an error.
import type { SetupServices } from './context.js';

export interface OwnerLabels {
  readonly upnLabel: string | null;
  readonly nameLabel: string | null;
}

const NONE: OwnerLabels = { upnLabel: null, nameLabel: null };
const caches = new WeakMap<object, Map<string, OwnerLabels>>();

const clip = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value === '' ? null : value.slice(0, 120);

export async function ownerLabelsOf(services: SetupServices, oid: string): Promise<OwnerLabels> {
  const key = oid.toLowerCase();
  const identity = services.bootstrap.identity();
  if (identity !== undefined && identity.oid.toLowerCase() === key) {
    return { upnLabel: clip(identity.upnLabel), nameLabel: clip(identity.nameLabel) };
  }
  let cache = caches.get(services);
  if (cache === undefined) {
    cache = new Map();
    caches.set(services, cache);
  }
  const known = cache.get(key);
  if (known !== undefined) return known;
  try {
    const user = await services.deps.clients.graph().getUser(key, { priority: 'high' });
    const labels = { upnLabel: clip(user?.userPrincipalName), nameLabel: clip(user?.displayName) };
    if (user !== null) cache.set(key, labels);
    return labels;
  } catch {
    return NONE;
  }
}
