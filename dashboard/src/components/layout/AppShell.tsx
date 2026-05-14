'use client';

import { ReactNode } from 'react';
import { Settings2 } from 'lucide-react';

import { NavLinks } from './NavLinks';
import { ThemeToggle } from './ThemeToggle';
import { useElectronWizard } from '@/lib/electron';

const VERSION_NOTE = 'Wave 5 · v0.1.0';

export function AppShell({ children }: { children: ReactNode }) {
  // `wizard` is non-null only when this dashboard page is loaded inside
  // the NanoClaw Setup Electron app. Plain browser visits get an
  // unchanged UI — the Setup pill simply doesn't render.
  const wizard = useElectronWizard();

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
