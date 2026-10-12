// T-B-125: the setup session (FR-B-205). In memory, 256-bit id, idle 60 minutes sliding, absolute 8
// hours, at most 5 live sessions, the end hook when the last one goes (FR-B-215c).
import { describe, expect, it } from 'vitest';
import { hashSessionId } from '../../src/policy/session-hash.js';
import { createSetupSessions } from '../../src/setup/session.js';
import { createFakeClock } from '../helpers/fake-clock.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function make(options: { open?: () => boolean } = {}) {
  const clock = createFakeClock();
  let counter = 0;
  const random = {
    bytes: (n: number): Uint8Array => {
      counter += 1;
      return new Uint8Array(n).map((_, i) => (counter * 31 + i * 7) % 256);
    },
    float: (): number => 0.5,
  };
  const emptied: string[] = [];
  const sessions = createSetupSessions({
    now: () => clock.nowMs(),
    random,
    isOpen: options.open ?? (() => true),
    onEmpty: (reason) => emptied.push(reason),
  });
  return { clock, sessions, emptied };
}

describe('creation', () => {
  it('is a random 256-bit id as 43 base64url characters, distinct each time, with the two deadlines', () => {
    const { clock, sessions } = make();
    const one = sessions.create();
    const two = sessions.create();
    expect(one.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(two.id).not.toBe(one.id);
    expect(one.idleExpiresAt).toBe(new Date(clock.nowMs() + HOUR).toISOString());
    expect(one.absoluteExpiresAt).toBe(new Date(clock.nowMs() + 8 * HOUR).toISOString());
    expect(sessions.find(hashSessionId(one.id))).toBeDefined();
    expect(sessions.find(hashSessionId('x'.repeat(43)))).toBeUndefined();
  });

  it('the registry stores the hash of the id, not the id', () => {
    const { sessions } = make();
    const session = sessions.create();
    expect(JSON.stringify(sessions)).not.toContain(session.id);
    expect(sessions.info(hashSessionId(session.id))).toBeDefined();
  });

  it('at most 5 sessions are live: the oldest is evicted', () => {
    const { clock, sessions } = make();
    const created = [];
    for (let n = 0; n < 6; n += 1) {
      created.push(sessions.create());
      clock.advance(1000);
    }
    expect(sessions.count()).toBe(5);
    expect(sessions.find(hashSessionId(created[0]?.id ?? ''))).toBeUndefined();
    expect(sessions.find(hashSessionId(created[5]?.id ?? ''))).toBeDefined();
  });
});

describe('deadlines', () => {
  it('idle 60 minutes, sliding by touch', () => {
    const { clock, sessions } = make();
    const { id } = sessions.create();
    const hash = hashSessionId(id);
    clock.advance(59 * MINUTE);
    expect(sessions.find(hash)).toBeDefined();
    sessions.touch(hash);
    clock.advance(59 * MINUTE);
    expect(sessions.find(hash)).toBeDefined();
    clock.advance(2 * MINUTE);
    expect(sessions.find(hash)).toBeUndefined();
  });

  it('absolute 8 hours, whatever the activity', () => {
    const { clock, sessions } = make();
    const { id } = sessions.create();
    const hash = hashSessionId(id);
    for (let n = 0; n < 9; n += 1) {
      clock.advance(50 * MINUTE);
      sessions.touch(hash);
    }
    // 7 h 30 min of activity; 29 more minutes is still inside both deadlines.
    clock.advance(29 * MINUTE);
    expect(sessions.find(hash)).toBeDefined();
    clock.advance(2 * MINUTE);
    expect(sessions.find(hash)).toBeUndefined();
  });

  it('a session does not exist once setup is no longer open (the actor exists only while open)', () => {
    let open = true;
    const { sessions } = make({ open: () => open });
    const { id } = sessions.create();
    expect(sessions.find(hashSessionId(id))).toBeDefined();
    open = false;
    expect(sessions.find(hashSessionId(id))).toBeUndefined();
  });

  it('a restart needs the token again: a new registry knows no session', () => {
    const { sessions } = make();
    const { id } = sessions.create();
    const restarted = make().sessions;
    expect(restarted.find(hashSessionId(id))).toBeUndefined();
  });
});

describe('ending', () => {
  it('end() removes one session at once; the hook runs when it was the last', () => {
    const { sessions, emptied } = make();
    const a = sessions.create();
    const b = sessions.create();
    expect(sessions.end(hashSessionId(a.id))).toEqual({ ended: true, last: false });
    expect(emptied).toEqual([]);
    expect(sessions.end(hashSessionId(a.id))).toEqual({ ended: false, last: false });
    expect(sessions.end(hashSessionId(b.id))).toEqual({ ended: true, last: true });
    expect(emptied).toEqual(['ended']);
  });

  it('the sweeper removes expired sessions and runs the hook when the last one expired', () => {
    const { clock, sessions, emptied } = make();
    const a = sessions.create();
    clock.advance(30 * MINUTE);
    const b = sessions.create();
    clock.advance(31 * MINUTE);
    // a is idle-expired, b is alive.
    expect(sessions.sweep()).toEqual({ expired: 1 });
    expect(emptied).toEqual([]);
    expect(sessions.find(hashSessionId(b.id))).toBeDefined();
    expect(sessions.find(hashSessionId(a.id))).toBeUndefined();
    clock.advance(HOUR);
    expect(sessions.sweep()).toEqual({ expired: 1 });
    expect(emptied).toEqual(['expired']);
    // Nothing left: a further sweep does not run the hook again.
    sessions.sweep();
    expect(emptied).toEqual(['expired']);
  });

  it('endAll clears every session (setup completed or reopened) and runs the hook once', () => {
    const { sessions, emptied } = make();
    sessions.create();
    sessions.create();
    sessions.endAll();
    expect(sessions.count()).toBe(0);
    expect(emptied).toEqual(['ended']);
  });
});
