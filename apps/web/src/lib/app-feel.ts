// App-feel: the installed app behaves like a native one. No pinch or double-tap zoom, no pull-to-refresh and
// no rubber-band when a vertical swipe runs out of content; a swipe that can still scroll something scrolls it.
//
// Done here and not in `app.css` (the entry CSS has a byte budget) and not as `user-scalable=no` in the
// viewport meta: axe (meta-viewport, WCAG 1.4.4) fails every page that carries it. Browser zoom (Ctrl +,
// the text-size setting) is untouched; only the touch gestures are. `touch-action` and
// `overscroll-behavior` do the work in Chromium and Firefox; iOS Safari honours neither for pinch and, in an
// installed app, not reliably for the bounce, so the `gesture*` events and a `touchmove` guard stop those.

/** Can this element scroll further in the direction of the swipe (`down`: the finger moves down)? */
function canScroll(element: Element, down: boolean): boolean {
  const { scrollTop, scrollHeight, clientHeight } = element;
  return down ? scrollTop > 0 : scrollTop + clientHeight < scrollHeight - 1;
}

/**
 * Would this swipe, started on `target`, scroll something? Walks up the scrollable ancestors; the page itself
 * (the scrolling element) is the last one. A swipe that scrolls nothing is the one that would bounce.
 */
export function swipeScrolls(target: EventTarget | null, down: boolean, root: Element): boolean {
  for (let node = target; node instanceof Element && node !== root; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && canScroll(node, down)) return true;
  }
  return canScroll(root, down);
}

export function installAppFeel(doc: Document = document): void {
  for (const element of [doc.documentElement, doc.body]) {
    element.style.cssText += 'touch-action:pan-x pan-y;overscroll-behavior:none';
  }
  for (const type of ['gesturestart', 'gesturechange']) {
    doc.addEventListener(type, (event) => {
      event.preventDefault();
    });
  }

  let startX = 0;
  let startY = 0;
  // `null`: the swipe has not moved yet; decided once, on its first move, so a swipe never changes its mind.
  let block: boolean | null = null;
  doc.addEventListener(
    'touchstart',
    (event) => {
      startX = event.touches[0]?.clientX ?? 0;
      startY = event.touches[0]?.clientY ?? 0;
      block = null;
    },
    { passive: true },
  );
  doc.addEventListener(
    'touchmove',
    (event) => {
      if (!event.cancelable) return;
      if (event.touches.length > 1) {
        event.preventDefault();
        return;
      }
      const dx = (event.touches[0]?.clientX ?? startX) - startX;
      const dy = (event.touches[0]?.clientY ?? startY) - startY;
      if (block === null) {
        if (dx === 0 && dy === 0) return;
        // A sideways swipe (a wide table, a slider) is never ours to stop.
        if (Math.abs(dx) >= Math.abs(dy)) {
          block = false;
          return;
        }
        const root = doc.scrollingElement ?? doc.documentElement;
        block = !swipeScrolls(event.target, dy > 0, root);
      }
      if (block) event.preventDefault();
    },
    { passive: false },
  );
}
