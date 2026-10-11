// STAGED MOUNTING OF A LONG PAGE (T-A-173; components/pages/staged.tsx).
//
// The page mounts one part per task, from the top down, and says so with `data-progressive`; nothing
// that is on screen is pushed by a later part (a part is always appended after the ones that are
// there, nested parts before the next sibling). Outside a staged root everything is there at once.
import { expectGuardFails } from '@m365portal/shared/testing';
import { render, waitFor } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { Staged, StagedRoot } from '../src/components/pages/staged';

/** A part that notes when it mounted. */
function Part({ name, log, children }: { name: string; log: string[]; children?: ReactNode }) {
  useEffect(() => {
    log.push(name);
  }, [name, log]);
  return (
    <div data-part={name}>
      {name}
      {children}
    </div>
  );
}

function page(log: string[], enabled: boolean) {
  return (
    <StagedRoot enabled={enabled}>
      <Staged>
        <Part name="a" log={log}>
          <Staged>
            <Part name="a1" log={log} />
          </Staged>
          <Staged>
            <Part name="a2" log={log} />
          </Staged>
        </Part>
      </Staged>
      <Staged>
        <Part name="b" log={log}>
          <Staged>
            <Part name="b1" log={log} />
          </Staged>
        </Part>
      </Staged>
      <Staged>
        <Part name="c" log={log} />
      </Staged>
    </StagedRoot>
  );
}

/** The order a page may fill in: document order, depth first. */
const DOCUMENT_ORDER = ['a', 'a1', 'a2', 'b', 'b1', 'c'];

function assertFillsTopDown(order: readonly string[]): void {
  expect(order).toEqual(DOCUMENT_ORDER);
}

describe('StagedRoot and Staged', () => {
  it('start pending, mount one part per turn from the top down, nested parts before the next sibling, and end done', async () => {
    const log: string[] = [];
    const { container } = render(page(log, true));
    const root = container.firstElementChild!;
    expect(root.getAttribute('data-progressive')).toBe('pending');
    expect(container.querySelectorAll('[data-part]').length).toBeLessThan(DOCUMENT_ORDER.length);
    await waitFor(() => {
      expect(root.getAttribute('data-progressive')).toBe('done');
    });
    expect(
      [...container.querySelectorAll('[data-part]')].map((el) => el.getAttribute('data-part')),
    ).toEqual(DOCUMENT_ORDER);
    assertFillsTopDown(
      log
        .filter((name) => DOCUMENT_ORDER.includes(name))
        .sort((x, y) => DOCUMENT_ORDER.indexOf(x) - DOCUMENT_ORDER.indexOf(y)),
    );
    // The mount order itself is the document order, not "all parents, then all children".
    expect(log).toEqual(DOCUMENT_ORDER);
  });

  it('mount everything at once, and say done, when it is not enabled', () => {
    const log: string[] = [];
    const { container } = render(page(log, false));
    expect(container.firstElementChild!.getAttribute('data-progressive')).toBe('done');
    expect(container.querySelectorAll('[data-part]')).toHaveLength(DOCUMENT_ORDER.length);
  });

  it('mount at once outside any root (a part used on its own)', () => {
    const log: string[] = [];
    const { container } = render(
      <Staged>
        <Part name="x" log={log} />
      </Staged>,
    );
    expect(container.querySelector('[data-part="x"]')).not.toBeNull();
  });

  it('an order that fills a later part first fails the check (negative fixture)', () => {
    expectGuardFails(assertFillsTopDown, ['a', 'b', 'a1', 'a2', 'b1', 'c']);
  });
});
