// The logo slot (T-A-212; FR-A-132, FR-A-152, WCAG 2.5.7; E-02, E-05; US-2.2). The server does the
// processing; the slot sends one file, shows what came back, and says what went wrong in words. The
// network is a fake `fetch`.
import enCatalogue from '@m365portal/shared/i18n/locales/en.json';
import nlCatalogue from '@m365portal/shared/i18n/locales/nl.json';
import { expectGuardFails } from '@m365portal/shared/testing';
import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogoSlot, LogoSlots } from '../../src/features/branding/LogoSlot';
import type { AssetRef, LogoVariant } from '../../src/features/branding/types';
import type { ApiClient } from '../../src/lib/api';
import { fakeApi, jsonResponse, problemResponse, renderInLanguage } from './helpers';

const en = enCatalogue as Record<string, string>;
const nl = nlCatalogue as Record<string, string>;

const HASH = 'b'.repeat(64);
const OTHER_HASH = 'c'.repeat(64);

const stagedResponse = (hash = HASH, warnings: unknown[] = []) => ({
  asset: {
    hash,
    url: `/branding/${hash}.png`,
    width: 240,
    height: 80,
    luminance: 0.4,
    bytes: 4096,
    created: true,
  },
  warnings,
});

const asset = (hash = HASH): AssetRef => ({
  hash,
  url: `/branding/${hash}.png`,
  width: 240,
  height: 80,
  luminance: 0.4,
});

const png = (name = 'logo.png') =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  return input;
}

afterEach(() => {
  vi.useRealTimers();
});

/** A slot whose parent keeps the asset, as the form does. */
function Controlled({
  variant = 'light',
  api,
  initial = null,
}: {
  readonly variant?: LogoVariant;
  readonly api: ApiClient;
  readonly initial?: AssetRef | null;
}) {
  const [current, setCurrent] = useState<AssetRef | null>(initial);
  return <LogoSlot variant={variant} asset={current} onChange={setCurrent} api={api} />;
}

describe('choosing a file (the non-drag alternative, WCAG 2.5.7)', () => {
  it('always has a file button next to the drop zone, with and without a logo', () => {
    const { api } = fakeApi(() => jsonResponse(stagedResponse()));
    const empty = renderInLanguage(
      <LogoSlot variant="light" asset={null} onChange={() => undefined} api={api} />,
    );
    expect(
      screen.getByRole('button', { name: 'Choose file for the light theme logo' }),
    ).toBeEnabled();
    expect(empty.container.querySelector('[data-slot="logo-dropzone"]')).not.toBeNull();
    empty.unmount();

    renderInLanguage(
      <LogoSlot variant="light" asset={asset()} onChange={() => undefined} api={api} />,
    );
    expect(
      screen.getByRole('button', { name: 'Replace the file of the light theme logo' }),
    ).toBeEnabled();
    expect(document.querySelector('[data-slot="logo-dropzone"]')).not.toBeNull();
  });

  it('uploads the chosen file to the slot of its variant and reports the processed asset', async () => {
    const { api, writes } = fakeApi(() => jsonResponse(stagedResponse(), { status: 201 }));
    const onChange = vi.fn();
    const { container, user } = renderInLanguage(
      <LogoSlot variant="dark" asset={null} onChange={onChange} api={api} />,
    );
    await user.upload(fileInput(container), png());

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(asset());
    });
    const call = writes()[0]!;
    expect(new URL(call.url, 'http://panel.test').searchParams.get('slot')).toBe('logoDark');
    expect([...(call.body as FormData).keys()]).toEqual(['file']);
  });

  it('opens the browser file picker from the button', async () => {
    const { api } = fakeApi(() => jsonResponse(stagedResponse()));
    const { container, user } = renderInLanguage(
      <LogoSlot variant="light" asset={null} onChange={() => undefined} api={api} />,
    );
    const click = vi.spyOn(fileInput(container), 'click');
    await user.click(screen.getByRole('button', { name: /^Choose file/ }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('keeps the hidden file input out of the tab order', () => {
    const { api } = fakeApi(() => jsonResponse(stagedResponse()));
    const { container } = renderInLanguage(
      <LogoSlot variant="light" asset={null} onChange={() => undefined} api={api} />,
    );
    expect(fileInput(container)).toHaveAttribute('tabindex', '-1');
    expect(fileInput(container)).toHaveAttribute('accept', 'image/png,image/jpeg,image/svg+xml');
  });
});

describe('drag and drop', () => {
  function zone(container: HTMLElement): HTMLElement {
    const found = container.querySelector<HTMLElement>('[data-slot="logo-dropzone"]');
    if (found === null) throw new Error('no drop zone');
    return found;
  }

  it('enter, over, leave and drop', async () => {
    const { api, writes } = fakeApi(() => jsonResponse(stagedResponse(), { status: 201 }));
    const onChange = vi.fn();
    const { container } = renderInLanguage(
      <LogoSlot variant="light" asset={null} onChange={onChange} api={api} />,
    );
    const target = zone(container);
    const dataTransfer = { files: [png()], types: ['Files'], dropEffect: 'none' };

    expect(target).toHaveAttribute('data-dragging', 'false');
    fireEvent.dragEnter(target, { dataTransfer });
    expect(target).toHaveAttribute('data-dragging', 'true');
    expect(within(target).getByText(en['logo.dropActive']!)).toBeInTheDocument();

    // Over must be cancelled, or the browser refuses the drop.
    const over = createEvent.dragOver(target, { dataTransfer });
    fireEvent(target, over);
    expect(over.defaultPrevented).toBe(true);

    fireEvent.dragLeave(target, { dataTransfer });
    expect(target).toHaveAttribute('data-dragging', 'false');

    fireEvent.dragEnter(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    expect(target).toHaveAttribute('data-dragging', 'false');
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(asset());
    });
    expect(writes()).toHaveLength(1);
  });

  it('takes the first file of several and ignores a drop without files', async () => {
    const { api, writes } = fakeApi(() => jsonResponse(stagedResponse(), { status: 201 }));
    const { container } = renderInLanguage(
      <LogoSlot variant="light" asset={null} onChange={() => undefined} api={api} />,
    );
    const target = zone(container);
    fireEvent.drop(target, { dataTransfer: { files: [], types: ['text/plain'] } });
    expect(writes()).toHaveLength(0);

    fireEvent.drop(target, {
      dataTransfer: { files: [png('one.png'), png('two.png')], types: ['Files'] },
    });
    await waitFor(() => {
      expect(writes()).toHaveLength(1);
    });
    expect(((writes()[0]!.body as FormData).get('file') as File).name).toBe('one.png');
  });

  it('ignores a drop while disabled', () => {
    const { api, writes } = fakeApi(() => jsonResponse(stagedResponse()));
    const { container } = renderInLanguage(
      <LogoSlot variant="light" asset={null} onChange={() => undefined} api={api} disabled />,
    );
    fireEvent.drop(zone(container), { dataTransfer: { files: [png()], types: ['Files'] } });
    expect(writes()).toHaveLength(0);
    expect(screen.getByRole('button', { name: /^Choose file/ })).toBeDisabled();
  });
});

describe('the processed result', () => {
  it("is an <img> of the server's /branding/<hash>.png, with its size in words", () => {
    const { api } = fakeApi(() => jsonResponse(stagedResponse()));
    renderInLanguage(
      <LogoSlot variant="light" asset={asset()} onChange={() => undefined} api={api} />,
    );
    const image = screen.getByRole('img', { name: 'Preview of the light theme logo' });
    expect(image).toHaveAttribute('src', `/branding/${HASH}.png`);
    expect(image.tagName).toBe('IMG');
    expect(screen.getByText('240 × 80 px')).toBeInTheDocument();
  });

  it("never renders a url that is not the server's asset path", () => {
    const { api } = fakeApi(() => jsonResponse(stagedResponse()));
    const hostile = { ...asset(), url: 'javascript:alert(1)' };
    renderInLanguage(
      <LogoSlot variant="light" asset={hostile} onChange={() => undefined} api={api} />,
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows the new asset only after the server answered; until then the old one stays', async () => {
    let release: (response: Response) => void = () => undefined;
    const { api } = fakeApi(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const onChange = vi.fn();
    const { container, user } = renderInLanguage(
      <LogoSlot variant="light" asset={asset(OTHER_HASH)} onChange={onChange} api={api} />,
    );
    await user.upload(fileInput(container), png());
    expect(await screen.findByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('src', `/branding/${OTHER_HASH}.png`);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      release(jsonResponse(stagedResponse(), { status: 201 }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(asset());
    });
  });
});

describe('warnings', () => {
  it('lists the removed SVG content in plain words and the flattened animation', async () => {
    const { api } = fakeApi(() =>
      jsonResponse(
        stagedResponse(HASH, [
          {
            code: 'svg_content_removed',
            categories: ['script', 'event_handler', 'external_reference'],
          },
          { code: 'animation_flattened' },
        ]),
        { status: 201 },
      ),
    );
    const { container, user } = renderInLanguage(<Controlled api={api} />);
    await user.upload(fileInput(container), png('logo.svg'));
    const region = await screen.findByRole('status', { name: 'About the light theme logo' });
    const items = within(region).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(
      'Parts of this SVG were removed because they are not allowed: scripts, event handlers, and references to other files.',
    );
    expect(items[1]).toHaveTextContent(en['logo.warning.animationFlattened']!);
  });

  it('writes the words in Dutch in Dutch', async () => {
    const { api } = fakeApi(() =>
      jsonResponse(
        stagedResponse(HASH, [{ code: 'svg_content_removed', categories: ['script'] }]),
        {
          status: 201,
        },
      ),
    );
    const { container, user } = renderInLanguage(<Controlled variant="compact" api={api} />, 'nl');
    await user.upload(fileInput(container), png('logo.svg'));
    const region = await screen.findByRole('status', { name: 'Over: compact logo' });
    expect(region).toHaveTextContent('scripts');
    expect(region).toHaveTextContent('Delen van deze SVG zijn verwijderd');
  });

  it('forgets the warnings of an image that is no longer the one shown', async () => {
    const { api } = fakeApi(() =>
      jsonResponse(stagedResponse(HASH, [{ code: 'animation_flattened' }]), { status: 201 }),
    );
    function Parent() {
      const [current, setCurrent] = useState<AssetRef | null>(null);
      return (
        <>
          <LogoSlot variant="light" asset={current} onChange={setCurrent} api={api} />
          <button
            type="button"
            onClick={() => {
              setCurrent(asset(OTHER_HASH));
            }}
          >
            swap
          </button>
        </>
      );
    }
    const { container, user } = renderInLanguage(<Parent />);
    await user.upload(fileInput(container), png());
    await screen.findByRole('status', { name: /About/ });
    await user.click(screen.getByRole('button', { name: 'swap' }));
    expect(screen.queryByRole('status', { name: /About/ })).not.toBeInTheDocument();
  });
});

describe('rejections show the translated problem message', () => {
  it('image_corrupt in English and in Dutch, and the previous asset is kept', async () => {
    const { api } = fakeApi(() => problemResponse(422, 'image_corrupt'));
    const onChange = vi.fn();
    const first = renderInLanguage(
      <LogoSlot variant="light" asset={asset()} onChange={onChange} api={api} />,
    );
    await first.user.upload(fileInput(first.container), png());
    expect(await screen.findByRole('alert')).toHaveTextContent(en['problem.image_corrupt']!);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('img')).toHaveAttribute('src', `/branding/${HASH}.png`);
    first.unmount();

    const second = renderInLanguage(
      <LogoSlot variant="light" asset={null} onChange={onChange} api={api} />,
      'nl',
    );
    await second.user.upload(fileInput(second.container), png());
    expect(await screen.findByRole('alert')).toHaveTextContent(nl['problem.image_corrupt']!);
  });

  it.each([
    'svg_text_unsupported',
    'image_type_unsupported',
    'staging_quota_exceeded',
    'rate_limited',
  ])('%s has its own message', async (code) => {
    const status = code === 'staging_quota_exceeded' ? 409 : code === 'rate_limited' ? 429 : 422;
    const { api } = fakeApi(() =>
      problemResponse(status, code, {}, code === 'rate_limited' ? { 'Retry-After': '2' } : {}),
    );
    const { container, user } = renderInLanguage(
      <LogoSlot variant="light" asset={null} onChange={() => undefined} api={api} />,
    );
    await user.upload(fileInput(container), png());
    const alert = await screen.findByRole('alert');
    const expected = en[`problem.${code}`]!.replace('{seconds}', '2');
    expect(alert).toHaveTextContent(expected);
  });

  it('a file over the limit is refused with payload_too_large before any request', async () => {
    const { api, calls } = fakeApi(() => jsonResponse(stagedResponse()));
    const { container, user } = renderInLanguage(
      <LogoSlot variant="light" asset={null} onChange={() => undefined} api={api} />,
    );
    const big = new File([new Uint8Array(2_097_153)], 'big.png', { type: 'image/png' });
    await user.upload(fileInput(container), big);
    expect(await screen.findByRole('alert')).toHaveTextContent(en['problem.payload_too_large']!);
    expect(calls).toHaveLength(0);
  });

  it('a server that cannot be reached says so', async () => {
    const { api } = fakeApi(() => {
      throw new TypeError('offline');
    });
    const { container, user } = renderInLanguage(
      <LogoSlot variant="light" asset={null} onChange={() => undefined} api={api} />,
    );
    await user.upload(fileInput(container), png());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong (code network_error, request ID -).',
    );
  });
});

describe('image_processing_busy', () => {
  it('names the wait, offers a retry that unlocks after Retry-After, and retries the same file', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let busy = true;
    const { api, writes } = fakeApi(() =>
      busy
        ? problemResponse(429, 'image_processing_busy', {}, { 'Retry-After': '3' })
        : jsonResponse(stagedResponse(), { status: 201 }),
    );
    const onChange = vi.fn();
    const { container, user } = renderInLanguage(
      <LogoSlot variant="light" asset={null} onChange={onChange} api={api} />,
    );
    await user.upload(fileInput(container), png('same.png'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Try again in 3 s.');
    const retry = screen.getByRole('button', { name: 'Try again in 3 s' });
    expect(retry).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('button', { name: 'Try again in 2 s' })).toBeDisabled();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const ready = screen.getByRole('button', { name: 'Try again' });
    expect(ready).toBeEnabled();

    busy = false;
    await user.click(ready);
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(asset());
    });
    expect(writes()).toHaveLength(2);
    expect(((writes()[1]!.body as FormData).get('file') as File).name).toBe('same.png');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('cancelling and progress', () => {
  it('shows an indeterminate progress bar with words, and Cancel aborts the request quietly', async () => {
    let signal: AbortSignal | null | undefined;
    const { api } = fakeApi(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          signal = call.signal;
          call.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const onChange = vi.fn();
    const { container, user } = renderInLanguage(
      <LogoSlot variant="light" asset={null} onChange={onChange} api={api} />,
    );
    await user.upload(fileInput(container), png());
    const bar = await screen.findByRole('progressbar', {
      name: 'Uploading and processing the light theme logo',
    });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByRole('button', { name: /^Choose file/ })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: en['logo.cancel']! }));
    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('remove', () => {
  it('has a remove action named after its slot that clears the logo', async () => {
    const { api } = fakeApi(() => jsonResponse(stagedResponse()));
    const onChange = vi.fn();
    const { user } = renderInLanguage(
      <LogoSlot variant="dark" asset={asset()} onChange={onChange} api={api} />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove the dark theme logo' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('has nothing to remove in an empty slot', () => {
    const { api } = fakeApi(() => jsonResponse(stagedResponse()));
    renderInLanguage(<LogoSlot variant="dark" asset={null} onChange={() => undefined} api={api} />);
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.getByText(en['logo.empty']!)).toBeInTheDocument();
  });

  it('a derived compact logo cannot be removed, only replaced, and says it is made automatically', () => {
    const { api } = fakeApi(() => jsonResponse(stagedResponse()));
    renderInLanguage(
      <LogoSlot variant="compact" asset={asset()} derived onChange={() => undefined} api={api} />,
    );
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.getByText(en['logo.derived']!)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Replace the file/ })).toBeEnabled();
  });
});

describe('the three slots', () => {
  it('shows light, dark and compact, each with its label and hint, and routes changes by variant', async () => {
    const { api } = fakeApi(() => jsonResponse(stagedResponse(), { status: 201 }));
    const onChange = vi.fn();
    const { container, user } = renderInLanguage(
      <LogoSlots
        value={{ light: asset(OTHER_HASH), dark: null, compact: null }}
        compactDerived={false}
        onChange={onChange}
        api={api}
      />,
    );
    const groups = screen.getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('aria-label') ?? '')).toEqual(
      expect.arrayContaining([
        en['logo.slot.light.label']!,
        en['logo.slot.dark.label']!,
        en['logo.slot.compact.label']!,
      ]),
    );
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
    expect(inputs).toHaveLength(3);
    await user.upload(inputs[1]!, png());
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('dark', asset());
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Nothing inserts uploaded content as HTML
// ---------------------------------------------------------------------------------------------

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const BRANDING_SOURCE = join(import.meta.dirname, '..', '..', 'src', 'features', 'branding');

function sourcesIn(directory: string): SourceFile[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path: relative(directory, path), text: readFileSync(path, 'utf8') };
    });
}

const HTML_SINKS =
  /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|new\s+DOMParser|createContextualFragment|FileReader|createObjectURL|\.readAsText|\.readAsDataURL|<object[\s>]|<embed[\s>]|<iframe[\s>]/;

function assertNoHtmlSink(files: readonly SourceFile[]): void {
  const stripped = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const offenders = files
    .filter((file) => HTML_SINKS.test(stripped(file.text)))
    .map((file) => file.path);
  if (offenders.length > 0) throw new Error(`HTML sink in: ${offenders.join(', ')}`);
}

describe('nothing inserts uploaded content as HTML', () => {
  it('no module of the branding feature has an HTML sink or reads the file in the browser', () => {
    const files = sourcesIn(BRANDING_SOURCE);
    expect(files.some((file) => file.path === 'LogoSlot.tsx')).toBe(true);
    assertNoHtmlSink(files);
  });

  it('negative fixtures: each sink fails the scan', () => {
    for (const text of [
      'const a = <div dangerouslySetInnerHTML={{ __html: svg }} />;',
      'el.innerHTML = text;',
      'const url = URL.createObjectURL(file);',
      'const reader = new FileReader();',
      'new DOMParser().parseFromString(text, "image/svg+xml");',
      'const view = <iframe src={url} />;',
    ]) {
      expectGuardFails(assertNoHtmlSink, [{ path: 'Sneaky.tsx', text }], {
        name: 'assertNoHtmlSink',
        reason: 'HTML sink',
      });
    }
  });
});
