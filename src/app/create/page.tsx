import { ModeLinks } from "@/components/ai-assist/AssistModeToggle";
import { WorkspaceOwnerGate } from "@/components/auth/WorkspaceOwnerGate";
import { DashboardStudio } from "@/components/dashboards/DashboardStudio";
import { MidstLockup } from "@/components/midst-logo";

export default function CreatePage() {
  return (
    <WorkspaceOwnerGate>
      <div className="flex min-h-dvh flex-col bg-sunken text-fg">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-hairline bg-surface px-4">
          <MidstLockup className="min-w-0" markClassName="h-6 w-6" wordClassName="text-sm" />
          <ModeLinks page="dash" />
        </header>
        <div className="mx-auto w-full max-w-6xl px-6 pt-6 pb-16">
          <DashboardStudio />
        </div>
      </div>
    </WorkspaceOwnerGate>
  );
}
