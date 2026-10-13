// @vitest-environment node
/// <reference types="node" />
//
// EVERY LAZY CATALOGUE HAS A ROUTE THAT LOADS IT (T-B-307; FR-B-604, PB-17). The text of the wizard, the
// connection page, the break-glass pages, "Mijn toegang" (with its label namespaces), the Appearance page, the
// sign-in page, the users and groups pages and the showcase is not in the entry bundle: a route loader asks for it before the page
// renders. The tests render pages with every namespace loaded up front (test/setup.ts), so a loader that is
// forgotten would not show there; this test reads the sources and fails on it instead (+ negative).
import { LAZY_NAMESPACES } from '@m365portal/shared/i18n';
import { expectGuardFails } from '@m365portal/shared/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCESS_NAMESPACES, APPEARANCE_NAMESPACES, DIRECTORY_NAMESPACES } from '../src/lib/locale';

const SRC = join(import.meta.dirname, '..', 'src');
const read = (file: string): string => readFileSync(join(SRC, file), 'utf8');

/** The file that loads the namespaces, and the namespaces it must name (directly or through a group). */
const LOADERS: readonly (readonly [string, readonly string[]])[] = [
  ['routes/__root.tsx', ['session']],
  ['components/shell/AppShell.tsx', ['palette', 'shortcuts']],
  ['routes/setup.tsx', ['setup']],
  ['routes/settings.connection.tsx', ['connection', 'setup']],
  ['routes/settings.access.tsx', [...ACCESS_NAMESPACES]],
  ['routes/settings.appearance.tsx', [...APPEARANCE_NAMESPACES]],
  ['routes/break-glass.tsx', ['breakglass']],
  ['routes/settings.restore-access.tsx', ['breakglass']],
  ['routes/signin.tsx', ['signin']],
  ['routes/design.tsx', ['showcase']],
  ['routes/users.tsx', [...DIRECTORY_NAMESPACES]],
  ['routes/groups.tsx', [...DIRECTORY_NAMESPACES]],
  ['features/setup/FinishStep.tsx', [...APPEARANCE_NAMESPACES]],
];

/** Does the source load `namespace`: a literal call, or one of the named groups that holds it. */
function loads(source: string, namespace: string): boolean {
  if (new RegExp(String.raw`loadLazyNamespace\('${namespace}'\)`).test(source)) return true;
  if (
    source.includes('ACCESS_NAMESPACES') &&
    (ACCESS_NAMESPACES as readonly string[]).includes(namespace)
  )
    return true;
  if (
    source.includes('DIRECTORY_NAMESPACES') &&
    (DIRECTORY_NAMESPACES as readonly string[]).includes(namespace)
  )
    return true;
  return (
    source.includes('APPEARANCE_NAMESPACES') &&
    (APPEARANCE_NAMESPACES as readonly string[]).includes(namespace)
  );
}

function problems(
  loaders: readonly (readonly [string, readonly string[]])[],
  reader: (file: string) => string,
): string[] {
  const found: string[] = [];
  for (const [file, namespaces] of loaders) {
    const source = reader(file);
    for (const namespace of namespaces) {
      if (!loads(source, namespace))
        found.push(`${file} does not load the lazy namespace ${namespace}`);
    }
  }
  const covered = new Set(loaders.flatMap(([, namespaces]) => namespaces));
  for (const namespace of LAZY_NAMESPACES) {
    if (!covered.has(namespace)) found.push(`no route loads the lazy namespace ${namespace}`);
  }
  return found;
}

describe('lazy namespaces', () => {
  it('every route that shows lazy text loads it, and every lazy namespace has a route', () => {
    expect(problems(LOADERS, read)).toEqual([]);
  });

  it('the label namespaces of "Mijn toegang", of the Appearance form and of the directory pages are lazy namespaces', () => {
    for (const namespace of [
      ...ACCESS_NAMESPACES,
      ...APPEARANCE_NAMESPACES,
      ...DIRECTORY_NAMESPACES,
    ]) {
      expect(LAZY_NAMESPACES as readonly string[]).toContain(namespace);
    }
  });

  it('negative: a route that forgets its loader fails', () => {
    expectGuardFails(
      () => {
        const broken = (file: string): string =>
          file === 'routes/signin.tsx' ? 'export const Route = {};' : read(file);
        expect(problems(LOADERS, broken)).toEqual([]);
      },
      {
        name: 'lazy namespace loaders (signin forgot)',
        reason: /routes\/signin\.tsx does not load the lazy namespace signin/,
      },
    );
  });

  it('negative: a directory page whose layout forgets the groups namespace fails', () => {
    expectGuardFails(
      () => {
        const broken = (file: string): string =>
          file === 'routes/groups.tsx' ? "loadLazyNamespace('users');" : read(file);
        expect(problems(LOADERS, broken)).toEqual([]);
      },
      {
        name: 'lazy namespace loaders (groups forgot the groups namespace)',
        reason: /routes\/groups\.tsx does not load the lazy namespace groups/,
      },
    );
  });

  it('negative: a lazy namespace nobody loads fails', () => {
    expectGuardFails(
      () => {
        expect(
          problems(
            LOADERS.filter(([file]) => file !== 'routes/design.tsx'),
            read,
          ),
        ).toEqual([]);
      },
      {
        name: 'lazy namespace without a route (showcase)',
        reason: /no route loads the lazy namespace showcase/,
      },
    );
  });
});
