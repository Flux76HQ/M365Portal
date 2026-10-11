// Libraries that inject a <style> at run time look for the page's CSP nonce in the webpack global
// `__webpack_nonce__`, which Vite never sets. Radix's scroll lock (react-remove-scroll via get-nonce)
// is one: without it opening a dialog raises a `style-src-elem` violation (stack-probe P15). The
// server puts the nonce in `<meta property="csp-nonce">`; this copies it to the global before the
// first render.

/** Where libraries look for the nonce. */
interface NonceGlobal {
  __webpack_nonce__?: string;
}

/** The nonce of the page, or undefined (a development server renders none). */
export function readPageNonce(doc: Document = document): string | undefined {
  const meta = doc.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]');
  // A browser hides the `nonce` attribute once the page has a CSP and keeps the value in the
  // `nonce` property; a document that was not parsed under a CSP (or an engine without the property)
  // still has the attribute.
  const nonce = meta?.nonce ?? meta?.getAttribute('nonce');
  return nonce === undefined || nonce === null || nonce === '' ? undefined : nonce;
}

/** Sets `__webpack_nonce__` from the meta tag, when there is a nonce. Returns it. */
export function installNonceShim(doc: Document = document): string | undefined {
  const nonce = readPageNonce(doc);
  if (nonce !== undefined) (globalThis as NonceGlobal).__webpack_nonce__ = nonce;
  return nonce;
}
