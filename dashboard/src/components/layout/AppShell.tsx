'use client';

import { ReactNode, useEffect } from 'react';
import { Settings2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { NavLinks } from './NavLinks';
import { ThemeToggle } from './ThemeToggle';
import { useElectronWizard } from '@/lib/electron';

const VERSION_NOTE = 'Wave 5 · v0.1.0';

/**
 * Global listener for the `error-recovery-intent` custom events the
 * /errors page (and other diagnosis surfaces) dispatch. PR 6 emits the
 * events; PR 7 wires the first concrete handler: `switch-model`
 * navigates the operator to the relevant agent's detail page where
 * the ModelSwitchModal lives.
 *
 * Other intents (`raise-budget`, `view-logs`, `reauth`,
 * `view-rate-history`, `retry`) emit a console hint until their
 * destination flows ship. Operators currently see the diagnosis card's
 * external-link primary CTA as the working path; the intent buttons
 * are aspirational placeholders.
 */
function useRecoveryIntents(): void {
  const router = useRouter();
  useEffect(() => {
    function handler(e: Event): void {
      const detail = (e as CustomEvent<{ intent?: string; agentId?: string }>)
        .detail;
      const intent = detail?.intent;
      if (!intent) return;
      switch (intent) {
        case 'switch-model':
          // If the dispatch carries an agentId, deep-link. Otherwise
          // fall back to the agents-list page — the operator picks
          // which agent to act on.
          if (detail?.agentId) {
            router.push(`/agents/${encodeURIComponent(detail.agentId)}`);
          } else {
            router.push('/agents');
          }
          break;
        case 'view-rate-history':
        case 'view-logs':
          router.push('/activity');
          break;
        case 'raise-budget':
          router.push('/groups');
          break;
        case 'reauth':
          // Wizard CredentialsStep deep-link. The Setup button in the
          // header opens the wizard from inside the Electron app; in
          // a plain browser visit we route to /agents where the
          // operator can re-enter credentials via the Switch model
          // flow.
          router.push('/agents');
          break;
        default:
          // Unknown intent — log so we can see what's surfacing.
          if (typeof console !== 'undefined') {
            console.warn(`[recovery] unhandled intent: ${intent}`);
          }
      }
    }
    window.addEventListener('error-recovery-intent', handler as EventListener);
    return () => {
      window.removeEventListener(
        'error-recovery-intent',
        handler as EventListener,
      );
    };
  }, [router]);
}

export function AppShell({ children }: { children: ReactNode }) {
  // `wizard` is non-null only when this dashboard page is loaded inside
  // the NanoClaw Setup Electron app. Plain browser visits get an
  // unchanged UI — the Setup pill simply doesn't render.
  const wizard = useElectronWizard();
  useRecoveryIntents();

  return (
    <div className="flex min-h-screen flex-col">
      <nav className="sticky top-0 z-10 border-b border-[var(--color-hairline)] bg-[var(--color-bg)]/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-4">
          <span className="text-xl font-medium tracking-tight text-[var(--color-ink)]">
            Factotem
          </span>
          <NavLinks />
          <div className="flex-1" />
          {wizard && (
            <button
              type="button"
              onClick={() => {
                void wizard.open();
              }}
              className="inline-flex items-center gap-1.5 rounded-pill border border-[var(--color-hairline)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-ink)]"
              title="Return to the setup wizard"
            >
              <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
              Setup
            </button>
          )}
          <ThemeToggle />
        </div>
      </nav>

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
        {children}
      </main>

      <footer className="border-t border-[var(--color-hairline)] bg-[var(--color-bg)]">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 text-xs text-[var(--color-ink-muted)]">
          <span>{VERSION_NOTE}</span>
          <span>NanoClaw / Factotem</span>
        </div>
      </footer>
    </div>
  );
}
