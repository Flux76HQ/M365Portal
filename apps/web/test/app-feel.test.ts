// App-feel (PWA): no pinch zoom, no pull-to-refresh or bounce on a swipe that has nothing to scroll, and a
// swipe that can scroll still scrolls. `touch-action` / `overscroll-behavior` are set on the page.
import { beforeEach, describe, expect, it } from 'vitest';
import { installAppFeel, swipeScrolls } from '../src/lib/app-feel';

function scrollable(element: HTMLElement, state: { top: number; height: number; client: number }) {
  element.style.overflowY = 'auto';
  Object.defineProperties(element, {
    scrollTop: { value: state.top, configurable: true },
    scrollHeight: { value: state.height, configurable: true },
    clientHeight: { value: state.client, configurable: true },
  });
}

function touch(type: string, x: number, y: number, target: EventTarget, touches = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y };
  Object.defineProperty(event, 'touches', { value: Array.from({ length: touches }, () => point) });
  target.dispatchEvent(event);
  return event;
}

describe('installAppFeel', () => {
  let page: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="page"><p id="text">x</p></div>';
    page = document.getElementById('page')!;
    installAppFeel(document);
  });

  it('turns pinch and double-tap zoom and the overscroll off on the page', () => {
    for (const element of [document.documentElement, document.body]) {
      expect(element.style.touchAction).toBe('pan-x pan-y');
      expect(element.style.overscrollBehavior).toBe('none');
    }
  });

  it('stops the Safari pinch gesture events', () => {
    expect(touch('gesturestart', 0, 0, document).defaultPrevented).toBe(true);
    expect(touch('gesturechange', 0, 0, document).defaultPrevented).toBe(true);
  });

  it('stops a two-finger move', () => {
    expect(touch('touchmove', 5, 5, page, 2).defaultPrevented).toBe(true);
  });

  it('stops a vertical swipe when the page has nothing to scroll (pull-to-refresh, bounce)', () => {
    touch('touchstart', 10, 100, page);
    expect(touch('touchmove', 10, 160, page).defaultPrevented).toBe(true);
    expect(touch('touchmove', 10, 200, page).defaultPrevented).toBe(true);
  });

  it('lets a vertical swipe through while the scrolling element can still move that way', () => {
    scrollable(document.documentElement, { top: 300, height: 2000, client: 800 });
    touch('touchstart', 10, 100, page);
    expect(touch('touchmove', 10, 160, page).defaultPrevented).toBe(false);
    touch('touchstart', 10, 100, page);
    expect(touch('touchmove', 10, 40, page).defaultPrevented).toBe(false);
  });

  it('stops a pull down at the very top of a scrolled page, but not the swipe up', () => {
    scrollable(document.documentElement, { top: 0, height: 2000, client: 800 });
    touch('touchstart', 10, 100, page);
    expect(touch('touchmove', 10, 160, page).defaultPrevented).toBe(true);
    touch('touchstart', 10, 100, page);
    expect(touch('touchmove', 10, 40, page).defaultPrevented).toBe(false);
  });

  it('never stops a sideways swipe', () => {
    touch('touchstart', 10, 100, page);
    expect(touch('touchmove', 90, 104, page).defaultPrevented).toBe(false);
    expect(touch('touchmove', 150, 110, page).defaultPrevented).toBe(false);
  });
});

describe('swipeScrolls', () => {
  it('lets an inner scroller that has room take the swipe even at the top of the page', () => {
    document.body.innerHTML = '<div id="inner"><span id="leaf">x</span></div>';
    const inner = document.getElementById('inner')!;
    scrollable(inner, { top: 50, height: 500, client: 200 });
    expect(swipeScrolls(document.getElementById('leaf'), true, document.documentElement)).toBe(
      true,
    );
  });
});
