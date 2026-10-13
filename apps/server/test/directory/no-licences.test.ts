// T-C-025, FR-C-207, SC-C3, decision D-C3: no licence data anywhere in Phase C. A source scan of the
// Phase C files and of the OpenAPI document finds no `assignedLicenses`, no `license`, no `licence`; the
// `$select` lists and the port DTOs do not carry any either (U17 and U48 stay open, deferred).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { groupsQuery, usersQuery } from '../../src/integrations/graph/directory-query.js';
import {
  GROUP_LIST_SELECT,
  GROUP_SELECT,
  REF_SELECT,
  USER_LIST_SELECT,
  USER_SELECT,
} from '../../src/integrations/graph/schemas.js';
import { readJson } from '../helpers/http-client.js';
import { ALL_GROUPS, FULL_USERS, createDirectoryFixture } from './support.js';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const LICENCE = /assignedLicenses|assignedPlans|provisionedPlans|licen[cs]e/i;

function sourcesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourcesBelow(join(directory, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(directory, entry.name)]
        : [],
  );
}

/** The files of Phase C on the server: the module, the query builder, and the port. */
const PHASE_C_FILES = [
  ...sourcesBelow(join(SRC, 'directory')),
  join(SRC, 'integrations/graph/directory-query.ts'),
  join(SRC, 'ports/graph.ts'),
];

/** The guard: the text names no licence property. */
function checkText(text: string): void {
  const hit = LICENCE.exec(text);
  if (hit !== null) throw new Error(`a licence word: ${hit[0]}`);
}

describe('no licence data in the Phase C source (FR-C-207)', () => {
  it('finds none in the directory module, the query builder and the port', () => {
    expect(PHASE_C_FILES.length).toBeGreaterThan(12);
    const hits = PHASE_C_FILES.filter((file) => LICENCE.test(readFileSync(file, 'utf8'))).map(
      (file) => relative(SRC, file),
    );
    expect(hits).toEqual([]);
  });

  it('negative: a source that selects assignedLicenses, or mentions a licence in a column, fails the guard', () => {
    expectGuardFails(checkText, "const select = 'id,assignedLicenses';", {
      reason: 'a licence word: assignedLicenses',
    });
    expectGuardFails(checkText, '// the licence column of the users list', {
      reason: 'a licence word',
    });
    expectGuardFails(checkText, 'license: string | null;', { reason: 'a licence word' });
    expect(() => {
      checkText('const select = USER_LIST_SELECT;');
    }).not.toThrow();
  });

  it('keeps every $select and every built query free of licence properties', () => {
    for (const select of [
      USER_SELECT,
      USER_LIST_SELECT,
      GROUP_SELECT,
      GROUP_LIST_SELECT,
      REF_SELECT,
    ]) {
      expect(select).not.toMatch(LICENCE);
    }
    const built = [
      usersQuery({ enabled: 'false', type: 'guest', order: 'desc', top: 5, q: 'a' }),
      groupsQuery({ kind: 'distribution', order: 'asc', top: 5, q: 'b' }),
    ];
    for (const query of built) expect(JSON.stringify(query)).not.toMatch(LICENCE);
  });
});

describe('no licence data in the OpenAPI document and in the answers (FR-C-207)', () => {
  it('finds none in the document, and none in any answer of the seven routes', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(FULL_USERS, ALL_GROUPS);
    const document = await readJson(await me.client.get('/api/v1/openapi.json'));
    expect(JSON.stringify(document)).not.toMatch(LICENCE);
    // A directory that DOES carry licences: the wire never shows them.
    const ids = f.seeded.ids;
    const user = f.directory.users.get(ids.userWithManager);
    expect(user).toBeDefined();
    const paths = [
      '/api/v1/users',
      `/api/v1/users/${ids.userWithManager}`,
      `/api/v1/users/${ids.userWithManager}/groups`,
      '/api/v1/groups',
      `/api/v1/groups/${ids.m365Group}`,
      `/api/v1/groups/${ids.m365Group}/owners`,
      `/api/v1/groups/${ids.m365Group}/members`,
    ];
    for (const path of paths) {
      const response = await me.client.get(path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).not.toMatch(LICENCE);
    }
  });

  it('negative: a document that lists a licence field fails the guard', () => {
    expectGuardFails(
      (document: unknown) => {
        checkText(JSON.stringify(document));
      },
      { components: { schemas: { User: { properties: { assignedLicenses: {} } } } } },
      { reason: 'a licence word: assignedLicenses' },
    );
  });
});
