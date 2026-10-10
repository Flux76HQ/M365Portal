// TRUST_PROXY (FR-A-046, plan 8.4, E-15): when `X-Forwarded-For` and `X-Forwarded-Proto` are
// believed, and which entry of `X-Forwarded-For` is the client.
//
// A forwarding header is written by whoever sent the request. It is a statement of fact only when
// the connection it arrived on is a proxy of ours, so every mode starts from the socket peer:
//
//   none  the peer is the client; both headers are ignored.
//   N     N proxies stand in front: the client is entry N from the right of `X-Forwarded-For` (the
//         proxies append, so entries to its left were supplied by the client and mean nothing). With
//         fewer than N entries, or an entry that is not an address, the peer is used. The scheme is
//         the last value of `X-Forwarded-Proto`.
//   list  only peers inside the listed networks are believed. From the right, trusted hops are
//         skipped and the first untrusted entry is the client; if every entry is trusted the
//         leftmost one is. An entry that is not an address makes the request fall back to the peer.
//
// An address is always compared and keyed in its canonical form (`normalizeIp`): IPv4-mapped IPv6
// is the IPv4 address, so a dual-stack socket does not give a client two identities.
import { BlockList } from 'node:net';
import { normalizeHost } from '../config/env.js';
import type { TrustProxySetting, TrustedNetwork } from '../config/env.js';
import { normalizeIp } from './client-key.js';

export interface ForwardingInput {
  /** The remote address of the socket, as the runtime reports it. */
  readonly peer: string | undefined;
  readonly forwardedFor: string | null | undefined;
  readonly forwardedProto: string | null | undefined;
}

export interface Forwarding {
  /** The canonical address of the client, or `undefined` when there is no usable peer. */
  readonly address: string | undefined;
  /** The scheme a trusted proxy announced; `undefined` when none did or none is believed. */
  readonly scheme: 'http' | 'https' | undefined;
}

export type ForwardingResolver = (input: ForwardingInput) => Forwarding;

function entriesOf(forwardedFor: string | null | undefined): string[] {
  if (forwardedFor === null || forwardedFor === undefined || forwardedFor.trim() === '') return [];
  return forwardedFor.split(',').map((entry) => entry.trim());
}

/** The last value of `X-Forwarded-Proto`: the one the closest proxy wrote. */
function announcedScheme(forwardedProto: string | null | undefined): 'http' | 'https' | undefined {
  const last = forwardedProto?.split(',').at(-1)?.trim().toLowerCase();
  return last === 'https' || last === 'http' ? last : undefined;
}

/**
 * A list entry as a Node block-list rule. An IPv4-mapped IPv6 range (`::ffff:10.0.0.0/104`) needs no
 * special case: Node's block list matches the IPv4 address it stands for, which is how the peers
 * are keyed (`normalizeIp`). `trust-proxy.test.ts` pins that behaviour with the ranges it maps.
 */
function addNetwork(list: BlockList, network: TrustedNetwork): void {
  list.addSubnet(network.address, network.prefix, network.family === 4 ? 'ipv4' : 'ipv6');
}

export function createForwardingResolver(setting: TrustProxySetting): ForwardingResolver {
  if (setting.mode === 'none') {
    return ({ peer }) => ({
      address: peer === undefined ? undefined : normalizeIp(peer),
      scheme: undefined,
    });
  }

  if (setting.mode === 'hops') {
    const { hops } = setting;
    return ({ peer, forwardedFor, forwardedProto }) => {
      let address = peer === undefined ? undefined : normalizeIp(peer);
      const entries = entriesOf(forwardedFor);
      if (entries.length >= hops) {
        const chosen = normalizeIp(entries[entries.length - hops] ?? '');
        if (chosen !== undefined) address = chosen;
      }
      return { address, scheme: announcedScheme(forwardedProto) };
    };
  }

  const trustedList = new BlockList();
  for (const network of setting.networks) addNetwork(trustedList, network);
  const isTrusted = (address: string): boolean =>
    trustedList.check(address, address.includes(':') ? 'ipv6' : 'ipv4');

  return ({ peer, forwardedFor, forwardedProto }) => {
    const peerAddress = peer === undefined ? undefined : normalizeIp(peer);
    if (peerAddress === undefined || !isTrusted(peerAddress)) {
      return { address: peerAddress, scheme: undefined };
    }
    let address = peerAddress;
    const entries = entriesOf(forwardedFor);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = normalizeIp(entries[index] ?? '');
      if (entry === undefined) {
        address = peerAddress;
        break;
      }
      address = entry;
      if (!isTrusted(entry)) break;
    }
    return { address, scheme: announcedScheme(forwardedProto) };
  };
}

/**
 * The scheme the request effectively arrived with: https when `PUBLIC_BASE_URL` is https (the
 * operator says the panel is served over https, and whatever terminates TLS is in front of us), or
 * when a trusted proxy announced https.
 */
export function effectiveScheme(input: {
  readonly publicIsHttps: boolean;
  readonly forwardedScheme: 'http' | 'https' | undefined;
}): 'http' | 'https' {
  return input.publicIsHttps || input.forwardedScheme === 'https' ? 'https' : 'http';
}

/**
 * The host the request was addressed to, in the form of `normalizeHost` (lower case, no port, one
 * trailing dot dropped, IPv6 in brackets), or `undefined` for a missing or malformed `Host`. The
 * HSTS rule and the preview rule both read the host through this function and no other.
 */
export function requestHost(request: { readonly headers: Headers }): string | undefined {
  const host = request.headers.get('host');
  return host === null ? undefined : normalizeHost(host);
}
