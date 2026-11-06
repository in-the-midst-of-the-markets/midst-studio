import { BookOpen, User } from "lucide-react";
import { ModeLinks } from "@/components/ai-assist/AssistModeToggle";
import { WorkspaceOwnerGate } from "@/components/auth/WorkspaceOwnerGate";
import DbtProjectPanel from "@/components/dbt/DbtProjectPanel";
import { MidstLockup } from "@/components/midst-logo";
import { withBasePath } from "@/lib/config/base-path";

export default function ModelsPage() {
  return (
    <WorkspaceOwnerGate>
      <div className="flex min-h-dvh flex-col bg-sunken text-fg">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-hairline bg-surface px-3 sm:gap-3 sm:px-4">
          <MidstLockup className="shrink-0" markClassName="h-6 w-6" wordClassName="text-sm" />
          <div className="min-w-0 flex-1">
            <ModeLinks page="models" />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a
              href="https://libredb.org"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-raised px-2.5 text-xs font-medium text-fg-secondary hover:bg-fill hover:text-fg"
            >
              <BookOpen aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
              <span className="max-sm:sr-only">Docs</span>
            </a>
            <a
              href={withBasePath("/settings/authenticator")}
              aria-label="Account"
              className="inline-flex size-8 items-center justify-center rounded-full border border-hairline bg-raised text-fg-secondary hover:bg-fill hover:text-fg"
            >
              <User aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
            </a>
          </div>
        </header>
        <div className="min-h-0 flex-1 px-4 py-8 lg:px-6">
          <DbtProjectPanel />
        </div>
      </div>
    </WorkspaceOwnerGate>
  );
}
