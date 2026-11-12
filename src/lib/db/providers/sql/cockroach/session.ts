/**
 * The PostgreSQL wire session CockroachDB answers on port 26257.
 *
 * The editor's query path on the `postgres` provider issues `SELECT pg_backend_pid()`
 * whenever a run carries a query id. This session sends the statement it was given
 * and nothing before it. No startup parameter is set: a Cockroach cluster rejects
 * several of the ones a PostgreSQL server accepts.
 */
import type { DatabaseConnection, SSLConfig } from "@/lib/types";

/** One result, rows in column order so a repeated name can be kept apart. */
export interface CockroachQueryResult {
  readonly rows: readonly (readonly unknown[])[];
  readonly fields: readonly { readonly name: string }[];
  readonly rowCount?: number | null;
}

/** The dial the provider holds. Tests pass their own; production opens a `pg` pool. */
export interface CockroachSession {
  query(sql: string): Promise<CockroachQueryResult>;
  end(): Promise<void>;
}

export type CockroachSessionFactory = (config: DatabaseConnection) => Promise<CockroachSession>;

const DEFAULT_PORT = 26257;

/** The pool options the wire session opens with. No startup parameter and no pid probe. */
export function cockroachPoolConfig(config: DatabaseConnection): {
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
    user: config.user?.trim() ?? "",
    password: config.password ?? "",
    database: config.database?.trim() ?? "",
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
export async function openCockroachSession(config: DatabaseConnection): Promise<CockroachSession> {
  const pg = await import("pg");
  const pool = new pg.Pool(cockroachPoolConfig(config));
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
