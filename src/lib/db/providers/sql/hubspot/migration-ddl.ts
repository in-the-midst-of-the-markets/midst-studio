/**
 * HubSpot property changes are not generated. The migration prints `refusal` after its header.
 * There is no transaction wrapper: a HubSpot change is one Web API request, not a BEGIN/COMMIT pair.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "HubSpot property changes are not generated here; create the property in HubSpot.";

export const HUBSPOT_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- HubSpot: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
