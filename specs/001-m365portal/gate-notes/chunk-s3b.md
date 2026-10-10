# Chunk s3b: open points, assumptions and risks (S3 design system, web: T-A-123 to T-A-128)

Status: **six tasks done** (`T-A-123` to `T-A-128`). This chunk holds no gate (G3 is `T-A-131`, after the DataTable tasks of the next chunk), so this note carries the evidence, the entry CSS size and the component inventory that the G3 note will repeat. S8 consolidates the open points into `docs/open-points.md` (`T-A-278`); no other stream edits that file.

## 1. What was run

| Item | Result |
|---|---|
| Web tests, live tree | 10 files, **218 tests, 0 failed, 0 skipped** (this chunk: 217; `router.test.tsx` is S4's). Per file: `styles.test.ts` 40, `motion.test.tsx` 30, `ui/cn.test.ts` 20, `ui/forms.test.tsx` 36, `ui/overlays.test.tsx` 27, `confirm-dialog.test.tsx` 15, `toast.test.tsx` 15, `ui/feedback.test.tsx` 17, `ui/layout.test.tsx` 17 |
| Clean copy | `scratchpad/s3b-copy`: `git ls-files -co --exclude-standard` tarred, `pnpm install --frozen-lockfile` (3.4 s), then `tsc -b` (exit 0), `eslint --max-warnings 0 apps/web` (exit 0), `vitest run` (10 files, 214 tests at the time), `tokens:check` (up to date), `prettier --check apps/web` clean. Four tests were added afterwards (input-group) and ran on the live tree only |
| Live tree | `eslint --max-warnings 0 apps/web` clean, `tsc -b` clean, `prettier --check` clean, `shared/repo-conventions.test.ts` + `shared/tokens.test.ts` 354 passed, `tools/workspace-deps` 31 passed, `pnpm install --frozen-lockfile` up to date |
| Red first | Every test file was run before its code existed and failed for the missing module (`styles.test.ts`: `ENOENT app.css`; `motion.test.tsx`, `forms.test.tsx`: unresolved import). Failures that were then repaired in the **test** are in section 5 (each was a property of the test environment, not a weakening of an assertion). Exception: the four `InputGroup` tests were written together with the component; a mutation (border back on the inner input, `outline-none`) turns the matching test red |
| Mutation checks | Provider without `strict`, `transitionFor` ignoring reduced motion, `reducedMotion="never"`, an error toast with a timer, an error toast announced politely, `objectName` made optional (the `@ts-expect-error` lines go unused and `tsc` fails), `InputGroup` with a border: each makes the named test red, and the originals were restored (green again) |
| Real browser | A showcase page of every primitive (scratch, not in the repository; source in the scratchpad) built with the real Vite and Tailwind plugins and driven in the preinstalled Chromium 141: **axe (wcag2a, 2aa, 21aa, 22aa) 0 violations on the page in light and dark, and with a Dialog, ConfirmDialog, DetailsPanel, Menu and the three toast kinds open**; **0 of 44 interactive elements below 24 by 24 px**; control height **32 px** (fine pointer) and **40 px** (coarse pointer, `hasTouch`); `document.getAnimations()` is **0** after opening a dialog and a toast under `prefers-reduced-motion: reduce` (2 without it); `forced-colors: active` screenshots reviewed (checkbox, switch thumb position, radio dot, segmented control, tabs, persona, banners all distinguishable); only `inter-latin-wght-normal` is requested and `Inter Variable` and `Inter Fallback` both report `loaded`; body background `#f3f5f8` (light) and `#0f1318` (dark) by computed style, so the dark theme really is dark (probe P19) |

## 2. Tasks and evidence

| Task | Verdict | Evidence |
|---|---|---|
| `T-A-123` Tailwind theme, fonts, accessibility CSS | done | `styles/{app,fonts,a11y}.css` (+ `motion.css`, section 4). `web/styles.test.ts`: four guards over the text with negative fixtures (`expectGuardFails`), and a **real Tailwind build** of a copy of the stylesheets with the Vite plugin: identical with and without a `dist/` folder, a control build with the plain `@import "tailwindcss"` that must differ (it does: `13deg` from `dist/` appears), a utility for each of 20 colour roles, 9 type styles, 3 radii, 3 shadows, 3 weights, 8 layers, 4 durations, 2 easings, 5 breakpoints (values compared with `BREAKPOINTS_PX`), none for `bg-red-500`, `text-white`, `rounded-xl`, `animate-spin`, `text-sm`; exactly the two Inter files emitted; the fallback face re-derived from the `hhea` table of the shipped woff2 (a small woff2 reader sits in the test). **Entry CSS size**: section 3 |
| `T-A-124` utilities and motion provider | done | `lib/cn.ts` (the `cn` package configured with the names of our theme: without that `cn('text-body', 'text-fg')` drops `text-body`, shown by a negative control), `lib/motion.ts` (the only module that creates transitions; a source scan of `components/ui`, `components/data-table` and `lib` refuses literal durations, easings, looping animations and transition objects, with ten negative fixtures), `components/ui/motion-provider.tsx` (`MotionConfig reducedMotion="user" nonce` around `LazyMotion` with `domAnimation` loaded on demand and `strict`), `components/ui/motion-features.ts`. The `domAnimation` bundle is a separate chunk in the real build (41.3 kB raw, 15.9 kB gzip), not part of the entry. Positive control for "no animation starts under reduced motion": without it the same component calls `Element.animate` |
| `T-A-125` form controls | done | `button`, `icon-button`, `input`, `textarea`, `select`, `checkbox`, `radio-group`, `switch`, `form-field` (+ `input-group`). 36 tests: roles and names, Enter, Space, arrows, Escape, disabled and read-only, `FormField` wiring (label, `aria-labelledby`, hint and error in `aria-describedby`, `aria-invalid`, `role="alert"`), state never colour alone, target and height classes, and a source scan that no form control carries literal text. Generated with `shadcn@4.21.4` in a scratch project (`init -t vite -b radix -p nova`, `add ...`, then `eject`, which removed the `shadcn` package and inlined `shadcn/tailwind.css`); the sources were restyled, nothing from `shadcn` is imported, and no `eslint-disable` exists in the tree |
| `T-A-126` overlays and navigation | done | `dialog`, `confirm-dialog`, `menu`, `tooltip`, `tabs`, `segmented-control`. `ConfirmDialog` without `objectName` is a compile error three ways (type, JSX, `undefined`), the module exports only `ConfirmDialog`, a blank name throws at run time, the focus lands on Cancel, Tab is trapped, Escape and Cancel close it, a click on the scrim does not, and the dialog does not close itself on confirm |
| `T-A-127` feedback and identity | done | `toast` (Radix Toast, PD-03), `banner`, `skeleton`, `empty-state`, `error-state`, `persona`. Toast: the announcer is `aria-live="polite"` (a foreground `assertive` one for errors), the timer pauses on hover and on focus, an error never dismisses itself, an action slot runs and closes; all with an injected clock (Vitest fake timers). No `sonner`, no `tw-animate-css`, no dependency beyond `radix-ui` was added for this task |
| `T-A-128` layout primitives | done | `breadcrumbs`, `command-bar`, `details-panel`. 17 tests: landmark names from props, `aria-current="page"`, truncation with the full name kept, a `renderLink` seam so no router is imported, one tab stop and roving focus in the toolbar, the overflow menu, the right panel from `lg` and the full-height sheet below, Escape and focus restore |

Dependencies added (install protocol, exact versions, `flock`): `@fontsource-variable/inter@5.3.0`, `cn@0.4.0`, `class-variance-authority@0.7.1`, `motion@14.1.0`, `radix-ui@1.7.0`, `lucide-react@1.55.0` (dependencies) and `@testing-library/user-event@14.6.7` (dev). Each is declared in `apps/web/package.json` only. `pnpm add` rewrites `pnpm-workspace.yaml` without its comments (and unquotes a key); the comments were put back at the end of the chunk, and any later `pnpm add` by anyone drops them again.

## 3. Entry CSS size (for the bundle budget, `T-A-259`)

Production build (Vite 8.3.4, Tailwind 4.3.3, lightningcss), `app.css` with all 26 primitives present in `src/` (the utilities they use), before any shell, page or DataTable code exists:

| | raw | gzip | brotli |
|---|---|---|---|
| `index-*.css` | **33,265 B** | **7,477 B** | **6,630 B** |
| theme and preflight only (the styles test, no component utilities) | 19,715 B | 4,948 B | 4,264 B |

Fonts: `inter-latin-wght-normal.woff2` 48,256 B (requested on first paint), `inter-latin-ext-wght-normal.woff2` 85,068 B (only when a character of its range appears). The CSS will grow with the shell, the pages and the DataTable; the G3 note should repeat the number.

## 4. Deviations from the Files lines (all inside the S3 territory, `apps/web/src/{styles,components/ui,lib}` and `apps/web/test`)

| File | Why |
|---|---|
| `src/styles/motion.css` | The keyframes and the `animate-*` utilities of the overlays. Plan 5.4 says "keyframes are written once in the token layer" and names no file; `app.css` is meant to add nothing of its own. A guard (`checkMotionCss`) proves every animation uses the duration and easing tokens, none loops, and each has its keyframes |
| `src/components/ui/motion-features.ts` | `LazyMotion` needs the feature bundle in a module that nothing imports statically, otherwise the bundler puts `domAnimation` into the entry chunk next to `MotionConfig` (the build shows it as its own 41 kB chunk) |
| `src/components/ui/input-group.tsx` | `T-A-125` "Done when" asks for `input-group` to be reworked so jsx-a11y passes; the task's Files line does not list it. Reworked: no click handler on a `<div>`, no rule disabled |
| `test/ui/cn.test.ts` | `lib/cn.ts` is new behaviour (a configured merge) and needed its own test. `T-A-001` should list it in spec section 2 with the other TA-08 additions |
| `components/ui/select.tsx` is one composite | The generated file has a dozen parts; the options are data here, so nobody can forget the indicator or the label wiring. The same for `Menu`, `SegmentedControl`, `Tooltip` and `Toast` (`useToast`): data-driven, every string a prop |

## 5. Things that look like test weakening and are not

- `forms.test.tsx` holds an arrow key down until Radix has moved the focus (`pressArrow`): Radix selects the radio when the focus arrives while the key is still down, and `user-event` releases it at once. The assertions are unchanged.
- `toast.test.tsx` stubs a `jest` global with `advanceTimersByTime`: Testing Library awaits a timer after every `user-event` call unless it believes Jest fake timers are on (`jestFakeTimersAreEnabled`), so every `await user.click()` hung under Vitest fake timers.
- `overlays.test.tsx` and `confirm-dialog.test.tsx` use `waitFor` for the focus returning to the trigger: Radix restores it one macrotask after the dialog unmounts.
- `@ts-expect-error` lines in `confirm-dialog.test.tsx` sit directly above the failing expression (Prettier had split a multi-line object so the directive no longer applied); they are proven by the mutation in section 1.

## Open points

| # | Point | Owner | When |
|---|---|---|---|
| OP-1 | **`main.tsx` still imports the scaffold's `styles.css`.** `T-A-163` removes it and imports `./styles/app.css`. Until then the real app has none of this chapter's CSS. `app.css` lists `@source '../../index.html'` and `@source '../'` (the whole `src/`), so every folder S4 adds is scanned without a change here | S4 | `T-A-163` |
| OP-2 | **The Radix scroll-lock `<style>` needs a nonce (probe P15).** Opening a Dialog, ConfirmDialog, DetailsPanel or Select makes `react-remove-scroll` inject a `<style>` whose nonce comes from `globalThis.__webpack_nonce__`. The boot code must set it from the `csp-nonce` meta tag **before the first render**, or the CSP blocks it. `MotionProvider` takes the nonce for Motion's own styles. The `Menu` is not modal and does not do this; the Select and the Dialog do | S4 (`T-A-164`), S9 (CSP e2e) | `T-A-163`/`T-A-164` |
| OP-3 | **Preload the Latin font.** Vite does not preload fonts. FR-A-123 asks for the Latin file to be preloaded; its hashed name is only known after the build, so `index.html` needs a small `transformIndexHtml` plugin (or a `<link rel="preload">` written by the build). The file is `inter-latin-wght-normal-<hash>.woff2` | S4 (`T-A-164`, `T-A-173`) | with the shell template |
| OP-4 | **axe reports `aria-hidden-focus` on `#root` while a Select is open.** Radix hides the rest of the page with `aria-hidden` and traps the focus. Dialog, ConfirmDialog and DetailsPanel pass the same rule, probably because axe ignores what lies under an open `aria-modal` dialog. It is a static false positive. `e2e/a11y.spec.ts` should not scan with a Select open, or should exempt that one rule in that state. The Menu was made non-modal for the same reason and passes | S9 | `T-A-323` |
| OP-5 | **Focus after a dialog opened from a menu item.** `useFocusReturn` (in `dialog.tsx`) hands the focus back to whatever had it when the dialog opened; Radix does it only for its own Trigger. When that element is gone (a menu item closed with its menu) the focus falls to `<body>`. A caller that opens a dialog from a menu should hand the focus to the menu's trigger itself, or the dialog should get a `returnFocusTo` prop; none is needed yet | S4 / S5 when it happens | on first use |
| OP-6 | **Full radius beyond the three documented uses.** `RADIUS_FULL_USES` lists avatar, switch thumb and status dot (plan 10.3). Radio buttons are round in every operating system, so `RadioGroupItem` uses `rounded-full` as well. Either `'radio'` joins the list in `packages/shared/src/tokens/radius.ts` (S3, one word) or the radio becomes a rounded square. See also OP-6 of `chunk-s3a.md`: nothing scans web code for `rounded-full` | S3 / owner | G3 |
| OP-7 | **No looping animation exists, on purpose.** FR-A-122 says every animation lasts at most 200 ms; a skeleton pulse, a spinner and a progress shimmer loop for seconds. The `Skeleton` is a static block, the `Button` has no spinner (a busy button sets `aria-busy` and the caller changes its label), and `--animate-*: initial` removes Tailwind's `animate-spin`, `animate-pulse`, `animate-ping` and `animate-bounce`. The owner may prefer a looping skeleton and read the rule as "per transition"; that would be a spec amendment, not a code change | owner | palette review at G3 |
| OP-8 | **`CommandBar` overflow is the caller's decision** (`maxVisible`), not measured: measuring needs layout, which happy-dom does not have, and a result that depends on layout cannot be unit-tested. A DataTable or a shell that wants a responsive bar passes a number from its own breakpoint hook | S3 (next chunk), S4 | `T-A-130` |
| OP-9 | **The tests need Node types in the web tsconfig.** `tsconfig.app.json` (S4) lists `"types": ["vite/client"]` only, so `test/styles.test.ts`, `motion.test.tsx` and `forms.test.tsx` carry `/// <reference types="node" />`. Adding `"node"` to the `types` of the test project would let those lines go | S4 | when `tsconfig*.json` is next touched |
| OP-10 | **Documentation to write** (`docs/architecture.md`, accessibility section and component table): the utility vocabulary of section 6 below; why `@theme reference inline` (one definition per token); the forced-colours rules (what is replaced by the browser, what each control does so that its state survives); the `useFocusReturn` rule; the motion rules (CSS keyframes for overlays, Motion only through `lib/motion.ts`, reduced motion in three layers); `cn` configuration; the generator workflow of PD-28 (`shadcn@4.21.4 init -t vite -b radix -p nova`, `add`, `eject`, copy, restyle) so the next component is generated the same way | S8 | `T-A-274` |
| OP-11 | **Spec section 2 (`T-A-001`) lists the controls** `web/ui/cn.test.ts` and the `web/ui/*.test.tsx` files of this chunk as additional controls (TA-08) | S0 / orchestrator | `T-A-001` |
| OP-12 | **The dev dependency `@testing-library/user-event` is missing from the plan's list of this stream's tasks** (it is in plan 5.4 for the web package). It was added under `T-A-125` | none | recorded |

## Assumptions

| # | Assumption |
|---|---|
| A-1 | `Button`'s default variant is `secondary` (outlined). A page that wants the one primary action says `variant="primary"`. A filled destructive variant is not offered: white on the dark-theme `danger` colour (a light colour chosen for text on dark surfaces) is not guaranteed, so `destructive` is an outlined button in the danger role |
| A-2 | A popup (Menu, Select) sits on the `dialog` layer, not the `menu` layer: it must not hide behind a dialog it was opened in, and it is appended to the body later than the dialog, so at the same z-index it paints on top. The `z-menu` utility exists and no component uses it yet. Tooltips are on `tooltip`, toasts on `toast` |
| A-3 | The font fallback face names `Arial` and `Liberation Sans` (same advance widths); `size-adjust` 106.7 % was measured against Liberation Sans in Chromium 141 over Dutch and English interface text at weight 400, so it is a measured value for a metric-compatible stand-in, not for Arial itself. A system with neither face skips the fallback and uses `system-ui` unadjusted (a few pixels of shift at most, nothing breaks) |
| A-4 | `prefers-contrast: more` raises two aliases (`--line-subtle` to the control border, `--fg-muted` to the secondary text) and the focus ring to 3 px. It does not touch the colour roles, which the server injects per request and whose position in the document must not matter |
| A-5 | Toasts are a plain list in the provider: at most five, newest first; an ordinary toast lasts 5 s unless asked otherwise; a closed toast disappears at once (no exit animation) because the state item is removed on close |
| A-6 | Toasts announce with the Radix announcer (one visually hidden live region per toast, `polite` or `assertive`), not with the visible list; the visible `li` has `aria-live="off"`. The region label may contain `{hotkey}`, which Radix replaces with F8 |
| A-7 | `Tooltip` brings its own provider, so no provider is needed at the root, and each tooltip has its own delay. A shared "skip the delay when moving between tooltips" behaviour would need one provider at the root; none is wanted yet |

## Risks

| # | Risk |
|---|---|
| R-1 | **`cn@0.4.0` is a young package** (a clsx plus tailwind-merge replacement by the shadcn authors). `lib/cn.ts` extends its tables for our utility names and `ui/cn.test.ts` pins the behaviour, with a negative control against the default tables. Fallback: `clsx` plus `tailwind-merge` with the same extension, the one file `lib/cn.ts` changes |
| R-2 | **Radix 1.7 attribute names.** The generated nova sources used `data-checked:`, which Radix 1.7.0 does not emit in this setup (it emits `data-state="checked"`); the restyled components use `data-[state=checked]`. A Radix upgrade that changes the attributes is caught by the keyboard and state tests (they read `aria-checked`) and by the forced-colours review, not by the class-name assertions |
| R-3 | **Forced colours were reviewed by eye on a screenshot of Chromium's emulation**, and by the rules in `a11y.css` and the `forced-colors:` classes, not by an automated test of computed colours. `e2e/forced-colors.spec.ts` (S9) is the control; it should at least check that a checked radio and a checked switch differ from an unchecked one |
| R-4 | **The unit tests run on happy-dom**, which has no layout: sizes, truncation and the `lg` breakpoint are asserted as classes there, and proven in the real browser run of section 1 (44 targets, 32 and 40 px). They are not yet in the e2e suite (`e2e/responsive.spec.ts`, S9) |
| R-5 | **`styles.test.ts` runs four Vite builds** (about one second here). They write into `apps/web/node_modules/.tmp/styles-test-*` and are removed in `afterAll`; a killed process leaves a folder in a git-ignored place |
| R-6 | **The Dialog and DetailsPanel are modal and use `react-remove-scroll`**, which locks the body scroll and adds `data-scroll-locked`. A page with a sticky header must account for the scrollbar width the lock compensates for; the shell is S4's |

## 6. Utility vocabulary (the contract S4, S5 and the next chunk code against)

| Group | Names |
|---|---|
| Colour (`bg-`, `text-`, `border-`, `outline-`, ...) | `surface-page`, `surface-raised`, `surface-sidebar`, `surface-overlay`, `fg`, `fg-secondary`, `fg-muted`, `line-control`, `line-subtle`, `danger`, `warning`, `success`, `info`, `accent`, `accent-hover`, `accent-active`, `accent-subtle`, `on-accent`, `accent-text`, `focus-ring` |
| Type | `text-caption`, `text-body-sm`, `text-body`, `text-body-lg`, `text-subtitle`, `text-title-3`, `text-title-2`, `text-title-1`, `text-display` (size, line height, tight tracking from 20 px); `font-regular`, `font-medium`, `font-semibold`; `font-sans` |
| Shape | `rounded-sm`, `rounded-md`, `rounded-lg`, `rounded-full`; `shadow-1`, `shadow-2`, `shadow-3` |
| Size | `h-control`, `min-h-control`, `size-control` (32 px, 40 px on coarse pointers); `min-h-target`, `min-w-target`, `size-target`, `h-target` (24 px); `h-row-compact`, `h-row-comfortable`; `max-w-content`; spacing on the 4 px grid (`p-4` is 16 px) |
| Layers | `z-base`, `z-sticky`, `z-chrome`, `z-menu`, `z-scrim`, `z-dialog`, `z-toast`, `z-tooltip` |
| Motion | `duration-instant`, `duration-fast`, `duration-base`, `duration-slow`; `ease-standard`, `ease-spring`; `animate-fade-in|out`, `animate-pop-in|out`, `animate-slide-in-right|out-right`, `animate-slide-in-bottom|out-bottom`, `animate-toast-in|out` |
| Glass | `glass-header`, `glass-sidebar`, `glass-scrim` (opaque under forced colours, reduced transparency and without `backdrop-filter`) |
| Variants | `dark:` (`[data-theme=dark]`), `reduced-transparency:`, plus Tailwind's `forced-colors:`, `contrast-more:`, `motion-reduce:` |
| Variables a layout may use | `--scroll-offset` (4.5 rem: the sticky header plus room; the shell uses it as scroll padding so focus is never hidden behind the header), `--fg-muted`, `--line-subtle` |

## 7. Components and props (contract C12: every string is a prop; no component imports a router or the i18n module)

All accept `className` where they render one element, and spread the remaining props of that element. `*` marks required.

| Module | Export and props |
|---|---|
| `button` | `Button`: `variant` `primary` `secondary` (default) `ghost` `destructive` `link`; `size` `default` `sm` `icon` `icon-sm`; `asChild`. `buttonVariants` |
| `icon-button` | `IconButton`: `label`* (the accessible name), `size` `default` `sm`, `variant` (default `ghost`), `children`* (the icon) |
| `input`, `textarea` | `Input`, `Textarea` (native props; invalid is `aria-invalid`) |
| `input-group` | `InputGroup`, `InputGroupAddon` (`align` `start` `end`), `InputGroupInput` |
| `select` | `Select`: `options`* (`{ value, label, disabled? }[]`), `placeholder`*, `value` or `defaultValue`, `onValueChange`, `disabled`, `required`, `name`, `id`, `aria-*`. Type `SelectOption` |
| `checkbox`, `switch` | `Checkbox` (`checked` may be `'indeterminate'`), `Switch` (Radix props) |
| `radio-group` | `RadioGroup`, `RadioGroupItem`, `RadioOption`: `value`*, `label`*, `hint`, `disabled` |
| `form-field` | `FormField`: `label`*, `hint`, `error`, `required`, `requiredLabel`, `layout` `stacked` `inline`, `children`* as `(control: FormFieldControlProps) => ReactNode` (`id`, `aria-labelledby`, `aria-describedby`, `aria-invalid`, `aria-required`: spread it on the control) |
| `dialog` | `Dialog`: `title`*, `closeLabel`*, `description`, `trigger`, `open`/`defaultOpen`/`onOpenChange`, `footer`, `size` `sm` `md` `lg`, `initialFocus` (a selector), `children`. Also `useFocusReturn`, `DIALOG_*_CLASS` |
| `confirm-dialog` | `ConfirmDialog`: `open`*, `onOpenChange`*, `objectName`* (required, not blank), `title`*, `description`, `confirmLabel`*, `cancelLabel`*, `onConfirm`*, `destructive` (default true), `pending`. Role `alertdialog`; does not close itself on confirm |
| `menu` | `Menu`: `trigger`*, `entries`* (`MenuEntry`: `label`, `separator`, `item { id, label, icon?, shortcut?, disabled?, destructive? }`, `radio-group { value, onValueChange, options }`), `onSelect`* (item id), `align`. Named by its trigger |
| `tooltip` | `Tooltip`: `content`*, `children`* (one focusable element), `side`, `delayDuration` |
| `tabs` | `Tabs`, `TabsList` (`label`*), `TabsTrigger`, `TabsContent` |
| `segmented-control` | `SegmentedControl`: `label`*, `options`* (`{ value, label, icon? }[]`), `value`*, `onValueChange`*, `disabled`. A radio group |
| `toast` | `ToastProvider`: `regionLabel`*, `closeLabel`*, `notificationLabel`, `children`*. `useToast()` returns `{ toast(options): id, dismiss(id?) }`; `ToastOptions`: `title`*, `description`, `tone` `info` `success` `warning` `error`, `action { label, altText, onAction }`, `duration` |
| `banner` | `Banner`: `tone`* `info` `success` `warning` `danger`, `title`, `action`, `children`*. `role="status"`, no close button |
| `skeleton` | `Skeleton`: `height`* (number is px), `width` |
| `empty-state` | `EmptyState`: `title`*, `headingLevel`* (2, 3 or 4), `description`, `icon`, `action` |
| `error-state` | `ErrorState`: `title`*, `headingLevel`*, `description`, `action`, `requestIdLabel`, `requestId` |
| `persona` | `Persona`: `initials`*, `label`*, `size` `sm` `md` `lg` |
| `breadcrumbs` | `Breadcrumbs`: `label`*, `items`* (`{ id, label, href? }[]`; the last is the current page), `renderLink` (the router link goes here) |
| `command-bar` | `CommandBar`: `label`*, `moreLabel`*, `groups`* (`{ id, label, items: { id, label, icon?, onSelect, disabled?, destructive? }[] }[]`), `maxVisible` |
| `details-panel` | `DetailsPanel`: `open`*, `onOpenChange`*, `title`*, `closeLabel`*, `description`, `footer`, `children` |
| `motion-provider` | `MotionProvider`: `nonce`, `children`*. Mount once, near the root, inside the router |

CommandPalette (FR-A-124 lists it) is S4's (`T-A-168`) and builds on `Dialog` and `cmdk`; `DataTable` is the next chunk.
