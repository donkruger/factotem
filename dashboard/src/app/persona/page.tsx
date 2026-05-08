import { Suspense } from 'react';

import { PersonaView } from './PersonaView';

/**
 * /persona — read-only snapshot of the deployment's assistant identity.
 * Shows the global ASSISTANT_NAME and per-group trigger_pattern, with
 * copy-pasteable shell commands for changing them. Mutations stay on
 * the existing `setup --step register` and `.env` edit paths.
 */
export default function PersonaPage() {
  return (
    <Suspense fallback={null}>
      <PersonaView />
    </Suspense>
  );
}
