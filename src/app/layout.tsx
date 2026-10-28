import type { ReactNode } from 'react';

// Root layout only. CHMS-F001 exposes no page, route handler or server action
// (TD-10, AC-F001-28); UI belongs to the frontend foundation workstream.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
