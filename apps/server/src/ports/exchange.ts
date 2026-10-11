// The Exchange Admin API client as services see it (plan 8.1, 8.7, FR-B-314). Phase B has the
// documented read path only: `capabilities().write` is the empty tuple, and a write method is a
// type error until Phase D adds one. Implementations: `AdminApiExchangeClient` (integrations/exchange)
// and `FakeExchangeClient` (test/fakes).

/** A property value of a cmdlet result. Only scalars are kept. */
export type ExchangeScalar = string | number | boolean;

/** `Get-OrganizationConfig` result: `name` and `guid` plus the properties that were selected. */
export interface ExchangeOrganizationConfig {
  readonly name: string | null;
  readonly guid: string | null;
  readonly [property: string]: ExchangeScalar | null;
}

/** One recipient of `Get-DistributionGroupMember`. */
export interface ExchangeRecipient {
  readonly name: string | null;
  readonly guid: string | null;
  readonly [property: string]: ExchangeScalar | null;
}

export interface ExchangeProbeResult {
  status: 'ok' | 'not_ready' | 'unavailable';
  httpStatus: number | null;
  roleEffective: 'yes' | 'no' | 'unknown';
  previewAvailable: 'yes' | 'no' | 'unknown';
}

export interface ExchangeClient {
  capabilities(): {
    read: readonly ('organizationConfig' | 'distributionGroupMembers')[];
    write: readonly [];
  };
  /** One cheap real call with a fresh token; the status says whether the role is effective yet. */
  probe(o?: { skipCache?: boolean }): Promise<ExchangeProbeResult>;
  getOrganizationConfig(select?: readonly string[]): Promise<ExchangeOrganizationConfig>;
  /** Follows `@odata.nextLink` inside the client; `resultSize` is 1 to 1,000. */
  listDistributionGroupMembers(
    identity: string,
    o?: { resultSize?: number },
  ): AsyncIterable<ExchangeRecipient>;
}
