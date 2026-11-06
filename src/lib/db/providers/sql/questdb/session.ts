/**
 * The PostgreSQL wire session QuestDB answers on port 8812.
 *
 * The editor's query path on the `postgres` provider issues `SELECT pg_backend_pid()`
 * whenever a run carries a query id. QuestDB has no such function, so that provider
 * cannot be the connection. This session sends the statement it was given and nothing
 * before it.
 */
import type { DatabaseConnection, SSLConfig } from "@/lib/types";

/** One result, rows in column order so a repeated name can be kept apart. */
export interface QuestDbQueryResult {
  readonly rows: readonly (readonly unknown[])[];
  readonly fields: readonly { readonly name: string }[];
  readonly rowCount?: number | null;
}

/** The dial the provider holds. Tests pass their own; production opens a `pg` pool. */
export interface QuestDbSession {
  query(sql: string): Promise<QuestDbQueryResult>;
  end(): Promise<void>;
}

export type QuestDbSessionFactory = (config: DatabaseConnection) => Promise<QuestDbSession>;

const DEFAULT_PORT = 8812;
const DEFAULT_USER = "admin";
const DEFAULT_DATABASE = "qdb";

/** The pool options the wire session opens with. No startup parameter and no pid probe. */
export function questDbPoolConfig(config: DatabaseConnection): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: false | { rejectUnauthorized: boolean; ca?: string; cert?: string; key?: string };
  max: number;
  connectionTimeoutMillis: number;
} {
  const mode = config.ssl?.mode;
  return {
    host: config.host ?? "",
    port: config.port || DEFAULT_PORT,
    user: config.user?.trim() || DEFAULT_USER,
    password: config.password ?? "",
    database: config.database?.trim() || DEFAULT_DATABASE,
    ssl: sslOf(mode, config.ssl),
    max: 4,
    connectionTimeoutMillis: 10_000,
  };
}

function sslOf(
  mode: SSLConfig["mode"] | undefined,
  ssl: SSLConfig | undefined,
): false | { rejectUnauthorized: boolean; ca?: string; cert?: string; key?: string } {
  if (mode === undefined || mode === "disable") return false;
  const verify = mode !== "require";
  return {
    rejectUnauthorized: ssl?.rejectUnauthorized ?? verify,
    ...(ssl?.caCert ? { ca: ssl.caCert } : {}),
    ...(ssl?.clientCert ? { cert: ssl.clientCert } : {}),
    ...(ssl?.clientKey ? { key: ssl.clientKey } : {}),
  };
}

/** Open the wire session. The dynamic import keeps `pg` out of a test that injects its own. */
export async function openQuestDbSession(config: DatabaseConnection): Promise<QuestDbSession> {
  const pg = await import("pg");
  const pool = new pg.Pool(questDbPoolConfig(config));
  return {
    query: async (sql) => {
      const result = await pool.query({ text: sql, rowMode: "array" });
      return {
        rows: result.rows as unknown[][],
        fields: result.fields.map((field) => ({ name: field.name })),
        rowCount: result.rowCount,
      };
    },
    end: () => pool.end(),
  };
}
