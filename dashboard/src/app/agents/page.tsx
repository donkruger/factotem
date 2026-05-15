import { Suspense } from 'react';

import { AgentsView } from './AgentsView';

/**
 * /agents — agent-first dashboard root. One card per agent showing name,
 * provider, today's spend, active group count, default trigger. Add
 * Agent CTA at top-right (PR 4 minimum). Per-agent detail at /agents/<id>
 * lands in a subsequent PR.
 *
 * See docs/PROVIDER_PLAYBOOK.md § 4.3 (Dashboard contract) and
 * docs/implementation/gemini-blueprint.md § 9.5.4 (Phase H.4).
 */
export default function AgentsPage() {
  return (
    <Suspense fallback={null}>
      <AgentsView />
    </Suspense>
  );
}
