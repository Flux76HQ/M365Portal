import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createAppRouter } from './router';
import './styles.css';

const router = createAppRouter();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root element is missing from index.html');

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
