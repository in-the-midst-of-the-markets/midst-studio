import { withBasePath } from "@/lib/config/base-path";
import { cn } from "@/lib/utils";

interface MidstMarkProps {
  className?: string;
  /** Set when the mark is the only name on screen. The lockup leaves this empty. */
  alt?: string;
}

/**
 * The product mark. Same artwork as the browser tab icon: a purple rounded
 * square with a white M. It carries its own ground, so it reads on light and dark chrome.
 */
function MidstMark({ className, alt = "" }: MidstMarkProps) {
  return <img src={withBasePath("/midst-logo.png")} alt={alt} className={cn("object-contain", className)} />;
}

interface MidstLockupProps {
  className?: string;
  markClassName?: string;
  wordClassName?: string;
}

/**
 * The mark with the word beside it. The top-left of the app, and the sign-in
 * brand, use this.
 */
export function MidstLockup({ className, markClassName, wordClassName }: MidstLockupProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <MidstMark className={cn("h-7 w-7", markClassName)} />
      <span className={cn("font-semibold tracking-tight text-fg", wordClassName)}>Midst</span>
    </span>
  );
}
