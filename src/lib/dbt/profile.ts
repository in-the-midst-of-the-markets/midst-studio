import { stringify } from "yaml";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

/**
 * How a saved connection becomes a dbt target.
 * Null means this engine has no dbt adapter the studio writes a profile for.
 * The table is the one branch on the type id, and the lookup is `DBT_TARGETS[connection.type]`.
 */
type DbtTarget = (connection: DatabaseConnection) => Record<string, string | number> | string;

const unsupported: DbtTarget | null = null;

export const DBT_TARGETS: Record<DatabaseType, DbtTarget | null> = {
  postgres: postgresTarget,
  mysql: mysqlTarget,
  snowflake: snowflakeTarget,
  clickhouse: clickhouseTarget,
  duckdb: duckdbTarget,
  databend: databendTarget,
  bigquery: unsupported,
  sqlite: unsupported,
  mongodb: unsupported,
  redis: unsupported,
  oracle: unsupported,
  mssql: unsupported,
  db2: unsupported,
  libredb: unsupported,
  couchbase: unsupported,
  druid: unsupported,
  elasticsearch: unsupported,
  opensearch: unsupported,
  cassandra: unsupported,
  trino: unsupported,
  libsql: unsupported,
  prometheus: unsupported,
  kafka: unsupported,
  etcd: unsupported,
  neo4j: unsupported,
  milvus: unsupported,
  qdrant: unsupported,
  weaviate: unsupported,
  influxdb: unsupported,
  influxdb3: unsupported,
  oxia: unsupported,
  s3: unsupported,
  kubernetes: unsupported,
  mqtt: unsupported,
  firestore: unsupported,
  rabbitmq: unsupported,
  opcua: unsupported,
  spark: unsupported,
  mtconnect: unsupported,
  modbus: unsupported,
  netconf: unsupported,
  snmp: unsupported,
  sparkplug: unsupported,
};

const DBT_PROFILE_NAME = "midst";

/** A profiles document for `connection`, or a sentence when dbt cannot use it. */
export function dbtProfile(connection: DatabaseConnection): { yaml: string } | { error: string } {
  const build = DBT_TARGETS[connection.type];
  if (build === null) return { error: "This connection has no dbt target." };
  const output = build(connection);
  if (typeof output === "string") return { error: output };
  return {
    yaml: stringify({ [DBT_PROFILE_NAME]: { target: "dev", outputs: { dev: output } } }),
  };
}

/** The schema a preview uses for this connection, when the profile can name one. */
export function dbtSchema(connection: DatabaseConnection): string {
  const build = DBT_TARGETS[connection.type];
  if (build === null) return "public";
  const output = build(connection);
  if (typeof output === "string") return "public";
  const schema = output.schema;
  return typeof schema === "string" ? schema : "public";
}

function postgresTarget(connection: DatabaseConnection): Record<string, string | number> | string {
  return serverTarget(connection, "postgres", 5432, "public");
}

function mysqlTarget(connection: DatabaseConnection): Record<string, string | number> | string {
  const output = serverTarget(connection, "mysql", 3306, connection.database ?? "public");
  if (typeof output === "string") return output;
  return { ...output, schema: connection.database ?? "public" };
}

function clickhouseTarget(connection: DatabaseConnection): Record<string, string | number> | string {
  return serverTarget(connection, "clickhouse", 8123, "default");
}

function databendTarget(connection: DatabaseConnection): Record<string, string | number> | string {
  return serverTarget(connection, "databend", 8000, "default");
}

function serverTarget(
  connection: DatabaseConnection,
  type: string,
  defaultPort: number,
  defaultSchema: string,
): Record<string, string | number> | string {
  if (connection.host === undefined || connection.host === "") return "This connection has no host for dbt.";
  const host = plain(connection.host);
  const user = plain(connection.user ?? "");
  const database = plain(connection.database ?? "");
  const schema = plain(named(connection.schema, defaultSchema));
  const secret = passwordOf(connection);
  if (host === null || user === null || database === null || schema === null || secret === null) {
    return "This connection has a value that cannot be written into a profile.";
  }
  return {
    type,
    host,
    port: connection.port ?? defaultPort,
    user,
    password: secret,
    dbname: database,
    schema,
    threads: 1,
  };
}

function snowflakeTarget(connection: DatabaseConnection): Record<string, string | number> | string {
  const account = snowflakeAccount(connection.host);
  if (account === null) return "This connection has no Snowflake account for dbt.";
  const secret = passwordOf(connection);
  const user = plain(connection.user ?? "");
  const database = plain(connection.database ?? "");
  const schema = plain(named(connection.schema, "PUBLIC"));
  const warehouse =
    connection.warehouse === undefined || connection.warehouse === "" ? "" : plain(connection.warehouse);
  if (secret === null || user === null || database === null || schema === null || warehouse === null) {
    return "This connection has a value that cannot be written into a profile.";
  }
  const output: Record<string, string | number> = {
    type: "snowflake",
    account,
    user,
    password: secret,
    database,
    schema,
    threads: 1,
  };
  if (warehouse !== "") output.warehouse = warehouse;
  return output;
}

function duckdbTarget(connection: DatabaseConnection): Record<string, string | number> | string {
  const path = connection.connectionString ?? connection.database ?? ":memory:";
  const schema = plain(named(connection.schema, "main"));
  if (path.includes("\n") || path.includes("\0") || schema === null) {
    return "This connection's DuckDB path cannot be written into a profile.";
  }
  return { type: "duckdb", path, schema, threads: 1 };
}

function passwordOf(connection: DatabaseConnection): string | null {
  const password = connection.password ?? "";
  if (password === "") return null;
  return plain(password);
}

function plain(value: string): string | null {
  if (value.includes("\n") || value.includes("\0")) return null;
  return value;
}

function named(value: string | undefined, fallback: string): string {
  return value !== undefined && value !== "" ? value : fallback;
}

function snowflakeAccount(host: string | undefined): string | null {
  if (host === undefined || host === "") return null;
  const suffix = ".snowflakecomputing.com";
  return host.endsWith(suffix) ? host.slice(0, -suffix.length) : host;
}
