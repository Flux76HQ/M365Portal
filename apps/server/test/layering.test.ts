// T-B-082, FR-B-315, FR-B-316, FR-B-310, FR-B-707, PBR-01 (+ negative): the import graph of
// `apps/server/src` against the layering table of plan 4.3. The ESLint rule `local/layering`
// (eslint-rules/rules/layering.js) is the editor-time half; this is the half that reads the whole tree
// and the one a rule that was switched off cannot silence. Both exist because a boundary that only
// one of them could see would be a boundary that nothing has seen fail.
//
//   everywhere            no node:http, https, http2, net (except the pure address helpers), tls, no
//                         undici; global fetch only under integrations/ (healthcheck.ts, the container
//                         probe of Phase A, is outside the rule)
//   boundary packages     jose, libsodium-wrappers, @azure/msal-node, @peculiar/x509 and
//                         reflect-metadata only under integrations/ and secrets/
//   integrations/graph, integrations/exchange   no jose, no @azure/msal-node
//   secrets/              no @azure/msal-node; x509 and reflect-metadata only under secrets/x509/
//   ports/                nothing but ports/ and @m365portal/shared
//   sign-in path          no file reachable from integrations/identity/oidc-client.ts imports MSAL
//   concrete clients      outside integrations/, only registry.ts and tenant-pin.ts may be imported
//                         (type-only imports excepted): services get clients from the registry
//   provisioner           created in integrations/registry.ts only, and never without a live bearer
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { createIdentityFetch } from '../src/integrations/identity/http.js';
import { createBootstrapAuthenticator } from '../src/integrations/identity/bootstrap.js';
import {
  createTenantProvisioner,
  provisionerFactory,
} from '../src/integrations/graph/provisioner.js';
import { NotConnectedError } from '../src/ports/errors.js';
import * as serviceFixture from './fixtures/layering/service-https.js';
import * as fetchFixture from './fixtures/layering/service-fetch.js';
import * as joseFixture from './fixtures/layering/graph-jose.js';
import * as msalFixture from './fixtures/layering/signin-msal.js';
import * as clientFixture from './fixtures/layering/service-client.js';
import * as portFixture from './fixtures/layering/port-io.js';
import * as secretsFixture from './fixtures/layering/secrets-fetch.js';
import * as x509Fixture from './fixtures/layering/x509-outside.js';
import {
  importsOf,
  readServerSources,
  resolveRelative,
  stripComments,
  type SourceFile,
} from './helpers/source-files.js';
import { createTime, rejectionOf } from './integrations/support.js';

const HTTP_MODULES = new Set(['http', 'https', 'http2', 'net', 'tls']);
const PURE_NET = new Set(['isIP', 'isIPv4', 'isIPv6', 'BlockList', 'SocketAddress']);
const BOUNDARY = new Set([
  'jose',
  'libsodium-wrappers',
  '@azure/msal-node',
  '@peculiar/x509',
  'reflect-metadata',
]);
const X509 = new Set(['@peculiar/x509', 'reflect-metadata']);
const SIGN_IN_ENTRY = 'integrations/identity/oidc-client.ts';
/** The only files outside integrations/ that may be imported from there (T-B-023, T-B-081). */
const PUBLIC_INTEGRATIONS = new Set(['integrations/registry.ts', 'integrations/tenant-pin.ts']);
const PROVISIONER_FILES = new Set([
  'integrations/registry.ts',
  'integrations/graph/provisioner.ts',
]);

/** `jose/dist/x` is `jose`; `@scope/pkg/sub` is `@scope/pkg`; `node:http` is `http`. */
function packageOf(specifier: string): string {
  if (specifier.startsWith('node:')) return specifier.slice(5).split('/')[0] ?? '';
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0] ?? '';
}

const FETCH_CALL = /(?:^|[^.\w$'"`])fetch\s*\(|\bglobalThis\s*\.\s*fetch\b|\bwindow\s*\.\s*fetch\b/;

export interface Violation {
  readonly path: string;
  readonly rule: string;
}

export function layeringViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  const report = (path: string, rule: string): void => {
    out.push({ path, rule });
  };
  const byPath = new Map(files.map((file) => [file.path, file]));

  for (const file of files) {
    const top = file.path.split('/')[0] ?? '';
    const second = file.path.split('/')[1] ?? '';
    const inIntegrations = top === 'integrations';
    const inSecrets = top === 'secrets';
    const inPorts = top === 'ports';
    const inGraphOrExchange = inIntegrations && (second === 'graph' || second === 'exchange');
    const inX509 = inSecrets && second === 'x509';

    for (const ref of importsOf(file.text)) {
      const name = packageOf(ref.specifier);
      const relative = ref.specifier.startsWith('.');

      if (inPorts) {
        const shared =
          ref.specifier === '@m365portal/shared' || ref.specifier.startsWith('@m365portal/shared/');
        const target = relative ? resolveRelative(file.path, ref.specifier) : undefined;
        if ((!relative && !shared) || (relative && !(target ?? '').startsWith('ports/'))) {
          report(file.path, `ports-pure:${ref.specifier}`);
        }
        continue;
      }

      if (!relative) {
        if (
          (HTTP_MODULES.has(name) || name === 'undici') &&
          !ref.typeOnly &&
          file.path !== 'healthcheck.ts'
        ) {
          const pureNet =
            name === 'net' && ref.names.length > 0 && ref.names.every((n) => PURE_NET.has(n));
          if (!pureNet) report(file.path, `http-module:${ref.specifier}`);
        }
        if (BOUNDARY.has(name) && !ref.typeOnly) {
          if (!inIntegrations && !inSecrets) report(file.path, `boundary-package:${name}`);
          if (inGraphOrExchange && (name === 'jose' || name === '@azure/msal-node')) {
            report(file.path, `graph-exchange-sdk:${name}`);
          }
          if (inSecrets && name === '@azure/msal-node') report(file.path, 'secrets-msal');
          if (X509.has(name) && inSecrets && !inX509) report(file.path, `x509-outside:${name}`);
        }
        continue;
      }

      // A relative import that leaves integrations/ for a concrete client of it.
      const target = resolveRelative(file.path, ref.specifier);
      if (
        !inIntegrations &&
        !ref.typeOnly &&
        target?.startsWith('integrations/') === true &&
        !PUBLIC_INTEGRATIONS.has(target)
      ) {
        report(file.path, `concrete-client:${target}`);
      }
      if (
        !ref.typeOnly &&
        target !== undefined &&
        ref.names.some((n) => n === 'createTenantProvisioner' || n === 'provisionerFactory') &&
        !PROVISIONER_FILES.has(file.path)
      ) {
        report(file.path, 'provisioner-outside-registry');
      }
    }

    if (
      !inIntegrations &&
      file.path !== 'healthcheck.ts' &&
      FETCH_CALL.test(stripComments(file.text))
    ) {
      report(file.path, 'fetch-outside-integrations');
    }
  }

  // The sign-in path: whatever oidc-client.ts reaches through relative imports must not import MSAL.
  const entry = byPath.get(SIGN_IN_ENTRY);
  if (entry !== undefined) {
    const seen = new Set<string>();
    const queue = [entry.path];
    for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
      if (seen.has(path)) continue;
      seen.add(path);
      const file = byPath.get(path);
      if (file === undefined) continue;
      for (const ref of importsOf(file.text)) {
        if (!ref.typeOnly && packageOf(ref.specifier) === '@azure/msal-node') {
          report(path, 'signin-msal');
        }
        const next = resolveRelative(path, ref.specifier);
        if (next !== undefined) queue.push(next);
      }
    }
  }
  return out;
}

function withFixture(
  files: readonly SourceFile[],
  fixture: { virtualPath: string; source: string },
): SourceFile[] {
  return [
    ...files.filter((file) => file.path !== fixture.virtualPath),
    { path: fixture.virtualPath, text: fixture.source },
  ];
}

const real = readServerSources();

describe('the real tree', () => {
  it('reads enough files to mean something', () => {
    expect(real.length).toBeGreaterThan(100);
    expect(real.some((file) => file.path === SIGN_IN_ENTRY)).toBe(true);
    expect(real.some((file) => file.path === 'integrations/registry.ts')).toBe(true);
  });

  it('has no layering violation', () => {
    expect(layeringViolations(real)).toEqual([]);
  });

  it('the sign-in path reaches the files of the sign-in code and not the MSAL ones', () => {
    // A sanity check of the closure: it must at least contain the token endpoint and the validator.
    const reach = new Set<string>();
    const queue = [SIGN_IN_ENTRY];
    for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
      if (reach.has(path)) continue;
      reach.add(path);
      const file = real.find((candidate) => candidate.path === path);
      for (const ref of importsOf(file?.text ?? '')) {
        const next = resolveRelative(path, ref.specifier);
        if (next !== undefined) queue.push(next);
      }
    }
    for (const name of [
      'token-endpoint',
      'id-token',
      'jwks',
      'tenant-metadata',
      'client-assertion',
    ]) {
      expect(reach.has(`integrations/identity/${name}.ts`), name).toBe(true);
    }
    expect(reach.has('integrations/identity/app-token.ts')).toBe(false);
    expect(reach.has('integrations/identity/bootstrap.ts')).toBe(false);
  });
});

describe('negatives: a file that breaks one rule is reported (the guard is seen failing)', () => {
  const CASES: readonly [string, { virtualPath: string; source: string }, string][] = [
    ['a service imports node:https', serviceFixture, 'http-module:node:https'],
    ['a service calls fetch', fetchFixture, 'fetch-outside-integrations'],
    ['the Graph client imports jose', joseFixture, 'graph-exchange-sdk:jose'],
    ['MSAL on the sign-in path', msalFixture, 'signin-msal'],
    [
      'a service builds a concrete client',
      clientFixture,
      'concrete-client:integrations/graph/graph-client.ts',
    ],
    ['a port imports node:fs', portFixture, 'ports-pure:node:fs'],
    ['secrets calls fetch', secretsFixture, 'fetch-outside-integrations'],
    ['x509 outside secrets/x509', x509Fixture, 'x509-outside:@peculiar/x509'],
  ];

  it.each(CASES)('%s', (_name, fixture, reason) => {
    expectGuardFails(
      (files: SourceFile[]) => {
        const found = layeringViolations(files);
        if (found.length > 0) {
          throw new Error(found.map((entry) => `${entry.path}: ${entry.rule}`).join('; '));
        }
      },
      withFixture(real, fixture),
      { name: 'layering', reason: `${fixture.virtualPath}: ${reason}` },
    );
  });

  it('a boundary package imported by a service is reported with the package name', () => {
    const found = layeringViolations([
      { path: 'auth/rogue.ts', text: "import { SignJWT } from 'jose';" },
    ]);
    expect(found).toEqual([{ path: 'auth/rogue.ts', rule: 'boundary-package:jose' }]);
  });
});

describe('what the rules allow', () => {
  const allowed: readonly [string, string][] = [
    ['integrations/graph/a.ts', "const r = await fetch('https://graph.microsoft.com/');"],
    ['http/a.ts', "import type { Server } from 'node:http';"],
    ['http/b.ts', "import { isIP, BlockList } from 'node:net';"],
    ['http/c.ts', 'const response = await app.fetch(request);'],
    ['http/d.ts', "// fetch('https://x') in a comment\nexport const a = 1;"],
    ['secrets/a.ts', "import { CompactSign } from 'jose';"],
    ['secrets/x509/a.ts', "import * as x509 from '@peculiar/x509';"],
    ['integrations/identity/a.ts', "import { PublicClientApplication } from '@azure/msal-node';"],
    ['auth/a.ts', "import type { JWTPayload } from 'jose';"],
    [
      'ports/a.ts',
      "import type { Guid } from './graph.js';\nimport { x } from '@m365portal/shared/limits';",
    ],
    ['setup/a.ts', "import { createClientsRegistry } from '../integrations/registry.js';"],
    ['setup/b.ts', "import type { GraphLog } from '../integrations/graph/graph-http.js';"],
    ['healthcheck.ts', "import { request } from 'node:http';\nrequest('http://127.0.0.1');"],
  ];
  it.each(allowed)('%s', (path, text) => {
    expect(layeringViolations([{ path, text }])).toEqual([]);
  });

  const forbidden: readonly [string, string, string][] = [
    ['http/a.ts', "import { request } from 'node:http';", 'http-module:node:http'],
    ['auth/a.ts', "import net from 'node:net';", 'http-module:node:net'],
    ['auth/b.ts', "import { Agent } from 'undici';", 'http-module:undici'],
    ['auth/c.ts', "const x = await import('node:tls');", 'http-module:node:tls'],
    ['auth/d.ts', "const h = require('https');", 'http-module:https'],
    ['auth/e.ts', 'const r = globalThis.fetch(url);', 'fetch-outside-integrations'],
    [
      'setup/a.ts',
      "import sodium from 'libsodium-wrappers';",
      'boundary-package:libsodium-wrappers',
    ],
    [
      'integrations/exchange/a.ts',
      "import { x } from '@azure/msal-node';",
      'graph-exchange-sdk:@azure/msal-node',
    ],
    ['secrets/a.ts', "import { x } from '@azure/msal-node';", 'secrets-msal'],
    ['secrets/a.ts', "import 'reflect-metadata';", 'x509-outside:reflect-metadata'],
    [
      'setup/a.ts',
      "import { AdminApiExchangeClient } from '../integrations/exchange/admin-api-client.js';",
      'concrete-client:integrations/exchange/admin-api-client.ts',
    ],
    [
      'ports/a.ts',
      "import { x } from '../integrations/registry.js';",
      'ports-pure:../integrations/registry.js',
    ],
    [
      'setup/a.ts',
      "import { createTenantProvisioner } from '../integrations/graph/provisioner.js';",
      'provisioner-outside-registry',
    ],
  ];
  it.each(forbidden)('%s refuses: %s', (path, text, rule) => {
    const found = layeringViolations([{ path, text }]);
    expect(found.map((entry) => entry.rule)).toContain(rule);
  });
});

describe('no TenantProvisioner without a live bootstrap (FR-B-310)', () => {
  const deps = () => {
    const time = createTime();
    return {
      clock: time.clock,
      random: { bytes: (n: number) => new Uint8Array(n), float: () => 0.5 },
      scheduler: time.scheduler,
      time,
    };
  };

  it('createTenantProvisioner needs a bearer provider', () => {
    const { clock, random, scheduler } = deps();
    for (const bearer of [undefined, null, 'token', {}, 5]) {
      expect(() => createTenantProvisioner(bearer as never, { clock, random, scheduler })).toThrow(
        TypeError,
      );
    }
  });

  it('the factory refuses a bootstrap that is not signed in, and one that was discarded', async () => {
    const { clock, random, scheduler, time } = deps();
    const factory = provisionerFactory({ clock, random, scheduler });
    const bootstrap = createBootstrapAuthenticator({
      clientId: '14d82eec-204b-4c2f-b7e8-296a70dab67e',
      clock,
      scheduler,
      jsonFetch: createIdentityFetch({ clock: time.clock, scheduler: time.scheduler }),
    });
    expect(await rejectionOf(factory(bootstrap))).toBeInstanceOf(NotConnectedError);
    bootstrap.discard();
    expect(await rejectionOf(factory(bootstrap))).toBeInstanceOf(NotConnectedError);
  });

  it('only the registry builds one', () => {
    const builders = real
      .filter((file) => file.path !== 'integrations/graph/provisioner.ts')
      .filter((file) =>
        importsOf(file.text).some((ref) =>
          ref.names.some((n) => n === 'createTenantProvisioner' || n === 'provisionerFactory'),
        ),
      )
      .map((file) => file.path);
    expect(builders).toEqual(['integrations/registry.ts']);
  });
});
