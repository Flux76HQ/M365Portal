// `seedDirectory` (T-C-014, FR-C-601): a deterministic directory for the tests and the e2e topology of
// Phase C: 1,200 users and 150 groups of every kind, nested groups, members the product cannot read,
// owners (users and a service principal), a 250-member group, a hidden-membership group, guests,
// disabled users, a user without a manager, a user whose `userType` is `null`, and names with quotes
// and diacritics. Everything is made up (`contoso-fake.example`); no name is a real person.
//
// Deterministic: the same `seed` gives the same directory, ids included (ids come from the
// directory's own counters). A failing test prints `SEED_NOTE`-style text from `describeSeed`, so the
// run can be repeated. Generated data comes from the index of a row; the seed picks departments,
// managers and memberships.
import { fakeGuid } from './ids.js';
import type { FakeDirectory, GroupRecord, UserRecord } from './directory.js';

export const DEFAULT_SEED = 20_261_012;
export const SEED_USERS = 1_200;
export const SEED_GROUPS = 150;
/** The domain every seeded address uses. */
export const SEED_DOMAIN = 'contoso-fake.example';

export interface SeedDirectoryOptions {
  readonly seed?: number;
  readonly users?: number;
  readonly groups?: number;
}

export interface SeededDirectory {
  readonly seed: number;
  /** Rows by role in the tests; every id exists in the directory. */
  readonly ids: {
    /** The user at the top of the manager chain: no manager (404 on the manager call). */
    readonly noManagerUser: string;
    /** A user whose manager is `managerOfWithManager`. */
    readonly userWithManager: string;
    readonly managerOfWithManager: string;
    readonly guest: string;
    readonly disabledUser: string;
    /** `userType` is `null` (U72). */
    readonly nullTypeUser: string;
    /** The display name has an apostrophe: `O'Neil`. */
    readonly quoteUser: string;
    readonly diacriticUser: string;
    /** No mail address (EC-C10). */
    readonly noMailUser: string;
    /** 250 direct members, users only. */
    readonly bigGroup: string;
    readonly hiddenGroup: string;
    readonly m365Group: string;
    readonly securityGroup: string;
    readonly mailSecurityGroup: string;
    readonly distributionGroup: string;
    readonly dynamicGroup: string;
    readonly syncedGroup: string;
    readonly quoteGroup: string;
    /** Has a device, a service principal and a contact among its members, and a service principal as owner. */
    readonly mixedGroup: string;
    /** Contains `nestedGroup`; a user of `nestedGroup` is transitively in this one. */
    readonly outerGroup: string;
    readonly nestedGroup: string;
  };
  /** Ids of the groups by kind, in creation order. */
  readonly kinds: {
    readonly m365: readonly string[];
    readonly security: readonly string[];
    readonly mailsecurity: readonly string[];
    readonly distribution: readonly string[];
  };
}

/** What to print when a test fails on seeded data, so the run can be repeated. */
export function describeSeed(seeded: Pick<SeededDirectory, 'seed'>): string {
  return `seedDirectory seed=${String(seeded.seed)}`;
}

/** A small deterministic generator (mulberry32): the seed is the only input. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const GIVEN = [
  'Anna',
  'Bram',
  'Carla',
  'Daan',
  'Eva',
  'Finn',
  'Gerda',
  'Hugo',
  'Iris',
  'Jens',
  'Kim',
  'Lars',
  'Mila',
  'Noah',
  'Olga',
  'Pim',
  'Quinn',
  'Roos',
  'Sven',
  'Tess',
  'Uma',
  'Vince',
  'Wout',
  'Xena',
  'Yara',
  'Zeno',
  'Amélie',
  'Björn',
  'Chloé',
  'Dmitri',
] as const;
const SURNAME = [
  'Jansen',
  'de Vries',
  'Bakker',
  'Visser',
  'Smit',
  'Meijer',
  'de Boer',
  'Mulder',
  'de Groot',
  'Bos',
  'Vos',
  'Peters',
  'Hendriks',
  'van Dijk',
  'Dekker',
  'Brouwer',
  'de Wit',
  'Dijkstra',
  'Smits',
  'de Graaf',
  'Müller',
  'Łukasz',
  'Ångström',
  'Søren',
  'Çelik',
  'García',
  'Nguyen',
  'Kowalski',
  'Rossi',
  'Haddad',
] as const;
const DEPARTMENTS = ['Finance', 'Sales', 'IT', 'HR', 'Legal', 'Operations', 'Marketing'] as const;
const TITLES = ['Analyst', 'Manager', 'Engineer', 'Coordinator', 'Specialist', 'Advisor'] as const;
const OFFICES = ['Amsterdam', 'Utrecht', 'Rotterdam', 'Brussels', 'Remote'] as const;

/** Lower-case ASCII for an address: the diacritics are dropped, spaces become dots. */
function ascii(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '')
    .toLowerCase();
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`the seed has no ${what}`);
  return value;
}

export function seedDirectory(
  directory: FakeDirectory,
  options: SeedDirectoryOptions = {},
): SeededDirectory {
  const seed = options.seed ?? DEFAULT_SEED;
  const userCount = options.users ?? SEED_USERS;
  const groupCount = options.groups ?? SEED_GROUPS;
  if (userCount < 300 || groupCount < 40)
    throw new RangeError('the seed needs 300 users and 40 groups at least');
  const next = generator(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;

  // ---- users -------------------------------------------------------------------------------------
  const users: UserRecord[] = [];
  for (let index = 0; index < userCount; index += 1) {
    const given = GIVEN[index % GIVEN.length] as string;
    const surname = SURNAME[Math.floor(index / GIVEN.length) % SURNAME.length] as string;
    const displayName = `${given} ${surname}`;
    const tag = String(index + 1).padStart(4, '0');
    const local = `${ascii(given)}.${ascii(surname)}.${tag}`;
    const guest = index % 40 === 7;
    users.push(
      directory.addUser({
        // Ids of their own, so the order of equal display names does not depend on how many users
        // a test added to the same fake tenant before the seed ran.
        id: fakeGuid('seed-user', index + 1),
        userPrincipalName: guest
          ? `${local}_partner.example#EXT#@contoso-fake.onmicrosoft.com`
          : `${local}@${SEED_DOMAIN}`,
        displayName,
        mail: guest ? `${local}@partner.example` : `${local}@${SEED_DOMAIN}`,
        department: index % 17 === 3 ? null : DEPARTMENTS[index % DEPARTMENTS.length],
        accountEnabled: index % 13 !== 5,
        givenName: given,
        surname,
        jobTitle: `${pick(TITLES)} ${DEPARTMENTS[index % DEPARTMENTS.length] as string}`,
        officeLocation: pick(OFFICES),
        userType: guest ? 'Guest' : 'Member',
        onPremisesSyncEnabled: index % 5 === 0 ? true : null,
        createdDateTime: `2022-0${String((index % 9) + 1)}-1${String(index % 10)}T08:15:0${String(index % 10)}Z`,
      }),
    );
  }
  // The named rows of the tests.
  const at = (index: number): UserRecord => must(users[index], `user ${String(index)}`);
  const quoteUser = at(1);
  Object.assign(quoteUser, { displayName: "Zoë O'Neil", givenName: 'Zoë', surname: "O'Neil" });
  const diacriticUser = at(2);
  Object.assign(diacriticUser, {
    displayName: 'Ångström Çelik',
    givenName: 'Ångström',
    surname: 'Çelik',
  });
  const nullTypeUser = at(3);
  nullTypeUser.userType = null;
  const noMailUser = at(4);
  noMailUser.mail = null;
  const guest = must(
    users.find((user) => user.userType === 'Guest'),
    'guest',
  );
  const disabledUser = must(
    users.find((user) => user.accountEnabled === false && user.userType === 'Member'),
    'disabled user',
  );

  // The manager chain: the first user has none; everyone else reports to someone earlier.
  const noManagerUser = at(0);
  for (let index = 1; index < users.length; index += 1) {
    at(index).managerId = at(Math.floor(next() * index)).id;
  }
  const userWithManager = at(10);
  const managerOfWithManager = must(
    directory.users.get(must(userWithManager.managerId, 'manager id')),
    'manager',
  );

  // ---- groups ------------------------------------------------------------------------------------
  const kinds = {
    m365: [] as string[],
    security: [] as string[],
    mailsecurity: [] as string[],
    distribution: [] as string[],
  };
  const groups: GroupRecord[] = [];
  const GROUP_TOPICS = [
    'Finance',
    'Sales',
    'Helpdesk',
    'Projects',
    'Board',
    'Legal',
    'Facilities',
    'Training',
    'Security',
    'Partners',
  ] as const;
  // Eight named groups follow the generated ones, so the directory holds `groupCount` in all.
  const NAMED_GROUPS = 8;
  for (let index = 0; index < groupCount - NAMED_GROUPS; index += 1) {
    const topic = GROUP_TOPICS[index % GROUP_TOPICS.length] as string;
    const tag = String(index + 1).padStart(3, '0');
    const slot = index % 10;
    const base = {
      id: fakeGuid('seed-group', index + 1),
      displayName: `${topic} ${tag}`,
      mailNickname: `${ascii(topic)}${tag}`,
    };
    let group: GroupRecord;
    if (slot < 3) {
      // Microsoft 365 group.
      group = directory.addGroup({
        ...base,
        mail: `${base.mailNickname}@${SEED_DOMAIN}`,
        groupTypes: ['Unified'],
        mailEnabled: true,
        securityEnabled: false,
        visibility: slot === 0 ? 'Public' : 'Private',
        description: `${topic} team site`,
      });
      kinds.m365.push(group.id);
    } else if (slot < 6) {
      group = directory.addGroup({
        ...base,
        mail: null,
        groupTypes: [],
        mailEnabled: false,
        securityEnabled: true,
        description: `${topic} access group`,
      });
      kinds.security.push(group.id);
    } else if (slot < 8) {
      group = directory.addGroup({
        ...base,
        mail: `${base.mailNickname}@${SEED_DOMAIN}`,
        groupTypes: [],
        mailEnabled: true,
        securityEnabled: true,
        onPremisesSyncEnabled: slot === 6 ? true : null,
      });
      kinds.mailsecurity.push(group.id);
    } else {
      group = directory.addGroup({
        ...base,
        mail: `${base.mailNickname}@${SEED_DOMAIN}`,
        groupTypes: [],
        mailEnabled: true,
        securityEnabled: false,
        onPremisesSyncEnabled: slot === 9 && index % 20 === 9 ? true : null,
      });
      kinds.distribution.push(group.id);
    }
    groups.push(group);
    // A few members and owners everywhere.
    const memberCount = 3 + Math.floor(next() * 12);
    for (let m = 0; m < memberCount; m += 1)
      directory.addMember(group.id, at(Math.floor(next() * users.length)).id);
    if (kinds.m365.includes(group.id) || kinds.security.includes(group.id)) {
      directory.addOwner(group.id, at(Math.floor(next() * users.length)).id);
    }
  }
  const firstOf = (list: readonly string[]): GroupRecord =>
    must(directory.groups.get(must(list[0], 'group of the kind')), 'group');

  const m365Group = firstOf(kinds.m365);
  const securityGroup = firstOf(kinds.security);
  const mailSecurityGroup = firstOf(kinds.mailsecurity.slice(1));
  const distributionGroup = firstOf(kinds.distribution);
  const syncedGroup = firstOf(kinds.mailsecurity);

  // The 250-member group (users only, in creation order) with an owner.
  const bigGroup = directory.addGroup({
    displayName: 'Everyone 250',
    mailNickname: 'everyone250',
    mail: `everyone250@${SEED_DOMAIN}`,
    groupTypes: ['Unified'],
    mailEnabled: true,
    securityEnabled: false,
    visibility: 'Public',
  });
  kinds.m365.push(bigGroup.id);
  for (let index = 0; index < 250; index += 1) directory.addMember(bigGroup.id, at(index).id);
  directory.addOwner(bigGroup.id, at(0).id);
  directory.addOwner(bigGroup.id, at(1).id);

  // A hidden-membership group: its members are not listed to the product.
  const hiddenGroup = directory.addGroup({
    displayName: 'Board (hidden)',
    mailNickname: 'boardhidden',
    mail: `boardhidden@${SEED_DOMAIN}`,
    groupTypes: ['Unified'],
    mailEnabled: true,
    securityEnabled: false,
    hiddenMembership: true,
  });
  kinds.m365.push(hiddenGroup.id);
  directory.addMember(hiddenGroup.id, at(5).id);
  directory.addMember(hiddenGroup.id, at(6).id);
  directory.addOwner(hiddenGroup.id, at(5).id);

  // A dynamic-membership group with a rule (the rule is not on the wire of Phase C).
  const dynamicGroup = directory.addGroup({
    displayName: 'Finance (dynamic)',
    mailNickname: 'financedynamic',
    groupTypes: ['DynamicMembership'],
    mailEnabled: false,
    securityEnabled: true,
    membershipRule: 'user.department -eq "Finance"',
  });
  kinds.security.push(dynamicGroup.id);
  for (const user of users.filter((candidate) => candidate.department === 'Finance').slice(0, 20)) {
    directory.addMember(dynamicGroup.id, user.id);
  }

  // Names with a quote and with diacritics.
  const quoteGroup = directory.addGroup({
    displayName: "O'Brien Team",
    mailNickname: 'obrienteam',
    mail: `obrienteam@${SEED_DOMAIN}`,
    groupTypes: ['Unified'],
    mailEnabled: true,
    securityEnabled: false,
    visibility: 'Private',
  });
  kinds.m365.push(quoteGroup.id);
  directory.addMember(quoteGroup.id, quoteUser.id);
  directory.addOwner(quoteGroup.id, quoteUser.id);
  const accented = directory.addGroup({
    displayName: 'Équipe Zürich',
    mailNickname: 'equipezurich',
    groupTypes: [],
    mailEnabled: false,
    securityEnabled: true,
  });
  kinds.security.push(accented.id);
  directory.addMember(accented.id, diacriticUser.id);

  // Members and owners the product cannot read: a device, a service principal, a contact.
  const mixedGroup = directory.addGroup({
    displayName: 'Mixed objects',
    mailNickname: 'mixedobjects',
    groupTypes: [],
    mailEnabled: false,
    securityEnabled: true,
  });
  kinds.security.push(mixedGroup.id);
  directory.addMember(mixedGroup.id, at(7).id);
  directory.addMember(
    mixedGroup.id,
    directory.addOtherObject('#microsoft.graph.device', 'Laptop 1').id,
  );
  const servicePrincipal = directory.addOtherObject(
    '#microsoft.graph.servicePrincipal',
    'Automation app',
  );
  directory.addMember(mixedGroup.id, servicePrincipal.id);
  directory.addMember(
    mixedGroup.id,
    directory.addOtherObject('#microsoft.graph.orgContact', 'Partner contact').id,
  );
  directory.addOwner(mixedGroup.id, servicePrincipal.id);

  // Nesting: a user of the nested group is transitively a member of the outer one.
  const nestedGroup = directory.addGroup({
    displayName: 'Nested team',
    mailNickname: 'nestedteam',
    groupTypes: [],
    mailEnabled: false,
    securityEnabled: true,
  });
  kinds.security.push(nestedGroup.id);
  const outerGroup = directory.addGroup({
    displayName: 'Outer team',
    mailNickname: 'outerteam',
    groupTypes: [],
    mailEnabled: false,
    securityEnabled: true,
  });
  kinds.security.push(outerGroup.id);
  directory.addMember(nestedGroup.id, at(8).id);
  directory.addMember(outerGroup.id, nestedGroup.id);

  return {
    seed,
    ids: {
      noManagerUser: noManagerUser.id,
      userWithManager: userWithManager.id,
      managerOfWithManager: managerOfWithManager.id,
      guest: guest.id,
      disabledUser: disabledUser.id,
      nullTypeUser: nullTypeUser.id,
      quoteUser: quoteUser.id,
      diacriticUser: diacriticUser.id,
      noMailUser: noMailUser.id,
      bigGroup: bigGroup.id,
      hiddenGroup: hiddenGroup.id,
      m365Group: m365Group.id,
      securityGroup: securityGroup.id,
      mailSecurityGroup: mailSecurityGroup.id,
      distributionGroup: distributionGroup.id,
      dynamicGroup: dynamicGroup.id,
      syncedGroup: syncedGroup.id,
      quoteGroup: quoteGroup.id,
      mixedGroup: mixedGroup.id,
      outerGroup: outerGroup.id,
      nestedGroup: nestedGroup.id,
    },
    kinds,
  };
}
