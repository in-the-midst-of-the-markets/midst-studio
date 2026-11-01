"use client";

import { withBasePath } from "@/lib/config/base-path";
import { cn } from "@/lib/utils";

export type AssistMode = "traditional" | "assist";

/**
 * The top-center switch between the SQL editor and the AI Assist page.
 * Native links, so the prefix a deployment mounts under is applied by hand.
 */
export function AssistModeToggle({ mode }: { mode: AssistMode }) {
  return (
    <nav aria-label="Editor mode" className="flex items-center rounded-lg border border-hairline bg-sunken p-0.5">
      <ModeLink href="/" current={mode === "traditional"}>
        Traditional
      </ModeLink>
      <ModeLink href="/assist" current={mode === "assist"}>
        AI Assist
      </ModeLink>
    </nav>
  );
}

function ModeLink({ href, current, children }: { href: string; current: boolean; children: string }) {
  return (
    <a
      href={withBasePath(href)}
      aria-current={current ? "page" : undefined}
      className={cn(
        "rounded-md px-2.5 py-1 text-xs font-medium",
        current ? "bg-brand-solid text-white" : "text-fg-muted hover:text-fg",
      )}
    >
      {children}
    </a>
  );
}
