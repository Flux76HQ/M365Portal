// The fake tenant over local HTTP (T-B-370, CB17, PB-21): the one fake of the server tests
// (`apps/server/test/fakes/fake-tenant`, CB7) behind a plain HTTP listener on `E2E_PORT + 2`, for the
// two other transports of plan 14.3:
//
//   the server process   `server-preload.mjs` (MSW) forwards its three Microsoft hosts here
//   the browser          `microsoft-routes.ts` (`context.route`) answers Microsoft navigations from here
//
// Two tenants live in the process, one per instance: `a` for the configured instance, `b` for the
// empty one that the wizard specs drive. Separate worlds keep a wizard run on B from touching the
// application that A signs in with.
//
//   HTTP  (E2E_PORT + 2)
//     CONNECT <microsoft host>:443   the browser's proxy: tunnelled to the TLS listener; any other host 403
//     ANY  /t/<a|b>/<microsoft host>/<path>?<query>   the request, as the fake sees it (redirects are
//                                                     returned as they are, never followed)
//     POST /control/<a|b>   {"op": "...", "args": ...} the control surface (`FAKE_OPERATIONS`)
//     GET  /healthz
//   HTTPS (E2E_PORT + 3, the throwaway certificate of E2E_TLS_KEY_FILE / E2E_TLS_CERT_FILE)
//     ANY  /<path>   for the browser, which reaches the three Microsoft host names here; the host is
//                    the `Host` header and the tenant the instance whose origin `redirect_uri` or
//                    `post_logout_redirect_uri` names (default A)
//
// The clock is the wall clock: the server process and the browser read the same time. This file runs
// under `tsx` (the fake is TypeScript, written for Vitest); it is test support and nothing under
// `apps/server/src` or any bundle refers to it (`server/no-test-hooks.test.ts`).
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import net from 'node:net';
import {
  createFakeEntra,
  seedApplication,
  type FakeEntra,
} from '../../apps/server/test/fakes/fake-tenant/entra/index.js';
import { exchangeModule } from '../../apps/server/test/fakes/fake-tenant/exchange/module.js';
import {
  createFakeGraph,
  describeSeed,
  seedDirectory,
  type FakeGraph,
  type SeededDirectory,
} from '../../apps/server/test/fakes/fake-tenant/graph/index.js';
import {
  createFakeTenant,
  FAKE_TENANT_HOSTS,
  SimulatedNetworkFailure,
  type FakeTenant,
} from '../../apps/server/test/fakes/fake-tenant/index.js';
import { type FakeExchange } from '../../apps/server/test/fakes/fake-tenant/exchange/module.js';
import { originOf, portOf } from './ports.js';
import { GLOBAL_ADMINISTRATOR_TEMPLATE_ID, PRINCIPALS, ROLE_GROUP } from './principals.js';

type TenantKey = 'a' | 'b';

interface Scene {
  readonly tenant: FakeTenant;
  readonly graph: FakeGraph;
  readonly entra: FakeEntra;
  readonly exchange: FakeExchange;
}

const clock = { now: () => Date.now() };

function seed(scene: Scene): void {
  const { directory } = scene.graph;
  for (const principal of Object.values(PRINCIPALS)) {
    directory.addUser({
      id: principal.oid,
      userPrincipalName: principal.upn,
      displayName: principal.displayName,
    });
  }
  const group = directory.addGroup({ id: ROLE_GROUP.oid, displayName: ROLE_GROUP.displayName });
  directory.addMember(group.id, PRINCIPALS['group-member'].oid);
  // The wizard polls at the interval the fake answers: one second keeps a run short.
  scene.entra.control.device.interval(1);
}

function createScene(): Scene {
  const graph = createFakeGraph({ clock });
  const entra = createFakeEntra({ clock, world: graph.world });
  const exchange = exchangeModule(graph.world);
  const tenant = createFakeTenant({
    clock,
    modules: [graph.module, entra.module, exchange.module],
  });
  const scene: Scene = { tenant, graph, entra, exchange };
  seed(scene);
  return scene;
}

const scenes: Record<TenantKey, Scene> = { a: createScene(), b: createScene() };

// ---- the seeded directory (T-C-060) ---------------------------------------------------------------

interface SeedHold {
  readonly seeded: SeededDirectory;
  /** The ids that existed before the seed, so that `directory.unseed` removes only what it added. */
  readonly before: {
    readonly users: ReadonlySet<string>;
    readonly groups: ReadonlySet<string>;
    readonly others: ReadonlySet<string>;
  };
}

const seededDirectories = new WeakMap<Scene, SeedHold>();

/** What a spec needs to know about the seeded directory; computed here, from the rows themselves. */
function seedSummary(scene: Scene) {
  const { directory } = scene.graph;
  let held = seededDirectories.get(scene);
  if (held === undefined) {
    const before = {
      users: new Set(directory.users.keys()),
      groups: new Set(directory.groups.keys()),
      others: new Set(directory.otherObjects.keys()),
    };
    held = { seeded: seedDirectory(directory), before };
    seededDirectories.set(scene, held);
  }
  const { seeded } = held;
  const users = [...directory.users.values()];
  const named = (id: string) => {
    const user = directory.users.get(id);
    const group = directory.groups.get(id);
    return {
      id,
      displayName: user?.displayName ?? group?.displayName ?? null,
      mail: user?.mail ?? group?.mail ?? null,
    };
  };
  const inFinance = (id: string | null | undefined): boolean =>
    id !== null && id !== undefined && directory.users.get(id)?.department === 'Finance';
  const finance = users.filter((user) => user.department === 'Finance');
  const withOutsideManager = finance.find(
    (user) => user.managerId !== null && !inFinance(user.managerId),
  );
  const outside = users.find(
    (user) => user.department === 'Sales' && user.id !== seeded.ids.noManagerUser,
  );
  return {
    note: describeSeed(seeded),
    ids: seeded.ids,
    named: Object.fromEntries(Object.entries(seeded.ids).map(([key, id]) => [key, named(id)])),
    counts: {
      users: users.length,
      groups: directory.groups.size,
      finance: finance.length,
      disabled: users.filter((user) => user.accountEnabled === false).length,
      enabled: users.filter((user) => user.accountEnabled !== false).length,
      guests: users.filter((user) => user.userType === 'Guest').length,
      members: users.filter((user) => user.userType === 'Member').length,
      m365: seeded.kinds.m365.length,
      security: seeded.kinds.security.length,
      mailsecurity: seeded.kinds.mailsecurity.length,
      distribution: seeded.kinds.distribution.length,
    },
    /** A Finance user whose manager is outside Finance: a restricted manager for a Finance-scoped actor. */
    financeUserWithOutsideManager:
      withOutsideManager === undefined ? null : named(withOutsideManager.id),
    /** A user outside Finance (Sales): the scoped actor gets a 403 on its id. */
    outsideUser: outside === undefined ? null : named(outside.id),
    /** A user of Finance. */
    financeUser: finance[0] === undefined ? null : named(finance[0].id),
  };
}

// ---- the control surface ------------------------------------------------------------------------

type Json = Record<string, unknown>;
type Operation = (scene: Scene, args: Json) => unknown;

function text(args: Json, name: string): string {
  const value = args[name];
  if (typeof value !== 'string') throw new Error(`argument ${name} must be a string`);
  return value;
}
function num(args: Json, name: string): number {
  const value = args[name];
  if (typeof value !== 'number') throw new Error(`argument ${name} must be a number`);
  return value;
}

/** The application the wizard created: the one that carries the install tag. */
function panelApplication(scene: Scene) {
  for (const application of scene.graph.directory.applications.values()) {
    if (application.tags.some((tag) => tag.startsWith('m365portal-install-'))) return application;
  }
  throw new Error('the fake tenant holds no application with an install tag');
}

/** What a person sees in Microsoft Entra for the panel's application: the facts the specs compare. */
function summaryOfPanelApplication(scene: Scene) {
  const { directory } = scene.graph;
  const application = panelApplication(scene);
  const servicePrincipal = directory.servicePrincipalByAppId(application.appId);
  const roles = (kind: 'graph' | 'exchange'): string[] => {
    if (servicePrincipal === undefined) return [];
    const names: string[] = [];
    for (const assignment of directory.appRoleAssignments.values()) {
      if (assignment.principalId !== servicePrincipal.id) continue;
      const resource = directory.servicePrincipals.get(assignment.resourceId);
      if (resource === undefined || directory.resourceKindOf(resource) !== kind) continue;
      const role = resource.appRoles.find((candidate) => candidate.id === assignment.appRoleId);
      if (role !== undefined) names.push(role.value);
    }
    return names.sort();
  };
  const claims = application.optionalClaims as { idToken?: { name: string }[] } | null;
  return {
    appId: application.appId,
    objectId: application.id,
    displayName: application.displayName,
    description: application.description,
    tags: application.tags,
    redirectUris: application.web.redirectUris,
    implicitGrant: application.web.implicitGrantSettings,
    optionalClaimNames: (claims?.idToken ?? []).map((claim) => claim.name).sort(),
    graphRoles: roles('graph'),
    exchangeRoles: roles('exchange'),
    entraRoleTemplateIds:
      servicePrincipal === undefined
        ? []
        : [...directory.directoryRoleAssignments.values()]
            .filter((assignment) => assignment.principalId === servicePrincipal.id)
            .map((assignment) => assignment.roleDefinitionId),
    keyCredentials: application.keyCredentials.length,
    thumbprintsSha1: application.keyCredentials.map((key) => key.thumbprintSha1.toLowerCase()),
    passwordCredentials: application.passwordCredentials.length,
    owners: application.owners.length,
  };
}

export const FAKE_OPERATIONS: Readonly<Record<string, Operation>> = {
  /** Back to the initial tenant: the people of `principals.ts`, nothing else. */
  reset(scene) {
    scene.tenant.reset();
    seededDirectories.delete(scene);
    seed(scene);
    return null;
  },
  // ---- the seeded directory of Phase C (FR-C-601, T-C-060) ---------------------------------------
  /** Adds the 1,200 users and 150 groups of `seedDirectory`; a second call returns the first answer. */
  'directory.seed': (scene) => seedSummary(scene),
  /** Takes the seeded rows out again, so that the shared tenant is what it was (other specs rely on it). */
  'directory.unseed': (scene) => {
    const held = seededDirectories.get(scene);
    if (held === undefined) return null;
    const { directory } = scene.graph;
    for (const id of [...directory.users.keys()])
      if (!held.before.users.has(id)) directory.users.delete(id);
    for (const id of [...directory.groups.keys()])
      if (!held.before.groups.has(id)) directory.groups.delete(id);
    for (const id of [...directory.otherObjects.keys()])
      if (!held.before.others.has(id)) directory.otherObjects.delete(id);
    seededDirectories.delete(scene);
    return null;
  },
  // U66, U67, U36: the switches of the fake Graph that the directory specs turn.
  'graph.managerForApps': (scene, args) => {
    scene.graph.control.managerForApps(args.mode === 'allowed' ? 'allowed' : 'refused');
    return null;
  },
  'graph.hiddenMembersRefused': (scene, args) => {
    scene.graph.control.hiddenMembersRefused(args.on !== false);
    return null;
  },
  'graph.omitGroupProperties': (scene, args) => {
    scene.graph.control.omitGroupProperties(args.on === true);
    return null;
  },
  // ---- sign-in -----------------------------------------------------------------------------------
  nextSignIn(scene, args) {
    scene.entra.control.nextSignIn(args);
    return null;
  },
  defaultSignIn(scene, args) {
    scene.entra.control.defaultSignIn(args.spec ?? null);
    return null;
  },
  'entra.logouts': (scene) => scene.entra.control.logouts(),
  'entra.authorizeRequests': (scene) => scene.entra.control.authorizeRequests(),
  'entra.tokenRequests': (scene) => scene.entra.control.tokenRequests(),
  'entra.failToken': (scene, args) => {
    scene.entra.control.failToken(args as never);
    return null;
  },
  // ---- the device sign-in of the wizard ----------------------------------------------------------
  'device.approve': (scene, args) => {
    scene.entra.control.device.approve({
      user: text(args, 'user'),
      ...(Array.isArray(args.entraRoleTemplateIds)
        ? { entraRoleTemplateIds: args.entraRoleTemplateIds as string[] }
        : { entraRoleTemplateIds: [GLOBAL_ADMINISTRATOR_TEMPLATE_ID] }),
    });
    return null;
  },
  'device.pending': (scene) => scene.entra.control.device.pending(),
  'device.decline': (scene) => {
    scene.entra.control.device.decline();
    return null;
  },
  'device.expire': (scene) => {
    scene.entra.control.device.expire();
    return null;
  },
  'device.block': (scene) => {
    scene.entra.control.device.block();
    return null;
  },
  'device.interval': (scene, args) => {
    scene.entra.control.device.interval(num(args, 'seconds'));
    return null;
  },
  'device.failStart': (scene, args) => {
    scene.entra.control.device.failStart((args.answer ?? null) as never);
    return null;
  },
  // ---- Graph and Exchange toggles -----------------------------------------------------------------
  'graph.replicationDelay': (scene, args) => {
    scene.graph.control.replicationDelay(num(args, 'calls'));
    return null;
  },
  'graph.failWith': (scene, args) => {
    scene.graph.control.failWith({
      times: num(args, 'times'),
      status: num(args, 'status') as 500,
      ...(typeof args.match === 'string' ? { match: new RegExp(args.match) } : {}),
    });
    return null;
  },
  'graph.credentialLifetimePolicy': (scene, args) => {
    scene.graph.control.credentialLifetimePolicy(
      typeof args.maxDays === 'number' ? args.maxDays : null,
    );
    return null;
  },
  'exchange.propagation': (scene, args) => {
    scene.exchange.control.propagation(num(args, 'calls'));
    return null;
  },
  'exchange.previewAvailable': (scene, args) => {
    scene.exchange.control.previewAvailable(args.available === true);
    return null;
  },
  /** A tenant without an Exchange service principal (OV-20, EB-03). */
  removeExchangeServicePrincipal(scene) {
    scene.graph.directory.removeExchangeServicePrincipal();
    return null;
  },
  /** An application with this name and no install tag (the adoption question of FR-B-303). */
  addForeignApplication(scene, args) {
    const { directory } = scene.graph;
    const objectId = directory.newId('foreign-application');
    const appId = directory.newId('foreign-client');
    directory.applications.set(objectId, {
      id: objectId,
      appId,
      displayName: text(args, 'displayName'),
      description: null,
      signInAudience: 'AzureADMyOrg',
      web: {
        redirectUris: [],
        implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
        logoutUrl: null,
      },
      requiredResourceAccess: [],
      optionalClaims: null,
      tags: [],
      keyCredentials: [],
      passwordCredentials: [],
      owners: [],
      createdDateTime: directory.nowIso(),
      extra: {},
      pending: 0,
    });
    return { objectId, appId };
  },
  // ---- drift (the repair of FR-B-218): changes made behind the panel's back ----------------------
  'drift.removeGraphGrant': (scene, args) => {
    const { directory } = scene.graph;
    const application = panelApplication(scene);
    const servicePrincipal = directory.servicePrincipalByAppId(application.appId);
    if (servicePrincipal === undefined) throw new Error('the panel application has no principal');
    const wanted = text(args, 'role');
    const graph = [...directory.servicePrincipals.values()].find(
      (candidate) => directory.resourceKindOf(candidate) === 'graph',
    );
    const role = graph?.appRoles.find((candidate) => candidate.value === wanted);
    let removed = 0;
    for (const [id, assignment] of directory.appRoleAssignments) {
      if (assignment.principalId === servicePrincipal.id && assignment.appRoleId === role?.id) {
        directory.appRoleAssignments.delete(id);
        removed += 1;
      }
    }
    return { removed };
  },
  'drift.setRedirectUris': (scene, args) => {
    panelApplication(scene).web.redirectUris = (args.uris as string[]).slice();
    return null;
  },
  /** The panel's application as Microsoft Entra holds it (for the specs that compare it with the UI). */
  panelApplication: (scene) => summaryOfPanelApplication(scene),
  /**
   * What a person does by hand in Microsoft Entra, following the checklist (FR-B-218, EB-04): the
   * application with exactly the values they were given, the certificate they downloaded, the
   * permissions, the consent and the Entra role. Returns the client id and the tenant id they then
   * type into the panel.
   */
  seedManualApplication(scene, args) {
    const names = (name: string): string[] =>
      Array.isArray(args[name]) ? (args[name] as string[]) : [];
    const seeded = seedApplication(scene.graph.world, {
      redirectUris: names('redirectUris'),
      displayName: text(args, 'displayName'),
      graphRoles: names('graphRoles'),
      exchangeRoles: names('exchangeRoles'),
      certificate: false,
    });
    const { directory } = scene.graph;
    const application = directory.applications.get(seeded.objectId);
    if (application === undefined) throw new Error('the seeded application is gone');
    application.description = text(args, 'description');
    application.tags = names('tags');
    application.optionalClaims = {
      idToken: names('optionalClaimNames').map((name) => ({ name, essential: false })),
    };
    application.keyCredentials = [
      directory.credentialFromUpload({
        key: text(args, 'certificateBase64'),
        type: 'AsymmetricX509Cert',
        usage: 'Verify',
        displayName: 'uploaded by hand',
      }),
    ];
    if (typeof args.entraRoleTemplateId === 'string') {
      seeded.assignEntraRole(args.entraRoleTemplateId);
    }
    return { appId: seeded.appId, tenantId: directory.tenantId };
  },
  /** The tenant id the fake reports (what a person reads on the Entra overview page). */
  tenantId: (scene) => scene.graph.directory.tenantId,
  // ---- what the fake saw --------------------------------------------------------------------------
  calls: (scene) => scene.tenant.calls.all(),
  'calls.mutating': (scene) => scene.tenant.calls.mutating(),
  'calls.clear': (scene) => {
    scene.tenant.calls.clear();
    return null;
  },
  /** Counts of objects of the panel, for "no duplicate application or service principal". */
  inventory: (scene) => {
    const { directory } = scene.graph;
    const applications = [...directory.applications.values()].filter((a) =>
      a.tags.some((tag) => tag.startsWith('m365portal')),
    );
    return {
      applications: applications.length,
      servicePrincipals: applications.filter(
        (a) => directory.servicePrincipalByAppId(a.appId) !== undefined,
      ).length,
      keyCredentials: applications.reduce((sum, a) => sum + a.keyCredentials.length, 0),
      redirectUris: applications.flatMap((a) => a.web.redirectUris),
      namedApplications: [...directory.applications.values()].map((a) => a.displayName),
    };
  },
};

// ---- the HTTP listener --------------------------------------------------------------------------

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

const SKIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
]);

async function forward(
  scene: Scene,
  host: string,
  rest: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? 'GET';
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (SKIPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(request);
  const fakeRequest = new Request(`https://${host}${rest}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: new Uint8Array(body) }),
  });
  try {
    const answer = await scene.tenant.fetch(fakeRequest);
    const out: Record<string, string | string[]> = {};
    answer.headers.forEach((value, name) => {
      out[name] = value;
    });
    const cookies = answer.headers.getSetCookie();
    if (cookies.length > 0) out['set-cookie'] = cookies;
    response.writeHead(answer.status, out);
    response.end(Buffer.from(await answer.arrayBuffer()));
  } catch (failure) {
    if (failure instanceof SimulatedNetworkFailure) {
      // The client must see a dropped connection, not an answer.
      request.socket.destroy();
      return;
    }
    process.stderr.write(`fake tenant crashed: ${String(failure)}\n`);
    send(response, 500, { error: 'fake_crashed' });
  }
}

/** The browser's side: the tenant is the instance the redirect comes back to. */
function tenantOfBrowserRequest(url: URL): TenantKey {
  for (const name of ['redirect_uri', 'post_logout_redirect_uri']) {
    const value = url.searchParams.get(name);
    if (value?.startsWith(originOf('b')) === true) return 'b';
  }
  return 'a';
}

async function handleBrowserRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'https://fake.invalid');
  const host = (request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!(FAKE_TENANT_HOSTS as readonly string[]).includes(host)) {
    send(response, 404, { error: 'not a host of the fake tenant' });
    return;
  }
  await forward(
    scenes[tenantOfBrowserRequest(url)],
    host,
    `${url.pathname}${url.search}`,
    request,
    response,
  );
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://fake.invalid');
    const segments = url.pathname.split('/');
    if (url.pathname === '/healthz') {
      send(response, 200, { status: 'ok' });
      return;
    }
    const tenantKey = segments[2] as TenantKey | undefined;
    if (tenantKey !== 'a' && tenantKey !== 'b') {
      send(response, 404, { error: 'unknown tenant' });
      return;
    }
    const scene = scenes[tenantKey];
    if (segments[1] === 'control' && request.method === 'POST') {
      try {
        const payload = JSON.parse((await readBody(request)).toString('utf8')) as {
          op?: string;
          args?: Json;
        };
        const operation = FAKE_OPERATIONS[payload.op ?? ''];
        if (operation === undefined) {
          send(response, 404, { error: `no operation ${String(payload.op)}` });
          return;
        }
        send(response, 200, { result: operation(scene, payload.args ?? {}) ?? null });
      } catch (failure) {
        process.stderr.write(`fake tenant operation failed: ${String(failure)}\n`);
        send(response, 400, { error: 'operation_failed' });
      }
      return;
    }
    if (segments[1] === 't') {
      const host = segments[3] ?? '';
      if (!(FAKE_TENANT_HOSTS as readonly string[]).includes(host)) {
        send(response, 404, { error: 'not a host of the fake tenant' });
        return;
      }
      const rest = `/${segments.slice(4).join('/')}${url.search}`;
      await forward(scene, host, rest, request, response);
      return;
    }
    send(response, 404, { error: 'unknown path' });
  })();
});

// The browser's proxy: a CONNECT to a Microsoft host is tunnelled to the TLS listener below, anything
// else is refused (the browser has no other way out).
server.on('connect', (request, socket, head) => {
  const host = (request.url ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!(FAKE_TENANT_HOSTS as readonly string[]).includes(host)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  const upstream = net.connect(portOf('fakeTls'), '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => {
    socket.destroy();
  });
  socket.on('error', () => {
    upstream.destroy();
  });
});

server.listen(portOf('fake'), '127.0.0.1');

const keyFile = process.env.E2E_TLS_KEY_FILE;
const certFile = process.env.E2E_TLS_CERT_FILE;
if (keyFile === undefined || certFile === undefined) {
  throw new Error('fake tenant: E2E_TLS_KEY_FILE and E2E_TLS_CERT_FILE are set by global-setup');
}
const tlsServer = createTlsServer(
  { key: readFileSync(keyFile), cert: readFileSync(certFile) },
  (request, response) => {
    void handleBrowserRequest(request, response);
  },
);
tlsServer.listen(portOf('fakeTls'), '127.0.0.1');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close();
    tlsServer.close();
    process.exit(0);
  });
}
