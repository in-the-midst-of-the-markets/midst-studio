/** One cached table, and the source a refresh runs again before it replaces the rows. */
export interface CacheEntry {
  tableName: string;
  sourceName: string;
  sourceSql: string;
  sourceConnectionId: string;
  rowCount: number;
  cachedAt: string;
}
