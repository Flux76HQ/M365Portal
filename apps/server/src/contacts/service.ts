// The contacts service (T-D-121, FR-D-301 to FR-D-305, EC-D9, EC-D10): what the six contact routes ask of
// Exchange and what they answer. As the other services, every method that returns or changes data takes the
// capability of the policy layer: a route that never asked `ctx` cannot call it (ADR-0175).
//
//   list         the contacts the actor may see, a prefix search, the list buffer, "narrow your search"
//   create       validation was the schema's; here the duplicate check, the derived `-Name`, the call
//   update       only the fields that differ from the contact are sent; a synced contact is read-only
//   remove       the typed name must equal the display name (422 `/confirmName` `confirm_mismatch`); the
//                lists the contact was in are read first and returned, cut to the lists the actor may see
//   memberships  the lists a contact is in, cut to the lists the actor may see
//
// A duplicate answers 409 `conflict` with `errors[] { pointer, code: 'conflict' }` and NO id. Audit entries
// carry the NAMES of the changed fields only (`fields`), never a value (FR-D-304). Nothing here logs a name,
// an address or an id (FR-D-107).
import { LIMITS } from '@m365portal/shared/limits';
import { pageLimitOf } from '@m365portal/shared/schemas/common';
import type {
  ContactCreateRequest,
  ContactDeleteRequest,
  ContactDeleteResponse,
  ContactDetail,
  ContactListQuery,
  ContactListResponse,
  ContactListsResponse,
  ContactUpdateRequest,
} from '@m365portal/shared/schemas/contacts';
import { appendAudit, type AuditActorKind } from '../audit/index.js';
import { withTransaction, type DatabaseHandle, type Tx } from '../db/index.js';
import { keyOf } from '../directory/paging.js';
import { seesNothing, visibilityOf } from '../directory/scoped-list.js';
import { ProblemError } from '../http/problem.js';
import type { AuthorizedResource, VisibleScope } from '../policy/index.js';
import type { RandomSource } from '../ports/clock.js';
import { ExchangeCommandError, ExchangeUnavailableError } from '../ports/errors.js';
import type {
  ExchangeClient,
  ExchangeContactChanges,
  ExchangeDistributionGroup,
  ExchangeMailContact,
} from '../ports/exchange.js';
import { exchangeProblem, viaExchange } from '../distribution-lists/errors.js';
import type { ListBufferStore } from '../distribution-lists/list-buffer.js';
import {
  contactResource,
  listResource,
  toContactDetail,
  toContactListItem,
  toListItem,
} from '../distribution-lists/mappers.js';
import { narrowYourSearch } from '../distribution-lists/service.js';
import { deriveContactName, findContactConflict, type ConflictPointer } from './validation.js';

export interface ContactsServiceDeps {
  readonly exchange: () => ExchangeClient;
  readonly buffers: ListBufferStore;
  readonly database: () => DatabaseHandle;
  readonly now: () => number;
  readonly random: RandomSource;
}

/** Who acts and from where, as the entries of a write record them. */
export interface ContactAuditContext {
  readonly actorKind: AuditActorKind;
  readonly actorId: string;
  readonly requestId: string;
  readonly clientIp?: string | undefined;
}

interface PageInput {
  readonly actorId: string;
  readonly query: { readonly limit?: string | undefined; readonly cursor?: string | undefined };
}

export interface ContactsService {
  list(
    input: PageInput & {
      readonly scope: VisibleScope<'contact'>;
      readonly query: ContactListQuery;
    },
  ): Promise<ContactListResponse>;
  /** The contact as Exchange has it, or `null`: the route needs the attributes to ask `authorizeResource`. */
  find(id: string): Promise<ExchangeMailContact | null>;
  detail(input: {
    readonly authorized: AuthorizedResource<'contact'>;
    readonly contact: ExchangeMailContact;
  }): ContactDetail;
  memberships(
    input: PageInput & {
      readonly authorized: AuthorizedResource<'contact'>;
      readonly contact: ExchangeMailContact;
      readonly lists: VisibleScope<'distributionList'>;
      readonly users: VisibleScope<'user'>;
    },
  ): Promise<ContactListsResponse>;
  create(input: {
    /** `contacts:create` for the proposed name, alias and address (the contact has no id yet). */
    readonly authorized: AuthorizedResource<'contact'>;
    readonly body: ContactCreateRequest;
    readonly audit: ContactAuditContext;
  }): Promise<ContactDetail>;
  update(input: {
    readonly authorized: AuthorizedResource<'contact'>;
    readonly contact: ExchangeMailContact;
    readonly body: ContactUpdateRequest;
    readonly audit: ContactAuditContext;
  }): Promise<ContactDetail>;
  remove(input: {
    readonly authorized: AuthorizedResource<'contact'>;
    readonly contact: ExchangeMailContact;
    readonly body: ContactDeleteRequest;
    readonly lists: VisibleScope<'distributionList'>;
    readonly audit: ContactAuditContext;
  }): Promise<ContactDeleteResponse>;
}

function conflict(pointer: ConflictPointer): ProblemError {
  return new ProblemError('conflict', { errors: [{ pointer, code: 'conflict' }] });
}

function cursorInvalid(): ProblemError {
  return new ProblemError('cursor_invalid');
}

/** A contact whose directory object is synchronised from on-premises cannot be changed here (FR-D-305, U80). */
function assertWritable(contact: ExchangeMailContact): void {
  if (contact.isDirSynced === true) throw new ProblemError('read_only_object');
}

export function createContactsService(deps: ContactsServiceDeps): ContactsService {
  const iso = (): string => new Date(deps.now()).toISOString();

  function record(work: (tx: Tx, ts: string) => void): void {
    const ts = iso();
    withTransaction(deps.database(), (tx) => {
      work(tx, ts);
    });
  }

  function entry(context: ContactAuditContext, ts: string) {
    return {
      ts,
      actorKind: context.actorKind,
      actorId: context.actorId,
      requestId: context.requestId,
      ...(context.clientIp === undefined ? {} : { clientIp: context.clientIp }),
    };
  }

  /** Slices a buffered list (the lists of a contact, the contacts) into a page and its cursor. */
  function page<Row, Out>(input: {
    readonly actorId: string;
    readonly route: string;
    readonly key: string;
    readonly cursor: string | undefined;
    readonly limit: number;
    readonly fresh: () => readonly Row[];
    readonly visible: (row: Row) => boolean;
    readonly map: (row: Row) => Out;
  }): { items: Out[]; nextCursor?: string } {
    let rows: readonly Row[];
    let offset = 0;
    if (input.cursor === undefined) {
      rows = input.fresh();
    } else {
      const held = deps.buffers.take<Row>(input.actorId, input.cursor);
      if (held?.route !== input.route || held.key !== input.key) throw cursorInvalid();
      rows = held.rows;
      offset = held.offset;
    }
    const items: Out[] = [];
    let index = offset;
    for (; index < rows.length && items.length < input.limit; index += 1) {
      const row = rows[index] as Row;
      if (input.visible(row)) items.push(input.map(row));
    }
    while (index < rows.length && !input.visible(rows[index] as Row)) index += 1;
    const nextCursor =
      input.cursor === undefined
        ? deps.buffers.put(input.actorId, {
            route: input.route,
            key: input.key,
            rows,
            offset: index,
          })
        : deps.buffers.next(input.actorId, input.cursor, index);
    return { items, ...(nextCursor === null ? {} : { nextCursor }) };
  }

  /** The lists a contact is in, from Exchange; the distinguished name is what the filter takes. */
  async function groupsOf(
    contact: ExchangeMailContact,
  ): Promise<readonly ExchangeDistributionGroup[]> {
    const { distinguishedName } = contact;
    if (distinguishedName === null) return [];
    const result = await viaExchange(() =>
      deps.exchange().listRecipientMemberships(distinguishedName, {
        limit: LIMITS.exchange.listBufferMax,
      }),
    );
    if (result.truncated) throw narrowYourSearch();
    return result.items;
  }

  return {
    async list({ scope, actorId, query }) {
      const scopes = scope.scopes;
      if (seesNothing(scopes)) return { items: [] };
      const limit = pageLimitOf(query);
      const key = keyOf({ q: query.q, order: query.order });
      let fresh: readonly ExchangeMailContact[] | undefined;
      if (query.cursor === undefined) {
        const result = await viaExchange(() =>
          deps.exchange().listMailContacts({
            limit: LIMITS.exchange.listBufferMax,
            ...(query.q === undefined ? {} : { prefix: query.q }),
          }),
        );
        if (result.truncated) throw narrowYourSearch();
        fresh = query.order === 'desc' ? [...result.items].reverse() : result.items;
      }
      return page({
        actorId,
        route: 'contacts.list',
        key,
        cursor: query.cursor,
        limit,
        fresh: () => fresh ?? [],
        visible: (contact) => visibilityOf(scopes, contactResource(contact)) !== null,
        map: toContactListItem,
      });
    },

    find(id) {
      return viaExchange(() => deps.exchange().getMailContact(id));
    },

    detail({ authorized, contact }) {
      if (authorized.resource.id !== contact.guid) {
        throw new TypeError('the capability is for another contact');
      }
      return toContactDetail(contact);
    },

    async memberships({ authorized, contact, lists, users, actorId, query }) {
      if (authorized.resource.id !== contact.guid) {
        throw new TypeError('the capability is for another contact');
      }
      const scopes = lists.scopes;
      if (seesNothing(scopes)) return { items: [] };
      const limit = pageLimitOf(query);
      const key = keyOf({ contact: contact.guid });
      let fresh: readonly ExchangeDistributionGroup[] | undefined;
      if (query.cursor === undefined) fresh = await groupsOf(contact);
      return page({
        actorId,
        route: 'contacts.memberships',
        key,
        cursor: query.cursor,
        limit,
        fresh: () => fresh ?? [],
        visible: (group) => visibilityOf(scopes, listResource(group)) !== null,
        map: (group) => toListItem(group, users),
      });
    },

    async create({ authorized, body, audit }) {
      if (
        authorized.resource.displayName !== body.displayName ||
        authorized.resource.alias !== body.alias ||
        authorized.resource.mail !== body.externalEmailAddress
      ) {
        throw new TypeError('the capability is for another contact');
      }
      const exchange = deps.exchange();
      const clash = await viaExchange(() =>
        findContactConflict(exchange, { address: body.externalEmailAddress, alias: body.alias }),
      );
      if (clash !== null) throw conflict(clash);

      let created: ExchangeMailContact;
      try {
        created = await exchange.createMailContact({
          name: deriveContactName(body.alias, deps.random),
          displayName: body.displayName,
          alias: body.alias,
          externalEmailAddress: body.externalEmailAddress,
          ...(body.firstName === undefined ? {} : { firstName: body.firstName }),
          ...(body.lastName === undefined ? {} : { lastName: body.lastName }),
        });
      } catch (error) {
        if (error instanceof ExchangeCommandError && error.commandCode === 'already_exists') {
          // Exchange refuses without saying which field: the alias is the one it keys on.
          throw conflict(
            (await viaExchange(() =>
              findContactConflict(exchange, {
                address: body.externalEmailAddress,
                alias: body.alias,
              }),
            )) ?? '/alias',
          );
        }
        throw exchangeProblem(error);
      }
      record((tx, ts) => {
        appendAudit(tx, {
          ...entry(audit, ts),
          action: 'contact.create',
          targetType: 'contact',
          targetId: created.guid,
          outcome: 'success',
          detail: { fields: ['displayName', 'alias', 'externalEmailAddress'] },
        });
      });
      return toContactDetail(created);
    },

    async update({ authorized, contact, body, audit }) {
      if (authorized.resource.id !== contact.guid) {
        throw new TypeError('the capability is for another contact');
      }
      assertWritable(contact);
      // Only what differs is sent and audited: a form that sends every field changes nothing it did not touch.
      const changes: {
        displayName?: string;
        alias?: string;
        externalEmailAddress?: string;
      } = {};
      if (body.displayName !== undefined && body.displayName !== contact.displayName) {
        changes.displayName = body.displayName;
      }
      if (body.alias !== undefined && body.alias !== contact.alias) changes.alias = body.alias;
      if (
        body.externalEmailAddress !== undefined &&
        body.externalEmailAddress !== (contact.externalEmailAddress ?? '').toLowerCase()
      ) {
        changes.externalEmailAddress = body.externalEmailAddress;
      }
      const fields = Object.keys(changes);
      if (fields.length === 0) return toContactDetail(contact);

      const exchange = deps.exchange();
      const clash = await viaExchange(() =>
        findContactConflict(
          exchange,
          {
            ...(changes.externalEmailAddress === undefined
              ? {}
              : { address: changes.externalEmailAddress }),
            ...(changes.alias === undefined ? {} : { alias: changes.alias }),
          },
          contact.guid,
        ),
      );
      if (clash !== null) throw conflict(clash);

      const call: ExchangeContactChanges = changes;
      let updated: ExchangeMailContact;
      try {
        updated = await exchange.updateMailContact(contact.guid, call);
      } catch (error) {
        if (error instanceof ExchangeCommandError && error.commandCode === 'already_exists') {
          throw conflict(
            changes.externalEmailAddress !== undefined && changes.alias === undefined
              ? '/externalEmailAddress'
              : '/alias',
          );
        }
        if (error instanceof ExchangeUnavailableError && error.reason === 'read_back_pending') {
          // Written and not readable yet (U82): the answer is the contact as it will read.
          updated = {
            ...contact,
            ...(changes.displayName === undefined ? {} : { displayName: changes.displayName }),
            ...(changes.alias === undefined ? {} : { alias: changes.alias }),
            ...(changes.externalEmailAddress === undefined
              ? {}
              : {
                  externalEmailAddress: changes.externalEmailAddress,
                  primarySmtpAddress: changes.externalEmailAddress,
                }),
          };
        } else {
          throw exchangeProblem(error);
        }
      }
      record((tx, ts) => {
        appendAudit(tx, {
          ...entry(audit, ts),
          action: 'contact.update',
          targetType: 'contact',
          targetId: contact.guid,
          outcome: 'success',
          detail: { fields },
        });
      });
      return toContactDetail(updated);
    },

    async remove({ authorized, contact, body, lists, audit }) {
      if (authorized.resource.id !== contact.guid) {
        throw new TypeError('the capability is for another contact');
      }
      assertWritable(contact);
      // The typed name is the display name, exactly (FR-D-303): a contact without one cannot be confirmed.
      if (contact.displayName === null || body.confirmName !== contact.displayName) {
        throw new ProblemError('validation_failed', {
          errors: [{ pointer: '/confirmName', code: 'confirm_mismatch' }],
        });
      }
      const was = await groupsOf(contact);
      await viaExchange(() => deps.exchange().removeMailContact(contact.guid));
      record((tx, ts) => {
        appendAudit(tx, {
          ...entry(audit, ts),
          action: 'contact.delete',
          targetType: 'contact',
          targetId: contact.guid,
          outcome: 'success',
          detail: { removed: was.length },
        });
      });
      // The names of lists are for a caller who may see them (distributionlists:read, scoped).
      const scopes = lists.scopes;
      return {
        removedFromLists: was
          .filter((group) => visibilityOf(scopes, listResource(group)) !== null)
          .slice(0, 200)
          .map((group) => ({ id: group.guid, displayName: group.displayName })),
      };
    },
  };
}
