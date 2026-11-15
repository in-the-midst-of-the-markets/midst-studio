/**
 * The SAP HANA session.
 *
 * Studio talks to HANA through the pure JavaScript `hdb` client (SAP's node-hdb).
 * The native `@sap/hana-client` is not loaded. Tests pass their own session; this
 * module is what production opens.
 */
import type { DatabaseConnection, SSLConfig } from "@/lib/types";

/** One result, rows in column order so a repeated name can be kept apart. */
export interface SapHanaQueryResult {
  readonly rows: readonly (readonly unknown[])[];
  readonly fields: readonly { readonly name: string }[];
  readonly rowCount?: number | null;
}

/** The dial the provider holds. Tests pass their own; production opens an `hdb` client. */
export interface SapHanaSession {
  query(sql: string): Promise<SapHanaQueryResult>;
  end(): Promise<void>;
}

export type SapHanaSessionFactory = (config: DatabaseConnection) => Promise<SapHanaSession>;

const DEFAULT_PORT = 30015;

/** The options `hdb.createClient` receives. Port 30015 is the indexserver for instance 00. */
export function sapHanaClientOptions(config: DatabaseConnection): {
  host: string;
  port: number;
  user: string;
  password: string;
  useTLS?: true;
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
} {
  const port = config.port || DEFAULT_PORT;
  const tls = tlsOf(config.ssl, port);
  return {
    host: config.host ?? "",
    port,
    user: config.user?.trim() ?? "",
    password: config.password ?? "",
    ...tls,
  };
}

function tlsOf(
  ssl: SSLConfig | undefined,
  port: number,
): { useTLS?: true; rejectUnauthorized?: boolean; ca?: string; cert?: string; key?: string } {
  const mode = ssl?.mode;
  const encrypt = (mode !== undefined && mode !== "disable") || port === 443;
  if (!encrypt) return {};
  const verify = mode !== "require" && mode !== "disable" && mode !== undefined;
  return {
    useTLS: true,
    rejectUnauthorized: ssl?.rejectUnauthorized ?? verify,
    ...(ssl?.caCert ? { ca: ssl.caCert } : {}),
    ...(ssl?.clientCert ? { cert: ssl.clientCert } : {}),
    ...(ssl?.clientKey ? { key: ssl.clientKey } : {}),
  };
}

interface HdbClient {
  connect(callback: (error: Error | null) => void): void;
  exec(sql: string, callback: (error: Error | null, result: unknown) => void): void;
  end(): void;
}

interface HdbModule {
  createClient(options: ReturnType<typeof sapHanaClientOptions>): HdbClient;
}

export function asHdb(loaded: unknown): HdbModule {
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    typeof (loaded as { createClient?: unknown }).createClient !== "function"
  ) {
    throw new Error("The SAP HANA client did not load.");
  }
  return loaded as HdbModule;
}

/** Turn an `hdb` exec result into column-ordered rows. A DML answer is one `affectedRows` cell. */
export function sapHanaRows(result: unknown): SapHanaQueryResult {
  if (typeof result === "number") {
    return { rows: [[result]], fields: [{ name: "affectedRows" }], rowCount: result };
  }
  if (!Array.isArray(result)) return { rows: [], fields: [], rowCount: 0 };
  const names: string[] = [];
  const seen = new Set<string>();
  const objects: Record<string, unknown>[] = [];
  for (const row of result) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    objects.push(record);
    for (const key of Object.keys(record)) {
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(key);
    }
  }
  return {
    rows: objects.map((row) => names.map((name) => row[name])),
    fields: names.map((name) => ({ name })),
    rowCount: objects.length,
  };
}

/** Open the session. The dynamic import keeps `hdb` out of a test that injects its own. */
export async function openSapHanaSession(config: DatabaseConnection): Promise<SapHanaSession> {
  const hdb = asHdb(await import("hdb"));
  const client = hdb.createClient(sapHanaClientOptions(config));
  try {
    await new Promise<void>((resolve, reject) => {
      client.connect((error) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    try {
      client.end();
    } catch {
      // The connect already failed. Closing a socket that never opened must not hide that error.
    }
    throw error;
  }
  return {
    query: (sql) =>
      new Promise((resolve, reject) => {
        client.exec(sql, (error, result) => (error ? reject(error) : resolve(sapHanaRows(result))));
      }),
    end: async () => {
      client.end();
    },
  };
}
