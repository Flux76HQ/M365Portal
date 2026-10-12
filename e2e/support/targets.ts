// Target size (WCAG 2.5.8): the interactive elements of a page that are smaller than 24 by 24 CSS px.
// Shared by responsive.spec.ts (every route) and keyboard.spec.ts (the new pages and states).
import type { Page } from '@playwright/test';

/** Visible interactive elements smaller than 24 by 24 CSS px (WCAG 2.5.8). */
export async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      '[role="button"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '[role="combobox"]',
      '[role="option"]',
    ].join(',');
    const small: string[] = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!el.checkVisibility()) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
      // A link inside a sentence is exempt (inline); so is a control that is only a hit area of a
      // larger one. Both are recognised by being inline text links.
      const inline = el instanceof HTMLAnchorElement && style.display === 'inline';
      if (inline) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // The visually hidden technique (a 1 by 1 px clipped box, such as the skip link until it has
      // focus): not a target while hidden; its size when focused is asserted in keyboard.spec.ts.
      if (rect.width <= 1 && rect.height <= 1) continue;
      if (rect.width < 23.5 || rect.height < 23.5) {
        small.push(
          `${el.tagName.toLowerCase()}[${el.getAttribute('role') ?? el.getAttribute('type') ?? ''}] "${(el.getAttribute('aria-label') ?? el.textContent.trim()).slice(0, 30)}" ${rect.width.toFixed(1)}x${rect.height.toFixed(1)}`,
        );
      }
    }
    return small;
  });
}
