// The modules of the application (contract C5, seam X1). Phase A has one, branding, which the S2
// stream appended here (`T-A-092`: one line). Phase B appends its five in the same way (`T-B-014`):
// secrets, setup, connection, auth and rbac, in this order. Each is a stub until its stream takes the
// file over at gate GB0 (tasks.md section 1.3).
//
// Phase C appends the directory module (`T-C-024`, seam XC1): P33 to P39, all GET, read only.
//
// Phase D step D1 appends three modules (seam XD1): groups (`T-D-123`: the member writes P53 and P54, beside
// the read-only directory module), distribution lists (`T-D-120`: P40 to P45) and contacts (`T-D-122`: P47
// to P52).
//
// The dashboard module (P70, FR-D-808) comes last: it only reads, through the services of the modules above.
//
// Order matters: routes are registered, `start` hooks run and the first `shell` wins in this order,
// and `stop` hooks run in the reverse order. Secrets come first among the new ones because the others
// need the sealed certificate; branding stays first because its shell renders for every page.
import { authModule } from './auth/module.js';
import { brandingModule } from './branding/index.js';
import { connectionModule } from './connection/module.js';
import { contactsModule } from './contacts/module.js';
import { dashboardModule } from './dashboard/module.js';
import { directoryModule } from './directory/module.js';
import { groupsModule } from './groups/module.js';
import { distributionListsModule } from './distribution-lists/module.js';
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
  // Phase C (XC1): the read-only users and groups routes.
  directoryModule,
  // Phase D (XD1): the member writes of a group, distribution lists with their members, and mail contacts.
  groupsModule,
  distributionListsModule,
  contactsModule,
  // Phase D (P70): the dashboard counters, over the scoped list reads of the modules above.
  dashboardModule,
];
