"use client";

import { buttonVariants } from "@/components/ui/button";
import { withBasePath } from "@/lib/config/base-path";
import { cn } from "@/lib/utils";

/** The three top-level surfaces. Each page links to the other two. */
type StudioSurface = "ide" | "assist" | "dash";

const SURFACES: readonly { id: StudioSurface; href: string; label: string }[] = [
  { id: "assist", href: "/assist", label: "AI" },
  { id: "ide", href: "/", label: "IDE" },
  { id: "dash", href: "/create", label: "Dash" },
];

/**
 * The IDE pair. A light brand wash and brand type, rather than a solid purple fill,
 * so the buttons sit with the rest of the header.
 */
export const IDE_MODE_LINK_CLASS =
  "border border-brand bg-brand/15 text-brand shadow-none hover:bg-brand/25 hover:text-brand";

/**
 * The other surfaces, as buttons beside each other.
 * The IDE offers AI and Dash, the AI page offers the IDE and Dash, and the dashboard offers AI and IDE.
 * `outline` is the quieter pair on the Analytics and dashboard headers.
 */
export function ModeLinks({
  page,
  variant = "default",
  className,
}: {
  page: StudioSurface;
  variant?: "default" | "outline";
  className?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {SURFACES.filter((surface) => surface.id !== page).map((surface) => (
        <a
          key={surface.id}
          href={withBasePath(surface.href)}
          className={cn(buttonVariants({ variant, size: "sm" }), "h-7 px-3 text-xs", className)}
        >
          {surface.label}
        </a>
      ))}
    </div>
  );
}
