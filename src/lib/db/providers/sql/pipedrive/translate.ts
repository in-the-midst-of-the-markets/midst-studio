/**
 * The SQL subset a Pipedrive connection runs.
 *
 * Pipedrive is a CRM API, not a SQL server. The editor still speaks SQL, and this module
 * turns one SELECT into one API v2 list of one standard resource. Filters, order and the
 * page are applied to that answer. A write, a join and a second statement fail here, before
 * a request. Custom fields and the next page are not requested.
 */
import {
  listedResource,
  listedRows,
  translateListedSql,
  type ListedColumn,
  type ListedCompare,
  type ListedFilter,
  type ListedOrder,
  type ListedProduct,
  type ListedResource,
  type ListedSelect,
} from "../listed-select";

/** One list page. Pipedrive's maximum `limit` is 500, and Studio does not follow `next_cursor`. */
export const PIPEDRIVE_ROW_CAP = 500;

export type PipedriveType = ListedColumn["type"];
export type PipedriveColumn = ListedColumn;
export type PipedriveResource = ListedResource;
export type PipedriveCompare = ListedCompare;
export type PipedriveFilter = ListedFilter;
export type PipedriveOrder = ListedOrder;
export type PipedriveSelect = ListedSelect;

function column(name: string, type: PipedriveType, json: string): PipedriveColumn {
  return { name, type, json };
}

function resource(name: string, primary: string, path: string, columns: readonly PipedriveColumn[]): PipedriveResource {
  return { name, primary, path, columns };
}

/** The standard resources this connection reads. Each one is one API v2 list. */
export const PIPEDRIVE_RESOURCES: readonly PipedriveResource[] = Object.freeze([
  resource("deal", "deal.id", "/api/v2/deals", [
    column("deal.id", "number", "id"),
    column("deal.title", "text", "title"),
    column("deal.status", "text", "status"),
    column("deal.value", "number", "value"),
    column("deal.currency", "text", "currency"),
    column("deal.owner_id", "number", "owner_id"),
    column("deal.person_id", "number", "person_id"),
    column("deal.org_id", "number", "org_id"),
    column("deal.pipeline_id", "number", "pipeline_id"),
    column("deal.stage_id", "number", "stage_id"),
    column("deal.update_time", "text", "update_time"),
  ]),
  resource("person", "person.id", "/api/v2/persons", [
    column("person.id", "number", "id"),
    column("person.name", "text", "name"),
    column("person.owner_id", "number", "owner_id"),
    column("person.org_id", "number", "org_id"),
    column("person.update_time", "text", "update_time"),
  ]),
  resource("organization", "organization.id", "/api/v2/organizations", [
    column("organization.id", "number", "id"),
    column("organization.name", "text", "name"),
    column("organization.owner_id", "number", "owner_id"),
    column("organization.update_time", "text", "update_time"),
  ]),
  resource("activity", "activity.id", "/api/v2/activities", [
    column("activity.id", "number", "id"),
    column("activity.subject", "text", "subject"),
    column("activity.type", "text", "type"),
    column("activity.done", "text", "done"),
    column("activity.deal_id", "number", "deal_id"),
    column("activity.due_date", "text", "due_date"),
    column("activity.update_time", "text", "update_time"),
  ]),
  resource("product", "product.id", "/api/v2/products", [
    column("product.id", "number", "id"),
    column("product.name", "text", "name"),
    column("product.code", "text", "code"),
    column("product.owner_id", "number", "owner_id"),
    column("product.update_time", "text", "update_time"),
  ]),
  resource("pipeline", "pipeline.id", "/api/v2/pipelines", [
    column("pipeline.id", "number", "id"),
    column("pipeline.name", "text", "name"),
    column("pipeline.order_nr", "number", "order_nr"),
    column("pipeline.update_time", "text", "update_time"),
  ]),
  resource("stage", "stage.id", "/api/v2/stages", [
    column("stage.id", "number", "id"),
    column("stage.name", "text", "name"),
    column("stage.pipeline_id", "number", "pipeline_id"),
    column("stage.order_nr", "number", "order_nr"),
    column("stage.update_time", "text", "update_time"),
  ]),
]);

const PIPEDRIVE: ListedProduct = {
  provider: "pipedrive",
  rowCap: PIPEDRIVE_ROW_CAP,
  resources: PIPEDRIVE_RESOURCES,
  product: "Pipedrive",
  example: "deal",
  exampleColumn: "deal.title",
};

export function pipedriveResource(name: string): PipedriveResource | undefined {
  return listedResource(PIPEDRIVE, name);
}

/** One statement, or a refusal that names what to write instead. */
export function translatePipedriveSql(sql: string): PipedriveSelect {
  return translateListedSql(sql, PIPEDRIVE);
}

/** The page of rows one API v2 list becomes. */
export function pipedriveRows(
  statement: PipedriveSelect,
  entries: readonly unknown[],
  sql: string,
): Record<string, unknown>[] {
  return listedRows(PIPEDRIVE, statement, entries, sql);
}
