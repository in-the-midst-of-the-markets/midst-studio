import { ModeLinks } from "@/components/ai-assist/AssistModeToggle";
import { WorkspaceOwnerGate } from "@/components/auth/WorkspaceOwnerGate";
import DbtProjectPanel from "@/components/dbt/DbtProjectPanel";
import { MidstLockup } from "@/components/midst-logo";

export default function ModelsPage() {
  return (
    <WorkspaceOwnerGate>
      <div className="flex min-h-dvh flex-col bg-sunken text-fg">
        <header className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-hairline bg-surface px-4">
          <MidstLockup className="min-w-0 justify-self-start" markClassName="h-6 w-6" wordClassName="text-sm" />
          <h1 className="text-sm font-medium">Models</h1>
          <div className="flex items-center justify-end">
            <ModeLinks page="models" variant="outline" />
          </div>
        </header>
        <div className="min-h-0 flex-1 px-4 py-6 lg:px-6">
          <DbtProjectPanel />
        </div>
      </div>
    </WorkspaceOwnerGate>
  );
}
