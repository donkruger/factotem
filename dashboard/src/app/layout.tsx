import type { Metadata } from 'next';
import { Comfortaa } from 'next/font/google';

import { AppShell } from '@/components/layout/AppShell';
import '@/styles/globals.css';

const comfortaa = Comfortaa({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-comfortaa',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Factotem · Operator Dashboard',
  description: 'Operator dashboard for the NanoClaw deployment.',
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className={comfortaa.variable}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
