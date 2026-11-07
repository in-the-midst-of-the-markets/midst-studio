import type { DatabaseType } from "@/lib/types";

/** A SaaS account the studio queries through its API, opened from SAAS Connectors. */
export interface SaasConnector {
  readonly type: DatabaseType;
  readonly label: string;
  readonly description: string;
}

/** The connectors the SAAS Connectors dialog lists. HubSpot is queried live; nothing is copied into a database. */
export const SAAS_CONNECTORS: readonly SaasConnector[] = [
  {
    type: "hubspot",
    label: "HubSpot",
    description: "Query contacts, companies, and deals with SQL. Studio sends each statement to the HubSpot API.",
  },
];
