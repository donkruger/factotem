'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Agents sits first because the agent-first navigation is the new primary
// mental model (PROVIDER_PLAYBOOK § 0). Server Health, Groups, etc. stay
// available — they're cross-cutting views. The /agents/<id> detail page
// owns the per-agent rollup.
const LINKS = [
  // Persona was the v1.0 read-only snapshot of the single-assistant
  // identity. Multi-agent (v1.2) made it redundant; /agents is now
  // the canonical entry point. The /persona route still resolves
  // (redirects to /agents) for bookmarked URLs.
  // See multi-agent-completion-blueprint.md § 3.3.
  { href: '/agents', label: 'Agents' },
  { href: '/', label: 'Server Health' },
  { href: '/activity', label: 'Activity' },
  { href: '/groups', label: 'Groups' },
  { href: '/cost', label: 'Cost' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/errors', label: 'Errors' },
  { href: '/audit', label: 'Audit' },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <ul className="flex items-center gap-1">
      {LINKS.map((link) => {
        const isActive =
          link.href === '/'
            ? pathname === '/' || pathname === ''
            : pathname?.startsWith(link.href);
        return (
          <li key={link.href}>
            <Link
              href={link.href}
              className={`rounded-pill px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-[var(--color-bg-subtle)] text-[var(--color-ink)]'
                  : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
              }`}
            >
              {link.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
