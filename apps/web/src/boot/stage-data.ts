// The data layer of the start-up (main.tsx): the API client, the Query client and the boot data, one
// dynamic import so that their modules are evaluated in a task of their own.
export { getApiClient } from '../lib/api';
export { readBootData } from '../lib/boot-data';
export { setStoredDefaultLanguage } from '../lib/locale';
export { createAppQueryClient, seedQueryClient } from '../lib/query';
// The check of the session before the first route is loaded (T-B-296).
export { recheckBootSession } from './recheck';
