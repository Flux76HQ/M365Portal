import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createAppRouter } from '../src/router';

describe('app router', () => {
  it('renders the index route with the product name', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }));

    render(<RouterProvider router={router} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'M365Portal' }),
    ).toBeInTheDocument();
  });
});
