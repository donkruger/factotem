import { Suspense } from 'react';

import { ActivityFeed } from '@/components/panels/ActivityFeed';

export default function ActivityPage() {
  // Suspense boundary required because ActivityFeed reads URL state via
  // useSearchParams; Next 16 statically pre-renders this page so the hook
  // would otherwise throw.
  return (
    <Suspense fallback={null}>
      <ActivityFeed />
    </Suspense>
  );
}
