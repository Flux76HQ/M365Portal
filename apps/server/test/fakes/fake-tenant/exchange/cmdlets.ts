// The ten cmdlets of the allow-list, interpreted over the fake Exchange state (T-D-115, plan 6). The
// worker stand-in (worker-standin.ts) calls `runCmdlet` for each `call` line, so `PwshExchangeClient`
// is tested against Exchange's rules and not against a mirror of its own code.
//
// What is strict here (each is a statement of Learn or a documented choice; the self-test lists them):
//   - the parameters are checked again against the shared allow-list (a caller that bypassed the
//     server's check is `invalid_argument`);
//   - `-Filter` is a small OPATH: `Property -like 'text*'` (wildcard only as a suffix) and
//     `Property -eq 'text'`, joined by `-and` and `-or` (`-and` binds tighter), quotes doubled; a
//     property that the cmdlet cannot filter on, an operator outside the two, or a syntax error is
//     `invalid_argument`;
//   - `-ResultSize` limits the rows; without it a cmdlet returns `state.defaultResultSize` (1,000);
//   - `Get-MailContact -Identity` that matches nothing returns ALL contacts (R-D-09), not an error;
//     `Get-DistributionGroup`, `Get-DistributionGroupMember` and `Get-Recipient` do raise `not_found`;
//   - an identity that matches more than one object is `invalid_argument`;
//   - `Get-DistributionGroup` and `Get-DistributionGroupMember` know no dynamic groups (Learn:
//     `Get-DynamicDistributionGroup` is another cmdlet); `Get-Recipient` knows every recipient.
//
// Rows hold exactly the projected properties of `src/integrations/exchange/pwsh/projections.ts`.
import { validateCall, type ExchangeCmdlet } from '@m365portal/shared/exchange/allow-list';
import type { ExchangeErrorCode } from '@m365portal/shared/exchange/protocol';
import {
  PROJECTIONS,
  type ProjectedCmdlet,
} from '../../../../src/integrations/exchange/pwsh/projections.js';
import { type FakeDistributionGroup, type FakeExchangeState, type FakeRecipient } from './state.js';
import {
  addMember,
  createContact,
  done,
  groupAsRecipient,
  groupMatches,
  recipientMatches,
  refuse,
  removeContact,
  removeMember,
  updateContact,
  type Outcome,
} from './writes.js';

export type CmdletOutcome =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly error: ExchangeErrorCode; readonly retryAfterMs?: number };

type Row = Record<string, unknown>;

const lower = (value: string | null | undefined): string => (value ?? '').toLowerCase();

// ---- OPATH ------------------------------------------------------------------------------------

interface Term {
  property: string;
  operator: 'like' | 'eq';
  literal: string;
}
/** Disjunction of conjunctions: `-and` binds tighter than `-or`. */
type Expression = Term[][];

class FilterSyntaxError extends Error {}

/** Parses the small OPATH of the product; anything else is a syntax error. */
export function parseOpath(text: string, filterable: readonly string[]): Expression {
  let at = 0;
  const skip = (): void => {
    while (at < text.length && text[at] === ' ') at += 1;
  };
  const word = (): string => {
    skip();
    const start = at;
    while (at < text.length && /[A-Za-z-]/.test(text[at] ?? '')) at += 1;
    return text.slice(start, at);
  };
  const literal = (): string => {
    skip();
    if (text[at] !== "'") throw new FilterSyntaxError();
    at += 1;
    let out = '';
    for (;;) {
      if (at >= text.length) throw new FilterSyntaxError();
      const char = text[at] ?? '';
      at += 1;
      if (char === "'") {
        if (text[at] === "'") {
          out += "'";
          at += 1;
          continue;
        }
        return out;
      }
      out += char;
    }
  };
  const term = (): Term => {
    const property = word();
    if (!filterable.includes(property)) throw new FilterSyntaxError();
    const operator = word();
    if (operator !== '-like' && operator !== '-eq') throw new FilterSyntaxError();
    const value = literal();
    if (operator === '-like') {
      // The wildcard of Exchange Online is a suffix, and only there (R-D-02).
      const star = value.indexOf('*');
      if (star >= 0 && star !== value.length - 1) throw new FilterSyntaxError();
    }
    return { property, operator: operator === '-like' ? 'like' : 'eq', literal: value };
  };
  const expression: Expression = [[]];
  expression[0]?.push(term());
  for (;;) {
    skip();
    if (at >= text.length) return expression;
    const connective = word();
    if (connective === '-and') expression[expression.length - 1]?.push(term());
    else if (connective === '-or') expression.push([term()]);
    else throw new FilterSyntaxError();
  }
}

function compare(term: Term, value: string): boolean {
  const left = lower(value);
  const right = lower(term.literal);
  if (term.operator === 'eq') return left === right;
  return right.endsWith('*') ? left.startsWith(right.slice(0, -1)) : left === right;
}

function holds(expression: Expression, values: (property: string) => string[]): boolean {
  return expression.some((conjunction) =>
    conjunction.every((term) => values(term.property).some((value) => compare(term, value))),
  );
}

// ---- rows -------------------------------------------------------------------------------------

const MANAGER = (guid: string): string => `CN=${guid}`;

export function recipientRow(key: ProjectedCmdlet, r: FakeRecipient): Row {
  const values: Row = {
    Guid: r.guid,
    ExternalDirectoryObjectId: r.externalDirectoryObjectId,
    DistinguishedName: r.distinguishedName,
    Identity: r.name,
    Name: r.name,
    DisplayName: r.displayName,
    Alias: r.alias,
    PrimarySmtpAddress: r.primarySmtpAddress,
    ExternalEmailAddress: r.externalEmailAddress,
    FirstName: r.firstName,
    LastName: r.lastName,
    RecipientType: r.recipientType,
    RecipientTypeDetails: r.recipientTypeDetails,
    HiddenFromAddressListsEnabled: r.hiddenFromAddressListsEnabled,
    IsDirSynced: r.isDirSynced,
    WhenCreatedUTC: r.createdDateTime,
    ManagedBy: null,
  };
  return project(key, values);
}

export function groupRow(key: ProjectedCmdlet, g: FakeDistributionGroup): Row {
  const values: Row = {
    Guid: g.guid,
    ExternalDirectoryObjectId: g.externalDirectoryObjectId,
    DistinguishedName: g.distinguishedName,
    Name: g.name,
    DisplayName: g.displayName,
    Alias: g.alias,
    PrimarySmtpAddress: g.primarySmtpAddress,
    RecipientType: groupAsRecipient(g).recipientType,
    RecipientTypeDetails: g.recipientTypeDetails,
    IsDirSynced: g.isDirSynced,
    ManagedBy: g.managedBy.map(MANAGER),
    WhenCreatedUTC: g.createdDateTime,
  };
  return project(key, values);
}

/** Exactly the projected properties, in order, `null` for what the object lacks. */
function project(key: ProjectedCmdlet, values: Row): Row {
  const row: Row = {};
  for (const name of PROJECTIONS[key]) row[name] = values[name] ?? null;
  return row;
}

const byName = <T extends { name: string; guid: string }>(a: T, b: T): number =>
  lower(a.name) < lower(b.name) ? -1 : lower(a.name) > lower(b.name) ? 1 : a.guid < b.guid ? -1 : 1;

// ---- reads ------------------------------------------------------------------------------------

function sizeOf(state: FakeExchangeState, args: Row): number {
  const value = args.ResultSize;
  if (value === 'Unlimited') return Number.POSITIVE_INFINITY;
  return typeof value === 'number' ? value : state.defaultResultSize;
}

function rowsOf(rows: Row[]): CmdletOutcome {
  return { ok: true, data: { rows, truncated: false } };
}

function filterOf(args: Row, filterable: readonly string[]): Outcome<Expression | null> {
  if (typeof args.Filter !== 'string') return done(null);
  try {
    return done(parseOpath(args.Filter, filterable));
  } catch (failure) {
    if (failure instanceof FilterSyntaxError) return refuse('invalid_argument');
    throw failure;
  }
}

function getDistributionGroup(state: FakeExchangeState, args: Row): CmdletOutcome {
  const filter = filterOf(args, [
    'Name',
    'DisplayName',
    'Alias',
    'PrimarySmtpAddress',
    'Members',
    'RecipientTypeDetails',
  ]);
  if (!filter.ok) return filter;
  return state.read((view) => {
    // Dynamic groups are another cmdlet's (Get-DynamicDistributionGroup).
    let groups = view.groups().filter((g) => g.recipientTypeDetails !== 'DynamicDistributionGroup');
    if (args.RecipientTypeDetails !== undefined) {
      const wanted = (args.RecipientTypeDetails as string[]).map(lower);
      groups = groups.filter((g) => wanted.includes(lower(g.recipientTypeDetails)));
    }
    if (typeof args.Identity === 'string') {
      const identity = args.Identity;
      const matches = groups.filter((g) => groupMatches(g, identity));
      if (matches.length === 0) return refuse('not_found');
      if (matches.length > 1) return refuse('invalid_argument');
      groups = matches;
    }
    if (filter.value !== null) {
      const expression = filter.value;
      groups = groups.filter((g) =>
        holds(expression, (property) => {
          switch (property) {
            case 'Name':
              return [g.name];
            case 'DisplayName':
              return [g.displayName];
            case 'Alias':
              return [g.alias];
            case 'PrimarySmtpAddress':
              return [g.primarySmtpAddress];
            case 'RecipientTypeDetails':
              return [g.recipientTypeDetails];
            default:
              return view.members(g).map((m) => m.distinguishedName);
          }
        }),
      );
    }
    const rows = [...groups]
      .sort(byName)
      .slice(0, sizeOf(state, args))
      .map((g) => groupRow('Get-DistributionGroup', g));
    return rowsOf(rows);
  });
}

function getDistributionGroupMember(state: FakeExchangeState, args: Row): CmdletOutcome {
  return state.read((view) => {
    const identity = String(args.Identity);
    const matches = view
      .groups()
      .filter(
        (g) => g.recipientTypeDetails !== 'DynamicDistributionGroup' && groupMatches(g, identity),
      );
    if (matches.length === 0) return refuse('not_found');
    const [group] = matches;
    if (matches.length > 1 || group === undefined) return refuse('invalid_argument');
    const rows = view
      .members(group)
      .slice(0, sizeOf(state, args))
      .map((m) => recipientRow('Get-DistributionGroupMember', m));
    return rowsOf(rows);
  });
}

function contactRows(
  state: FakeExchangeState,
  contacts: FakeRecipient[],
  args: Row,
): CmdletOutcome {
  return rowsOf(
    [...contacts]
      .sort(byName)
      .slice(0, sizeOf(state, args))
      .map((c) => recipientRow('Get-MailContact', c)),
  );
}

function getMailContact(state: FakeExchangeState, args: Row): CmdletOutcome {
  const filter = filterOf(args, [
    'Name',
    'DisplayName',
    'Alias',
    'PrimarySmtpAddress',
    'ExternalEmailAddress',
  ]);
  if (!filter.ok) return filter;
  return state.read((view) => {
    let contacts = view.contacts();
    if (typeof args.Identity === 'string') {
      const identity = args.Identity;
      const matches = contacts.filter((c) => recipientMatches(c, identity));
      if (matches.length > 1) return refuse('invalid_argument');
      // R-D-09: an identity that matches nothing returns ALL contacts, as if there were no Identity.
      if (matches.length === 1) contacts = matches;
    }
    if (typeof args.ANR === 'string') {
      const prefix = lower(args.ANR);
      contacts = contacts.filter((c) =>
        [c.name, c.displayName, c.alias, c.primarySmtpAddress, c.firstName, c.lastName].some((v) =>
          lower(v).startsWith(prefix),
        ),
      );
    }
    if (filter.value !== null) {
      const expression = filter.value;
      contacts = contacts.filter((c) =>
        holds(expression, (property) => {
          switch (property) {
            case 'Name':
              return [c.name];
            case 'DisplayName':
              return [c.displayName];
            case 'Alias':
              return [c.alias];
            case 'PrimarySmtpAddress':
              return [c.primarySmtpAddress];
            default:
              return [c.externalEmailAddress ?? ''];
          }
        }),
      );
    }
    if (args.SortBy !== undefined) {
      // Name, DisplayName or Alias: the default order is by name already; the others are honoured.
      const key = args.SortBy as 'Name' | 'DisplayName' | 'Alias';
      const pick = (c: FakeRecipient): string =>
        lower(key === 'Name' ? c.name : key === 'Alias' ? c.alias : c.displayName);
      contacts = [...contacts].sort((a, b) => (pick(a) < pick(b) ? -1 : pick(a) > pick(b) ? 1 : 0));
    }
    return contactRows(state, contacts, args);
  });
}

function getRecipient(state: FakeExchangeState, args: Row): CmdletOutcome {
  const filter = filterOf(args, [
    'Name',
    'DisplayName',
    'Alias',
    'PrimarySmtpAddress',
    'RecipientTypeDetails',
  ]);
  if (!filter.ok) return filter;
  return state.read((view) => {
    interface Entity {
      guid: string;
      name: string;
      row: Row;
      recipient: FakeRecipient;
    }
    const entities: Entity[] = [
      ...view.recipients().map((r) => ({
        guid: r.guid,
        name: r.name,
        row: recipientRow('Get-Recipient', r),
        recipient: r,
      })),
      ...view.groups().map((g) => ({
        guid: g.guid,
        name: g.name,
        row: groupRow('Get-Recipient', g),
        recipient: groupAsRecipient(g),
      })),
    ];
    let selected = entities;
    if (args.RecipientTypeDetails !== undefined) {
      const wanted = (args.RecipientTypeDetails as string[]).map(lower);
      selected = selected.filter((e) => wanted.includes(lower(e.recipient.recipientTypeDetails)));
    }
    if (typeof args.Identity === 'string') {
      const identity = args.Identity;
      const matches = selected.filter((e) => recipientMatches(e.recipient, identity));
      if (matches.length === 0) return refuse('not_found');
      if (matches.length > 1) return refuse('invalid_argument');
      selected = matches;
    }
    if (filter.value !== null) {
      const expression = filter.value;
      selected = selected.filter((e) =>
        holds(expression, (property) => {
          switch (property) {
            case 'Name':
              return [e.recipient.name];
            case 'DisplayName':
              return [e.recipient.displayName];
            case 'Alias':
              return [e.recipient.alias];
            case 'PrimarySmtpAddress':
              return [e.recipient.primarySmtpAddress];
            default:
              return [e.recipient.recipientTypeDetails];
          }
        }),
      );
    }
    return rowsOf(
      [...selected]
        .sort(byName)
        .slice(0, sizeOf(state, args))
        .map((e) => e.row),
    );
  });
}

function getOrganizationConfig(state: FakeExchangeState): CmdletOutcome {
  const config = state.organizationConfig;
  const values: Row = {
    Name: config.name,
    Identity: config.name,
    Id: config.name,
    Guid: config.guid,
    MailTipsAllTipsEnabled: config.mailTipsAllTipsEnabled,
    MailTipsExternalRecipientsTipsEnabled: config.mailTipsExternalRecipientsTipsEnabled,
    MailTipsLargeAudienceThreshold: config.mailTipsLargeAudienceThreshold,
  };
  return rowsOf([project('Get-OrganizationConfig', values)]);
}

// ---- writes -----------------------------------------------------------------------------------

function ok(): CmdletOutcome {
  return { ok: true, data: { done: true } };
}

function fromOutcome(outcome: Outcome<unknown>): CmdletOutcome {
  return outcome.ok ? ok() : outcome;
}

function text(args: Row, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

/** Runs one cmdlet. The arguments are checked against the allow-list first, like the script does. */
export function runCmdlet(
  state: FakeExchangeState,
  cmdlet: string,
  args: Record<string, unknown>,
): CmdletOutcome {
  const checked = validateCall(cmdlet, args);
  if (!checked.ok) return refuse('invalid_argument');
  const name: ExchangeCmdlet = checked.cmdlet;
  const a = checked.args;
  switch (name) {
    case 'Get-DistributionGroup':
      return getDistributionGroup(state, a);
    case 'Get-DistributionGroupMember':
      return getDistributionGroupMember(state, a);
    case 'Get-MailContact':
      return getMailContact(state, a);
    case 'Get-Recipient':
      return getRecipient(state, a);
    case 'Get-OrganizationConfig':
      return getOrganizationConfig(state);
    case 'Add-DistributionGroupMember':
      return fromOutcome(
        addMember(state, String(a.Identity), String(a.Member), {
          bypass: a.BypassSecurityGroupManagerCheck === true,
        }),
      );
    case 'Remove-DistributionGroupMember':
      return fromOutcome(
        removeMember(state, String(a.Identity), String(a.Member), {
          bypass: a.BypassSecurityGroupManagerCheck === true,
        }),
      );
    case 'New-MailContact': {
      const created = createContact(state, {
        name: String(a.Name),
        externalEmailAddress: String(a.ExternalEmailAddress),
        ...(text(a, 'Alias') === undefined ? {} : { alias: text(a, 'Alias') }),
        ...(text(a, 'DisplayName') === undefined ? {} : { displayName: text(a, 'DisplayName') }),
        ...(text(a, 'FirstName') === undefined ? {} : { firstName: text(a, 'FirstName') }),
        ...(text(a, 'LastName') === undefined ? {} : { lastName: text(a, 'LastName') }),
      });
      return created.ok
        ? {
            ok: true,
            data: { rows: [recipientRow('Get-MailContact', created.value)], truncated: false },
          }
        : created;
    }
    case 'Set-MailContact':
      return fromOutcome(
        updateContact(state, String(a.Identity), {
          ...(text(a, 'Name') === undefined ? {} : { name: text(a, 'Name') }),
          ...(text(a, 'Alias') === undefined ? {} : { alias: text(a, 'Alias') }),
          ...(text(a, 'DisplayName') === undefined ? {} : { displayName: text(a, 'DisplayName') }),
          ...(text(a, 'ExternalEmailAddress') === undefined
            ? {}
            : { externalEmailAddress: text(a, 'ExternalEmailAddress') }),
          ...(typeof a.HiddenFromAddressListsEnabled === 'boolean'
            ? { hiddenFromAddressListsEnabled: a.HiddenFromAddressListsEnabled }
            : {}),
        }),
      );
    case 'Remove-MailContact':
      return fromOutcome(removeContact(state, String(a.Identity)));
  }
}
