// THE FOUR DIRECTORY ROUTES ARE GATED (T-C-046; FR-C-501). /users and /users/$id need `users:read`, /groups and
// /groups/$id need `groups:read`. An actor without the permission sees the No-access content at the same URL
// and the page asks the API for nothing (the route loaders start no request for a denied route). The
// navigation and the command registry are unchanged and still gated by the same two permissions.
import { createTranslator } from '@m365portal/shared/i18n';
import type { Permission } from '@m365portal/shared/permissions';
import { screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleMe } from './helpers/boot-fixtures';
import { renderApp } from './helpers/render-shell';
import { loadAllLazyNamespaces } from './helpers/setup-fixtures';
import {
  createDirectoryApi,
  guid,
  makeGroup,
  groupRecord,
  seedWorld,
} from './support/directory-handlers';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const en = createTranslator('en');
const noAccess = en.t('pages.noAccess.title');

const USER_PAGE = `/users/${guid(1001)}`;
const GROUP_PAGE = `/groups/${guid(2001)}`;

const CASES: readonly (readonly [
  path: string,
  holds: Permission,
  lacks: Permission,
  heading: string,
])[] = [
  ['/users', 'users:read', 'groups:read', 'Users'],
  [USER_PAGE, 'users:read', 'groups:read', 'User 0001'],
  ['/groups', 'groups:read', 'users:read', 'Groups'],
  [GROUP_PAGE, 'groups:read', 'users:read', 'Group 0001'],
];

function world() {
  const w = seedWorld(3, 0);
  w.groups.push(groupRecord(makeGroup(1)));
  return w;
}

describe.each(CASES)('%s', (path, holds, lacks, heading) => {
  it(`is open to an actor with ${holds}`, async () => {
    const api = createDirectoryApi(world());
    await renderApp({
      me: sampleMe({ kind: 'user', permissions: [holds] }),
      path,
      fetch: api.fetch,
    });
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.queryByText(noAccess)).toBeNull();
  });

  it(`shows the No-access content at the same URL to an actor with only ${lacks}, and asks for nothing`, async () => {
    const api = createDirectoryApi(world());
    const { router } = await renderApp({
      me: sampleMe({ kind: 'user', permissions: [lacks] }),
      path,
      fetch: api.fetch,
    });
    expect(await screen.findByRole('heading', { level: 1, name: noAccess })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(path);
    // Give a loader that would wrongly prefetch time to do it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(api.calls.filter((call) => /^\/api\/v1\/(users|groups)/.test(call.path))).toEqual([]);
  });

  it('sends an anonymous visitor to the sign-in page with the path as returnTo', async () => {
    const { router } = await renderApp({ me: sampleMe(), path });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/signin');
    });
    expect(router.state.location.search).toEqual({ returnTo: path });
  });
});

describe('the placeholder pages are gone', () => {
  it('neither /users nor /groups says "Not available until Phase C"', async () => {
    for (const path of ['/users', '/groups']) {
      const api = createDirectoryApi(world());
      const { unmount } = await renderApp({
        me: sampleMe({ kind: 'user', permissions: ['users:read', 'groups:read'] }),
        path,
        fetch: api.fetch,
      });
      await screen.findByRole('table');
      expect(document.body.textContent).not.toMatch(/Phase C|until Phase/);
      unmount();
    }
  });
});
