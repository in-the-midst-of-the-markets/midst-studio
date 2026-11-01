import { withBasePath } from "@/lib/config/base-path";
import { cn } from "@/lib/utils";

interface MidstLogoProps {
  className?: string;
}

/**
 * Marketing wordmark. The file is white on transparent; light mode paints it
 * black so it stays visible on a light page.
 */
export function MidstWordmark({ className }: MidstLogoProps) {
  return (
    <img
      src={withBasePath("/midst-wordmark.png")}
      alt="MIDST"
      className={cn("h-6 w-auto brightness-0 dark:brightness-100", className)}
    />
  );
}

/** Marketing M. The white facets need a dark ground, which the caller supplies. */
export function MidstMark({ className }: MidstLogoProps) {
  return <img src={withBasePath("/midst-mark.png")} alt="" className={cn("object-contain", className)} />;
}
