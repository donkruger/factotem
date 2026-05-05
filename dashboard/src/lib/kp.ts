/**
 * Kanban Pro deep-link helpers + a hook to read the current machine's
 * brain path from /health (used by callers to populate the `project` query
 * parameter so KP opens the ticket in the right project).
 */

'use client';

import { useEffect, useState } from 'react';

import { getHealth } from './nanoclaw';

export function ticketUrl(ticketId: string, projectPath: string): string {
  const params = new URLSearchParams({ id: ticketId, project: projectPath });
  return `kanbanpro://open-ticket?${params}`;
}

export function appendNoteUrl(
  ticketId: string,
  text: string,
  projectPath: string,
): string {
  const params = new URLSearchParams({
    id: ticketId,
    text,
    project: projectPath,
  });
  return `kanbanpro://append-note?${params}`;
}

let cachedBrainPath: string | null | undefined;

/**
 * Reads `machine.brain_path` from /health. Caches the value across the page
 * lifetime — the brain path doesn't change without a NanoClaw restart, so a
 * single fetch per session is fine.
 */
export function useBrainPath(): string | null {
  const [brainPath, setBrainPath] = useState<string | null>(
    cachedBrainPath ?? null,
  );

  useEffect(() => {
    if (cachedBrainPath !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const h = await getHealth();
        const path = h.machine.brain_path ?? null;
        cachedBrainPath = path;
        if (!cancelled) setBrainPath(path);
      } catch {
        cachedBrainPath = null;
        if (!cancelled) setBrainPath(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return brainPath;
}
