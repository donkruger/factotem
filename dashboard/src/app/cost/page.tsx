import { CostView } from './CostView';

/**
 * Cost route. Static server component shell that delegates to a client
 * `<CostView />` for polling, charts, and the alerts form.
 *
 * T-1778243000000 (Wave 6 part 2 of the Factotem Dashboard v1 epic).
 */
export default function CostPage() {
  return <CostView />;
}
