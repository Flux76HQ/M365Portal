// Which font URLs count as the self-hosted Inter (visual.spec.ts, assertSelfHostedFont). The app ships the
// Inter subsets `latin` and `latin-ext` (the browser downloads a subset only when the page uses a
// character in its range, so a page with diacritics loads the second one). Only files that the server of
// the page itself serves from /assets/inter-* qualify: the origin is compared, not just the path.
export const SELF_HOSTED_FONT_PATH = /^\/assets\/inter-(latin|latin-ext)-wght-normal[^/]*\.woff2$/;

/** True when `url` is a self-hosted Inter file of the page served from `origin`. */
export function isSelfHostedFont(url, origin) {
  const parsed = new URL(url, origin);
  return parsed.origin === new URL(origin).origin && SELF_HOSTED_FONT_PATH.test(parsed.pathname);
}
