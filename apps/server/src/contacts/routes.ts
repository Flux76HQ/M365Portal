// The contact routes P47 to P52 (T-D-122, FR-D-301, FR-D-304, spec 6.11.1).
//
//   P47 contacts.list         GET    /api/v1/contacts               scoped, paged, no total
//   P48 contacts.get          GET    /api/v1/contacts/{id}          404 unknown, 403 out of scope (ODB-11)
//   P49 contacts.create       POST   /api/v1/contacts               audit contact.create; the scope rule is
//                                                                   the proposed name, alias and address
//   P50 contacts.update       PATCH  /api/v1/contacts/{id}          audit contact.update (field names only)
//   P51 contacts.delete       DELETE /api/v1/contacts/{id}          body { confirmName }; audit contact.delete
//   P52 contacts.memberships  GET    /api/v1/contacts/{id}/lists    needs contacts:read AND distributionlists:read
//
// A duplicate address or alias is 409 `conflict` with `errors[] { pointer, code: 'conflict' }` and no id; a
// wrong confirmation is 422 with the pointer `/confirmName` and the code `confirm_mismatch`; a contact that
// Exchange reports as synchronised is 409 `read_only_object`. The success entries of the writes are written
// by the service next to the change, a denial by the wrapper.
import {
  ContactCreateRequestSchema,
  ContactDeleteRequestSchema,
  ContactDeleteResponseSchema,
  ContactDetailSchema,
  ContactIdParamsSchema,
  ContactListQuerySchema,
  ContactListResponseSchema,
  ContactListsQuerySchema,
  ContactListsResponseSchema,
  ContactUpdateRequestSchema,
} from '@m365portal/shared/schemas/contacts';
import { ProblemError } from '../http/problem.js';
import { defineRoute, type RouteContext, type RouteDefinition } from '../http/route.js';
import { ResourceDenied, type PolicyContext } from '../policy/index.js';
import { seesNothing } from '../directory/scoped-list.js';
import { problemAnswer } from '../distribution-lists/context.js';
import { contactResource } from '../distribution-lists/mappers.js';
import type { ContactAuditContext, ContactsService } from './service.js';

const TAGS = ['contacts'] as const;

function auditOf(c: RouteContext): ContactAuditContext {
  const actor = c.get('actor');
  const { address } = c.get('client');
  return {
    actorKind: actor.kind,
    actorId: actor.id,
    requestId: c.get('requestId'),
    ...(address === undefined ? {} : { clientIp: address }),
  };
}

export function contactsRoutes(contacts: ContactsService): RouteDefinition[] {
  /** Reads the contact, 404 when unknown. */
  async function found(id: string) {
    const contact = await contacts.find(id);
    if (contact === null) throw new ProblemError('not_found');
    return contact;
  }

  async function authorizedRead(ctx: PolicyContext, id: string) {
    const contact = await found(id);
    return {
      contact,
      authorized: ctx.authorizeResource('contacts:read', contactResource(contact)),
    };
  }

  const exchangeDown = problemAnswer(
    'Exchange is unavailable, throttled, or refused the application.',
  );

  return [
    defineRoute({
      id: 'contacts.list',
      method: 'GET',
      path: '/api/v1/contacts',
      access: { permission: 'contacts:read', scoped: 'contact' },
      rateLimit: 'read',
      summary: 'The mail contacts',
      description:
        'Contacts the caller may see, sorted by display name, with a prefix search on name, alias and address. Paged with a cursor; there is no total. A result larger than the list buffer answers 422 with the detail code narrow_search.',
      request: { query: ContactListQuerySchema },
      responses: {
        200: {
          description: 'A page of contacts and the cursor of the next one.',
          content: { 'application/json': { schema: ContactListResponseSchema } },
        },
        400: problemAnswer('The cursor is unknown, expired or not the caller’s (cursor_invalid).'),
        422: problemAnswer('The query is not valid, or the search matches too many contacts.'),
        503: exchangeDown,
      },
      handler: async (c, input, ctx) => {
        const scope = ctx.visibleScopes('contacts:read');
        return c.json(
          await contacts.list({ scope, actorId: c.get('actor').id, query: input.query }),
          200,
        );
      },
    }),

    defineRoute({
      id: 'contacts.get',
      method: 'GET',
      path: '/api/v1/contacts/{id}',
      access: { permission: 'contacts:read', scoped: 'contact' },
      rateLimit: 'read',
      summary: 'A mail contact',
      description:
        'Core properties and whether the contact is synchronised from on-premises (read-only). A contact outside the caller’s scope is 403, an unknown id 404.',
      request: { params: ContactIdParamsSchema },
      responses: {
        200: {
          description: 'The contact.',
          content: { 'application/json': { schema: ContactDetailSchema } },
        },
        403: problemAnswer('The contact is outside the caller’s scope (permission_denied).'),
        404: problemAnswer('No such contact.'),
        503: exchangeDown,
      },
      handler: async (c, input, ctx) => {
        const { contact, authorized } = await authorizedRead(ctx, input.params.id);
        return c.json(contacts.detail({ authorized, contact }), 200);
      },
    }),

    defineRoute({
      id: 'contacts.create',
      method: 'POST',
      path: '/api/v1/contacts',
      access: { permission: 'contacts:create', scoped: 'contact' },
      rateLimit: 'write',
      audit: 'contact.create',
      tags: TAGS,
      summary: 'Create a mail contact',
      description:
        'Creates a contact from a display name, an alias and a normalised external address, and optionally a first and last name. The Exchange name is derived from the alias. The scope of the caller is checked against the proposed name, alias and address. A duplicate address or alias is 409 conflict with the field as the pointer and no id.',
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: ContactCreateRequestSchema } },
        },
      },
      responses: {
        201: {
          description: 'The contact as read back.',
          content: { 'application/json': { schema: ContactDetailSchema } },
        },
        403: problemAnswer('Not allowed: permission or scope (the proposed name is outside it).'),
        409: problemAnswer('The address or the alias is taken (conflict).'),
        422: problemAnswer('A field is not valid.'),
        503: exchangeDown,
      },
      handler: async (c, input, ctx) => {
        const { body } = input;
        const authorized = ctx.authorizeResource('contacts:create', {
          type: 'contact',
          displayName: body.displayName,
          alias: body.alias,
          mail: body.externalEmailAddress,
        });
        const created = await contacts.create({ authorized, body, audit: auditOf(c) });
        return c.json(created, 201, { Location: `/api/v1/contacts/${created.id}` });
      },
    }),

    defineRoute({
      id: 'contacts.update',
      method: 'PATCH',
      path: '/api/v1/contacts/{id}',
      access: { permission: 'contacts:update', scoped: 'contact' },
      rateLimit: 'write',
      audit: 'contact.update',
      tags: TAGS,
      summary: 'Change a mail contact',
      description:
        'Changes the display name, the alias or the external address (at least one). Only fields that differ are sent to Exchange and audited, by name. The contact must stay inside the caller’s scope. A synchronised contact is 409 read_only_object; a duplicate is 409 conflict with the field as the pointer.',
      request: {
        params: ContactIdParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: ContactUpdateRequestSchema } },
        },
      },
      responses: {
        200: {
          description: 'The contact as read back.',
          content: { 'application/json': { schema: ContactDetailSchema } },
        },
        403: problemAnswer('Not allowed: permission or scope (before or after the change).'),
        404: problemAnswer('No such contact.'),
        409: problemAnswer(
          'The contact is synchronised (read_only_object), or the address or alias is taken (conflict).',
        ),
        422: problemAnswer('A field is not valid.'),
        503: exchangeDown,
      },
      handler: async (c, input, ctx) => {
        const contact = await found(input.params.id);
        const authorized = ctx.authorizeResource('contacts:update', contactResource(contact));
        // A rename must not take the contact out of the caller's scope: the result is asked too.
        const { body } = input;
        ctx.authorizeResource(
          'contacts:update',
          contactResource({
            guid: contact.guid,
            displayName: body.displayName ?? contact.displayName,
            alias: body.alias ?? contact.alias,
            externalEmailAddress: body.externalEmailAddress ?? contact.externalEmailAddress,
            primarySmtpAddress: body.externalEmailAddress ?? contact.primarySmtpAddress,
          }),
        );
        return c.json(await contacts.update({ authorized, contact, body, audit: auditOf(c) }), 200);
      },
    }),

    defineRoute({
      id: 'contacts.delete',
      method: 'DELETE',
      path: '/api/v1/contacts/{id}',
      access: { permission: 'contacts:delete', scoped: 'contact' },
      rateLimit: 'write',
      audit: 'contact.delete',
      tags: TAGS,
      summary: 'Delete a mail contact',
      description:
        'Deletes the contact after the display name is typed again as confirmName (422, pointer /confirmName, code confirm_mismatch when it differs). Exchange removes the contact from the lists it is in; the answer names the lists the caller may see. A synchronised contact is 409 read_only_object.',
      request: {
        params: ContactIdParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: ContactDeleteRequestSchema } },
        },
      },
      responses: {
        200: {
          description: 'The lists the contact was removed from.',
          content: { 'application/json': { schema: ContactDeleteResponseSchema } },
        },
        403: problemAnswer('Not allowed: permission or scope.'),
        404: problemAnswer('No such contact.'),
        409: problemAnswer('The contact is synchronised (read_only_object).'),
        422: problemAnswer('The confirmation does not match (confirm_mismatch).'),
        503: exchangeDown,
      },
      handler: async (c, input, ctx) => {
        const contact = await found(input.params.id);
        const authorized = ctx.authorizeResource('contacts:delete', contactResource(contact));
        const body = await contacts.remove({
          authorized,
          contact,
          body: input.body,
          lists: ctx.visibleScopes('distributionlists:read'),
          audit: auditOf(c),
        });
        return c.json(body, 200);
      },
    }),

    defineRoute({
      id: 'contacts.memberships',
      method: 'GET',
      path: '/api/v1/contacts/{id}/lists',
      access: { permission: 'contacts:read', scoped: 'contact' },
      rateLimit: 'read',
      summary: 'The distribution lists of a contact',
      description:
        'The lists the contact is a member of, cut to the lists the caller may see. Needs contacts:read on the contact and distributionlists:read.',
      request: { params: ContactIdParamsSchema, query: ContactListsQuerySchema },
      responses: {
        200: {
          description: 'A page of lists and the cursor of the next one.',
          content: { 'application/json': { schema: ContactListsResponseSchema } },
        },
        400: problemAnswer('The cursor is unknown, expired or not the caller’s (cursor_invalid).'),
        403: problemAnswer('The contact is outside the scope, or the caller reads no lists.'),
        404: problemAnswer('No such contact.'),
        503: exchangeDown,
      },
      handler: async (c, input, ctx) => {
        const { contact, authorized } = await authorizedRead(ctx, input.params.id);
        const lists = ctx.visibleScopes('distributionlists:read');
        // The route declares contacts:read; the second permission is asked here (spec 6.11.1, P52).
        if (seesNothing(lists.scopes)) {
          throw new ResourceDenied('distributionlists:read', 'permission_missing');
        }
        const body = await contacts.memberships({
          authorized,
          contact,
          lists,
          users: ctx.visibleScopes('users:read'),
          actorId: c.get('actor').id,
          query: input.query,
        });
        return c.json(body, 200);
      },
    }),
  ];
}
