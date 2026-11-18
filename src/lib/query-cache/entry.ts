/** One cached table, and the source a refresh runs again before it replaces the rows. */
export interface CacheEntry {
  tableName: string;
  sourceName: string;
  sourceSql: string;
  sourceConnectionId: string;
  rowCount: number;
  cachedAt: string;
  /**
   * How often an open KnowSQL page reruns the source and replaces the rows.
   * Absent when the table refreshes only when someone asks.
   */
  refreshSeconds?: number;
}
