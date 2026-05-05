'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Server Health' },
  { href: '/activity', label: 'Activity' },
  { href: '/groups', label: 'Groups' },
  { href: '/cost', label: 'Cost' },
  { href: '/alerts', label: 'Alerts' },
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
