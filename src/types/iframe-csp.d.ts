/**
 * The HTML `csp` attribute is an iframe's Content Security Policy.
 *
 * React's iframe props leave it out, so a frame that sets it fails `next build`'s
 * type check. The dashboard text and filter frames set it.
 */
declare namespace React {
  interface IframeHTMLAttributes<T> {
    csp?: string | undefined;
  }
}
