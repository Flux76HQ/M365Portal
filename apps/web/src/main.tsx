// The entry. The order of the first lines matters:
//   1. zod-config   Zod must not probe `new Function` (Trusted Types, probe P17): before any schema parses.
//   2. app.css      the stylesheet (the server inlines the built result into the HTML shell).
//   3. the nonce    libraries that inject a <style> at run time read `__webpack_nonce__` (probe P15).
//   4. the cache    `me` and `branding` come embedded in the page, so the first render needs no request.
import './boot/zod-config';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installNonceShim } from './boot/nonce-shim';
import { RootProviders } from './components/pages/root-providers';
import { getApiClient } from './lib/api';
import { readBootData } from './lib/boot-data';
import { createAppQueryClient, seedQueryClient } from './lib/query';
import { createAppRouter } from './router';

const nonce = installNonceShim();
const api = getApiClient();
const queryClient = createAppQueryClient();
const bootData = readBootData();
if (bootData) seedQueryClient(queryClient, bootData, api);

const router = createAppRouter(undefined, { queryClient, api });

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root element is missing from index.html');

createRoot(rootElement).render(
  <StrictMode>
    <RootProviders router={router} queryClient={queryClient} nonce={nonce} />
  </StrictMode>,
);
