// The seed of the fake Exchange: the data it starts with (the e2e control surface loads it, `exchange.seed`),
// as a small JSON document, so that the e2e topology can exercise lists and contacts end to end with
// data it chooses. Test support only; nothing in `src/` reads it.
//
//   {
//     "recipients": [{ "key": "anna", "displayName": "Anna Jansen", "primarySmtpAddress": "anna@x.example",
//                      "recipientTypeDetails"?: "UserMailbox", "isDirSynced"?, "hidden"?,
//                      "externalDirectoryObjectId"?: "<the user's object id in the fake Graph>" }],
//     "contacts":   [{ "displayName", "alias", "externalEmailAddress", "firstName"?, "lastName"?, "isDirSynced"? }],
//     "groups":     [{ "name", "primarySmtpAddress", "displayName"?, "alias"?, "recipientTypeDetails"?,
//                      "isDirSynced"?, "managedByApp"?, "members"?: ["anna", "bob@x.example"] }],
//     "bulk":       { "groups"?: 10001, "contacts"?: 0, "prefix"?: "Bulk" },   // many rows, for `narrow_search`
//     "connect"?:   "ok" | { "error": "role_pending" | "permission_denied" | ... },
//     "appHoldsOrganizationManagement"?, "defaultResultSize"?, "readBackDelay"?
//   }
//
// A member names a recipient by its `key` or by its primary address. The same seed always builds the same
// state (GUIDs come from a counter), which is what lets the journal of writes be replayed after a restart.
import { EXCHANGE_COMMAND_CODES } from '../../../../src/ports/errors.js';
import { z } from 'zod';
import { FakeExchangeState, type FakeRecipient } from './state.js';

const Text = z.string().min(1).max(256);

const SeedSchema = z.strictObject({
  recipients: z
    .array(
      z.strictObject({
        key: Text,
        displayName: Text,
        primarySmtpAddress: Text,
        recipientTypeDetails: Text.optional(),
        isDirSynced: z.boolean().optional(),
        hidden: z.boolean().optional(),
        externalDirectoryObjectId: Text.optional(),
      }),
    )
    .default([]),
  contacts: z
    .array(
      z.strictObject({
        displayName: Text,
        alias: Text,
        externalEmailAddress: Text,
        firstName: Text.nullable().optional(),
        lastName: Text.nullable().optional(),
        isDirSynced: z.boolean().optional(),
      }),
    )
    .default([]),
  groups: z
    .array(
      z.strictObject({
        name: Text,
        primarySmtpAddress: Text,
        displayName: Text.optional(),
        alias: Text.optional(),
        recipientTypeDetails: Text.optional(),
        isDirSynced: z.boolean().optional(),
        managedByApp: z.boolean().optional(),
        members: z.array(Text).default([]),
      }),
    )
    .default([]),
  bulk: z
    .strictObject({
      groups: z.number().int().min(0).max(50_000).optional(),
      contacts: z.number().int().min(0).max(50_000).optional(),
      prefix: z.string().min(1).max(40).optional(),
    })
    .optional(),
  connect: z
    .union([z.literal('ok'), z.strictObject({ error: z.enum(EXCHANGE_COMMAND_CODES) })])
    .default('ok'),
  appHoldsOrganizationManagement: z.boolean().optional(),
  defaultResultSize: z.number().int().min(1).max(10_000_000).optional(),
  readBackDelay: z.number().int().min(0).max(100).optional(),
});

export type StandInSeed = z.infer<typeof SeedSchema>;

/** Throws a plain `Error` for a document that is not a seed (the message names the problem, never a value). */
export function parseSeed(json: unknown): StandInSeed {
  const parsed = SeedSchema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
    throw new Error(`the stand-in seed is invalid at: ${where}`);
  }
  return parsed.data;
}

/** What a stand-in starts with when no seed file exists: a few lists, people and one contact. */
export const DEFAULT_SEED: StandInSeed = parseSeed({
  recipients: [
    {
      key: 'anna',
      displayName: 'Anna Jansen',
      primarySmtpAddress: 'anna.jansen@contoso-fake.example',
    },
    {
      key: 'bob',
      displayName: 'Bob de Vries',
      primarySmtpAddress: 'bob.devries@contoso-fake.example',
    },
    {
      key: 'carla',
      displayName: 'Carla Smit',
      primarySmtpAddress: 'carla.smit@contoso-fake.example',
    },
  ],
  contacts: [
    {
      displayName: 'Carol Bakker',
      alias: 'carol.bakker',
      externalEmailAddress: 'carol@partner.example',
      firstName: 'Carol',
      lastName: 'Bakker',
    },
    { displayName: 'Dan Visser', alias: 'dan.visser', externalEmailAddress: 'dan@partner.example' },
  ],
  groups: [
    {
      name: 'Marketing',
      primarySmtpAddress: 'marketing@contoso-fake.example',
      managedByApp: true,
      members: ['anna', 'bob'],
    },
    {
      name: 'Sales',
      primarySmtpAddress: 'sales@contoso-fake.example',
      managedByApp: true,
      members: ['carla'],
    },
    {
      name: 'Legacy synced',
      primarySmtpAddress: 'legacy@contoso-fake.example',
      isDirSynced: true,
      members: ['anna'],
    },
  ],
});

/** The state a seed describes. Deterministic. */
export function buildState(seed: StandInSeed): FakeExchangeState {
  return applySeed(new FakeExchangeState(), seed);
}

/** Loads a seed into a state that is empty (a new one, or one that was just reset). */
export function applySeed(state: FakeExchangeState, seed: StandInSeed): FakeExchangeState {
  const byKey = new Map<string, FakeRecipient>();
  const byAddress = new Map<string, FakeRecipient>();
  for (const spec of seed.recipients) {
    const recipient = state.addRecipient({
      displayName: spec.displayName,
      primarySmtpAddress: spec.primarySmtpAddress,
      ...(spec.recipientTypeDetails === undefined
        ? {}
        : { recipientTypeDetails: spec.recipientTypeDetails }),
      ...(spec.isDirSynced === undefined ? {} : { isDirSynced: spec.isDirSynced }),
      ...(spec.hidden === undefined ? {} : { hidden: spec.hidden }),
      ...(spec.externalDirectoryObjectId === undefined
        ? {}
        : { externalDirectoryObjectId: spec.externalDirectoryObjectId }),
    });
    byKey.set(spec.key, recipient);
    byAddress.set(spec.primarySmtpAddress.toLowerCase(), recipient);
  }
  for (const spec of seed.contacts) {
    state.addMailContact({
      displayName: spec.displayName,
      alias: spec.alias,
      externalEmailAddress: spec.externalEmailAddress,
      ...(spec.firstName === undefined ? {} : { firstName: spec.firstName }),
      ...(spec.lastName === undefined ? {} : { lastName: spec.lastName }),
      ...(spec.isDirSynced === undefined ? {} : { isDirSynced: spec.isDirSynced }),
    });
  }
  for (const spec of seed.groups) {
    const members = spec.members.map((ref) => {
      const found = byKey.get(ref) ?? byAddress.get(ref.toLowerCase());
      if (found === undefined)
        throw new Error('the stand-in seed names a member that is not a recipient');
      return found;
    });
    state.addDistributionGroup({
      name: spec.name,
      primarySmtpAddress: spec.primarySmtpAddress,
      members,
      ...(spec.displayName === undefined ? {} : { displayName: spec.displayName }),
      ...(spec.alias === undefined ? {} : { alias: spec.alias }),
      ...(spec.recipientTypeDetails === undefined
        ? {}
        : { recipientTypeDetails: spec.recipientTypeDetails }),
      ...(spec.isDirSynced === undefined ? {} : { isDirSynced: spec.isDirSynced }),
      ...(spec.managedByApp === undefined ? {} : { managedByApp: spec.managedByApp }),
    });
  }
  const prefix = seed.bulk?.prefix ?? 'Bulk';
  for (let n = 1; n <= (seed.bulk?.groups ?? 0); n += 1) {
    const label = String(n).padStart(5, '0');
    state.addDistributionGroup({
      name: `${prefix} group ${label}`,
      primarySmtpAddress: `${prefix.toLowerCase()}-group-${label}@contoso-fake.example`,
      managedByApp: true,
    });
  }
  for (let n = 1; n <= (seed.bulk?.contacts ?? 0); n += 1) {
    const label = String(n).padStart(5, '0');
    state.addMailContact({
      displayName: `${prefix} contact ${label}`,
      alias: `${prefix.toLowerCase()}-contact-${label}`,
      externalEmailAddress: `${prefix.toLowerCase()}-contact-${label}@partner.example`,
    });
  }
  if (seed.appHoldsOrganizationManagement !== undefined) {
    state.setAppHoldsOrganizationManagement(seed.appHoldsOrganizationManagement);
  }
  if (seed.defaultResultSize !== undefined) state.setDefaultResultSize(seed.defaultResultSize);
  if (seed.readBackDelay !== undefined) state.setReadBackDelay(seed.readBackDelay);
  return state;
}
