import { ReactNode } from 'react';

import { ThemeToggle } from './ThemeToggle';

const VERSION_NOTE = 'Wave 3 scaffold · v0.1.0';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <nav className="sticky top-0 z-10 border-b border-[var(--color-hairline)] bg-[var(--color-bg)]/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-4">
          <span className="text-xl font-medium tracking-tight text-[var(--color-ink)]">
            Factotem
          </span>
          <span className="text-xs text-[var(--color-ink-muted)]">
            Operator Dashboard
          </span>
          <div className="flex-1" />
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
