// The Phase B rules of the documentation contract (T-B-420, FR-B-709, FR-B-711, FR-B-713 doc half,
// EB-30, EB-32, SC-B-017, XB35). Every rule is a guard: a function that throws with the reason when the
// document breaks it. `docs-contract.test.ts` runs each on the real document and on that document with
// one required item removed (the negative fixtures), so a guard that stopped looking is noticed.
//
// The guards read the documents as data. What they require comes from the Phase B spec (6.8, 6.9) and
// plan (16, 17), and, where a document must equal a table of the spec (the role matrix), from the spec
// file itself, parsed here independently of the code.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeTokens, findTable, headingsOf, sectionOf, stripMarkup, tablesIn } from './markdown.js';

export type Needle = readonly [pattern: RegExp | string, what: string];

const flat = (text: string): string => text.replace(/\s+/g, ' ');

export function has(text: string, pattern: RegExp | string): boolean {
  return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(flat(text));
}

/** Throws `missing: <what>` for the first needle the text does not hold. */
export function requireAll(label: string, text: string, needles: readonly Needle[]): void {
  const missing = needles.filter(([pattern]) => !has(text, pattern)).map(([, what]) => what);
  if (missing.length > 0) throw new Error(`${label}: missing: ${missing.join('; ')}`);
}

export function requireHeadings(
  label: string,
  markdown: string,
  headings: readonly Needle[],
): void {
  const texts = headingsOf(markdown).map((heading) => heading.text);
  const missing = headings
    .filter(([pattern]) => !texts.some((text) => has(text, pattern)))
    .map(([, what]) => what);
  if (missing.length > 0) throw new Error(`${label}: missing section: ${missing.join('; ')}`);
}

/** The English part (before the heading "Nederlands" of level 1 or 2) and the Dutch part (from it). */
export function halves(markdown: string): { english: string; dutch: string } {
  const lines = markdown.split('\n');
  let inFence = false;
  let at = -1;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && at === -1 && /^#{1,2}\s+Nederlands\b/.test(line)) at = index;
  });
  if (at === -1) throw new Error('the document has no Dutch section (a heading "Nederlands")');
  return { english: lines.slice(0, at).join('\n'), dutch: lines.slice(at).join('\n') };
}

// =============================================================================================
// README (FR-B-709, US-B13, spec 6.8)
// =============================================================================================

const FIRST_RUN_TOKENS: readonly Needle[] = [
  ['generate-app-key', 'the command that creates the key (generate-app-key)'],
  ['docker run', 'docker run'],
  ['APP_KEY', 'APP_KEY'],
  ['docker exec', 'docker exec (print the setup token)'],
  ['setup-token', 'the setup-token command'],
  ['/setup', 'the address /setup'],
  ['Global Administrator', 'the administrator the wizard needs (Global Administrator)'],
  ['Privileged Role Administrator', 'Privileged Role Administrator'],
  ['Application Administrator', 'Application Administrator'],
  ['http://localhost', 'http://localhost'],
  ['HOST_PORT', 'the port variable HOST_PORT'],
  ['secrets/app_key', 'the Compose secret file secrets/app_key'],
];

export function assertReadmePhaseB(markdown: string): void {
  const { english, dutch } = halves(markdown);
  requireHeadings('README (English)', english, [[/first run|first start/i, 'a first-run section']]);
  requireHeadings('README (Dutch)', dutch, [
    [/eerste (keer|start)|eerste gebruik/i, 'a first-run section (Eerste start)'],
  ]);
  const englishRun = sectionOf(english, /first run|first start/i) ?? '';
  const dutchRun = sectionOf(dutch, /eerste (keer|start)|eerste gebruik/i) ?? '';
  requireAll('README first run (English)', englishRun, [
    ...FIRST_RUN_TOKENS,
    [/on behalf of your organi[sz]ation/i, 'leaving "Consent on behalf of your organization" off'],
    [/https/i, 'the https alternative'],
    [/Cloud Application Administrator/, 'Cloud Application Administrator'],
  ]);
  requireAll('README first run (Dutch)', dutchRun, [
    ...FIRST_RUN_TOKENS,
    [
      /namens (je|uw) organisatie|on behalf of your organi[sz]ation/i,
      'de toestemming namens de organisatie niet geven',
    ],
    [/beheerder/i, 'de Nederlandse tekst over de beheerder'],
    [/https/i, 'https'],
  ]);
  // The order of the steps: key, start, token, open /setup, sign in (both languages).
  for (const [label, text] of [
    ['English', englishRun],
    ['Dutch', dutchRun],
  ] as const) {
    const order = ['generate-app-key', 'docker run', 'docker exec', '/setup'].map((token) =>
      text.indexOf(token),
    );
    if (
      order.some((index) => index < 0) ||
      order.some((index, i) => i > 0 && index < (order[i - 1] ?? -1))
    ) {
      throw new Error(
        `README first run (${label}): the steps are not in order (key, start, token, /setup)`,
      );
    }
  }
  if (/PREVIEW_MODE\s*=\s*true/.test(markdown)) {
    throw new Error(
      'README still tells the reader to start with PREVIEW_MODE=true (removed in Phase B)',
    );
  }
}

// =============================================================================================
// docs/operations.md (FR-B-703, FR-B-704, FR-B-709, EB-11, EB-30, EB-31, EB-32, B-26)
// =============================================================================================

export function assertOperationsPhaseB(markdown: string): void {
  const { english, dutch } = halves(markdown);
  requireHeadings('operations.md', english, [
    [/sealing key|APP_KEY/i, 'the sealing key (APP_KEY): generation, backup, rotation'],
    [/certificate/i, 'the certificate: expiry and renewal'],
    [/setup token/i, 'the setup token and setup-reopen'],
    [/break-glass/i, 'break-glass: hash and use'],
    [/session|timeout/i, 'sessions and timeouts'],
    [/reverse proxy/i, 'the reverse-proxy checklist'],
    [/key compromise|compromised key|leaked key/i, 'the key-compromise procedure'],
    [/outbound/i, 'outbound hosts'],
  ]);
  requireAll('operations.md', english, [
    ['9,437,184', 'the largest accepted request, 9,437,184 bytes'],
    [/Phase B adds no larger/i, 'the sentence that Phase B adds no larger request'],
    [/preserve[^.]*Host/i, 'reverse proxy: preserve Host'],
    [/forward[^.]*cookies/i, 'reverse proxy: forward cookies'],
    [/(not|never) cache[^.]*HTML|no HTML cach/i, 'reverse proxy: no HTML caching'],
    [/at least 9,437,184/i, 'reverse proxy: a body of at least 9,437,184 bytes'],
    ['/api/v1/auth/break-glass', 'restricting /api/v1/auth/break-glass by address at the proxy'],
    [/sovereign|national cloud/i, 'sovereign clouds are unsupported'],
    ['login.microsoftonline.com', 'outbound host login.microsoftonline.com'],
    ['graph.microsoft.com', 'outbound host graph.microsoft.com'],
    ['outlook.office365.com', 'outbound host outlook.office365.com'],
    ['pre-rotate-', 'every pre-rotate-* copy in the key-compromise procedure'],
    ['setup-reopen', 'setup-reopen'],
    [
      /SETUP_TOKEN[^.]*(remove|unset)|(remove|unset)[^.]*SETUP_TOKEN/i,
      'removing SETUP_TOKEN after the first installation',
    ],
    ['rotate-app-key', 'the rotation command rotate-app-key'],
    ['APP_KEY_PREVIOUS', 'APP_KEY_PREVIOUS during a rotation'],
    ['hash-password', 'the hash-password command'],
    [/14 characters/i, 'the 14-character floor of hash-password'],
    ['NODE_USE_ENV_PROXY', 'the NODE_USE_ENV_PROXY hint'],
    [
      /NODE_USE_ENV_PROXY[^|]*UNVERIFIED|UNVERIFIED[^|]*NODE_USE_ENV_PROXY|U41/,
      'the NODE_USE_ENV_PROXY hint marked UNVERIFIED (U41)',
    ],
    [
      /PUBLIC_BASE_URL[^.]*(change|changed)[^.]*(setup-reopen|repair)|(setup-reopen|repair)[^.]*PUBLIC_BASE_URL/i,
      'recovery for a changed PUBLIC_BASE_URL (EB-11)',
    ],
    [/single[- ]replica|one replica/i, 'the single-replica note (B-26)'],
    [
      /lock counters|counters[^.]*(reset|lost)/i,
      'a restart resets the in-memory lock counters (RB-17)',
    ],
    [
      /Key Vault|platform secret/i,
      'a platform secret or Key Vault reference reaches the container as APP_KEY or APP_KEY_FILE',
    ],
    [
      /key[^.]*separately from[^.]*(`?\/data`?|the data volume)|separately from[^.]*backup/i,
      'backup of the key separately from /data',
    ],
  ]);
  requireAll('operations.md (Dutch)', dutch, [
    ['APP_KEY', 'APP_KEY'],
    [/certificaat/i, 'het certificaat'],
    [/setup-token|setuptoken/i, 'het setup-token'],
    [/break-glass/i, 'break-glass'],
    [/reverse proxy/i, 'de reverse proxy'],
    [/gelekt|gecompromitteerd|lek/i, 'de procedure bij een gelekte sleutel'],
    [/soeverein|nationale clouds?/i, 'soevereine clouds worden niet ondersteund'],
    ['9,437,184', 'het grootste verzoek, 9,437,184 bytes'],
    [/uitgaand|login\.microsoftonline\.com/i, 'de uitgaande hosts'],
  ]);
}

// =============================================================================================
// docs/security.md (FR-B-709, plan 16 and 16.1, AM-16, RB-05 to RB-09)
// =============================================================================================

export const STRIDE_SURFACES: readonly string[] = [
  'Setup gate',
  'Wizard and bootstrap token',
  'Sign-in',
  'Sessions',
  'RBAC and policy',
  'Secrets',
  'Break-glass',
  'Microsoft clients',
];
export const ASVS_CHAPTERS: readonly string[] = ['V2', 'V3', 'V4', 'V6', 'V7', 'V8', 'V13'];

export function assertSecurityPhaseB(markdown: string): void {
  const { english, dutch } = halves(markdown);
  requireHeadings('security.md', english, [
    [/phase b.*stride|stride.*phase b/i, 'the Phase B STRIDE tables'],
    [/first-run takeover/i, 'the first-run takeover analysis'],
    [/cookie.*csrf|csrf.*cookie/i, 'the cookie and CSRF design'],
    [/session.*step-up|step-up/i, 'the session and step-up design'],
    [/attack review/i, 'the attack review'],
    [/accepted risks/i, 'the accepted risks'],
    [/key compromise|compromised key/i, 'the key-compromise note'],
  ]);

  // The STRIDE tables: one row per surface, six columns S T R I D E.
  const stride = findTable(
    english,
    (header) =>
      header.length === 7 &&
      /surface/i.test(header[0] ?? '') &&
      ['S', 'T', 'R', 'I', 'D', 'E'].every((letter, index) => header[index + 1] === letter),
  );
  if (stride === undefined)
    throw new Error(
      'security.md: no Phase B STRIDE table (header Surface | S | T | R | I | D | E)',
    );
  for (const surface of STRIDE_SURFACES) {
    const row = stride.rows.find((candidate) =>
      (candidate[0] ?? '').toLowerCase().startsWith(surface.toLowerCase()),
    );
    if (row === undefined) throw new Error(`security.md: the STRIDE table has no row "${surface}"`);
    for (let column = 1; column <= 6; column += 1) {
      if ((row[column] ?? '').trim().length < 8) {
        throw new Error(
          `security.md: the STRIDE row "${surface}" has an empty cell in column ${String(column)}`,
        );
      }
    }
  }

  // ASVS level 2 rows of Phase B.
  const asvs = tablesIn(english).find(
    (table) =>
      /chapter|asvs/i.test(table.header[0] ?? '') &&
      ASVS_CHAPTERS.every((chapter) =>
        table.rows.some((row) => (row[0] ?? '').startsWith(chapter)),
      ),
  );
  if (asvs === undefined) {
    throw new Error(`security.md: no ASVS level 2 table with the rows ${ASVS_CHAPTERS.join(', ')}`);
  }
  for (const chapter of ASVS_CHAPTERS) {
    const row = asvs.rows.find((candidate) => (candidate[0] ?? '').startsWith(chapter));
    if ((row?.slice(1).join(' ').trim().length ?? 0) < 20) {
      throw new Error(`security.md: the ASVS row ${chapter} says nothing`);
    }
  }

  // The attack review of plan 16.1: 25 rows with a residual cell.
  const review = tablesIn(english).find(
    (table) =>
      /^#$/.test(table.header[0] ?? '') && table.header.some((cell) => /residual/i.test(cell)),
  );
  if (review === undefined)
    throw new Error('security.md: no attack-review table (header # | Attack | ... | Residual)');
  if (review.rows.length !== 25) {
    throw new Error(
      `security.md: the attack review has ${String(review.rows.length)} rows, plan 16.1 has 25`,
    );
  }
  review.rows.forEach((row, index) => {
    if (row[0] !== String(index + 1))
      throw new Error(
        `security.md: attack-review row ${String(index + 1)} is numbered "${row[0] ?? ''}"`,
      );
    if (row.some((cell) => cell.trim() === ''))
      throw new Error(`security.md: attack-review row ${String(index + 1)} has an empty cell`);
  });

  requireAll('security.md', english, [
    [
      /not isolated by port|shared (across|between) ports|ports? (do|does) not isolate/i,
      'cookies are not isolated by port (the localhost trade-off)',
    ],
    [/combined (CSRF )?binding|csrf binding/i, 'the combined CSRF binding'],
    [
      /Exchange Administrator[^.]*blast radius|blast radius[^.]*Exchange Administrator/i,
      'the Exchange Administrator blast radius',
    ],
    [/self-signed/i, 'the self-signed certificate trade-off'],
    [/CA certificate|certificate authority/i, 'Learn advises a CA certificate'],
    [/headers[^.]*unchanged|unchanged[^.]*headers/i, 'why the headers did not change'],
    [/owner-verified|cannot prove|simulation cannot/i, 'what the simulation cannot prove'],
    [
      /rotating[^.]*APP_KEY[^.]*(does not|not)[^.]*renew/i,
      'rotating APP_KEY does not renew the certificate',
    ],
    [/DNS rebinding/i, 'DNS rebinding'],
    [/loopback[^.]*Host|Host[^.]*loopback/i, 'the loopback Host rule'],
    [/group owners/i, 'control from the Entra side: group owners'],
    [/application owners/i, 'control from the Entra side: application owners'],
    [/credential holders|holds? credentials/i, 'control from the Entra side: credential holders'],
    ['ODB-17', 'break-glass without a second factor (ODB-17)'],
    [/device code flow/i, 'blocking the device code flow by Conditional Access'],
    ['manual mode', 'manual mode as the alternative'],
    ['docker inspect', 'the docker inspect exposure of -e APP_KEY'],
    [
      /R-08[^.]*(closed|removed)|(closed|removed)[^.]*R-08/i,
      'the Phase A preview-mode risk (R-08) closed',
    ],
    ['RB-17', 'accepted risk RB-17'],
    ['RB-18', 'accepted risk RB-18'],
    [/memory residue/i, 'accepted risk: memory residue of keys'],
    [/gap between[^.]*authorize/i, 'accepted risk: the gap between authorize and a later write'],
    [/break-glass[^.]*(existence|exists)/i, 'accepted risk: the existence of break-glass'],
  ]);
  requireAll('security.md (Dutch)', dutch, [
    [/fase b/i, 'Fase B'],
    ['STRIDE', 'STRIDE'],
    [/break-glass/i, 'break-glass'],
    ['APP_KEY', 'APP_KEY'],
    [/sessie|sessies/i, 'sessies'],
    [/ASVS/, 'ASVS'],
  ]);
}

// =============================================================================================
// docs/permissions.md (FR-B-301, FR-B-502, FR-B-709, B-01; spec 8.2, 8.3, 8.8)
// =============================================================================================

export interface MatrixRow {
  readonly permission: string;
  readonly resource: string;
  readonly roles: readonly string[];
  readonly bestuur: string;
}

/** The matrix of spec 6.9.4, read from the spec file. */
export function specRoleMatrix(specText: string): MatrixRow[] {
  const section = specText.slice(specText.indexOf('#### 6.9.4'), specText.indexOf('#### 6.9.5'));
  const table = tablesIn(section)[0];
  if (table === undefined) throw new Error('spec 6.9.4 has no table');
  return table.rawRows.map((row) => ({
    permission: codeTokens(row[0] ?? '')[0] ?? '',
    resource: stripMarkup(row[1] ?? ''),
    roles: [2, 3, 4, 5, 6].map((index) => stripMarkup(row[index] ?? '')),
    bestuur: stripMarkup(row[7] ?? ''),
  }));
}

export const GRAPH_ROLE_IDS: Readonly<Record<string, string>> = {
  'User.Read.All': 'df021288-bdef-4463-88db-98f22de89214',
  'GroupMember.Read.All': '98830695-27a2-44f7-8c18-0c3ebc9698f6',
  'GroupMember.ReadWrite.All': 'dbaae8cf-10b5-4b86-a4a1-f871c94c6695',
  'Organization.Read.All': '498476ce-e0fe-48b0-b801-37ba7e2685c6',
};

export function assertPermissionsPhaseB(markdown: string, specText: string): void {
  const { english, dutch } = halves(markdown);
  const expected = specRoleMatrix(specText);
  if (expected.length !== 15) throw new Error('spec 6.9.4 does not list 15 permissions');

  const table = findTable(
    english,
    (header) =>
      header.some((cell) => cell.includes('Eigenaar')) && /permission/i.test(header[0] ?? ''),
  );
  if (table === undefined)
    throw new Error('permissions.md: no role matrix (a table with the column Eigenaar)');
  const columns = ['Eigenaar', 'Beheerder', 'Operator', 'Helpdesk', 'Lezer', 'Bestuur'];
  const index = columns.map((name) => table.header.findIndex((cell) => cell.includes(name)));
  if (index.some((position) => position < 0))
    throw new Error('permissions.md: the role matrix lacks a role column');
  const rows = table.rawRows;
  for (const row of expected) {
    const found = rows.find((candidate) => codeTokens(candidate[0] ?? '')[0] === row.permission);
    if (found === undefined)
      throw new Error(`permissions.md: the role matrix has no row for ${row.permission}`);
    const cell = (column: number): string =>
      stripMarkup(found[index[column] ?? 0] ?? '').toLowerCase();
    row.roles.forEach((mark, role) => {
      if ((mark.toLowerCase() === 'x') !== (cell(role) === 'x')) {
        throw new Error(
          `permissions.md: ${row.permission} for ${columns[role] ?? ''} is "${cell(role)}", the spec has "${mark}"`,
        );
      }
    });
    if (cell(5) !== row.bestuur.toLowerCase()) {
      throw new Error(
        `permissions.md: ${row.permission} for Bestuur is "${cell(5)}", the spec has "${row.bestuur}"`,
      );
    }
  }
  if (rows.length !== 15)
    throw new Error(`permissions.md: the role matrix has ${String(rows.length)} rows, not 15`);
  const totals = [15, 13, 9, 6, 4, 5];
  totals.forEach((total, role) => {
    const count = expected.filter((row) =>
      role < 5 ? row.roles[role]?.toLowerCase() === 'x' : row.bestuur !== '',
    ).length;
    if (count !== total)
      throw new Error(
        `the spec matrix gives ${String(count)} permissions for ${columns[role] ?? ''}, expected ${String(total)}`,
      );
  });

  requireAll('permissions.md', english, [
    ...Object.entries(GRAPH_ROLE_IDS).flatMap(([name, id]): Needle[] => [
      [name, `the application role ${name}`],
      [id, `the id of ${name} (re-read on Microsoft Learn, or UNVERIFIED with a register row)`],
    ]),
    ['dc50a0fb-09a3-484d-be87-e023b12c6440', 'the id of Exchange.ManageAsApp'],
    ['29232cdf-9323-42fd-ade2-1d097af3e4de', 'the EXCHANGE_ROLES template exchange_administrator'],
    [
      '31392ffb-586c-42d1-9346-e59415a2cc4e',
      'the EXCHANGE_ROLES template exchange_recipient_administrator',
    ],
    ['EXCHANGE_ROLES', 'the name EXCHANGE_ROLES'],
    ['Application.ReadWrite.All', 'the delegated scope Application.ReadWrite.All'],
    ['AppRoleAssignment.ReadWrite.All', 'the delegated scope AppRoleAssignment.ReadWrite.All'],
    [
      'RoleManagement.ReadWrite.Directory',
      'the delegated scope RoleManagement.ReadWrite.Directory',
    ],
    ['FORBIDDEN_APP_ROLES', 'the roles the runtime application never holds'],
    [
      /User\.ReadWrite\.All[\s\S]*Group\.ReadWrite\.All[\s\S]*Directory\.Read\.All/,
      'the delta against the brief (three dropped, two added)',
    ],
    [/Exchange\.ManageAsApp/, 'the Exchange app role'],
    [/permissions-reference/, 'the permissions reference as the Learn source'],
    [/resource type/i, 'the permission to resource-type map'],
    [
      /global-only|unscoped/i,
      'the scope semantics (global-only permissions come from unscoped assignments only)',
    ],
    ['U5', 'the register id U5 for the narrower Exchange role (UNVERIFIED)'],
    [
      /Group\.Read\.All[^.]*(not granted|never|dropped)|(not granted|never|dropped)[^.]*Group\.Read\.All/i,
      'Group.Read.All is not granted',
    ],
  ]);
  requireAll('permissions.md (Dutch)', dutch, [
    [/Eigenaar/, 'de rol Eigenaar'],
    [/rollenmatrix|rol(len)?-?matrix/i, 'de rollenmatrix'],
    [/Exchange/i, 'Exchange'],
  ]);
}

// =============================================================================================
// docs/architecture.md (FR-B-709, FR-B-711, PB-01, plan 11.9)
// =============================================================================================

export const PHASE_B_DEPENDENCIES: readonly (readonly [
  name: string,
  mark: RegExp,
  note: RegExp,
])[] = [
  ['libsodium-wrappers', /reuse/i, /XChaCha20/],
  ['@peculiar/x509', /reuse|adapt/i, /self-signed/i],
  ['reflect-metadata', /reuse/i, /polyfill/i],
  ['jose', /reuse/i, /PS256|ID-token|ID token/],
  ['@azure/msal-node', /reuse/i, /device code|application token/i],
  ['msw', /reuse/i, /fetch/i],
];

export function assertArchitecturePhaseB(markdown: string): void {
  const { english, dutch } = halves(markdown);
  const table = findTable(
    english,
    (header) =>
      /dependency/i.test(header[0] ?? '') &&
      header.some((cell) => /reason/i.test(cell)) &&
      header.some((cell) => /mark/i.test(cell)),
  );
  if (table === undefined)
    throw new Error('architecture.md: no dependency table (Dependency, Reason, Mark)');
  for (const [name, mark, note] of PHASE_B_DEPENDENCIES) {
    const row = table.rows.find(
      (candidate) => (candidate[0] ?? '').replace(/\s*\(.*\)$/, '') === name,
    );
    if (row === undefined)
      throw new Error(`architecture.md: the dependency table has no row for ${name}`);
    const reason = row[table.header.findIndex((cell) => /reason/i.test(cell))] ?? '';
    const markCell = row[table.header.findIndex((cell) => /mark/i.test(cell))] ?? '';
    if (!mark.test(markCell))
      throw new Error(`architecture.md: ${name} has the mark "${markCell}"`);
    if (!note.test(reason))
      throw new Error(
        `architecture.md: the reason of ${name} does not say what it is for ("${reason}")`,
      );
  }
  requireHeadings('architecture.md', english, [
    [/layering|layers/i, 'the layering with the integrations boundary'],
    [/modules/i, 'the module list'],
  ]);
  requireAll('architecture.md', english, [
    ['integrations', 'the integrations boundary'],
    [/global `?fetch`?|only[^.]*fetch/i, 'the fetch-only rule'],
    [/no-egress/i, 'the no-egress guard'],
    ['jsonwebtoken', 'the note that @azure/msal-node brings jsonwebtoken'],
    [
      /never configures|never used|does not use/i,
      'jsonwebtoken serves a certificate path this product never configures',
    ],
    ['AuthorizedResource', 'the capability-branded argument AuthorizedResource'],
    ['VisibleScope', 'the capability-branded argument VisibleScope'],
    ['projectUser', 'projectUser for every response with user attributes'],
    [/Phase C|Phases C and D|Phase D/, 'the rule for Phases C and D'],
    [/session (timing|timeouts?)/i, 'accessibility: session timing'],
    [/wizard/i, 'accessibility: the wizard'],
    ...['secrets', 'setup', 'connection', 'auth', 'rbac'].map((module): Needle => [
      new RegExp(`\`${module}\``),
      `the module ${module}`,
    ]),
  ]);
  requireAll('architecture.md (Dutch)', dutch, [
    [/afhankelijkhe/i, 'de afhankelijkheden'],
    [/libsodium/, 'libsodium'],
  ]);
}

// =============================================================================================
// docs/adr: ADR-0102 records the interface-only decision (T-B-427); the format of every ADR, the
// blocks 0101 to 0126 and 0151 to 0178 included, is checked by `assertAdrDirectory` in the test file
// =============================================================================================

export function adrFilesOf(directory: string, number: number): string[] {
  const prefix = `${String(number).padStart(4, '0')}-`;
  return readdirSync(directory).filter((name) => name.startsWith(prefix) && name.endsWith('.md'));
}

export function assertAdr0102(directory: string): void {
  const file = adrFilesOf(directory, 102)[0];
  if (file === undefined) throw new Error('ADR-0102 does not exist');
  const text = readFileSync(join(directory, file), 'utf8');
  const missing = [
    [
      /interface[- ]only|interface plus|interface and/i,
      'the interface-only decision for the Exchange write path',
    ],
    [/owner/i, 'that the owner decides'],
    [/updated/i, "that it is updated with the owner's choice after the gate"],
    [/ODB-01/, 'ODB-01'],
  ].filter(([pattern]) => !(pattern as RegExp).test(flat(text)));
  if (missing.length > 0) {
    throw new Error(`ADR-0102 must record ${missing.map(([, what]) => String(what)).join('; ')}`);
  }
}

// =============================================================================================
// docs/open-points.md (FR-B-709, T-B-425, spec 8.5, plan 18.3 and 20)
// =============================================================================================

export function assertOpenPointsPhaseB(markdown: string): void {
  const needles: Needle[] = [];
  for (let n = 34; n <= 50; n += 1)
    needles.push([new RegExp(`\\| U${String(n)} \\| [^|\\s]`), `the register row U${String(n)}`]);
  for (const id of ['U22', 'U31', 'U33', 'U40', 'U41', 'U43', 'U44'])
    needles.push([new RegExp(`\\b${id}\\b`), `the update to ${id}`]);
  for (let n = 1; n <= 23; n += 1)
    needles.push([
      new RegExp(`\\| OV-${String(n).padStart(2, '0')} \\| [^|\\s]`),
      `the owner-verified item OV-${String(n).padStart(2, '0')}`,
    ]);
  for (let n = 1; n <= 26; n += 1)
    needles.push([
      new RegExp(`\\| B-${String(n).padStart(2, '0')} \\| [^|\\s]`),
      `the assumption B-${String(n).padStart(2, '0')}`,
    ]);
  for (let n = 1; n <= 28; n += 1)
    needles.push([
      new RegExp(`\\| PB-${String(n).padStart(2, '0')} \\| [^|\\s]`),
      `the decision PB-${String(n).padStart(2, '0')}`,
    ]);
  for (let n = 1; n <= 18; n += 1)
    needles.push([
      new RegExp(`\\| RB-${String(n).padStart(2, '0')} \\| [^|\\s]`),
      `the risk RB-${String(n).padStart(2, '0')}`,
    ]);
  for (let n = 1; n <= 14; n += 1)
    needles.push([
      new RegExp(`\\| PBR-${String(n).padStart(2, '0')} \\| [^|\\s]`),
      `the risk PBR-${String(n).padStart(2, '0')}`,
    ]);
  for (let n = 1; n <= 18; n += 1)
    needles.push([
      new RegExp(`\\| ODB-${String(n).padStart(2, '0')} \\| [^|\\s]`),
      `the owner decision ODB-${String(n).padStart(2, '0')}`,
    ]);
  requireAll('open-points.md', markdown, [
    ...needles,
    [
      /mfa_required[^.]*amr_missing|amr_missing[^.]*mfa_required/,
      'the decision: step-up without MFA gives mfa_required or amr_missing (FR-B-411), not stepup_failed',
    ],
    [/F-45[^.]*250/, 'the decision: the F-45 fixture uses 250 short entries'],
    [/break-glass[^.]*actor/i, 'the decision: the actor ids anonymous and break-glass'],
    [
      /default language[^.]*(delivery path|no path)|stored default language/i,
      'the stored default language has no delivery path yet',
    ],
    [
      /group properties[^.]*OV-19|OV-19[^.]*group properties/i,
      'the group properties of OV-19 are not visible in the panel',
    ],
    [/x5t[^.]*(constant|not a variable)/i, 'the x5t fallback is a constant, not a variable'],
    [/audit view|no audit UI|missing audit/i, 'the missing audit view (Phase D)'],
  ]);
}

// =============================================================================================
// The contract file, the route table and the negative-control table of plan 14.6
// =============================================================================================

export function contractRouteIds(contractText: string): string[] {
  return [...contractText.matchAll(/^\| (?:P|R)\d+ \| `([a-z][a-zA-Z0-9.]*)` \|/gm)].map(
    (match) => match[1] ?? '',
  );
}

export function assertRoutesMatchContract(input: {
  readonly documented: readonly string[];
  readonly phaseA: readonly string[];
  readonly phaseB: readonly string[];
  /** Phase C (spec 003, table 6.7.1): the seven read routes P33 to P39. */
  readonly phaseC?: readonly string[];
}): void {
  const problems: string[] = [];
  const phaseC = input.phaseC ?? [];
  const known = new Set([...input.phaseA, ...input.phaseB, ...phaseC]);
  for (const id of [...input.phaseB, ...phaseC]) {
    if (!input.documented.includes(id))
      problems.push(`the contract lists ${id}, which is not in the route table`);
  }
  for (const id of input.documented) {
    if (!known.has(id)) problems.push(`the route table has ${id}, which no contract lists`);
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

const TEST_PREFIX: Readonly<Record<string, string>> = {
  server: 'apps/server/test/',
  shared: 'packages/shared/test/',
  web: 'apps/web/test/',
  py: 'scripts/',
};

export function assertNegativeControlTable(planText: string, root: string): void {
  const start = planText.indexOf('### 14.6');
  const end = planText.indexOf('### 14.7');
  if (start < 0 || end < start) throw new Error('plan.md has no section 14.6');
  const table = tablesIn(planText.slice(start, end))[0];
  if (table === undefined || table.rows.length < 25)
    throw new Error('plan 14.6 has no negative-control table of 25 rows or more');
  const problems: string[] = [];
  for (const row of table.rawRows) {
    for (const path of codeTokens(row[2] ?? '')) {
      const slash = path.indexOf('/');
      const prefix = path.slice(0, slash);
      const file = path.startsWith('tools/')
        ? path
        : `${TEST_PREFIX[prefix] ?? ''}${path.slice(slash + 1)}`;
      if (!existsSync(join(root, file)))
        problems.push(`${stripMarkup(row[0] ?? '')}: ${path} does not exist (${file})`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
}
