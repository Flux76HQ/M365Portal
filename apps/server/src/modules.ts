// The modules of the application (contract C5, seam X1). Phase A has one, branding, which the S2
// stream appends here (`T-A-092`: one line). Phase B appends its five in the same way.
//
// Order matters: routes are registered, `start` hooks run and the first `shell` wins in this order.
import { brandingModule } from './branding/index.js';
import type { AppModuleFactory } from './module.js';

export const appModules: readonly AppModuleFactory[] = [brandingModule];
