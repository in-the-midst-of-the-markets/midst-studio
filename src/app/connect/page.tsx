"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { WorkspaceOwnerGate } from "@/components/auth/WorkspaceOwnerGate";
import { SaasFlowEditor } from "@/components/saas/SaasFlowEditor";
import { MidstLockup } from "@/components/midst-logo";

export default function ConnectPage() {
  return (
    <WorkspaceOwnerGate>
      <div className="flex min-h-dvh flex-col bg-sunken text-fg">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-hairline bg-surface px-6">
          <MidstLockup markClassName="h-7 w-7" wordClassName="text-base" />
          <span className="h-5 w-px bg-hairline" aria-hidden="true" />
          <span className="text-sm text-fg-secondary">Connect APIs</span>
        </header>
        <div className="flex flex-1 flex-col px-6 pt-6 pb-10">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm text-fg-muted transition-colors hover:text-fg"
          >
            <ArrowLeft className="size-3.5" />
            Back to the editor
          </Link>
          <h1 className="mt-4 text-2xl font-medium text-fg">Connect APIs</h1>
          <p className="mt-1 max-w-2xl text-sm text-fg-secondary">
            Drag a service onto the board, fill in its token, and save it as a connection. Draw a line when one API
            feeds another. Tokens stay in this browser until you save.
          </p>
          <div className="mt-6">
            <SaasFlowEditor />
          </div>
        </div>
      </div>
    </WorkspaceOwnerGate>
  );
}
