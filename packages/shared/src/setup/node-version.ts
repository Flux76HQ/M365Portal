// The Node.js versions the panel supports, once (FR-B-213 `node_version`, CB4). The wizard's
// environment check compares the running Node with this range and warns when it is outside;
// `shared/node-version.test.ts` compares the constant with the `engines.node` range of the root
// `package.json` and with the major of `.nvmrc`, so the three cannot drift apart.

/** The lowest supported version: major, minor, patch. */
export const NODE_MINIMUM = [22, 19, 0] as const;

/** The supported major; the next major is outside the range. */
export const NODE_MAJOR = 22;

/** The range as `package.json` states it in `engines.node`. */
export const NODE_ENGINES_RANGE = `>=${NODE_MINIMUM.join('.')} <${String(NODE_MAJOR + 1)}`;

const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Whether `version` (`process.versions.node`, with or without a leading `v`) lies inside
 * `NODE_ENGINES_RANGE`. A pre-release, a short version or anything that is not three numbers is not
 * supported: the check is for released Node builds.
 */
export function isSupportedNodeVersion(version: string): boolean {
  const match = VERSION.exec(version);
  if (match === null) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (major !== NODE_MAJOR) return false;
  const [, minimumMinor, minimumPatch] = NODE_MINIMUM;
  return minor > minimumMinor || (minor === minimumMinor && patch >= minimumPatch);
}
