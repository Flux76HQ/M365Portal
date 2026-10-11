import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RootProviders } from '../src/components/pages/root-providers';
import { createApiClient } from '../src/lib/api';
import { createAppQueryClient, seedQueryClient } from '../src/lib/query';
import { createAppRouter } from '../src/router';
import { sampleBranding, sampleMe } from './helpers/boot-fixtures';

describe('app router', () => {
  it('renders the index route: the Dashboard', async () => {
    const api = createApiClient({
      buildVersion: null,
      fetch: () => Promise.reject(new Error('offline')),
    });
    const queryClient = createAppQueryClient();
    seedQueryClient(queryClient, { me: sampleMe(), branding: sampleBranding() }, api);
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }), {
      queryClient,
      api,
    });

    render(<RootProviders router={router} queryClient={queryClient} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });
});
