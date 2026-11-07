/**
 * Supabase is Postgres. The dialog accepts a project ref, a dashboard URL, the direct host,
 * the pooler host, or the `postgresql://` string the Supabase dashboard copies. This turns
 * all of those into the host, port, user and database the Postgres provider opens.
 */
import type { DatabaseConnection } from "@/lib/types";

const PROJECT_REF = /^[a-z0-9]{10,40}$/i;

/** A hostname Supabase itself serves: a name under supabase.co or supabase.com, not a name that merely contains those letters. */
export function isSupabaseCloudHost(host: string | undefined): boolean {
  const name = host?.trim().toLowerCase().replace(/\.$/, "") ?? "";
  return name.endsWith(".supabase.co") || name.endsWith(".supabase.com");
}

/** The connection the Postgres provider should open for a Supabase dialog. */
export function normalizeSupabaseConnection(config: DatabaseConnection): DatabaseConnection {
  const next: DatabaseConnection = { ...config, type: "supabase" };
  if (next.connectionString?.trim()) {
    return sealSupabaseTls({ ...next, connectionString: withCloudTls(next.connectionString) });
  }
  const fromUrl = absorbPostgresUrl(next);
  const host = expandSupabaseHost(fromUrl.host?.trim() ?? "");
  return sealSupabaseTls({
    ...fromUrl,
    host,
    port: fromUrl.port || 5432,
    user: fromUrl.user?.trim() || "postgres",
    database: fromUrl.database?.trim() || "postgres",
  });
}

/**
 * Postgres prefers `sslmode` inside a connection string over the ssl object beside it.
 * A cloud host is rewritten to `require` unless the string already asks for a verifying mode,
 * so `sslmode=disable` cannot open that host in cleartext.
 */
function withCloudTls(connectionString: string): string {
  const original = connectionString.trim();
  let url: URL;
  try {
    url = new URL(original.replace(/^postgres(ql)?:/i, "https:"));
  } catch {
    return original;
  }
  if (!isSupabaseCloudHost(url.hostname)) return original;
  const modes = sslModes(url);
  const sealed = modes.length > 0 && modes.every((mode) => mode === "require" || VERIFYING_SSL.has(mode));
  if (sealed) return original;
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === "sslmode") url.searchParams.delete(key);
  }
  url.searchParams.set("sslmode", "require");
  const scheme = /^postgres:\/\//i.test(original) ? "postgres:" : "postgresql:";
  return url.toString().replace(/^https:/i, scheme);
}

const VERIFYING_SSL = new Set(["verify-full", "verify-ca", "verify-system"]);

/** Every sslmode query, whatever case it was written in. A later one is the one Postgres reads. */
function sslModes(url: URL): string[] {
  const modes: string[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (key.toLowerCase() === "sslmode") modes.push(value.toLowerCase());
  }
  return modes;
}

function sealSupabaseTls(config: DatabaseConnection): DatabaseConnection {
  const cloud = isSupabaseCloudHost(config.host) || cloudHostIn(config.connectionString);
  if (!cloud) return config;
  const mode = config.ssl?.mode;
  if (mode === "verify-full" || mode === "verify-ca" || mode === "verify-system") return config;
  return { ...config, ssl: { ...config.ssl, mode: "require" } };
}

function cloudHostIn(connectionString: string | undefined): boolean {
  const raw = connectionString?.trim();
  if (!raw) return false;
  try {
    return isSupabaseCloudHost(new URL(raw.replace(/^postgres(ql)?:/i, "https:")).hostname);
  } catch {
    return false;
  }
}

function absorbPostgresUrl(config: DatabaseConnection): DatabaseConnection {
  const raw = config.host?.trim() ?? "";
  const postgres = /^postgres(ql)?:\/\//i.test(raw);
  const http = /^https?:\/\//i.test(raw);
  if (!postgres && !http) return config;
  let url: URL;
  try {
    url = new URL(raw.replace(/^postgres(ql)?:/i, "https:"));
  } catch {
    return config;
  }
  // An https URL with no userinfo is a dashboard or project address, read by expandSupabaseHost.
  if (!postgres && url.username === "" && url.password === "") return config;
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const port = url.port === "" ? config.port : Number(url.port);
  return {
    ...config,
    host: url.hostname,
    port: Number.isInteger(port) ? port : config.port,
    user: decodeURIComponent(url.username || config.user || ""),
    password: decodeURIComponent(url.password || config.password || ""),
    database: database || config.database,
  };
}

/** A project ref or a Supabase URL becomes the direct database host. A pooler host is left as written. */
export function expandSupabaseHost(host: string): string {
  const trimmed = host.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return trimmed;
    }
    const name = url.hostname.toLowerCase().replace(/\.$/, "");
    const ref = dashboardRef(url);
    if (ref !== undefined) return `db.${ref}.supabase.co`;
    const label = projectLabel(name);
    if (label !== undefined) return `db.${label}.supabase.co`;
    return name;
  }
  const bare = trimmed.replace(/\.$/, "");
  if (PROJECT_REF.test(bare)) return `db.${bare.toLowerCase()}.supabase.co`;
  const label = projectLabel(bare.toLowerCase());
  if (label !== undefined) return `db.${label}.supabase.co`;
  return bare;
}

/** The project ref in a dashboard URL, only when the host is supabase.com itself. */
function dashboardRef(url: URL): string | undefined {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host !== "supabase.com" && host !== "www.supabase.com") return undefined;
  const match = url.pathname.match(/^\/dashboard\/project\/([a-z0-9]{10,40})(?:\/|$)/i);
  return match?.[1]?.toLowerCase();
}

/** The single label of `<ref>.supabase.co`, when it is not already the direct `db.` host. */
function projectLabel(hostname: string): string | undefined {
  if (!hostname.endsWith(".supabase.co")) return undefined;
  const label = hostname.slice(0, -".supabase.co".length);
  if (!/^[a-z0-9-]+$/i.test(label) || label.includes(".") || label.toLowerCase() === "db") return undefined;
  return label.toLowerCase();
}
