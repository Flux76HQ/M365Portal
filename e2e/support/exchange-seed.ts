// The data of the fake Exchange behind the `pwsh` shim (Phase D, T-D-180). The server under test finds
// `e2e/support/pwsh-shim/pwsh` on its PATH (`servers.ts`, `makePwshShimDirectory`), which starts the fake
// worker; that worker reads `seed.json` from the shim directory of the run on EVERY request, so writing a
// seed here replaces the data at once and drops the journal of earlier writes: that is the reseed between
// tests, no restart. The format is `StandInSeed` (`apps/server/test/fakes/fake-tenant/exchange/standin-seed.ts`).
//
// The people of the lists are the principals of the fake directory: the stand-in matches a list member to a
// user of the panel by `externalDirectoryObjectId`, and a user is added by the mail address Graph reports
// (the user principal name, `directory.ts` of the fake Graph).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pwshShimDirectory, readState } from '../servers.js';
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

function seedFile(): string {
  return join(pwshShimDirectory(readState().runDir), 'seed.json');
}

// The worker tells a changed seed by the hash of the file text. Writing the same seed again would keep the
// journal of the earlier writes, so every write ends with a different amount of trailing white space (JSON
// does not mind): a reseed is always a reseed. The count lives in a file next to the seed, NOT in a variable of
// this module: Playwright starts a new worker process after every failed test, and a counter that began at 1
// again would make the next seed byte for byte the one the fake already holds (no reseed, the writes of the
// test before stay). That is what happened to the first visual run, where every test fails for want of a baseline.
function nextGeneration(): number {
  const file = join(pwshShimDirectory(readState().runDir), 'seed.generation');
  let current = 0;
  try {
    current = Number(readFileSync(file, 'utf8')) || 0;
  } catch {
    // the first seed of the run
  }
  const next = current + 1;
  writeFileSync(file, String(next));
  return next;
}

/** Replaces the data of the fake Exchange (and forgets every write made since the last seed). */
export function seedExchange(seed: ExchangeSeed = standardSeed()): void {
  writeFileSync(seedFile(), `${JSON.stringify(seed)}${'\n'.repeat(nextGeneration())}`);
}

/**
 * The shim goes back to its own default seed. The next request replaces the state, so this also forgets
 * the writes. Removing the file is how a spec ends: the run directory is removed with the run anyway.
 */
export function clearExchangeSeed(): void {
  rmSync(seedFile(), { force: true });
}

/** The seed on disk, or `undefined` (a spec that edits the seed it started from). */
export function currentExchangeSeed(): ExchangeSeed | undefined {
  return existsSync(seedFile())
    ? (JSON.parse(readFileSync(seedFile(), 'utf8')) as ExchangeSeed)
    : undefined;
}
