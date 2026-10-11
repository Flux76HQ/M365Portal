// local/layering (FR-B-315, PB-01, plan 4.3): the server's layers and where outbound HTTP may start.
// The scope test at the end pins where the rule runs; the canary case file
// (tools/lint-canary/cases/layering.case.ts) pins that the real configuration applies it there.
import type { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createRuleTester, ruleOf, scopeOf, STRICT_ASSERTIONS } from './support.js';

const rule = ruleOf('layering');
const NODE_GLOBALS = { fetch: 'readonly', globalThis: 'readonly' } as const;

const src = (path: string): string => `apps/server/src/${path}`;

function ok(code: string, filename: string, name?: string): RuleTester.ValidTestCase {
  return { name: name ?? `${filename}: ${code}`, code, filename };
}

type MessageId = 'httpModule' | 'boundaryPackage' | 'forbiddenHere' | 'portsPure' | 'fetchOutside';

function bad(
  code: string,
  filename: string,
  messageId: MessageId,
  data?: Record<string, string>,
  name?: string,
): RuleTester.InvalidTestCase {
  return {
    name: name ?? `${filename}: ${code}`,
    code,
    filename,
    errors: [{ messageId, ...(data === undefined ? {} : { data }) }],
  };
}

/** An error without a data assertion, for messages whose data is a long sentence. */
function badAny(
  code: string,
  filename: string,
  messageId: MessageId,
  name?: string,
): RuleTester.InvalidTestCase {
  return { name: name ?? `${filename}: ${code}`, code, filename, errors: [{ messageId }] };
}

const TOKENS = "tokens are the identity folder's business";
const NO_ENTRA = 'secrets holds keys and certificates, it does not talk to Entra';
const LAZY_X509 = 'the X.509 library is loaded lazily and only from secrets/x509/';

const SERVICE = src('setup/runner.ts');
const ROUTE = src('auth/routes.ts');
const REPOSITORY = src('rbac/repository.ts');
const POLICY = src('policy/authorize.ts');
const HTTP = src('http/route.ts');
const GRAPH = src('integrations/graph/graph-http.ts');
const EXCHANGE = src('integrations/exchange/admin-api-client.ts');
const IDENTITY = src('integrations/identity/app-token.ts');
const SECRETS = src('secrets/sealed-box.ts');
const X509 = src('secrets/x509/certificate.ts');
const PORT = src('ports/graph.ts');
const OTHER = src('branding/service.ts');

createRuleTester().run('local/layering', rule, {
  assertionOptions: STRICT_ASSERTIONS,
  valid: [
    // Services depend on ports, shared code and the allowed parts of node:crypto.
    ok("import type { GraphClient } from '../ports/graph.js';", SERVICE),
    ok("import { PERMISSIONS } from '@m365portal/shared/permissions';", SERVICE),
    ok("import { timingSafeEqual, randomBytes, createHash, scrypt } from 'node:crypto';", ROUTE),
    ok("import { z } from 'zod';", REPOSITORY),
    ok("import { eq } from 'drizzle-orm';", REPOSITORY),
    // Type-only imports emit nothing and open nothing.
    ok(
      "import type { Server } from 'node:http';",
      src('start.ts'),
      'a type-only import of node:http',
    ),
    ok("import type { ServerOptions } from 'node:http';", HTTP),
    ok("import { type Server } from 'node:http';", HTTP, 'every specifier inline type'),
    ok("export type { Server } from 'node:http';", HTTP, 'a type re-export'),
    ok("import type { Dispatcher } from 'undici';", SERVICE),
    ok("import type * as jose from 'jose';", SERVICE, 'a type-only namespace import'),
    // The pure address helpers of node:net open no socket.
    ok("import { isIP, isIPv4, isIPv6 } from 'node:net';", src('config/env.ts')),
    ok("import { BlockList } from 'node:net';", src('http/trust-proxy.ts')),
    ok("import { isIP } from 'net';", src('http/client-key.ts'), 'the unprefixed spelling'),
    // The integrations are where fetch and the SDKs live.
    ok(
      "const r = await fetch('https://graph.microsoft.com/v1.0/organization');",
      GRAPH,
      'fetch in graph',
    ),
    ok("await fetch(url, { redirect: 'error' });", EXCHANGE),
    ok("import { ConfidentialClientApplication } from '@azure/msal-node';", IDENTITY),
    ok("import { jwtVerify, createRemoteJWKSet } from 'jose';", IDENTITY),
    ok("import { randomUUID } from 'node:crypto';", GRAPH),
    // Secrets: sodium, jose, node:crypto; the X.509 library only under secrets/x509.
    ok("import sodium from 'libsodium-wrappers';", SECRETS),
    ok("import { CompactSign } from 'jose';", SECRETS),
    ok("import { X509CertificateGenerator } from '@peculiar/x509';", X509),
    ok("import 'reflect-metadata';", X509),
    ok("const lazy = await import('@peculiar/x509');", X509, 'the lazy import under x509/'),
    // Ports: relative imports inside ports, the shared package, nothing else.
    ok("import type { Guid } from './graph.js';", PORT),
    ok("import type { Permission } from '@m365portal/shared/permissions';", PORT),
    ok("export { GraphClient } from './graph.js';", src('ports/index.ts')),
    // What looks like fetch but is not the global.
    ok('const response = await app.fetch(request);', OTHER, 'a method named fetch'),
    ok('const fetch = makeFetch(); fetch(url);', OTHER, 'a local named fetch'),
    ok('function run(fetch: Fetch) { return fetch(url); }', OTHER, 'a parameter named fetch'),
    ok('type Get = typeof fetch;', OTHER, 'naming the type of the global'),
    ok('const o = { fetch: handler }; o.fetch(1);', OTHER, 'a property key'),
    ok('const f = props.fetch;', OTHER),
    {
      name: 'a declared global is still found, but integrations may use it',
      code: "await fetch('https://login.microsoftonline.com');",
      filename: IDENTITY,
      languageOptions: { globals: NODE_GLOBALS },
    },
    // Not a path the rule has an opinion on: only the global bans apply.
    ok("import { z } from 'zod';", 'tools/x/y.ts'),
    // A computed specifier cannot be read: the import-graph test is the second line.
    ok('const m = await import(name);', SERVICE, 'a computed dynamic import'),
    ok('const m = require(name);', SERVICE, 'a computed require'),
    // Packages that merely contain a banned word.
    ok(
      "import { x } from 'jose-extra-utils-not-jose-pkg-lookalike';",
      SERVICE,
      'a package that starts like jose',
    ),
    ok("import { y } from 'http-status-codes';", SERVICE, 'http-status-codes is not node:http'),
    ok("import { y } from './net.js';", SERVICE, 'a local file called net'),
  ],

  invalid: [
    // node:http, node:https, node:net, node:tls, node:http2 and undici, anywhere.
    bad("import https from 'node:https';", SERVICE, 'httpModule', { module: 'node:https' }),
    bad("import { request } from 'node:http';", ROUTE, 'httpModule', { module: 'node:http' }),
    bad("import { connect } from 'node:net';", REPOSITORY, 'httpModule', { module: 'node:net' }),
    bad("import tls from 'node:tls';", POLICY, 'httpModule', { module: 'node:tls' }),
    bad("import http2 from 'node:http2';", HTTP, 'httpModule', { module: 'node:http2' }),
    bad("import { request } from 'undici';", SERVICE, 'httpModule', { module: 'undici' }),
    bad("import { fetch } from 'undici';", GRAPH, 'httpModule', { module: 'undici' }),
    bad("import https from 'node:https';", IDENTITY, 'httpModule', { module: 'node:https' }),
    bad("import https from 'https';", SERVICE, 'httpModule', { module: 'https' }),
    bad("import * as net from 'node:net';", SERVICE, 'httpModule', { module: 'node:net' }),
    bad("import net, { isIP } from 'node:net';", SERVICE, 'httpModule', { module: 'node:net' }),
    bad("import { isIP, Socket } from 'node:net';", SERVICE, 'httpModule', { module: 'node:net' }),
    bad(
      "import https from 'node:https';",
      OTHER,
      'httpModule',
      { module: 'node:https' },
      'any folder',
    ),
    bad("import { createServer } from 'node:http';", src('index.ts'), 'httpModule', {
      module: 'node:http',
    }),
    bad("export * from 'node:https';", SERVICE, 'httpModule', { module: 'node:https' }),
    bad("export { request } from 'node:https';", SERVICE, 'httpModule', { module: 'node:https' }),
    bad("const h = await import('node:https');", SERVICE, 'httpModule', { module: 'node:https' }),
    bad("const h = require('node:https');", SERVICE, 'httpModule', { module: 'node:https' }),
    bad("import h = require('node:https');", SERVICE, 'httpModule', { module: 'node:https' }),
    bad("import 'undici';", SERVICE, 'httpModule', { module: 'undici' }),
    bad("import { request } from 'node:https/some';", SERVICE, 'httpModule', {
      module: 'node:https/some',
    }),
    // The SDKs belong to integrations and secrets.
    bad("import { jwtVerify } from 'jose';", SERVICE, 'boundaryPackage', { module: 'jose' }),
    bad("import sodium from 'libsodium-wrappers';", ROUTE, 'boundaryPackage', {
      module: 'libsodium-wrappers',
    }),
    bad(
      "import { PublicClientApplication } from '@azure/msal-node';",
      REPOSITORY,
      'boundaryPackage',
      {
        module: '@azure/msal-node',
      },
    ),
    bad("import { X509Certificate } from '@peculiar/x509';", POLICY, 'boundaryPackage', {
      module: '@peculiar/x509',
    }),
    bad("import 'reflect-metadata';", HTTP, 'boundaryPackage', { module: 'reflect-metadata' }),
    bad("import { jwtVerify } from 'jose';", OTHER, 'boundaryPackage', { module: 'jose' }),
    bad(
      "import { base64url } from 'jose/dist/webapi/util/base64url';",
      SERVICE,
      'boundaryPackage',
      {
        module: 'jose/dist/webapi/util/base64url',
      },
    ),
    bad("const j = await import('jose');", SERVICE, 'boundaryPackage', { module: 'jose' }),
    // Graph and Exchange hold no tokens of their own making.
    bad("import { decodeJwt } from 'jose';", GRAPH, 'forbiddenHere', {
      module: 'jose',
      reason: TOKENS,
    }),
    bad("import { SignJWT } from 'jose';", EXCHANGE, 'forbiddenHere', {
      module: 'jose',
      reason: TOKENS,
    }),
    bad(
      "import { ConfidentialClientApplication } from '@azure/msal-node';",
      GRAPH,
      'forbiddenHere',
      {
        module: '@azure/msal-node',
        reason: TOKENS,
      },
    ),
    bad("import msal from '@azure/msal-node';", EXCHANGE, 'forbiddenHere', {
      module: '@azure/msal-node',
      reason: TOKENS,
    }),
    // Secrets: no Entra, and the X.509 library only below secrets/x509.
    bad("import { X509CertificateGenerator } from '@peculiar/x509';", SECRETS, 'forbiddenHere', {
      module: '@peculiar/x509',
      reason: LAZY_X509,
    }),
    bad("import 'reflect-metadata';", src('secrets/certificate-holder.ts'), 'forbiddenHere', {
      module: 'reflect-metadata',
      reason: LAZY_X509,
    }),
    bad("import msal from '@azure/msal-node';", SECRETS, 'forbiddenHere', {
      module: '@azure/msal-node',
      reason: NO_ENTRA,
    }),
    bad(
      "import { X509Certificate } from '@peculiar/x509';",
      src('secrets/x509.ts'),
      'forbiddenHere',
      { module: '@peculiar/x509', reason: LAZY_X509 },
      'a file called x509 is not the folder',
    ),
    // Ports import nothing external.
    bad("import { z } from 'zod';", PORT, 'portsPure', { module: 'zod' }),
    bad("import type { Dispatcher } from 'undici';", PORT, 'portsPure', { module: 'undici' }),
    bad("import { randomBytes } from 'node:crypto';", src('ports/clock.ts'), 'portsPure', {
      module: 'node:crypto',
    }),
    bad("import { x } from '../lifecycle/sweepers.js';", src('ports/clock.ts'), 'portsPure', {
      module: '../lifecycle/sweepers.js',
    }),
    bad("import { y } from '../../shared/x.js';", PORT, 'portsPure', {
      module: '../../shared/x.js',
    }),
    bad("import pino from 'pino';", src('ports/errors.ts'), 'portsPure', { module: 'pino' }),
    bad("import https from 'node:https';", PORT, 'portsPure', { module: 'node:https' }),
    bad("export { x } from 'jose';", PORT, 'portsPure', { module: 'jose' }),
    bad("const m = await import('zod');", PORT, 'portsPure', { module: 'zod' }),
    bad("import type { Guid } from '@m365portal/shared-lookalike';", PORT, 'portsPure', {
      module: '@m365portal/shared-lookalike',
    }),
    // Global fetch outside integrations.
    badAny("const r = await fetch('https://example.test');", SERVICE, 'fetchOutside'),
    badAny("await fetch('https://graph.microsoft.com/v1.0/organization');", ROUTE, 'fetchOutside'),
    badAny('const f = fetch;', REPOSITORY, 'fetchOutside', 'fetch passed along'),
    badAny('run(fetch);', POLICY, 'fetchOutside'),
    badAny(
      "globalThis.fetch('https://example.test');",
      SERVICE,
      'fetchOutside',
      'globalThis.fetch',
    ),
    badAny("self.fetch('https://example.test');", SERVICE, 'fetchOutside', 'self.fetch'),
    badAny("globalThis['fetch'](url);", SERVICE, 'fetchOutside', 'computed key'),
    badAny('const { fetch } = globalThis; fetch(url);', SERVICE, 'fetchOutside', 'destructured'),
    badAny("fetch('x');", SECRETS, 'fetchOutside', 'secrets may not call fetch'),
    badAny("fetch('x');", X509, 'fetchOutside', 'x509 may not call fetch'),
    badAny("fetch('x');", PORT, 'fetchOutside', 'a port may not call fetch'),
    badAny("fetch('x');", OTHER, 'fetchOutside', 'any other folder'),
    {
      name: 'a declared global is reported once per reference',
      code: "fetch('a');\nfetch('b');",
      filename: SERVICE,
      languageOptions: { globals: NODE_GLOBALS },
      errors: [
        { messageId: 'fetchOutside', line: 1 },
        { messageId: 'fetchOutside', line: 2 },
      ],
    },
    // The global bans do not depend on the folder: a file that is not under src is still refused.
    bad("import https from 'node:https';", 'packages/shared/src/x.ts', 'httpModule', {
      module: 'node:https',
    }),
    badAny(
      "fetch('x');",
      'apps/web/src/lib/api.ts',
      'fetchOutside',
      'the rule is path-agnostic for fetch',
    ),
  ],
});

describe('local/layering: scope', () => {
  it('runs on the server sources and leaves the container probe out', () => {
    const scope = scopeOf('layering');

    expect(scope.files).toEqual(['apps/server/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}']);
    expect(scope.ignores).toEqual(['apps/server/src/healthcheck.ts']);
  });
});
