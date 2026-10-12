// The modules of the application (contract C5, seam X1). Phase A has one, branding, which the S2
// stream appended here (`T-A-092`: one line). Phase B appends its five in the same way (`T-B-014`):
// secrets, setup, connection, auth and rbac, in this order. Each is a stub until its stream takes the
// file over at gate GB0 (tasks.md section 1.3).
//
// Order matters: routes are registered, `start` hooks run and the first `shell` wins in this order,
// and `stop` hooks run in the reverse order. Secrets come first among the new ones because the others
// need the sealed certificate; branding stays first because its shell renders for every page.
import { authModule } from './auth/module.js';
import { brandingModule } from './branding/index.js';
import { connectionModule } from './connection/module.js';
import type { AppModuleFactory } from './module.js';
import { rbacModule } from './rbac/module.js';
import { secretsModule } from './secrets/module.js';
import { setupModule } from './setup/module.js';

export const appModules: readonly AppModuleFactory[] = [
  brandingModule,
  secretsModule,
  setupModule,
  connectionModule,
  authModule,
  rbacModule,
];
