// T-D-114, FR-D-103: the parts of the key hand-over that touch the machine: how a tmpfs is recognised,
// what the real scratch file system does (a private directory, removal, the sweep), and that the
// manager of scratch directories only ever touches directories it made (a bug must not delete
// anything else). The behaviour of a session in both modes is in no-key-on-disk.test.ts.
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SCRATCH_PREFIX,
  createScratchManager,
  isOnTmpfs,
  nodeScratchFileSystem,
} from '../../src/integrations/exchange/pwsh/key-handover.js';
import { sequenceRandom } from '../integrations/support.js';
import { MemoryScratch } from './support.js';

/** A cut from `/proc/self/mountinfo` of a container with a read-only root and a tmpfs on /tmp and /dev/shm. */
const MOUNTINFO = [
  '2154 1993 0:150 / / ro,relatime master:420 - overlay overlay rw,lowerdir=/x',
  '2155 2154 0:152 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw',
  '2156 2154 0:153 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755',
  '2157 2156 0:157 / /dev/shm rw,nosuid,nodev,noexec,relatime - tmpfs shm rw,size=65536k',
  '2158 2154 0:158 / /tmp rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=1048576k',
  '2159 2154 8:1 /var/lib/docker/volumes/data /data rw,relatime - ext4 /dev/sda1 rw',
  '2160 2154 0:159 / /with\\040space rw - tmpfs tmpfs rw',
  '2161 2154 0:160 / /ram rw - ramfs ramfs rw',
].join('\n');

describe('isOnTmpfs', () => {
  it.each([
    ['/tmp', true],
    ['/tmp/m365portal-exo-0123456789abcdef', true],
    ['/dev/shm', true],
    ['/dev/shm/deep/er', true],
    ['/dev', true],
    ['/ram/x', true],
    ['/with space/x', true],
    ['/data', false],
    ['/data/x', false],
    ['/app', false],
    ['/', false],
    ['/tmpfoo', false],
    ['/dev/shmx', true],
  ])('%s is %s', (path, expected) => {
    expect(isOnTmpfs(MOUNTINFO, path)).toBe(expected);
  });

  it('the longest mount point decides: a disk below a tmpfs is a disk', () => {
    const text = `${MOUNTINFO}\n2170 2158 8:2 / /tmp/disk rw - ext4 /dev/sdb1 rw`;
    expect(isOnTmpfs(text, '/tmp/disk/x')).toBe(false);
    expect(isOnTmpfs(text, '/tmp/other')).toBe(true);
  });

  it('is false for text it cannot read, and for no text', () => {
    expect(isOnTmpfs('', '/tmp')).toBe(false);
    expect(isOnTmpfs('garbage\nmore garbage', '/tmp')).toBe(false);
    expect(isOnTmpfs('1 2 3 4', '/tmp')).toBe(false);
  });

  it('resolves a path with dots before it decides', () => {
    expect(isOnTmpfs(MOUNTINFO, '/tmp/../data/x')).toBe(false);
    expect(isOnTmpfs(MOUNTINFO, '/data/../tmp/x')).toBe(true);
  });
});

describe('the real scratch file system', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('makes a directory with mode 0700, refuses one that exists, and removes a tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'exo-scratch-'));
    made.push(root);
    const dir = join(root, 'd');
    nodeScratchFileSystem.makeDirectory(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(() => {
      nodeScratchFileSystem.makeDirectory(dir);
    }).toThrow();
    writeFileSync(join(dir, 'k.pfx'), 'x');
    nodeScratchFileSystem.removeTree(dir);
    expect(() => statSync(dir)).toThrow();
    // Removing what is gone is not an error.
    expect(() => {
      nodeScratchFileSystem.removeTree(dir);
    }).not.toThrow();
  });

  it('lists the directories directly below a root, and nothing for a root that is not there', () => {
    const root = mkdtempSync(join(tmpdir(), 'exo-scratch-'));
    made.push(root);
    mkdirSync(join(root, 'a'));
    mkdirSync(join(root, 'b'));
    writeFileSync(join(root, 'file'), 'x');
    expect(nodeScratchFileSystem.listDirectories(root).sort()).toEqual(['a', 'b']);
    expect(nodeScratchFileSystem.listDirectories(join(root, 'missing'))).toEqual([]);
  });

  it('knows that a plain temporary directory on this machine is or is not a tmpfs without throwing', () => {
    expect(typeof nodeScratchFileSystem.isTmpfs(tmpdir())).toBe('boolean');
    expect(nodeScratchFileSystem.isTmpfs('/definitely/not/mounted/anywhere')).toBeTypeOf('boolean');
  });
});

describe('the scratch manager', () => {
  const random = (): ReturnType<typeof sequenceRandom> => sequenceRandom([0]);

  it('names directories with the prefix and 16 hex digits, one different name each time', () => {
    const fs = new MemoryScratch();
    const manager = createScratchManager({ fs, root: '/dev/shm', random: random() });
    const first = manager.create();
    const second = manager.create();
    for (const path of [first, second]) {
      expect(path).toMatch(new RegExp(`^/dev/shm/${SCRATCH_PREFIX}[0-9a-f]{16}$`));
    }
    expect(first).not.toBe(second);
  });

  it('removes only a directory it could have made: the root, a parent, a lookalike and a path with dots are left alone', () => {
    const fs = new MemoryScratch();
    const manager = createScratchManager({ fs, root: '/dev/shm', random: random() });
    fs.plant('/dev/shm/precious/file', Uint8Array.from([1]));
    fs.plant('/dev/shm/m365portal-exo-evil/file', Uint8Array.from([2]));
    fs.plant('/dev/other/m365portal-exo-0123456789abcdef/file', Uint8Array.from([3]));
    for (const path of [
      '/dev/shm',
      '/dev',
      '/',
      '/dev/shm/precious',
      '/dev/shm/m365portal-exo-evil',
      '/dev/shm/../shm/precious',
      '/dev/other/m365portal-exo-0123456789abcdef',
    ]) {
      manager.remove(path);
    }
    expect([...fs.files().keys()].sort()).toEqual([
      '/dev/other/m365portal-exo-0123456789abcdef/file',
      '/dev/shm/m365portal-exo-evil/file',
      '/dev/shm/precious/file',
    ]);
  });

  it('refuses a root that is not a tmpfs, and sweeps once', () => {
    const disk = new MemoryScratch({ tmpfs: false });
    expect(() => {
      createScratchManager({ fs: disk, root: '/data', random: random() }).prepare();
    }).toThrow('scratch_not_tmpfs');
    const fs = new MemoryScratch();
    fs.plant('/dev/shm/m365portal-exo-0123456789abcdef/k.pfx', Uint8Array.from([1]));
    const manager = createScratchManager({ fs, root: '/dev/shm', random: random() });
    manager.prepare();
    expect(fs.files().size).toBe(0);
    fs.plant('/dev/shm/m365portal-exo-fedcba9876543210/k.pfx', Uint8Array.from([1]));
    manager.prepare();
    // Once: a directory that appears later belongs to a live worker of this process.
    expect(fs.files().size).toBe(1);
  });
});
