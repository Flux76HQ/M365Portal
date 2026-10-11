// local/layering (FR-B-315, PB-01; plan 4.3; T-B-061)
//
// Who may import what in apps/server/src, and where outbound HTTP may start. The rule is the
// editor-time and CI half of the layering; `apps/server/test/layering.test.ts` is the import-graph
// half. Both exist because a boundary only one of them could see would be a boundary that nothing
// has seen fail.
//
//   everywhere in apps/server/src
//     node:http, node:https, node:http2, node:net, node:tls, undici      never imported
//         exceptions: a type-only import (it emits nothing) and the pure address helpers of node:net
//         (isIP, isIPv4, isIPv6, BlockList, SocketAddress), which open no socket
//     global fetch                                                       only under integrations/
//     jose, libsodium-wrappers, @azure/msal-node, @peculiar/x509,
//     reflect-metadata                                                   only under integrations/ and secrets/
//   integrations/graph, integrations/exchange   no jose, no @azure/msal-node
//   secrets/                                    no @azure/msal-node; @peculiar/x509 and
//                                               reflect-metadata only under secrets/x509/
//   ports/                                      nothing but relative imports inside ports/ and
//                                               @m365portal/shared (types and error classes only)
//
// The rule asks the file it is run on, so the same rule serves every folder; its scope (below)
// decides where it runs. apps/server/src/healthcheck.ts is outside the scope: the container probe
// opens one request to the loopback address of the process itself and is Phase A code.
//
// Resolution is by the module name written in the source. A computed `import(name)` or
// `require(name)` cannot be read and is not reported: the import-graph test and the code review
// are the second line there.
import { posix } from 'node:path';
import { isGlobalObject, resolvedName } from '../lib/ast.js';
import { SERVER_SOURCES } from '../lib/scope.js';

export const meta = {
  type: 'problem',
  docs: {
    description:
      'Keep the server layers apart: no HTTP modules, fetch only in integrations/, SDKs only in integrations/ and secrets/ (FR-B-315)',
  },
  messages: {
    httpModule:
      'Import of "{{module}}": outbound HTTP is global fetch inside apps/server/src/integrations only (FR-B-315).',
    boundaryPackage:
      'Import of "{{module}}": only apps/server/src/integrations and apps/server/src/secrets use it (FR-B-315).',
    forbiddenHere: 'Import of "{{module}}" is not allowed in this folder: {{reason}} (plan 4.3).',
    portsPure:
      'Import of "{{module}}" in a port: ports import nothing external and nothing outside ports/ except @m365portal/shared (FR-B-315).',
    fetchOutside:
      'Use of global fetch outside apps/server/src/integrations: services depend on the ports (FR-B-315).',
  },
  schema: [],
};

export const scope = {
  files: [SERVER_SOURCES],
  ignores: ['apps/server/src/healthcheck.ts'],
};

/** Modules that open sockets. `http` and `node:http` are the same module. */
const HTTP_MODULES = new Set(['http', 'https', 'http2', 'net', 'tls']);
/** The functions of node:net that only look at addresses. */
const PURE_NET_NAMES = new Set(['isIP', 'isIPv4', 'isIPv6', 'BlockList', 'SocketAddress']);

const BOUNDARY_PACKAGES = new Set([
  'jose',
  'libsodium-wrappers',
  '@azure/msal-node',
  '@peculiar/x509',
  'reflect-metadata',
]);
const X509_PACKAGES = new Set(['@peculiar/x509', 'reflect-metadata']);

/** The folder of apps/server/src a file lives in, as the path below src, or undefined. */
function pathBelowSrc(filename) {
  const match = /(?:^|\/)apps\/server\/src\/(.+)$/.exec(filename.replaceAll('\\', '/'));
  return match?.[1];
}

/** `jose/dist/x` is the package `jose`; `@scope/pkg/sub` is `@scope/pkg`; `node:fs` is `fs`. */
function packageOf(specifier) {
  if (specifier.startsWith('node:')) return specifier.slice('node:'.length).split('/')[0];
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function isUndiciOrHttp(name) {
  return name === 'undici' || HTTP_MODULES.has(name);
}

/** Is a global reference: no variable of that name is declared in the file. */
function isGlobalName(variable) {
  return variable === undefined || variable.defs.length === 0;
}

export function create(context) {
  const { sourceCode } = context;
  const below = pathBelowSrc(context.filename);
  const top = below?.split('/')[0];
  const second = below?.split('/')[1];
  const inIntegrations = top === 'integrations';
  const inSecrets = top === 'secrets';
  const inPorts = top === 'ports';
  const inX509 = inSecrets && second === 'x509';
  const inGraphOrExchange = inIntegrations && (second === 'graph' || second === 'exchange');

  function checkModule(node, specifier, { typeOnly, importedNames }) {
    if (typeof specifier !== 'string') return;

    if (inPorts) {
      const external = !specifier.startsWith('.');
      const shared =
        specifier === '@m365portal/shared' || specifier.startsWith('@m365portal/shared/');
      const leaves =
        specifier.startsWith('.') &&
        !posix.normalize(posix.join(posix.dirname(below), specifier)).startsWith('ports/');
      if ((external && !shared) || leaves) {
        context.report({ node, messageId: 'portsPure', data: { module: specifier } });
      }
      return;
    }

    const name = packageOf(specifier);
    if (name === undefined || specifier.startsWith('.')) return;

    // A type-only import emits nothing and opens nothing: it is how the Phase A code names `Server`.
    if (isUndiciOrHttp(name) && !typeOnly) {
      const pureNet =
        name === 'net' &&
        importedNames !== undefined &&
        importedNames.length > 0 &&
        importedNames.every((imported) => PURE_NET_NAMES.has(imported));
      if (!pureNet) {
        context.report({ node, messageId: 'httpModule', data: { module: specifier } });
      }
      return;
    }

    if (BOUNDARY_PACKAGES.has(name) && !inIntegrations && !inSecrets && !typeOnly) {
      context.report({ node, messageId: 'boundaryPackage', data: { module: specifier } });
      return;
    }
    if (inGraphOrExchange && (name === 'jose' || name === '@azure/msal-node') && !typeOnly) {
      context.report({
        node,
        messageId: 'forbiddenHere',
        data: { module: specifier, reason: "tokens are the identity folder's business" },
      });
      return;
    }
    if (
      inSecrets &&
      !inX509 &&
      (X509_PACKAGES.has(name) || name === '@azure/msal-node') &&
      !typeOnly
    ) {
      context.report({
        node,
        messageId: 'forbiddenHere',
        data: {
          module: specifier,
          reason:
            name === '@azure/msal-node'
              ? 'secrets holds keys and certificates, it does not talk to Entra'
              : 'the X.509 library is loaded lazily and only from secrets/x509/',
        },
      });
    }
  }

  function namesOf(declaration) {
    return declaration.specifiers.map((specifier) => {
      if (specifier.type === 'ImportSpecifier') {
        return specifier.imported.type === 'Identifier'
          ? specifier.imported.name
          : String(specifier.imported.value);
      }
      return '*'; // default and namespace imports can reach everything
    });
  }

  function allInlineType(declaration) {
    return (
      declaration.specifiers.length > 0 &&
      declaration.specifiers.every((specifier) => specifier.importKind === 'type')
    );
  }

  return {
    ImportDeclaration(node) {
      checkModule(node.source, node.source.value, {
        typeOnly: node.importKind === 'type' || allInlineType(node),
        importedNames: namesOf(node),
      });
    },
    ExportNamedDeclaration(node) {
      if (node.source === null || node.source === undefined) return;
      checkModule(node.source, node.source.value, {
        typeOnly: node.exportKind === 'type',
        importedNames: node.specifiers.map((specifier) =>
          specifier.local.type === 'Identifier' ? specifier.local.name : '*',
        ),
      });
    },
    ExportAllDeclaration(node) {
      checkModule(node.source, node.source.value, {
        typeOnly: node.exportKind === 'type',
        importedNames: ['*'],
      });
    },
    ImportExpression(node) {
      if (node.source.type === 'Literal') {
        checkModule(node.source, node.source.value, { typeOnly: false, importedNames: ['*'] });
      }
    },
    TSImportEqualsDeclaration(node) {
      const reference = node.moduleReference;
      if (
        reference.type === 'TSExternalModuleReference' &&
        reference.expression.type === 'Literal'
      ) {
        checkModule(reference, reference.expression.value, {
          typeOnly: node.importKind === 'type',
          importedNames: ['*'],
        });
      }
    },
    CallExpression(node) {
      const callee = node.callee;
      if (
        callee.type === 'Identifier' &&
        callee.name === 'require' &&
        node.arguments.length === 1 &&
        node.arguments[0].type === 'Literal'
      ) {
        checkModule(node, node.arguments[0].value, { typeOnly: false, importedNames: ['*'] });
      }
    },

    // Global fetch: the references to a global that is declared (by the config's globals) or not
    // declared at all, the way no-restricted-globals finds them; then the same name on the global
    // object (`globalThis.fetch`, `const { fetch } = globalThis`).
    Program(node) {
      if (inIntegrations) return;
      const globalScope = sourceCode.getScope(node);
      const isTypeQuery = (reference) => reference.identifier.parent.type === 'TSTypeQuery';
      for (const variable of globalScope.variables) {
        if (variable.name === 'fetch' && isGlobalName(variable)) {
          for (const reference of variable.references) {
            if (!isTypeQuery(reference)) {
              context.report({ node: reference.identifier, messageId: 'fetchOutside' });
            }
          }
        }
      }
      for (const reference of globalScope.through) {
        if (reference.identifier.name === 'fetch' && !isTypeQuery(reference)) {
          context.report({ node: reference.identifier, messageId: 'fetchOutside' });
        }
      }
    },
    MemberExpression(node) {
      if (inIntegrations) return;
      if (resolvedName(sourceCode, node) === 'fetch' && isGlobalObject(sourceCode, node.object)) {
        context.report({ node, messageId: 'fetchOutside' });
      }
    },
    Property(node) {
      if (inIntegrations || node.parent.type !== 'ObjectPattern') return;
      if (resolvedName(sourceCode, node) !== 'fetch') return;
      const { parent: pattern } = node;
      const holder = pattern.parent;
      const source =
        holder.type === 'VariableDeclarator' && holder.id === pattern
          ? holder.init
          : holder.type === 'AssignmentExpression' && holder.left === pattern
            ? holder.right
            : undefined;
      if (source !== undefined && source !== null && isGlobalObject(sourceCode, source)) {
        context.report({ node, messageId: 'fetchOutside' });
      }
    },
  };
}
