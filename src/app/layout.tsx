import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "BASELINE — by Baker HQ",
  description: "BASELINE v2 by Baker HQ",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-surface text-neutral-100">
        <header className="border-b border-surface-border px-6 py-4">
          <div className="mx-auto flex max-w-5xl items-center justify-between">
            <div>
              <span className="text-sm font-semibold tracking-wide text-neutral-100">
                BASELINE
              </span>
              <span className="ml-2 text-xs text-neutral-500">by Baker HQ · v2 rv2.4</span>
            </div>
            <nav className="flex gap-5 text-sm text-neutral-400">
              <Link href="/dashboard" className="hover:text-neutral-100">
                Dashboard
              </Link>
              <Link href="/budget" className="hover:text-neutral-100">
                Budget
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
