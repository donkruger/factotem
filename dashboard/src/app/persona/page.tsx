import { redirect } from 'next/navigation';

/**
 * /persona was the v1.0 surface for a single-assistant deployment.
 * Multi-agent (v1.2 — Gemini blueprint) made it redundant; the
 * per-agent detail page at /agents/<id> is now the canonical
 * identity view.
 *
 * We redirect rather than 404 because operators have this URL
 * bookmarked, deep-linked from older docs, etc. The `/api/persona`
 * endpoint stays alive for now (operator-side integrations may have
 * it) — it's marked for removal in v1.3.
 *
 * See multi-agent-completion-blueprint.md § 3.3.
 */
export default function PersonaPage() {
  redirect('/agents');
}
