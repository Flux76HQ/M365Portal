// The CLOSED allow-list of the Exchange worker (Phase D, T-D-105, FR-D-102, PD-02): cmdlet name ->
// argument schema. Exactly ten cmdlets. A cmdlet that is not here, a parameter that is not listed
// for it, a missing required parameter or a value that breaks its rule is refused by the server
// before a line is written to the worker; the PowerShell script is generated from the same table and
// checked against `allowListManifest()` by a hash, so the two sides cannot differ.
//
// Everything below is plain data (no functions, no Zod): the manifest is serialised into the script.
// The Zod schemas are built FROM the data (`cmdletArgsSchema`), never the other way round.
//
// Sources (research-microsoft-d.md R-D-02 and R-D-09, every parameter read on Learn 2026-10-13):
//   - `Add-` and `Remove-DistributionGroupMember`: `-Identity`, `-Member`,
//     `-BypassSecurityGroupManagerCheck`. `-Member` is optional in Learn's syntax; here it is required.
//   - `Get-MailContact`: an `-Identity` of `$null` or of a name that does not exist returns ALL
//     contacts, so an identity must be present, non-blank and never `undefined` (a key whose value
//     is `undefined` would vanish in JSON and turn the call into "return everything").
//   - `New-MailContact`: `-Name` (mandatory, 64), `-ExternalEmailAddress` (mandatory), `-Alias` (64),
//     `-DisplayName` (256), `-FirstName`, `-LastName`. `-PrimarySmtpAddress` is on-premises only.
//   - `Set-MailContact` has no `-FirstName` and no `-LastName` (U15).
//   - `Confirm` and `WhatIf` are never caller parameters: the script adds `-Confirm:$false` to the
//     `Remove-` cmdlets itself (`confirmFalse`) because a non-interactive worker cannot answer a prompt.
//   - UNVERIFIED value lists (not read on Learn): the `SortBy` values of `Get-DistributionGroup` and
//     the `RecipientTypeDetails` values of `Get-DistributionGroup` and `Get-Recipient`; those take an
//     identifier pattern instead of an enumeration until a page is read.
import { z } from 'zod';

/** The ten cmdlets, in the order of the task. */
export const EXCHANGE_CMDLETS = [
  'Get-DistributionGroup',
  'Get-DistributionGroupMember',
  'Add-DistributionGroupMember',
  'Remove-DistributionGroupMember',
  'Get-MailContact',
  'New-MailContact',
  'Set-MailContact',
  'Remove-MailContact',
  'Get-Recipient',
  'Get-OrganizationConfig',
] as const;
export type ExchangeCmdlet = (typeof EXCHANGE_CMDLETS)[number];

/** Is this value one of the ten names, spelt exactly? Own properties only. */
export function isExchangeCmdlet(value: unknown): value is ExchangeCmdlet {
  return typeof value === 'string' && (EXCHANGE_CMDLETS as readonly string[]).includes(value);
}

/**
 * Regular expression SOURCES (no flags) shared by the TypeScript schemas and the PowerShell script.
 * They use only constructs that .NET reads the same way: character classes, `\uXXXX`, groups,
 * quantifiers and one lookahead.
 */
export const TEXT_PATTERNS = Object.freeze({
  /** Any text with a visible character and no control, line or paragraph separator character. */
  plain: String.raw`^(?=.*\S)[^\u0000-\u001F\u007F-\u009F\u2028\u2029]+$`,
  /** An Exchange alias: R-D-09, `New-MailContact -Alias`. */
  alias: String.raw`^[A-Za-z0-9!#%*+\-/=?^_~¡-ÿ]+(\.[A-Za-z0-9!#%*+\-/=?^_~¡-ÿ]+)*$`,
  /** An external address: lower case ASCII local part and a domain with an alphabetic last label. */
  smtp: String.raw`^[a-z0-9!#%*+\-/=?^_~]+(\.[a-z0-9!#%*+\-/=?^_~]+)*@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$`,
  /** A property or type name: letters and digits, starting with a letter. */
  identifier: String.raw`^[A-Za-z][A-Za-z0-9]{0,63}$`,
} as const);
export type TextPattern = keyof typeof TEXT_PATTERNS;

/** One parameter of a cmdlet. */
export type ParamSpec =
  | { readonly kind: 'text'; readonly maxChars: number; readonly pattern: TextPattern }
  | { readonly kind: 'switch' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'resultSize'; readonly maxInt: number }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | {
      readonly kind: 'enumList';
      readonly values: readonly string[];
      readonly maxItems: number;
    }
  | { readonly kind: 'identifierList'; readonly maxItems: number };

/** What a cmdlet accepts. */
export interface CmdletSpec {
  /** `read` for a `Get-` cmdlet, `write` for the others. */
  readonly access: 'read' | 'write';
  /** The parameters a caller may pass, by their PowerShell name without the dash. */
  readonly params: Readonly<Record<string, ParamSpec>>;
  /** Parameters that must be present. */
  readonly required: readonly string[];
  /** When non-empty, at least one of these must be present (Set-MailContact). */
  readonly atLeastOneOf: readonly string[];
  /** The script appends `-Confirm:$false`: a destructive cmdlet pauses for confirmation otherwise (R-D-02). */
  readonly confirmFalse: boolean;
}

const identity: ParamSpec = { kind: 'text', maxChars: 256, pattern: 'plain' };
const filter: ParamSpec = { kind: 'text', maxChars: 1024, pattern: 'plain' };
const resultSize: ParamSpec = { kind: 'resultSize', maxInt: 10_000_000 };

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function cmdlet(
  access: CmdletSpec['access'],
  params: Record<string, ParamSpec>,
  options: { required?: string[]; atLeastOneOf?: string[]; confirmFalse?: boolean } = {},
): CmdletSpec {
  return {
    access,
    params,
    required: options.required ?? [],
    atLeastOneOf: options.atLeastOneOf ?? [],
    confirmFalse: options.confirmFalse ?? false,
  };
}

/** The allow-list: the single source for the server and for the script generator. */
export const ALLOW_LIST: Readonly<Record<ExchangeCmdlet, CmdletSpec>> = deepFreeze({
  'Get-DistributionGroup': cmdlet('read', {
    Identity: identity,
    Filter: filter,
    ResultSize: resultSize,
    SortBy: { kind: 'text', maxChars: 64, pattern: 'identifier' },
    RecipientTypeDetails: { kind: 'identifierList', maxItems: 4 },
    IncludeManagedByWithDisplayNames: { kind: 'switch' },
  }),
  'Get-DistributionGroupMember': cmdlet(
    'read',
    { Identity: identity, ResultSize: resultSize },
    { required: ['Identity'] },
  ),
  'Add-DistributionGroupMember': cmdlet(
    'write',
    { Identity: identity, Member: identity, BypassSecurityGroupManagerCheck: { kind: 'switch' } },
    { required: ['Identity', 'Member'] },
  ),
  'Remove-DistributionGroupMember': cmdlet(
    'write',
    { Identity: identity, Member: identity, BypassSecurityGroupManagerCheck: { kind: 'switch' } },
    { required: ['Identity', 'Member'], confirmFalse: true },
  ),
  'Get-MailContact': cmdlet('read', {
    Identity: identity,
    Filter: filter,
    ResultSize: resultSize,
    SortBy: { kind: 'enum', values: ['Name', 'DisplayName', 'Alias'] },
    RecipientTypeDetails: {
      kind: 'enumList',
      values: ['MailContact', 'MailForestContact'],
      maxItems: 2,
    },
    ANR: { kind: 'text', maxChars: 256, pattern: 'plain' },
  }),
  'New-MailContact': cmdlet(
    'write',
    {
      Name: { kind: 'text', maxChars: 64, pattern: 'plain' },
      ExternalEmailAddress: { kind: 'text', maxChars: 254, pattern: 'smtp' },
      Alias: { kind: 'text', maxChars: 64, pattern: 'alias' },
      DisplayName: { kind: 'text', maxChars: 256, pattern: 'plain' },
      FirstName: { kind: 'text', maxChars: 64, pattern: 'plain' },
      LastName: { kind: 'text', maxChars: 64, pattern: 'plain' },
    },
    { required: ['Name', 'ExternalEmailAddress'] },
  ),
  'Set-MailContact': cmdlet(
    'write',
    {
      Identity: identity,
      Name: { kind: 'text', maxChars: 64, pattern: 'plain' },
      ExternalEmailAddress: { kind: 'text', maxChars: 254, pattern: 'smtp' },
      Alias: { kind: 'text', maxChars: 64, pattern: 'alias' },
      DisplayName: { kind: 'text', maxChars: 256, pattern: 'plain' },
      HiddenFromAddressListsEnabled: { kind: 'boolean' },
    },
    {
      required: ['Identity'],
      atLeastOneOf: [
        'Name',
        'ExternalEmailAddress',
        'Alias',
        'DisplayName',
        'HiddenFromAddressListsEnabled',
      ],
    },
  ),
  'Remove-MailContact': cmdlet(
    'write',
    { Identity: identity },
    { required: ['Identity'], confirmFalse: true },
  ),
  'Get-Recipient': cmdlet('read', {
    Identity: identity,
    Filter: filter,
    ResultSize: resultSize,
    RecipientTypeDetails: { kind: 'identifierList', maxItems: 8 },
  }),
  'Get-OrganizationConfig': cmdlet('read', {}),
});

/** The `Get-` cmdlets. */
export const EXCHANGE_READ_CMDLETS: readonly ExchangeCmdlet[] = Object.freeze(
  EXCHANGE_CMDLETS.filter((name) => ALLOW_LIST[name].access === 'read'),
);

/** The cmdlets that change something: the ones the write capability of the client is built from. */
export const EXCHANGE_WRITE_CMDLETS: readonly ExchangeCmdlet[] = Object.freeze(
  EXCHANGE_CMDLETS.filter((name) => ALLOW_LIST[name].access === 'write'),
);

// ---------------------------------------------------------------------------------------------
// Schemas built from the data
// ---------------------------------------------------------------------------------------------

function valueSchema(spec: ParamSpec): z.ZodType {
  switch (spec.kind) {
    case 'text': {
      const pattern = new RegExp(TEXT_PATTERNS[spec.pattern]);
      return z
        .string()
        .max(spec.maxChars)
        .refine((value) => pattern.test(value), { error: 'not an allowed value' });
    }
    case 'switch':
      return z.literal(true);
    case 'boolean':
      return z.boolean();
    case 'resultSize':
      return z.union([z.literal('Unlimited'), z.number().int().min(1).max(spec.maxInt)]);
    case 'enum':
      return z.enum(spec.values as [string, ...string[]]);
    case 'enumList':
      return z
        .array(z.enum(spec.values as [string, ...string[]]))
        .min(1)
        .max(spec.maxItems)
        .refine((items) => new Set(items).size === items.length, { error: 'each value once' });
    case 'identifierList': {
      const pattern = new RegExp(TEXT_PATTERNS.identifier);
      return z
        .array(z.string().refine((value) => pattern.test(value), { error: 'not an allowed value' }))
        .min(1)
        .max(spec.maxItems);
    }
  }
}

function isPlainArgs(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  // A key whose value is `undefined` disappears in JSON and would change the meaning of the call.
  return Object.values(value).every((entry) => entry !== undefined);
}

const schemaCache = new Map<ExchangeCmdlet, z.ZodType<Record<string, unknown>>>();

/** The strict argument schema of one cmdlet, built from `ALLOW_LIST` and cached. */
export function cmdletArgsSchema(name: ExchangeCmdlet): z.ZodType<Record<string, unknown>> {
  const cached = schemaCache.get(name);
  if (cached !== undefined) return cached;
  const spec = ALLOW_LIST[name];
  const shape: Record<string, z.ZodType> = {};
  for (const [parameter, parameterSpec] of Object.entries(spec.params)) {
    const schema = valueSchema(parameterSpec);
    shape[parameter] = spec.required.includes(parameter) ? schema : schema.optional();
  }
  const strict = z
    .strictObject(shape)
    .refine(
      (args) =>
        spec.atLeastOneOf.length === 0 ||
        spec.atLeastOneOf.some(
          (parameter) => (args as Record<string, unknown>)[parameter] !== undefined,
        ),
      { error: 'at least one parameter to change' },
    );
  const built = z.custom<Record<string, unknown>>(isPlainArgs).pipe(strict) as unknown as z.ZodType<
    Record<string, unknown>
  >;
  schemaCache.set(name, built);
  return built;
}

/** The answer of `validateCall`. Issues name parameters only, never values (FR-D-107). */
export type CallValidation =
  | { readonly ok: true; readonly cmdlet: ExchangeCmdlet; readonly args: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly reason: 'unknown_cmdlet' | 'invalid_arguments';
      readonly parameters: readonly string[];
    };

/** Check one call against the allow-list. The one gate the server passes every request through. */
export function validateCall(cmdlet: unknown, args: unknown): CallValidation {
  if (!isExchangeCmdlet(cmdlet)) return { ok: false, reason: 'unknown_cmdlet', parameters: [] };
  const result = cmdletArgsSchema(cmdlet).safeParse(args);
  if (result.success) return { ok: true, cmdlet, args: result.data };
  const parameters = [
    ...new Set(
      result.error.issues.flatMap((issue) => {
        if (issue.code === 'unrecognized_keys')
          return [`unrecognized(${String(issue.keys.length)})`];
        const first = issue.path[0];
        return typeof first === 'string' ? [first] : [];
      }),
    ),
  ];
  return { ok: false, reason: 'invalid_arguments', parameters };
}

// ---------------------------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------------------------

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sortedKeys(child)]),
    );
  }
  return value;
}

/**
 * The canonical text of the table, with the text patterns: one line of JSON, keys sorted, cmdlets in
 * the order of `EXCHANGE_CMDLETS`. The script generator embeds it; a test compares the SHA-256 of
 * this text with the hash in the generated script, so a script made from another table is detected.
 */
export function allowListManifest(list: Readonly<Record<string, CmdletSpec>> = ALLOW_LIST): string {
  const cmdlets: Record<string, unknown> = {};
  for (const name of EXCHANGE_CMDLETS) cmdlets[name] = sortedKeys(list[name]);
  // Sorting would break the cmdlet order, so the object is written by hand.
  const body = EXCHANGE_CMDLETS.map(
    (name) => `${JSON.stringify(name)}:${JSON.stringify(cmdlets[name])}`,
  );
  return `{"cmdlets":{${body.join(',')}},"patterns":${JSON.stringify(sortedKeys(TEXT_PATTERNS))},"version":1}`;
}
