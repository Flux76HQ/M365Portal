// local/no-decode-microsoft-tokens (FR-B-316; T-B-061)
//
// Learn: "Don't attempt to validate or read tokens for any API you don't own" (v2-oauth2-auth-code-flow,
// refresh the access token). An access token for Graph or Exchange is opaque to us; the only token
// the product reads is the ID token Entra issues to our own application, and that happens in one
// file, apps/server/src/integrations/identity/id-token.ts, after the signature is checked. Anywhere
// else in apps/server/src these are refused:
//
//   decodeJwt, decodeProtectedHeader        imported (from any module, under any alias), reached on a
//                                           namespace (`jose.decodeJwt`), or called by name
//   a manual split of a token               Buffer.from / atob / base64url.decode applied to a piece
//                                           of `something.split('.')`, directly or through a const or
//                                           a destructuring that holds one
//
// A bare `.split('.')` is not reported: host names and version strings are split on dots all the
// time. What marks a token is decoding a part of the split.
import { findVariable, resolvedName, staticName, unwrap } from '../lib/ast.js';
import { SERVER_SOURCES } from '../lib/scope.js';

export const meta = {
  type: 'problem',
  docs: {
    description:
      'Disallow decoding Microsoft tokens outside integrations/identity/id-token.ts (FR-B-316)',
  },
  messages: {
    decodeFunction:
      '"{{name}}" reads a token: only integrations/identity/id-token.ts may, and only for the ID token of our own application (FR-B-316).',
    manualSplit:
      'Decoding a part of a dot-separated string is reading a token by hand: only integrations/identity/id-token.ts may (FR-B-316).',
  },
  schema: [],
};

export const scope = {
  files: [SERVER_SOURCES],
  ignores: ['apps/server/src/integrations/identity/id-token.ts'],
};

const DECODE_FUNCTIONS = new Set(['decodeJwt', 'decodeProtectedHeader']);

function isSplitOnDot(node) {
  const call = unwrap(node);
  if (call.type !== 'CallExpression') return false;
  const callee = unwrap(call.callee);
  if (callee.type !== 'MemberExpression' || staticName(callee) !== 'split') return false;
  const [separator] = call.arguments;
  return separator?.type === 'Literal' && separator.value === '.';
}

export function create(context) {
  const { sourceCode } = context;

  /** Does the expression hold a piece of a dot-split string? */
  function isTokenPiece(expression, depth = 0) {
    const node = unwrap(expression);
    if (isSplitOnDot(node)) return true;
    if (node.type === 'MemberExpression') return isTokenPiece(node.object, depth + 1);
    // `payload ?? ''`, `payload || ''`, `ok ? payload : ''`: a fallback does not make it another value.
    if (node.type === 'LogicalExpression') {
      return isTokenPiece(node.left, depth + 1) || isTokenPiece(node.right, depth + 1);
    }
    if (node.type === 'ConditionalExpression') {
      return isTokenPiece(node.consequent, depth + 1) || isTokenPiece(node.alternate, depth + 1);
    }
    if (node.type === 'CallExpression') {
      // `parts[1].replace(...)`, `parts.at(1)`: a method of a piece is still a piece.
      const callee = unwrap(node.callee);
      return callee.type === 'MemberExpression' && isTokenPiece(callee.object, depth + 1);
    }
    if (node.type !== 'Identifier' || depth > 4) return false;
    const variable = findVariable(sourceCode.getScope(node), node.name);
    if (variable?.defs.length !== 1) return false;
    const [definition] = variable.defs;
    if (definition?.type !== 'Variable') return false;
    const declarator = definition.node;
    if (declarator.init === null || declarator.init === undefined) return false;
    // `const parts = x.split('.')`, `const [h, p] = x.split('.')`, `const p = parts[1]`.
    return isTokenPiece(declarator.init, depth + 1);
  }

  function isBase64Decoder(call) {
    const callee = unwrap(call.callee);
    if (callee.type === 'Identifier') return callee.name === 'atob';
    if (callee.type !== 'MemberExpression') return false;
    const name = resolvedName(sourceCode, callee);
    const object = unwrap(callee.object);
    if (object.type === 'Identifier' && object.name === 'Buffer' && name === 'from') {
      const encoding = call.arguments[1];
      return (
        encoding?.type === 'Literal' &&
        typeof encoding.value === 'string' &&
        encoding.value.startsWith('base64')
      );
    }
    // `base64url.decode(piece)` of jose, and `decodeBase64Url(piece)` written as a member.
    return (
      name === 'decode' &&
      object.type !== undefined &&
      ((object.type === 'Identifier' && /base64/i.test(object.name)) ||
        (object.type === 'MemberExpression' && /base64/i.test(staticName(object) ?? '')))
    );
  }

  return {
    ImportSpecifier(node) {
      const imported =
        node.imported.type === 'Identifier' ? node.imported.name : String(node.imported.value);
      if (DECODE_FUNCTIONS.has(imported)) {
        context.report({ node, messageId: 'decodeFunction', data: { name: imported } });
      }
    },
    MemberExpression(node) {
      const name = resolvedName(sourceCode, node);
      if (name !== undefined && DECODE_FUNCTIONS.has(name)) {
        context.report({ node, messageId: 'decodeFunction', data: { name } });
      }
    },
    CallExpression(node) {
      const callee = unwrap(node.callee);
      if (callee.type === 'Identifier' && DECODE_FUNCTIONS.has(callee.name)) {
        // Reported at the import when there is one; a call of a name nobody imported is reported here.
        const variable = findVariable(sourceCode.getScope(node), callee.name);
        const imported = variable?.defs.some((definition) => definition.type === 'ImportBinding');
        if (imported !== true) {
          context.report({ node, messageId: 'decodeFunction', data: { name: callee.name } });
        }
        return;
      }
      if (!isBase64Decoder(node)) return;
      const [argument] = node.arguments;
      if (argument !== undefined && isTokenPiece(argument)) {
        context.report({ node, messageId: 'manualSplit' });
      }
    },
  };
}
