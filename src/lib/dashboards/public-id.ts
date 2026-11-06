/**
 * Ids a dashboard shows for a filter or a chart.
 *
 * A filter's id is what a query writes as `{{id}}`. A chart's id names that chart
 * when a data point on it sets a filter, and that filter can drive other charts.
 * The id is given once. The editor shows it and does not change it.
 */

function randomHex(length: number): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, length);
}

/** An id for a filter: `id_` plus random hex, so it is not a word a query would use. */
export function filterPublicId(): string {
  return `id_${randomHex(10)}`;
}

/** An id for a chart: `c_` plus random hex. */
export function chartPublicId(): string {
  return `c_${randomHex(10)}`;
}

const CHART_TOKEN = /^c_[a-f0-9]{8,32}$/;

/** Whether `token` is a chart id this dashboard gave out. */
export function isChartToken(token: string | undefined): token is string {
  return token !== undefined && CHART_TOKEN.test(token);
}

/**
 * The chart id to store. The one on the chart being saved wins, then the one
 * already stored, then a new id.
 */
export function chartTokenFor(incoming: string | undefined, stored: string | undefined): string {
  if (isChartToken(incoming)) return incoming;
  if (isChartToken(stored)) return stored;
  return chartPublicId();
}

/** The same chart, with an id when it does not have one yet. */
export function ensureChartToken<T extends { token?: string }>(chart: T): T {
  if (isChartToken(chart.token)) return chart;
  return { ...chart, token: chartPublicId() };
}
