import { Suspense } from 'react';

import { AgentDetailView } from './AgentDetailView';

/**
 * /agents/[id] — per-agent detail route. Same static-export pattern as
 * /groups/[jid]: one placeholder param, the client derives the real id
 * from `window.location.pathname` after hydration.
 *
 * The detail page hosts the per-agent rollup (health, cost, groups,
 * persona) and the model-switch journey. See PROVIDER_PLAYBOOK § 4.3.2
 * (Agent-level controls) and docs/implementation/gemini-blueprint.md
 * § 7.4 (model-switch modal).
 */
export function generateStaticParams() {
  return [{ id: '_' }];
}

export default function AgentDetailPage() {
  return (
    <Suspense fallback={null}>
      <AgentDetailView />
    </Suspense>
  );
}
