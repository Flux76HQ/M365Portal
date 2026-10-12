// The RBAC shapes as the API sends them (contract section 7): one mapping from the records of the
// repository to `Assignment`, `Role` and `RoleTemplate`, and the opaque list cursor.
import { GuidSchema, IsoTimestampSchema } from '@m365portal/shared/schemas/common';
import type { Assignment } from '@m365portal/shared/schemas/rbac';
import { ProblemError } from '../http/problem.js';
import type { AssignmentRecord } from './repository.js';

/** The assignment as the API sends it; `builtin` tells whether the role is one of the five. */
export function assignmentToWire(
  record: AssignmentRecord,
  builtinRoles: ReadonlySet<string>,
): Assignment {
  return {
    id: record.id,
    principalType: record.principalType,
    principalId: record.principalId,
    role: { key: record.roleKey, builtin: builtinRoles.has(record.roleKey) },
    scope: record.scope.map((item) => structuredClone(item)),
    expiresAt: record.expiresAt,
    source: record.source,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
  };
}

interface CursorPosition {
  readonly createdAt: string;
  readonly id: string;
}

/** `createdAt` and `id` of the last row of a page, as URL-safe text. The client treats it as opaque. */
export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify([position.createdAt, position.id]), 'utf8').toString(
    'base64url',
  );
}

/** The position a cursor stands for, or a 422 `validation_failed` for any text that is not one of ours. */
export function decodeCursor(cursor: string): CursorPosition {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2) {
      const [createdAt, id] = parsed as unknown[];
      if (IsoTimestampSchema.safeParse(createdAt).success && GuidSchema.safeParse(id).success) {
        return { createdAt: createdAt as string, id: id as string };
      }
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw new ProblemError('validation_failed', {
    errors: [{ pointer: '/cursor', code: 'invalid_cursor' }],
  });
}
