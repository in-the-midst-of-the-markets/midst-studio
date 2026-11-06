"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { WorkspaceOwnerGate } from "@/components/auth/WorkspaceOwnerGate";
import { Marketplace } from "@/components/marketplace/Marketplace";
import { MidstLockup } from "@/components/midst-logo";

export default function MarketplacePage() {
  // The proxy sends a visitor without a session to /login, as it does for /monitoring.
  return (
    <WorkspaceOwnerGate>
      <div className="flex min-h-dvh flex-col bg-sunken text-fg">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-hairline bg-surface px-6">
          <MidstLockup markClassName="h-7 w-7" wordClassName="text-base" />
          <span className="h-5 w-px bg-hairline" aria-hidden="true" />
          <span className="text-sm text-fg-secondary">Marketplace</span>
        </header>
        <div className="mx-auto w-full max-w-4xl flex-1 px-6 pt-8 pb-16">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm text-fg-muted transition-colors hover:text-fg"
          >
            <ArrowLeft className="size-3.5" />
            Back to the editor
          </Link>
          <div className="mt-6">
            <Marketplace />
          </div>
        </div>
      </div>
    </WorkspaceOwnerGate>
  );
}
