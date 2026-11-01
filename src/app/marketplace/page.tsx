"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { WorkspaceOwnerGate } from "@/components/auth/WorkspaceOwnerGate";
import { Marketplace } from "@/components/marketplace/Marketplace";

export default function MarketplacePage() {
  // The proxy sends a visitor without a session to /login, as it does for /monitoring.
  return (
    <WorkspaceOwnerGate>
      <div className="mx-auto max-w-3xl px-6 pt-6 pb-16">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted transition-colors hover:text-fg"
        >
          <ArrowLeft className="size-3.5" />
          Back to the editor
        </Link>
        <Marketplace />
      </div>
    </WorkspaceOwnerGate>
  );
}
