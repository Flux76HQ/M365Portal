import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Sets CSS properties on an element through the CSSOM (`style.setProperty`), the way the page's
 * `style-src` allows, and never as a `style="..."` string (plan 8.1). Colours that belong to the
 * organisation (a chosen accent, a plate) cannot be utility classes, so they are written here. An empty
 * value removes the property. The element is named by the returned ref.
 */
export function useCssProperties<T extends HTMLElement>(
  properties: Readonly<Record<string, string>>,
): RefObject<T | null> {
  const reference = useRef<T>(null);
  const serialised = JSON.stringify(properties);
  useLayoutEffect(() => {
    const element = reference.current;
    if (element === null) return;
    for (const [name, value] of Object.entries(JSON.parse(serialised) as Record<string, string>)) {
      if (value === '') element.style.removeProperty(name);
      else element.style.setProperty(name, value);
    }
  }, [serialised]);
  return reference;
}
