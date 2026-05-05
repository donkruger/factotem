import { Suspense } from 'react';

import { GroupListView } from './GroupListView';

/**
 * /groups — list of all registered groups. Server component shell that
 * wraps the client view in a Suspense boundary (consistent with the
 * Activity route, which Next 16 requires when client components read
 * URL state during static export).
 *
 * T-1778242000000 (Wave 6 part 1, Group Management).
 */
export default function GroupsPage() {
  return (
    <Suspense fallback={null}>
      <GroupListView />
    </Suspense>
  );
}
