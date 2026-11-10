/**
 * Which share requests the middleware can answer without a session.
 *
 * The id is the credential. It is 32 hex characters from the server, so a path that
 * merely starts with `/share` or `/api/share` is not public: publish, refresh and
 * delete stay behind the session. The query route is public and reads only the
 * snapshot named by that id.
 */

const SHARE_ID = "[a-f0-9]{32}";

const SHARE_ID_PATTERN = /^[a-f0-9]{32}$/;

export function isShareId(value: string): boolean {
  return SHARE_ID_PATTERN.test(value);
}

/** A page or a read of one snapshot. Anything else under `/share` still needs a session. */
export function isPublicShareRequest(method: string, pathname: string): boolean {
  if (method === "GET" && new RegExp(`^/share/${SHARE_ID}$`).test(pathname)) return true;
  if (method === "GET" && new RegExp(`^/api/share/${SHARE_ID}$`).test(pathname)) return true;
  if (method === "POST" && new RegExp(`^/api/share/${SHARE_ID}/query$`).test(pathname)) return true;
  return false;
}
