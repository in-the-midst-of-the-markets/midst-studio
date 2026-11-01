"use client";

import { buttonVariants } from "@/components/ui/button";
import { withBasePath } from "@/lib/config/base-path";
import { cn } from "@/lib/utils";

export type AssistMode = "traditional" | "assist";

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
