"use client";

import { buttonVariants } from "@/components/ui/button";
import { withBasePath } from "@/lib/config/base-path";
import { cn } from "@/lib/utils";

export type AssistMode = "traditional" | "assist";

/**
 * The top-center switch between the SQL editor and the AI page.
 * Native links, so the prefix a deployment mounts under is applied by hand.
 */
export function AssistModeToggle({ mode }: { mode: AssistMode }) {
  return (
    <nav aria-label="Editor mode" className="flex items-center gap-1">
      <ModeLink href="/" current={mode === "traditional"}>
        IDE
      </ModeLink>
      <ModeLink href="/assist" current={mode === "assist"}>
        AI
      </ModeLink>
    </nav>
  );
}

/** The other page, as a button. The IDE offers AI, and the AI page offers the IDE. */
export function OtherModeLink({ mode }: { mode: AssistMode }) {
  const toAssist = mode === "traditional";
  return (
    <a
      href={withBasePath(toAssist ? "/assist" : "/")}
      className={cn(buttonVariants({ variant: "default", size: "sm" }), "h-7 px-3 text-xs")}
    >
      {toAssist ? "AI" : "IDE"}
    </a>
  );
}

function ModeLink({ href, current, children }: { href: string; current: boolean; children: string }) {
  return (
    <a
      href={withBasePath(href)}
      aria-current={current ? "page" : undefined}
      className={cn(buttonVariants({ variant: current ? "default" : "outline", size: "sm" }), "h-7 px-2.5 text-xs")}
    >
      {children}
    </a>
  );
}
