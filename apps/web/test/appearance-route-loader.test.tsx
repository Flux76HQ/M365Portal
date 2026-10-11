// The Appearance route loads the shared branding code before the page renders (T-A-173).
//
// `useBrandingTools()` is null until the code has loaded and the page then re-renders; a re-render that
// arrives from a promise runs as one synchronous task (40 ms on a phone). With the route's `loader`
// the router waits for the code, so the first render already has it. The test pins both halves: the
// route has the loader, and once it has run the hook answers at its first render.
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useBrandingTools } from '../src/features/branding/tools';
import { Route } from '../src/routes/settings.appearance';

describe('the Appearance route loader', () => {
  it('exists and loads the branding tools, so the first render of the page has them', async () => {
    const loader = (Route.options as { loader?: (context: never) => Promise<void> }).loader;
    expect(loader, 'the route has a loader').toBeTypeOf('function');
    await loader?.({} as never);
    const { result } = renderHook(() => useBrandingTools());
    expect(result.current, 'the tools are there at the first render').not.toBeNull();
  });
});
