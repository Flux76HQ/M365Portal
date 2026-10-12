// Canary cases for local/layering (FR-B-315, PB-01; plan 4.3 names the fixture that imports
// node:https from a service and must make the lint fail): scope apps/server/src/** except
// apps/server/src/healthcheck.ts.
//
// The two "outside" controls are the ones that notice a scope that was widened: the rule keeps no
// opinion about the web package's own fetch wrapper or about the container probe, only its scope
// does, so a rule run there reports.
import type { CanaryCase } from '../canary-case.js';

const RULE = 'local/layering';

export const cases = [
  {
    name: 'a service imports node:https',
    path: 'apps/server/src/setup/__lint_canary__/https-service.ts',
    code: `
import { request } from 'node:https';

export function call(): void {
  request('https://graph.microsoft.com/v1.0/organization');
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a repository imports undici',
    path: 'apps/server/src/rbac/__lint_canary__/undici-repository.ts',
    code: `
import { request } from 'undici';

export const get = request;
`,
    mustReport: [RULE],
  },
  {
    name: 'a route opens a socket with node:net',
    path: 'apps/server/src/auth/__lint_canary__/net-route.ts',
    code: `
import { connect } from 'node:net';

export const open = connect;
`,
    mustReport: [RULE],
  },
  {
    name: 'a service calls global fetch',
    path: 'apps/server/src/connection/__lint_canary__/fetch-service.ts',
    code: `
export async function organization(): Promise<unknown> {
  const response = await fetch('https://graph.microsoft.com/v1.0/organization');
  return response.json();
}
`,
    mustReport: [RULE],
  },
  {
    name: 'secrets calls global fetch',
    path: 'apps/server/src/secrets/__lint_canary__/fetch-secrets.ts',
    code: `
export async function ping(): Promise<number> {
  const response = await fetch('https://login.microsoftonline.com');
  return response.status;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'the policy layer imports jose',
    path: 'apps/server/src/policy/__lint_canary__/jose-policy.ts',
    code: `
import { jwtVerify } from 'jose';

export const verify = jwtVerify;
`,
    mustReport: [RULE],
  },
  {
    name: 'a Graph client imports MSAL',
    path: 'apps/server/src/integrations/graph/__lint_canary__/msal-graph.ts',
    code: `
import { ConfidentialClientApplication } from '@azure/msal-node';

export const app = ConfidentialClientApplication;
`,
    mustReport: [RULE],
  },
  {
    name: 'secrets outside x509/ imports the X.509 library',
    path: 'apps/server/src/secrets/__lint_canary__/x509-secrets.ts',
    code: `
import { X509Certificate } from '@peculiar/x509';

export const parse = X509Certificate;
`,
    mustReport: [RULE],
  },
  {
    name: 'a port imports a package',
    path: 'apps/server/src/ports/__lint_canary__/zod-port.ts',
    code: `
import { z } from 'zod';

export const schema = z.string();
`,
    mustReport: [RULE],
  },
  {
    name: 'control: the identity folder uses fetch, jose and MSAL',
    path: 'apps/server/src/integrations/identity/__lint_canary__/identity.ts',
    code: `
import { jwtVerify } from 'jose';
import { ConfidentialClientApplication } from '@azure/msal-node';

export async function load(uri: string): Promise<unknown> {
  const response = await fetch(uri, { redirect: 'error' });
  return [jwtVerify, ConfidentialClientApplication, response];
}
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: a service depends on a port and on node:crypto',
    path: 'apps/server/src/setup/__lint_canary__/clean-service.ts',
    code: `
import { timingSafeEqual } from 'node:crypto';
import type { GraphClient } from '../../ports/graph.js';

export function same(a: Buffer, b: Buffer, graph: GraphClient): boolean {
  return graph !== undefined && timingSafeEqual(a, b);
}
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: a type-only import of node:http is how Phase A names the server type',
    path: 'apps/server/src/__lint_canary__/type-only-http.ts',
    code: `
import type { Server } from 'node:http';

export type Handle = Server;
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the pure address helpers of node:net open no socket',
    path: 'apps/server/src/http/__lint_canary__/address-helpers.ts',
    code: `
import { BlockList, isIP } from 'node:net';

export const known = [BlockList, isIP];
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the container probe opens one request to its own loopback address',
    path: 'apps/server/src/healthcheck.ts',
    code: `
import { request } from 'node:http';

export const probe = request;
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the web package has its own fetch wrapper (rule scoped to the server)',
    path: 'apps/web/src/__lint_canary__/web-fetch.ts',
    code: `
export async function get(path: string): Promise<Response> {
  return fetch(path);
}
`,
    mustNotReport: [RULE],
  },
] as const satisfies readonly CanaryCase[];
