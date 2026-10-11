// Zod 4 probes `new Function('')` on the first parse to decide whether it may compile schemas. Under
// `require-trusted-types-for 'script'` that probe is reported as a violation even though Zod catches
// it (stack-probe P17). `jitless` turns the probe off; the server keeps JIT on. This module is
// imported for its effect, first in the entry, and from `zod/v4/core` so that it adds no schemas.
import { config } from 'zod/v4/core';

config({ jitless: true });

/** True once the configuration has been applied (a test reads it). */
export const ZOD_JITLESS: boolean = config().jitless === true;
