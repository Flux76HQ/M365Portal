import { createRootRouteWithContext } from '@tanstack/react-router';
import { NotFound } from '../components/pages/NotFound';
import { RootError } from '../components/pages/RootError';
import { AppShell } from '../components/shell/AppShell';
import { loadMe } from '../lib/gating';
import type { RouterContext } from '../lib/router-context';

// The root route loads `me` before any page (so every child can gate on `context.me` without a request),
// draws the shell around the page, answers an unknown URL with Not-found inside the shell, and has its
// own error boundary for the case that `me` cannot be loaded at all.
export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: ({ context }) => loadMe(context),
  component: AppShell,
  notFoundComponent: NotFound,
  errorComponent: RootError,
});
