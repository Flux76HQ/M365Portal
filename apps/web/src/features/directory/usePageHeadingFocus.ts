// Focus moves to the page heading when the person arrives at a page by navigating (FR-C-506), so a screen
// reader starts reading the new page and the keyboard starts at its top. It does not move on the first load
// of the address (the browser and the skip link own that), and it does not run again when only the search
// parameters change: the person is then working in the page, on a filter, and must keep the focus there.
import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

export function usePageHeadingFocus(): void {
  const router = useRouter();
  useEffect(() => {
    const index = router.state.location.state.__TSR_index;
    if (index <= 0) return;
    const heading = document.querySelector<HTMLElement>('main h1');
    if (heading === null) return;
    // A heading is not focusable by default; -1 makes it a target for the script and not a tab stop.
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [router]);
}
