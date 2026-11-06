import { ChevronRight, Pencil } from "lucide-react";
import { ModeLinks } from "@/components/ai-assist/AssistModeToggle";
import { WorkspaceOwnerGate } from "@/components/auth/WorkspaceOwnerGate";
import { DashboardStudio } from "@/components/dashboards/DashboardStudio";
import { MidstLockup } from "@/components/midst-logo";

export default function CreatePage() {
  return (
    <WorkspaceOwnerGate>
      <div className="flex min-h-dvh flex-col bg-sunken text-fg">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-hairline bg-surface px-3 sm:gap-3 sm:px-4">
          <MidstLockup className="shrink-0" markClassName="h-6 w-6" wordClassName="text-sm" />
          <p className="hidden min-w-0 items-center gap-1.5 text-sm text-fg-muted sm:flex">
            <span>Dashboards</span>
            <ChevronRight className="size-3.5 shrink-0" />
            <span className="truncate font-medium text-fg">Create</span>
          </p>
          <div className="ml-auto flex min-w-0 items-center justify-end gap-2">
            <span className="hidden items-center gap-1.5 rounded-full bg-brand-tint/15 px-3 py-1 text-xs font-medium text-brand md:inline-flex">
              <Pencil className="size-3.5" />
              Dashboard builder
            </span>
            <ModeLinks page="dash" />
          </div>
        </header>
        <div className="min-h-0 flex-1 px-4 py-6 lg:px-6">
          <DashboardStudio />
        </div>
      </div>
    </WorkspaceOwnerGate>
  );
}
