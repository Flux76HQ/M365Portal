import { PRODUCT_NAME } from '@m365portal/shared';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">{PRODUCT_NAME}</h1>
    </main>
  );
}
