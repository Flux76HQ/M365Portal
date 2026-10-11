// The call record of the fake tenant (T-B-063): what it saw, as metadata only.
import type { CallLog, CallRecord } from './types.js';

export interface Recorder {
  readonly log: CallLog;
  record(entry: Omit<CallRecord, 'sequence'>): CallRecord;
  /** Forgets every call and starts the numbering at 1 again. */
  restart(): void;
}

export function createRecorder(): Recorder {
  let calls: CallRecord[] = [];
  let sequence = 0;

  const log: CallLog = {
    all: () => [...calls],
    mutating: () => calls.filter((call) => call.mutating),
    forHost: (host) => calls.filter((call) => call.host === host.toLowerCase()),
    get length() {
      return calls.length;
    },
    clear() {
      calls = [];
    },
  };

  return {
    log,
    record(entry) {
      sequence += 1;
      const call: CallRecord = { sequence, ...entry };
      calls.push(call);
      return call;
    },
    restart() {
      calls = [];
      sequence = 0;
    },
  };
}
