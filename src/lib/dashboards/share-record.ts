import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getDataDir } from "@/lib/data-dir";
import type { UserPayload } from "@/lib/auth";
import type { SavedChartConfig, SavedDashboard } from "@/lib/types";
import { isShareId } from "./share-access";
import { ShareNotFoundError } from "./share-limits";

/**
 * One published dashboard on disk: the public board, and the source queries the
 * server reruns when the snapshot is due. The source queries stay in this file.
 * The public routes do not return them.
 */

export interface StoredShareSource {
  readonly table: string;
  readonly connectionId: string;
  readonly sql: string;
}

export interface ShareOwner {
  readonly username: string;
  readonly role: UserPayload["role"];
  readonly idpSubject?: string;
  readonly idpIssuer?: string;
}

export interface ShareRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly refreshedAt: string;
  readonly ownerKey: string;
  readonly owner: ShareOwner;
  readonly dashboard: SavedDashboard;
  readonly charts: SavedChartConfig[];
  readonly sources: readonly StoredShareSource[];
  readonly tables: readonly string[];
  readonly refreshSeconds?: number;
}

export interface PublicShare {
  readonly id: string;
  readonly name: string;
  readonly dashboard: SavedDashboard;
  readonly charts: SavedChartConfig[];
  readonly refreshedAt: string;
  readonly refreshSeconds?: number;
}

export function shareDirectory(): string {
  return join(getDataDir(), "dashboard-shares");
}

function sharePath(id: string, suffix: string): string {
  if (!isShareId(id)) throw new ShareNotFoundError();
  return join(shareDirectory(), `${id}${suffix}`);
}

export function shareJsonPath(id: string): string {
  return sharePath(id, ".json");
}

export function shareDbPath(id: string): string {
  return sharePath(id, ".duckdb");
}

export function newShareId(): string {
  return randomBytes(16).toString("hex");
}

function reviveDashboard(dashboard: SavedDashboard): SavedDashboard {
  return {
    ...dashboard,
    createdAt: new Date(dashboard.createdAt),
    updatedAt: new Date(dashboard.updatedAt),
  };
}

function reviveCharts(charts: readonly SavedChartConfig[]): SavedChartConfig[] {
  return charts.map((chart) => ({ ...chart, createdAt: new Date(chart.createdAt) }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The snapshot record, or null when the file is missing or not one of ours. */
export function readShare(id: string): ShareRecord | null {
  if (!isShareId(id)) return null;
  let text: string;
  try {
    text = readFileSync(shareJsonPath(id), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.id !== id || !isRecord(parsed.owner)) return null;
  if (!isRecord(parsed.dashboard) || !Array.isArray(parsed.charts) || !Array.isArray(parsed.sources)) return null;
  const owner = parsed.owner;
  if (typeof owner.username !== "string" || (owner.role !== "admin" && owner.role !== "user")) return null;
  const record: ShareRecord = {
    id,
    name: typeof parsed.name === "string" ? parsed.name : "Dashboard",
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    refreshedAt: typeof parsed.refreshedAt === "string" ? parsed.refreshedAt : new Date(0).toISOString(),
    ownerKey: typeof parsed.ownerKey === "string" ? parsed.ownerKey : "",
    owner: {
      username: owner.username,
      role: owner.role,
      ...(typeof owner.idpSubject === "string" ? { idpSubject: owner.idpSubject } : {}),
      ...(typeof owner.idpIssuer === "string" ? { idpIssuer: owner.idpIssuer } : {}),
    },
    dashboard: reviveDashboard(parsed.dashboard as unknown as SavedDashboard),
    charts: reviveCharts(parsed.charts as SavedChartConfig[]),
    sources: parsed.sources.filter(isStoredSource),
    tables: Array.isArray(parsed.tables)
      ? parsed.tables.filter((item): item is string => typeof item === "string")
      : [],
    ...(typeof parsed.refreshSeconds === "number" ? { refreshSeconds: parsed.refreshSeconds } : {}),
  };
  return record;
}

function isStoredSource(value: unknown): value is StoredShareSource {
  if (!isRecord(value)) return false;
  return typeof value.table === "string" && typeof value.connectionId === "string" && typeof value.sql === "string";
}

export function writeShare(record: ShareRecord): void {
  mkdirSync(shareDirectory(), { recursive: true });
  const path = shareJsonPath(record.id);
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, JSON.stringify(record), "utf8");
  renameSync(temp, path);
}

export function deleteShare(id: string): void {
  if (!isShareId(id)) throw new ShareNotFoundError();
  rmSync(shareJsonPath(id), { force: true });
  rmSync(shareDbPath(id), { force: true });
  rmSync(`${shareDbPath(id)}.wal`, { force: true });
}

/** What a visitor is allowed to see. Source queries and the owner stay on the server. */
export function publicShare(record: ShareRecord): PublicShare {
  return {
    id: record.id,
    name: record.name,
    dashboard: record.dashboard,
    charts: record.charts,
    refreshedAt: record.refreshedAt,
    ...(record.refreshSeconds !== undefined ? { refreshSeconds: record.refreshSeconds } : {}),
  };
}

export function ownerSession(record: ShareRecord): UserPayload {
  return {
    username: record.owner.username,
    role: record.owner.role,
    ...(record.owner.idpSubject !== undefined ? { idpSubject: record.owner.idpSubject } : {}),
    ...(record.owner.idpIssuer !== undefined ? { idpIssuer: record.owner.idpIssuer } : {}),
  };
}
