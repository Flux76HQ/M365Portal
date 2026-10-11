// Wire schemas of the sign-in routes (tasks T-B-180, CB14; contract P01 to P06 and P09, FR-B-402,
// FR-B-410, FR-B-521, FR-B-603).
//
// Rules of this folder: Zod only, no transform, every schema has `.meta({ id })` (the id is the
// constant name without `Schema`), request schemas are strict. A route schema cannot rewrite a
// value, so the lenient query of `GET /auth/login` is a plain string schema and `loginQueryOf` is the
// one function that turns it into safe values.
import { z } from 'zod';
import { LIMITS } from '../limits.js';
import { safeReturnTo } from '../auth/return-to.js';
import { NO_ACCESS_REASONS, SIGNIN_ERROR_CODES } from '../auth/signin-errors.js';
import { GuidSchema } from './common.js';

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

// ---------------------------------------------------------------------------------------------
// Sign-in codes (spec 6.9.5)
// ---------------------------------------------------------------------------------------------

/** The allow-list of `/signin?error=`. A value outside it renders `signin_failed` (`resolveSigninError`). */
export const SigninErrorCodeSchema = z.enum(SIGNIN_ERROR_CODES).meta({ id: 'SigninErrorCode' });

/** The reasons of `/no-access?reason=`. A value outside the list renders `no_role`. */
export const NoAccessReasonSchema = z.enum(NO_ACCESS_REASONS).meta({ id: 'NoAccessReason' });

// ---------------------------------------------------------------------------------------------
// GET /auth/login (P01)
// ---------------------------------------------------------------------------------------------

export const LOGIN_PROMPTS = Object.freeze(['login', 'select_account'] as const);
export type LoginPrompt = (typeof LOGIN_PROMPTS)[number];
export const LOGIN_PURPOSES = Object.freeze(['signin', 'stepup'] as const);
export type LoginPurpose = (typeof LOGIN_PURPOSES)[number];

/**
 * The query of `GET /auth/login`. Nothing here is rejected: `returnTo` that is unsafe becomes `/`,
 * a `prompt` outside the two values is dropped and any other `purpose` is `signin` (all in
 * `loginQueryOf`), and a parameter nobody declared is ignored. A navigation must never answer 422.
 */
export const LoginQuerySchema = z
  .object({
    returnTo: z.string().optional(),
    prompt: z.string().optional(),
    purpose: z.string().optional(),
  })
  .meta({ id: 'LoginQuery' });

export interface LoginQuery {
  readonly returnTo: string;
  readonly prompt: LoginPrompt | undefined;
  readonly purpose: LoginPurpose;
}

/** The sanitised values of a parsed login query: the one place these three rules are written. */
export function loginQueryOf(query: {
  readonly returnTo?: string | undefined;
  readonly prompt?: string | undefined;
  readonly purpose?: string | undefined;
}): LoginQuery {
  const prompt = LOGIN_PROMPTS.find((candidate) => candidate === query.prompt);
  return {
    returnTo: safeReturnTo(query.returnTo),
    prompt,
    purpose: query.purpose === 'stepup' ? 'stepup' : 'signin',
  };
}

// ---------------------------------------------------------------------------------------------
// Sign-out (P04, P05, CD-02)
// ---------------------------------------------------------------------------------------------

/** The local landing page of a break-glass sign-out, which has no Entra session (CD-02). */
export const LOCAL_SIGNED_OUT_PATH = '/signin?signedout=1';

const ENTRA_HOST = 'login.microsoftonline.com';
const LOGGED_OUT_SUFFIX = '/auth/logged-out';

/**
 * True for exactly the two shapes of a sign-out redirect (CD-02): the local path
 * `/signin?signedout=1`, or the Entra `end_session_endpoint` of one tenant,
 * `https://login.microsoftonline.com/<tenant id>/oauth2/v2.0/logout?post_logout_redirect_uri=<the
 * panel's origin>/auth/logged-out` with no other parameter. The web client navigates to nothing else.
 */
export function isLogoutRedirect(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value === LOCAL_SIGNED_OUT_PATH) return true;
  if (value.length === 0 || value.length > 2048 || !/^[\x21-\x7e]+$/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.hostname !== ENTRA_HOST) return false;
  if (url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '')
    return false;
  const tenant = /^\/([^/]+)\/oauth2\/v2\.0\/logout$/.exec(url.pathname)?.[1];
  if (tenant === undefined || !GuidSchema.safeParse(tenant).success) return false;
  const params = [...url.searchParams.keys()];
  if (params.length !== 1 || params[0] !== 'post_logout_redirect_uri') return false;
  const target = url.searchParams.get('post_logout_redirect_uri') ?? '';
  try {
    const landing = new URL(target);
    return (
      (landing.protocol === 'https:' || landing.protocol === 'http:') &&
      landing.username === '' &&
      landing.password === '' &&
      landing.pathname === LOGGED_OUT_SUFFIX &&
      landing.search === '' &&
      landing.hash === '' &&
      target === `${landing.origin}${LOGGED_OUT_SUFFIX}`
    );
  } catch {
    return false;
  }
}

const LogoutRedirectSchema = z.string().refine(isLogoutRedirect, {
  error: 'a sign-out redirect is the Entra logout URL of the tenant or /signin?signedout=1',
});

/** `POST /api/v1/auth/logout`: the empty strict object (a body of `{}`). */
export const LogoutRequestSchema = z.strictObject({}).meta({ id: 'LogoutRequest' });

export const LogoutResponseSchema = z
  .strictObject({ redirect: LogoutRedirectSchema })
  .meta({ id: 'LogoutResponse' });

/** `POST /api/v1/auth/logout-all`: at least one session ended (the current one). */
export const LogoutAllResponseSchema = z
  .strictObject({
    redirect: LogoutRedirectSchema,
    sessionsEnded: z.number().int().min(1).max(LIMITS.session.perPrincipalMax),
  })
  .meta({ id: 'LogoutAllResponse' });

// ---------------------------------------------------------------------------------------------
// Break-glass (P06, FR-B-521)
// ---------------------------------------------------------------------------------------------

export const BREAK_GLASS_USERNAME_MAX_BYTES = 256;
export const BREAK_GLASS_PASSWORD_MAX_BYTES = 1_024;

/** `POST /api/v1/auth/break-glass`: a username of 1 to 256 bytes and a password of 1 to 1,024 bytes. */
export const BreakGlassRequestSchema = z
  .strictObject({
    username: z
      .string()
      .min(1)
      .refine((value) => utf8Bytes(value) <= BREAK_GLASS_USERNAME_MAX_BYTES, {
        error: 'at most 256 bytes',
      }),
    password: z
      .string()
      .min(1)
      .refine((value) => utf8Bytes(value) <= BREAK_GLASS_PASSWORD_MAX_BYTES, {
        error: 'at most 1,024 bytes',
      }),
  })
  .meta({ id: 'BreakGlassRequest' });

export const BreakGlassResponseSchema = z
  .strictObject({ redirect: z.literal('/settings/restore-access') })
  .meta({ id: 'BreakGlassResponse' });
