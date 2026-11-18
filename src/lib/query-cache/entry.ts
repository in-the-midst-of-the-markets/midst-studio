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
  /**
   * Local minutes after midnight. Present when the table reruns daily at that
   * clock time, the way the AI schedule picks a time on the calendar.
   */
  refreshMinute?: number;
  /** Local calendar day `YYYY-MM-DD` the daily clock time may start. */
  refreshStartsOn?: string;
  /** True while the saved run stays on the table and does not fire. */
  refreshPaused?: boolean;
}
