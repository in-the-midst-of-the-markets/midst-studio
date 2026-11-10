import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { SharedDashboard } from "@/components/dashboards/SharedDashboard";
import { MidstLockup } from "@/components/midst-logo";
import { isShareId } from "@/lib/dashboards/share-access";

export default async function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isShareId(id)) notFound();
  return (
    <div className="flex min-h-dvh flex-col bg-sunken text-fg">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-hairline bg-surface px-3 sm:px-4">
        <MidstLockup className="shrink-0" markClassName="h-6 w-6" wordClassName="text-sm" />
        <p className="flex min-w-0 items-center gap-1.5 text-sm text-fg-muted">
          <span>Dashboards</span>
          <ChevronRight className="size-3.5 shrink-0" />
          <span className="truncate font-medium text-fg">Shared</span>
        </p>
      </header>
      <div className="min-h-0 flex-1 px-4 py-6 lg:px-6">
        <SharedDashboard id={id} />
      </div>
    </div>
  );
}
