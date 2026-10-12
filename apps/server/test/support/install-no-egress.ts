// Vitest setup file of the `server` project (vitest.config.ts `setupFiles`, seam XB14): the no-egress
// guard is on for every test file without any code in the test.
import { installNoEgress } from './no-egress.js';

installNoEgress();
