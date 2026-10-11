import type { ErrorComponentProps } from '@tanstack/react-router';
import { ErrorView } from './ErrorView';

/** The boundary of a page (the router's default): the page failed, the shell around it still works. */
export function RouteError(props: ErrorComponentProps) {
  return <ErrorView {...props} scope="route" />;
}
