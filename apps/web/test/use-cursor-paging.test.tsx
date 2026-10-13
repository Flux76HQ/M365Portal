// THE CURSOR PAGING HOOK (T-C-041; FR-C-502, EC-C3). Next and previous move through cursors the server handed
// out, the earlier pages are remembered in component state, a change of filters starts again, and a
// `cursor_invalid` answer restarts the list from the first page with a notice.
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import { useCursorPaging } from '../src/features/directory/useCursorPaging';

const apiError = (code: string, status = 400) =>
  new ApiError({
    code,
    status,
    requestId: null,
    errors: [],
    expectedOrigin: null,
    retryAfterSeconds: null,
  });

describe('useCursorPaging', () => {
  it('starts on the first page with no cursor and nothing before it', () => {
    const { result } = renderHook(() => useCursorPaging('a'));
    expect(result.current.cursor).toBeUndefined();
    expect(result.current.page).toBe(1);
    expect(result.current.canPrevious).toBe(false);
    expect(result.current.restarted).toBe(false);
  });

  it('moves forward with the cursors it is given and back through the ones it remembered', () => {
    const { result } = renderHook(() => useCursorPaging('a'));
    act(() => {
      result.current.next('c2');
    });
    expect(result.current.cursor).toBe('c2');
    expect(result.current.page).toBe(2);
    expect(result.current.canPrevious).toBe(true);
    act(() => {
      result.current.next('c3');
    });
    expect(result.current.cursor).toBe('c3');
    expect(result.current.page).toBe(3);
    act(() => {
      result.current.previous();
    });
    expect(result.current.cursor).toBe('c2');
    expect(result.current.page).toBe(2);
    act(() => {
      result.current.previous();
    });
    expect(result.current.cursor).toBeUndefined();
    expect(result.current.canPrevious).toBe(false);
    act(() => {
      result.current.previous();
    });
    expect(result.current.page).toBe(1);
  });

  it('starts again from the first page when the filters (the reset key) change', () => {
    const { result, rerender } = renderHook(({ key }) => useCursorPaging(key), {
      initialProps: { key: 'a' },
    });
    act(() => {
      result.current.next('c2');
    });
    rerender({ key: 'a' });
    expect(result.current.page).toBe(2);
    rerender({ key: 'b' });
    expect(result.current.cursor).toBeUndefined();
    expect(result.current.page).toBe(1);
    expect(result.current.canPrevious).toBe(false);
  });

  it('restarts from the first page and says so when the server calls the cursor invalid', () => {
    const { result, rerender } = renderHook(({ error }) => useCursorPaging('a', error), {
      initialProps: { error: null as unknown },
    });
    act(() => {
      result.current.next('c2');
    });
    act(() => {
      result.current.next('c3');
    });
    rerender({ error: apiError('cursor_invalid') });
    expect(result.current.cursor).toBeUndefined();
    expect(result.current.page).toBe(1);
    expect(result.current.restarted).toBe(true);
    // The same error object is not handled twice: a later next works and clears the notice.
    act(() => {
      result.current.next('c9');
    });
    expect(result.current.cursor).toBe('c9');
    expect(result.current.restarted).toBe(false);
  });

  it('leaves every other error to the page', () => {
    const { result, rerender } = renderHook(({ error }) => useCursorPaging('a', error), {
      initialProps: { error: null as unknown },
    });
    act(() => {
      result.current.next('c2');
    });
    rerender({ error: apiError('graph_unavailable', 503) });
    rerender({ error: new Error('cursor_invalid') });
    expect(result.current.cursor).toBe('c2');
    expect(result.current.restarted).toBe(false);
  });

  it('a change of filters clears the restart notice', () => {
    const { result, rerender } = renderHook(({ key, error }) => useCursorPaging(key, error), {
      initialProps: { key: 'a', error: null as unknown },
    });
    rerender({ key: 'a', error: apiError('cursor_invalid') });
    expect(result.current.restarted).toBe(true);
    rerender({ key: 'b', error: null });
    expect(result.current.restarted).toBe(false);
  });
});
