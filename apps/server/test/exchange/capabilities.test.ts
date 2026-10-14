// T-D-111, FR-D-101 (+ negative): `capabilities().write` lists exactly the write methods that are
// built, the type of the tuple is the closed union of their names (a method outside it is a type
// error), and no client has a write-looking method that its capabilities do not list. The guard is
// the half of "a write method cannot be added by accident elsewhere" that reads the classes.
import { EXCHANGE_WRITE_CMDLETS } from '@m365portal/shared/exchange/allow-list';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { AdminApiExchangeClient } from '../../src/integrations/exchange/admin-api-client.js';
import { InvokeExchangeClient } from '../../src/integrations/exchange/invoke-client.js';
import {
  EXCHANGE_COMMAND_CODES,
  ExchangeCommandError,
  type ExchangeCommandCode,
} from '../../src/ports/errors.js';
import type {
  ExchangeAdminApiClient,
  ExchangeCapabilities,
  ExchangeClient,
  ExchangeReadCapability,
  ExchangeWriteCapability,
} from '../../src/ports/exchange.js';
import { FakeExchangeClient } from '../fakes/fake-exchange-client.js';

const WRITE_CAPABILITIES = [
  'addDistributionGroupMember',
  'removeDistributionGroupMember',
  'createMailContact',
  'updateMailContact',
  'removeMailContact',
] as const;

const READ_CAPABILITIES = [
  'organizationConfig',
  'distributionGroupMembers',
  'distributionGroups',
  'mailContacts',
  'recipientMemberships',
] as const;

/** A method that changes something is named like it (the Phase C guard for Graph uses the same words). */
const WRITE_NAME = /^(create|update|delete|add|remove|set|reset|new|patch|put|post|write|grant)/i;

/** Own methods of a class prototype, without the constructor. */
function methodsOf(prototype: object): string[] {
  return Object.getOwnPropertyNames(prototype).filter(
    (name) =>
      name !== 'constructor' && typeof (prototype as Record<string, unknown>)[name] === 'function',
  );
}

/** The guard: every method with a writing name is listed in `write`, and every listed name is a method. */
function checkWriteSurface(surface: {
  readonly methods: readonly string[];
  readonly write: readonly string[];
}): void {
  const { methods, write } = surface;
  const unlisted = methods.filter((name) => WRITE_NAME.test(name) && !write.includes(name));
  if (unlisted.length > 0)
    throw new Error(`write method not in capabilities: ${unlisted.join(', ')}`);
  const missing = write.filter((name) => !methods.includes(name));
  if (missing.length > 0) throw new Error(`capability without a method: ${missing.join(', ')}`);
}

describe('the types of the port', () => {
  it('has a closed union of five write capabilities and five read capabilities', () => {
    expectTypeOf<ExchangeWriteCapability>().toEqualTypeOf<(typeof WRITE_CAPABILITIES)[number]>();
    expectTypeOf<ExchangeReadCapability>().toEqualTypeOf<(typeof READ_CAPABILITIES)[number]>();
    expectTypeOf<ExchangeCapabilities['write']>().toEqualTypeOf<
      readonly ExchangeWriteCapability[]
    >();
  });

  it('negative: a method outside the union is a type error', () => {
    const fine: ExchangeCapabilities = { read: [], write: ['createMailContact'] };
    expect(fine.write).toHaveLength(1);
    // @ts-expect-error 'deleteMailbox' is not a write capability: the union is closed (FR-D-101)
    const bad: ExchangeCapabilities = { read: [], write: ['deleteMailbox'] };
    expect(bad.write).toHaveLength(1);
    // @ts-expect-error a read capability is not a write capability
    const swapped: ExchangeCapabilities = { read: [], write: ['organizationConfig'] };
    expect(swapped.write).toHaveLength(1);
  });

  it('keeps the Phase B surface inside the port: the Admin API client is a subset of the full client', () => {
    expectTypeOf<ExchangeClient>().toExtend<ExchangeAdminApiClient>();
    expectTypeOf<keyof ExchangeAdminApiClient>().toEqualTypeOf<
      'capabilities' | 'probe' | 'getOrganizationConfig' | 'listDistributionGroupMembers'
    >();
  });

  it('keeps the closed list of command codes the classifier (error-class.ts) can answer', () => {
    expect([...EXCHANGE_COMMAND_CODES]).toEqual([
      'not_found',
      'already_exists',
      'already_member',
      'not_a_member',
      'member_type_not_allowed',
      'permission_denied',
      'manager_check',
      'read_only_object',
      'throttled',
      'timeout',
      'invalid_argument',
      'not_connected',
      'role_pending',
      'internal',
    ]);
  });
});

describe('ExchangeCommandError', () => {
  it('carries the closed code and nothing else, and is retryable for throttled and timeout only', () => {
    for (const code of EXCHANGE_COMMAND_CODES) {
      const error = new ExchangeCommandError(code);
      expect(error.commandCode).toBe(code);
      expect(error.message).toBe('exchange_command');
      expect(error.retryable).toBe(code === 'throttled' || code === 'timeout');
      expect(JSON.stringify(error)).toBe(
        JSON.stringify({
          name: 'ExchangeCommandError',
          code: 'exchange_command',
          retryable: error.retryable,
          commandCode: code,
        }),
      );
    }
  });

  it('keeps Retry-After, and turns a code it does not know into internal', () => {
    expect(new ExchangeCommandError('throttled', { retryAfterMs: 4_000 }).retryAfterMs).toBe(4_000);
    expect(
      new ExchangeCommandError('Mailbox Anna Jansen not found' as ExchangeCommandCode).commandCode,
    ).toBe('internal');
  });
});

describe('capabilities() of each client', () => {
  it('the Admin API client is read only', () => {
    expect(AdminApiExchangeClient.prototype.capabilities.call({})).toEqual({
      read: ['organizationConfig', 'distributionGroupMembers'],
      write: [],
    });
    expect(() => {
      checkWriteSurface({ methods: methodsOf(AdminApiExchangeClient.prototype), write: [] });
    }).not.toThrow();
  });

  it('the Invoke client lists exactly the five writes it has, and the allow-list has five write cmdlets', () => {
    const capabilities = InvokeExchangeClient.prototype.capabilities.call({});
    expect(capabilities.write).toEqual(WRITE_CAPABILITIES);
    expect(capabilities.read).toEqual(READ_CAPABILITIES);
    // Five client methods, four cmdlets with side effects: add and remove member, new, set, remove contact.
    expect(EXCHANGE_WRITE_CMDLETS).toHaveLength(5);
    expect(() => {
      checkWriteSurface({
        methods: methodsOf(InvokeExchangeClient.prototype),
        write: capabilities.write,
      });
    }).not.toThrow();
  });

  it('the in-memory client lists the same capabilities and has the same write methods', () => {
    const capabilities = FakeExchangeClient.prototype.capabilities.call({
      calls: [],
    } as unknown as FakeExchangeClient);
    expect(capabilities.write).toEqual(WRITE_CAPABILITIES);
    expect(capabilities.read).toEqual(READ_CAPABILITIES);
    expect(() => {
      checkWriteSurface({
        methods: methodsOf(FakeExchangeClient.prototype),
        write: capabilities.write,
      });
    }).not.toThrow();
  });

  it('negative: a client with a writing method that its capabilities do not list fails the guard', () => {
    class Sneaky {
      removeMailbox(): void {
        /* a fixture: the name is what the guard reads */
      }
      listMailContacts(): void {
        /* a read */
      }
    }
    expectGuardFails(
      checkWriteSurface,
      { methods: methodsOf(Sneaky.prototype), write: [...WRITE_CAPABILITIES] },
      { name: 'unlisted write method', reason: 'write method not in capabilities: removeMailbox' },
    );
    expectGuardFails(
      checkWriteSurface,
      { methods: ['listMailContacts'], write: ['createMailContact'] },
      {
        name: 'capability without a method',
        reason: 'capability without a method: createMailContact',
      },
    );
  });
});
