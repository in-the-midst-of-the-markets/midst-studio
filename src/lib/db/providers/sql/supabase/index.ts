/**
 * Supabase provider.
 *
 * A Supabase database is Postgres. This subclass normalizes the host the dialog collects
 * (a project ref, a `https://<ref>.supabase.co` URL, the direct host, the pooler host, or a
 * pasted `postgresql://` URL) and then uses the Postgres provider unchanged, so the SQL
 * editor, the schema tree, explain and transactions are the Postgres ones.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import type {
  DatabaseConnection,
  ObjectKindSpec,
  ProviderCapabilities,
  ProviderExecutionContext,
  ProviderOptions,
} from "@/lib/db/types";
import { PostgresProvider } from "../postgres";
import { normalizeSupabaseConnection } from "./connection";

/** The Postgres kind, without the object-edit flags. The tree still shows source. */
function withoutObjectEdits(kind: ObjectKindSpec): ObjectKindSpec {
  const { acceptsSourceEdits, acceptsRowWrites, ...rest } = kind;
  void acceptsSourceEdits;
  void acceptsRowWrites;
  return rest;
}

export class SupabaseProvider extends PostgresProvider {
  constructor(config: DatabaseConnection, options: ProviderOptions = {}, execution: ProviderExecutionContext = {}) {
    super(normalizeSupabaseConnection(config), options, execution);
    // Postgres implements object edit. This connection does not declare it, so the methods
    // are absent on the instance rather than inherited and unused.
    Object.defineProperty(this, "buildObjectEdit", { value: undefined });
    Object.defineProperty(this, "applyObjectEdit", { value: undefined });
  }

  /**
   * The parent check names PostgreSQL. A Supabase connection with no host should say where
   * the host comes from. `this.validate()` in the parent constructor reaches this override.
   */
  public override validate(): void {
    if (!this.config.id) {
      throw new DatabaseConfigError("Connection ID is required", "supabase");
    }
    if (!this.config.connectionString?.trim() && !this.config.host?.trim()) {
      throw new DatabaseConfigError(
        "Host is required. Use the project ref, db.<ref>.supabase.co, the pooler host, or a postgresql:// URL.",
        "supabase",
      );
    }
    super.validate();
  }

  public override getCapabilities(): ProviderCapabilities {
    const base = super.getCapabilities();
    const { createTable: _createTable, ...rest } = base;
    void _createTable;
    return {
      ...rest,
      defaultPort: 5432,
      objectKinds: rest.objectKinds?.map(withoutObjectEdits),
    };
  }
}
