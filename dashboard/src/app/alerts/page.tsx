import { AlertsList } from '@/components/panels/AlertsList';

/**
 * Alerts route. Server-component shell that delegates to the client-side
 * `<AlertsList />` for polling and the operator action surface.
 *
 * T-1778244000000 (Wave 7 part 1 of the Factotem Dashboard v1 epic).
 */
export default function AlertsPage() {
  return <AlertsList />;
}
