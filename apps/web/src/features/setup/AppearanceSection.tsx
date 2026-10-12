import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '../../components/ui/skeleton';
import type { ApiClient } from '../../lib/api';
import { brandingQueryOptions } from '../../lib/query';
import { AppearanceForm } from '../branding/AppearanceForm';
import { useBrandingTools } from '../branding/tools';

/** The Phase A Appearance form inside the finish step. A separate chunk: it loads only when the step shows it. */
export default function AppearanceSection({ api }: { readonly api: ApiClient }) {
  const query = useQuery(brandingQueryOptions(api));
  const tools = useBrandingTools();
  if (query.data === undefined || tools === null) return <Skeleton height={240} />;
  return <AppearanceForm branding={query.data} tools={tools} api={api} />;
}
