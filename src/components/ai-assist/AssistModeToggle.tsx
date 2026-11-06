"use client";

import { Code2, Layers, LayoutDashboard, Sparkles, type LucideIcon } from "lucide-react";
import { withBasePath } from "@/lib/config/base-path";
import { cn } from "@/lib/utils";

/** The top-level surfaces. Each page shows all four, and marks the one that is open. */
type StudioSurface = "ide" | "assist" | "dash" | "models";

const SURFACES: readonly { id: StudioSurface; href: string; label: string; icon: LucideIcon }[] = [
  { id: "assist", href: "/assist", label: "AI", icon: Sparkles },
  { id: "ide", href: "/", label: "IDE", icon: Code2 },
  { id: "dash", href: "/create", label: "Dash", icon: LayoutDashboard },
  { id: "models", href: "/models", label: "Models", icon: Layers },
];

/** White on every page. The open page is the light brand wash. */
const MODE_LINK_CLASS = "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium shadow-none";

/**
 * The same four pages on every surface.
 * The open page is marked. The others are white, on the IDE as well as on AI, Dash, and Models.
 */
export function ModeLinks({ page }: { page: StudioSurface }) {
  return (
    <div className="min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <nav aria-label="Studio pages" className="flex w-max items-center gap-1.5">
        {SURFACES.map((surface) => {
          const current = surface.id === page;
          const Icon = surface.icon;
          return (
            <a
              key={surface.id}
              href={withBasePath(surface.href)}
              aria-current={current ? "page" : undefined}
              className={cn(
                MODE_LINK_CLASS,
                current
                  ? "border-transparent bg-brand-tint/20 text-brand"
                  : "border-hairline bg-raised text-fg-secondary hover:bg-fill hover:text-fg",
              )}
            >
              <Icon aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
              <span className="max-sm:sr-only">{surface.label}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
