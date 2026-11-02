import { ChevronRight, Pencil } from "lucide-react";
import { ModeLinks } from "@/components/ai-assist/AssistModeToggle";
import { WorkspaceOwnerGate } from "@/components/auth/WorkspaceOwnerGate";
import { DashboardStudio } from "@/components/dashboards/DashboardStudio";
import { MidstLockup } from "@/components/midst-logo";

export default function CreatePage() {
  return (
    <WorkspaceOwnerGate>
      <div className="flex min-h-dvh flex-col bg-sunken text-fg">
        <header className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-hairline bg-surface px-4">
          <MidstLockup className="min-w-0 justify-self-start" markClassName="h-6 w-6" wordClassName="text-sm" />
          <p className="flex items-center gap-1.5 text-sm text-fg-muted">
            <span>Dashboards</span>
            <ChevronRight className="size-3.5" />
            <span className="font-medium text-fg">Create</span>
          </p>
          <div className="flex items-center justify-end gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-tint/15 px-3 py-1 text-xs font-medium text-brand">
              <Pencil className="size-3.5" />
              Dashboard builder
            </span>
            <ModeLinks page="dash" variant="outline" />
          </div>
        </header>
        <div className="min-h-0 flex-1 px-4 py-6 lg:px-6">
          <DashboardStudio />
        </div>
      </div>
    </WorkspaceOwnerGate>
  );
}
