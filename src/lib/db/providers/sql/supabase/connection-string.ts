import type { ConnectionStringSpec, ParsedConnection } from "@/lib/db/connection-string/types";
import type { SSLMode } from "@/lib/types";

/**
 * A `postgresql://` URL whose host mentions Supabase. Every other `postgresql://` URL stays
 * with the Postgres type. This row is walked before that one, and the overlap is declared
 * in `CONNECTION_STRING_PASTE_OVERLAPS`.
 */
function claimsSupabase(text: string): boolean {
  const lower = text.toLowerCase();
  return (lower.startsWith("postgres://") || lower.startsWith("postgresql://")) && lower.includes("supabase");
}

function sslOf(params: URLSearchParams): Pick<ParsedConnection, "sslMode" | "unmappedTLSParam"> {
  const raw = params.get("sslmode");
  if (raw === null) return { sslMode: "require" };
  const mode = raw.toLowerCase();
  if (
    mode === "disable" ||
    mode === "require" ||
    mode === "verify-ca" ||
    mode === "verify-full" ||
    mode === "verify-system"
  ) {
    return { sslMode: mode as SSLMode };
  }
  return { unmappedTLSParam: `sslmode=${raw}` };
}

function parseSupabaseUrl(text: string): ParsedConnection | null {
  if (!claimsSupabase(text)) return null;
  let url: URL;
  try {
    url = new URL(text.replace(/^postgres(ql)?:/i, "https:"));
  } catch {
    return null;
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const tls = sslOf(url.searchParams);
  return {
    type: "supabase",
    host: url.hostname,
    ...(url.port === "" ? {} : { port: url.port }),
    ...(url.username === "" ? {} : { user: decodeURIComponent(url.username) }),
    ...(url.password === "" ? {} : { password: decodeURIComponent(url.password) }),
    ...(database === "" ? {} : { database }),
    ...tls,
  };
}

/**
 * `supabase`: no scheme of its own (the wire scheme is `postgresql://`, which Postgres already
 * shows). A paste is accepted only when the host mentions Supabase, and there is no seed load check.
 */
export const SUPABASE_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: {
    catchAll: false,
    claims: claimsSupabase,
    names: claimsSupabase,
    parse: parseSupabaseUrl,
    formats: ["postgresql://"],
  },
  validateSeed: null,
};
