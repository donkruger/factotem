import { Suspense } from 'react';

import { GroupDetailView } from './GroupDetailView';

/**
 * /groups/[jid] — group detail route. Wraps a client view that derives
 * the JID from window.location.pathname at runtime and polls
 * /api/groups/:jid every 10s.
 *
 * Static export note: the dashboard is exported as a static site
 * (`output: 'export'` in next.config.ts). Dynamic routes with
 * `generateStaticParams` only emit one HTML file per param entry — we
 * ship the single placeholder `_` and let `src/http/server.ts` rewrite
 * any `/groups/<real-jid>/` request to serve this same HTML. The client
 * then reads the real JID from window.location.pathname and fetches.
 */
export function generateStaticParams() {
  return [{ jid: '_' }];
}

export default function GroupDetailPage() {
  return (
    <Suspense fallback={null}>
      <GroupDetailView />
    </Suspense>
  );
}
