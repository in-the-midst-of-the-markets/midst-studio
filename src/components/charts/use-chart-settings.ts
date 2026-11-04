"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_CHART_SETTINGS, readChartSettings, subscribeChartSettings } from "@/lib/charts/chart-settings";

/** This browser's chart defaults, updating when the profile menu changes them. */
export function useChartSettings() {
  return useSyncExternalStore(subscribeChartSettings, readChartSettings, () => DEFAULT_CHART_SETTINGS);
}
