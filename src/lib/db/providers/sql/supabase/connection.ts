/**
 * Supabase is Postgres. The dialog accepts a project ref, a dashboard URL, the direct host,
 * the pooler host, or the `postgresql://` string the Supabase dashboard copies. This turns
 * all of those into the host, port, user and database the Postgres provider opens.
 */
import type { DatabaseConnection } from "@/lib/types";

const PROJECT_REF = /^[a-z0-9]{10,40}$/i;

/** The connection the Postgres provider should open for a Supabase dialog. */
export function normalizeSupabaseConnection(config: DatabaseConnection): DatabaseConnection {
  const next: DatabaseConnection = { ...config, type: "supabase" };
  if (next.connectionString?.trim()) return next;
  const fromUrl = absorbPostgresUrl(next);
  const host = expandSupabaseHost(fromUrl.host?.trim() ?? "");
  const normalized: DatabaseConnection = {
    ...fromUrl,
    host,
    port: fromUrl.port || 5432,
    user: fromUrl.user?.trim() || "postgres",
    database: fromUrl.database?.trim() || "postgres",
  };
  if (host.toLowerCase().includes("supabase") && (normalized.ssl === undefined || normalized.ssl.mode === "disable")) {
    normalized.ssl = { mode: "require" };
  }
  return normalized;
}

function absorbPostgresUrl(config: DatabaseConnection): DatabaseConnection {
  const raw = config.host?.trim() ?? "";
  if (!/^postgres(ql)?:\/\//i.test(raw)) return config;
  const url = new URL(raw.replace(/^postgres(ql)?:/i, "https:"));
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
  const dashboard = host.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (dashboard?.[1]) return `db.${dashboard[1]}.supabase.co`;
  const projectUrl = host.match(/^https?:\/\/([a-z0-9-]+)\.supabase\.co\/?$/i);
  if (projectUrl?.[1] && projectUrl[1].toLowerCase() !== "db") return `db.${projectUrl[1]}.supabase.co`;
  const bareProject = host.match(/^([a-z0-9-]+)\.supabase\.co$/i);
  if (bareProject?.[1] && !bareProject[1].includes(".") && bareProject[1].toLowerCase() !== "db") {
    return `db.${bareProject[1]}.supabase.co`;
  }
  if (PROJECT_REF.test(host)) return `db.${host}.supabase.co`;
  return host;
}
