// What the directory routes share (T-C-022, T-C-023, T-C-024): the two services in one object, and the
// problem answers for the OpenAPI document.
import { ProblemSchema } from '@m365portal/shared/problem';
import type { GroupsService } from './groups-service.js';
import type { UsersService } from './users-service.js';

export interface DirectoryContext {
  readonly users: UsersService;
  readonly groups: GroupsService;
}

const PROBLEM_CONTENT = { 'application/problem+json': { schema: ProblemSchema } } as const;

/** A problem answer of a route, for the OpenAPI document. */
export function problemAnswer(description: string): {
  readonly description: string;
  readonly content: typeof PROBLEM_CONTENT;
} {
  return { description, content: PROBLEM_CONTENT };
}
