/**
 * The PostgreSQL wire session Amazon Redshift answers on port 5439.
 *
 * The editor's query path on the `postgres` provider issues `SELECT pg_backend_pid()`
 * whenever a run carries a query id. This session sends the statement it was given
 * and nothing before it. No startup parameter is set: a Redshift cluster rejects
 * several of the ones a PostgreSQL server accepts.
 */
import type { DatabaseConnection, SSLConfig } from "@/lib/types";

/** One result, rows in column order so a repeated name can be kept apart. */
export interface RedshiftQueryResult {
  readonly rows: readonly (readonly unknown[])[];
  readonly fields: readonly { readonly name: string }[];
  readonly rowCount?: number | null;
}

/** The dial the provider holds. Tests pass their own; production opens a `pg` pool. */
export interface RedshiftSession {
  query(sql: string): Promise<RedshiftQueryResult>;
  end(): Promise<void>;
}

export type RedshiftSessionFactory = (config: DatabaseConnection) => Promise<RedshiftSession>;

const DEFAULT_PORT = 5439;

/** The pool options the wire session opens with. No startup parameter and no pid probe. */
export function redshiftPoolConfig(config: DatabaseConnection): {
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
export async function openRedshiftSession(config: DatabaseConnection): Promise<RedshiftSession> {
  const pg = await import("pg");
  const pool = new pg.Pool(redshiftPoolConfig(config));
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
