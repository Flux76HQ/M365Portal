// The data of the fake Exchange (Phase D, T-D-180; ADR 0182). The server under test calls `InvokeCommand` on the
// fake tenant, which holds the Exchange state in memory; seeding is a control operation (`exchange.seed`) that
// replaces that state at once and forgets every write made since: the reseed between tests, no restart. The
// format is `StandInSeed` (`apps/server/test/fakes/fake-tenant/exchange/standin-seed.ts`).
//
// The people of the lists are the principals of the fake directory: the fake matches a list member to a
// user of the panel by `externalDirectoryObjectId`, and a user is added by the mail address Graph reports
// (the user principal name, `directory.ts` of the fake Graph).
import { FakeControl } from './fake-control.js';
import { PRINCIPALS, type PrincipalName } from './principals.js';

export interface SeedRecipient {
  readonly key: string;
  readonly displayName: string;
  readonly primarySmtpAddress: string;
  readonly recipientTypeDetails?: string;
  readonly isDirSynced?: boolean;
  readonly hidden?: boolean;
  readonly externalDirectoryObjectId?: string;
}

export interface SeedContact {
  readonly displayName: string;
  readonly alias: string;
  readonly externalEmailAddress: string;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly isDirSynced?: boolean;
}

export interface SeedGroup {
  readonly name: string;
  readonly primarySmtpAddress: string;
  readonly displayName?: string;
  readonly alias?: string;
  readonly recipientTypeDetails?: string;
  readonly isDirSynced?: boolean;
  readonly managedByApp?: boolean;
  readonly members?: readonly string[];
}

export interface ExchangeSeed {
  readonly recipients?: readonly SeedRecipient[];
  readonly contacts?: readonly SeedContact[];
  readonly groups?: readonly SeedGroup[];
  readonly bulk?: {
    readonly groups?: number;
    readonly contacts?: number;
    readonly prefix?: string;
  };
  readonly connect?: 'ok' | { readonly error: string };
  readonly readBackDelay?: number;
}

/** A user of the panel's directory as a recipient of Exchange: same object id, same address. */
export function recipientOf(principal: PrincipalName, key: string): SeedRecipient {
  const person = PRINCIPALS[principal];
  return {
    key,
    displayName: person.displayName,
    primarySmtpAddress: person.upn,
    externalDirectoryObjectId: person.oid,
  };
}

/** The people of the standard seed, by key. */
export const PEOPLE = {
  rita: recipientOf('reader', 'rita'),
  hanna: recipientOf('helpdesk', 'hanna'),
  oscar: recipientOf('operator', 'oscar'),
  adam: recipientOf('administrator', 'adam'),
  gerrit: recipientOf('group-member', 'gerrit'),
} as const;

export const SEEDED_CONTACTS = {
  carol: {
    displayName: 'Carol Bakker',
    alias: 'carol.bakker',
    externalEmailAddress: 'carol@partner.example',
    firstName: 'Carol',
    lastName: 'Bakker',
  },
  dan: {
    displayName: 'Dan Visser',
    alias: 'dan.visser',
    externalEmailAddress: 'dan@partner.example',
  },
  sam: {
    displayName: 'Sam Synced',
    alias: 'sam.synced',
    externalEmailAddress: 'sam@partner.example',
    isDirSynced: true,
  },
} as const satisfies Record<string, SeedContact>;

/** The lists of the standard seed: names the specs search for and look at. */
export const SEEDED_LISTS = {
  marketing: 'Marketing',
  sales: 'Sales',
  archive: 'Archive',
  legacy: 'Legacy synced',
  dynamic: 'Everyone dynamic',
} as const;

/** The standard seed: five users, three contacts (one synchronised), five lists of every kind. */
export function standardSeed(): ExchangeSeed {
  return {
    recipients: Object.values(PEOPLE),
    contacts: Object.values(SEEDED_CONTACTS),
    groups: [
      {
        name: SEEDED_LISTS.marketing,
        primarySmtpAddress: 'marketing@contoso-fake.example',
        managedByApp: true,
        members: ['rita', 'hanna'],
      },
      {
        name: SEEDED_LISTS.sales,
        primarySmtpAddress: 'sales@contoso-fake.example',
        managedByApp: true,
        members: ['oscar'],
      },
      {
        name: SEEDED_LISTS.archive,
        primarySmtpAddress: 'archive@contoso-fake.example',
        managedByApp: true,
        members: [],
      },
      {
        name: SEEDED_LISTS.legacy,
        primarySmtpAddress: 'legacy@contoso-fake.example',
        isDirSynced: true,
        members: ['rita'],
      },
      {
        name: SEEDED_LISTS.dynamic,
        primarySmtpAddress: 'everyone-dynamic@contoso-fake.example',
        recipientTypeDetails: 'DynamicDistributionGroup',
        managedByApp: true,
      },
    ],
  };
}

/** Replaces the data of the fake Exchange (and forgets every write made since the last seed). */
export async function seedExchange(seed: ExchangeSeed = standardSeed()): Promise<void> {
  await new FakeControl('a').call('exchange.seed', { seed });
}

/**
 * The fake goes back to the default seed of the stand-in (`DEFAULT_SEED`): the next test starts from known data
 * and the writes of the last one are gone.
 */
export async function clearExchangeSeed(): Promise<void> {
  await new FakeControl('a').call('exchange.seed', { seed: null });
}
