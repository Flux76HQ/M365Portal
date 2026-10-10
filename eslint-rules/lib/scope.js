// Where the local rules look, written once. Not a rule, so the loader does not scan it.
//
// The extensions are every kind of script the repository can hold. A rule scoped to `*.ts` and
// `*.tsx` alone leaves a `.mts`, a `.cjs` or a static `offline.js` outside every control (G0 defect
// D15). A test of the scope of each rule lists the same pattern, so narrowing it is a visible edit.

/** Every script file extension, as a brace body: `apps/web/src/**` + `/*.{ts,tsx,...}`. */
export const SCRIPT_EXTENSIONS = 'ts,tsx,mts,cts,js,jsx,mjs,cjs';
/** Files with JSX in them. */
export const JSX_EXTENSIONS = 'tsx,jsx';

/** The web package: its sources and the static files it serves as they are (`public/offline.js`). */
export const WEB_SCRIPTS = `apps/web/{src,public}/**/*.{${SCRIPT_EXTENSIONS}}`;
/** The components of the web package. */
export const WEB_COMPONENTS = `apps/web/src/**/*.{${JSX_EXTENSIONS}}`;
/** The server: its sources and its scripts (migrations in apps/server/drizzle are outside). */
export const SERVER_SCRIPTS = `apps/server/{src,scripts}/**/*.{${SCRIPT_EXTENSIONS}}`;
/** The server's sources: the application and its routes. */
export const SERVER_SOURCES = `apps/server/src/**/*.{${SCRIPT_EXTENSIONS}}`;
