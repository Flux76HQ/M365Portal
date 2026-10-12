// THE LOGOUT REDIRECT THE CLIENT FOLLOWS (T-B-295; FR-B-410, FR-B-606; plan 12.3).
//
// Sign-out is a `fetch` on this origin that answers `{redirect}`; the client then navigates to that value.
// A navigation is the one place where a value from the network becomes an address, so the client accepts
// exactly two shapes and navigates to nothing else: the Entra sign-out page on `login.microsoftonline.com`
// over `https`, or exactly the local path `/signin?signedout=1` (a break-glass session has no Entra
// session to end). The server validates the same value before it sends it (`isLogoutRedirect` of the
// shared package); this is the second check, in the browser.
import { ENTRA_LOGIN_HOST, LOCAL_SIGNED_OUT_PATH } from '@m365portal/shared/schemas/auth';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { ENTRA_HOST, SIGNED_OUT_PATH, checkedLogoutRedirect } from '../src/lib/ms-url';

const TENANT = '3f2b6a52-7c1e-4a8e-9a3d-0c5f4d1b2e77';
const ENTRA_LOGOUT = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout?post_logout_redirect_uri=https%3A%2F%2Fpanel.example.com%2Fauth%2Flogged-out`;

/** The guard the navigation helper is: it throws for a value the client must not navigate to. */
function assertAccepted(value: unknown): string {
  const checked = checkedLogoutRedirect(value);
  if (checked === null) throw new Error(`the redirect ${JSON.stringify(value)} is not accepted`);
  return checked;
}

describe('the two accepted shapes', () => {
  it('uses the constants of the shared package, so the server and the client cannot drift apart', () => {
    expect(ENTRA_HOST).toBe(ENTRA_LOGIN_HOST);
    expect(SIGNED_OUT_PATH).toBe(LOCAL_SIGNED_OUT_PATH);
  });

  it('accepts the Entra sign-out URL of a tenant, unchanged', () => {
    expect(checkedLogoutRedirect(ENTRA_LOGOUT)).toBe(ENTRA_LOGOUT);
  });

  it('accepts the local signed-out path, unchanged', () => {
    expect(checkedLogoutRedirect('/signin?signedout=1')).toBe('/signin?signedout=1');
  });
});

describe('everything else is refused', () => {
  const hostile: readonly [string, unknown][] = [
    ['javascript:', 'javascript:alert(1)'],
    ['javascript: in capitals', 'JAVASCRIPT:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['http instead of https', 'http://login.microsoftonline.com/x/oauth2/v2.0/logout'],
    ['a look-alike host as a suffix', 'https://login.microsoftonline.com.evil.example/x'],
    ['a look-alike host as a prefix', 'https://evil-login.microsoftonline.com/x'],
    ['a look-alike host in the user info', 'https://login.microsoftonline.com@evil.example/x'],
    ['the user info on the right host', 'https://user:pw@login.microsoftonline.com/x'],
    ['a port', 'https://login.microsoftonline.com:8443/x'],
    ['another Microsoft host', 'https://login.microsoft.com/x'],
    ['a sovereign cloud host', 'https://login.microsoftonline.us/x'],
    ['a protocol-relative URL', '//login.microsoftonline.com/x'],
    ['a protocol-relative URL to another host', '//evil.example/x'],
    ['another local path', '/signin'],
    ['the local path with another query', '/signin?signedout=0'],
    ['the local path with an extra parameter', '/signin?signedout=1&returnTo=//evil'],
    ['the local path with a fragment', '/signin?signedout=1#x'],
    ['an open redirect through the local path', '/\\evil.example'],
    ['a backslash in the host part', 'https:\\\\login.microsoftonline.com\\x'],
    ['a line break', 'https://login.microsoftonline.com/x\r\nSet-Cookie: a=b'],
    ['a tab inside', 'https://login.microsoft\tonline.com/x'],
    ['a leading space', ' https://login.microsoftonline.com/x'],
    ['an empty string', ''],
    ['a very long value', `https://login.microsoftonline.com/${'a'.repeat(3000)}`],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { toString: () => ENTRA_LOGOUT }],
    ['an array holding the URL', [ENTRA_LOGOUT]],
  ];

  it.each(hostile)('refuses %s', (_name, value) => {
    expect(checkedLogoutRedirect(value)).toBeNull();
  });

  it('is a guard that throws for each of them (+ negative: a helper that navigates to any string would fail here)', () => {
    for (const [name, value] of hostile) {
      expectGuardFails(assertAccepted, value, { name: `checkedLogoutRedirect: ${name}` });
    }
    expect(() => assertAccepted(ENTRA_LOGOUT)).not.toThrow();
  });
});
