// NAMES ARE DATA, NEVER MARKUP (T-C-048; FR-C-404). Display names, addresses, departments and descriptions
// come from Microsoft 365 and may hold anything. Every page that shows them renders them as text: no element
// is created from them, no event handler attribute appears, no link is built from them. The source holds no
// HTML sink either (the lint rule `local/no-dangerous-html` is the editor-time half, this is the second).
import { expectGuardFails } from '@m365portal/shared/testing';
import { screen, waitFor } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleMe } from './helpers/boot-fixtures';
import { renderApp } from './helpers/render-shell';
import { loadAllLazyNamespaces } from './helpers/setup-fixtures';
import {
  createDirectoryApi,
  emptyWorld,
  groupRecord,
  guid,
  makeGroup,
  makeUser,
  userRow,
} from './support/directory-handlers';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const HOSTILE = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(2)</script>',
  '"><svg onload=alert(3)>',
  '<a href="javascript:alert(4)">click</a>',
  '<iframe src="https://evil.example"></iframe>',
  '&lt;b&gt;encoded&lt;/b&gt;',
  '{{constructor.constructor("alert(5)")()}}',
] as const;

const [IMG, SCRIPT, SVG, ANCHOR, IFRAME, ENCODED, TEMPLATE] = HOSTILE;

function hostileWorld() {
  const w = emptyWorld();
  w.users.push(
    makeUser(1, {
      displayName: IMG,
      givenName: SCRIPT,
      surname: SVG,
      userPrincipalName: ANCHOR,
      mail: IFRAME,
      department: ENCODED,
      jobTitle: TEMPLATE,
      officeLocation: IMG,
      manager: { state: 'present', user: { ...userRow(2), displayName: SCRIPT } },
    }),
    makeUser(2, { displayName: SVG }),
  );
  w.groups.push(
    groupRecord(
      makeGroup(1, { displayName: SCRIPT, description: IMG, mail: ANCHOR, mailNickname: IFRAME }),
      {
        owners: [{ ...userRow(1), displayName: IMG, mail: SCRIPT }],
        members: [
          { ...userRow(1), displayName: SVG, userPrincipalName: ANCHOR },
          {
            kind: 'other',
            id: guid(7001),
            displayName: IFRAME,
            mail: ENCODED,
            userPrincipalName: null,
          },
        ],
      },
    ),
  );
  w.userGroups[guid(1001)] = [guid(2001)];
  return w;
}

/** What markup injection would leave in the page: elements the product never draws, handlers, script links. */
function injectionIn(root: HTMLElement): string[] {
  const found: string[] = [];
  for (const element of root.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase();
    if (['img', 'script', 'iframe', 'object', 'embed', 'b', 'i', 'style'].includes(tag)) {
      found.push(`<${tag}> element`);
    }
    for (const attribute of element.attributes) {
      if (/^on/i.test(attribute.name)) found.push(`${tag}[${attribute.name}]`);
      if (/^\s*javascript:/i.test(attribute.value))
        found.push(`${tag}[${attribute.name}] script link`);
    }
  }
  return found;
}

/** The hostile strings as the page shows them: found as the text of a node, character for character. */
function textsFound(root: HTMLElement, texts: readonly string[]): string[] {
  const nodes: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node.textContent ?? '');
  }
  return texts.filter((text) => nodes.some((candidate) => candidate.includes(text)));
}

const PAGES: readonly (readonly [
  path: string,
  ready: () => Promise<unknown>,
  shown: readonly string[],
])[] = [
  ['/users', () => screen.findByRole('link', { name: IMG }), [IMG, SVG, ANCHOR, IFRAME, ENCODED]],
  [
    `/users/${guid(1001)}`,
    () => screen.findByRole('heading', { level: 1, name: IMG }),
    [IMG, SCRIPT, SVG, ANCHOR, IFRAME, ENCODED, TEMPLATE],
  ],
  ['/groups', () => screen.findByRole('link', { name: SCRIPT }), [SCRIPT, ANCHOR]],
  [
    `/groups/${guid(2001)}`,
    () => screen.findByRole('heading', { level: 1, name: SCRIPT }),
    [SCRIPT, IMG, ANCHOR, IFRAME, SVG, ENCODED],
  ],
];

describe.each(PAGES)('%s', (path, ready, shown) => {
  it('renders every hostile value as text and creates no element, handler or script link', async () => {
    const api = createDirectoryApi(hostileWorld());
    const { container } = await renderApp({
      me: sampleMe({ kind: 'user', permissions: ['users:read', 'groups:read'] }),
      path,
      fetch: api.fetch,
    });
    await ready();
    await waitFor(() => {
      expect(textsFound(container, shown).sort()).toEqual([...shown].sort());
    });
    expect(injectionIn(container)).toEqual([]);
  });
});

describe('the checks themselves', () => {
  it('negative: injectionIn sees an element made from a name', () => {
    const page = document.createElement('div');
    page.innerHTML = '<p>Ada <img src="x" onerror="alert(1)"></p>';
    expectGuardFails(
      () => {
        expect(injectionIn(page)).toEqual([]);
      },
      { name: 'injection check (img with a handler)' },
    );
  });

  it('negative: injectionIn sees a script link', () => {
    const page = document.createElement('div');
    page.innerHTML = '<a href="javascript:alert(1)">Ada</a>';
    expectGuardFails(
      () => {
        expect(injectionIn(page)).toEqual([]);
      },
      { name: 'injection check (javascript: link)' },
    );
  });
});

describe('the source writes no HTML (FR-C-404)', () => {
  const SINK =
    /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|srcDoc|setHTMLUnsafe/;
  const sources = () => {
    const root = join(import.meta.dirname, '..', 'src');
    return ['features/directory', 'features/users', 'features/groups', 'routes'].flatMap((folder) =>
      readdirSync(join(root, folder))
        .filter((name) => /\.(ts|tsx)$/.test(name))
        .map(
          (name) => [`${folder}/${name}`, readFileSync(join(root, folder, name), 'utf8')] as const,
        ),
    );
  };

  it('has none in the directory, users and groups features or in the routes', () => {
    expect(sources().length).toBeGreaterThan(20);
    for (const [name, source] of sources()) expect(SINK.test(source), name).toBe(false);
  });

  it('negative: the scan sees a sink', () => {
    expectGuardFails(
      () => {
        expect(SINK.test('<p dangerouslySetInnerHTML={{ __html: name }} />')).toBe(false);
      },
      { name: 'html sink scan' },
    );
  });
});
