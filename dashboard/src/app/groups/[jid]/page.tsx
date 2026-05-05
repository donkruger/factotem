import { Suspense } from 'react';

import { GroupDetailView } from './GroupDetailView';

/**
 * /groups/[jid] — group detail route. Wraps a client view that polls
 * /api/groups/:jid every 10s and renders Overview / Activity /
 * Configuration tabs.
 *
 * Static export note: the dashboard is exported as a static site
 * (`output: 'export'` in next.config.ts), so this dynamic route requires
 * `generateStaticParams`. We can't enumerate real JIDs at build time —
 * the data lives in the live SQLite — so we ship a single placeholder
 * route and rely on client-side navigation populating the slug at
 * runtime. The placeholder also acts as the 404 landing for any direct
 * load that happens before the client takes over.
 */
export function generateStaticParams() {
  return [{ jid: '_' }];
}

interface PageParams {
  // Next 16: params is a Promise.
  params: Promise<{ jid: string }>;
}

export default async function GroupDetailPage({ params }: PageParams) {
  const { jid } = await params;
  return (
    <Suspense fallback={null}>
      <GroupDetailView jid={decodeURIComponent(jid)} />
    </Suspense>
  );
}
