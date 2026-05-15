import { Suspense } from 'react';

import { ErrorsView } from './ErrorsView';

/**
 * /errors — operator's diagnosis surface. Lists recent `outcome=error`
 * turns from /api/turns, groups them by error_class, surfaces
 * operator-readable diagnosis copy and recovery actions per
 * PROVIDER_PLAYBOOK § 7.5.
 *
 * Gemini blueprint Phase E.5 (PR 6).
 */
export default function ErrorsPage() {
  return (
    <Suspense fallback={null}>
      <ErrorsView />
    </Suspense>
  );
}
