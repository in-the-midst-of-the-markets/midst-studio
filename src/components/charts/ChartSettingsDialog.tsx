"use client";

import { useEffect, useState } from "react";
import { useSyncExternalStore } from "react";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import {
  CHART_COLOR_LIMIT,
  CHART_FONT_SIZE_MAX,
  CHART_FONT_SIZE_MIN,
  CHART_FONTS,
  DEFAULT_CHART_SETTINGS,
  chartCategories,
  nextChartColor,
  normalizeChartSettings,
  readChartSettings,
  subscribeChartSettings,
  writeChartSettings,
  type ChartColorSettings,
  type ChartSettings,
  type ChartTextSettings,
} from "@/lib/charts/chart-settings";
import { chartTheme } from "@/lib/charts/palette";

function Choice({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-fg">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function SizeField({ label, value, onChange }: { label: string; value: number; onChange: (size: number) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-fg-muted">
      {label}
      <input
        type="number"
        aria-label={label}
        min={CHART_FONT_SIZE_MIN}
        max={CHART_FONT_SIZE_MAX}
        value={value}
        onChange={(event) => {
          const size = Number(event.target.value);
          if (!Number.isInteger(size) || size < CHART_FONT_SIZE_MIN || size > CHART_FONT_SIZE_MAX) return;
          onChange(size);
        }}
        className="w-24 rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm text-fg"
      />
    </label>
  );
}

function writeText(settings: ChartSettings, patch: Partial<ChartTextSettings>): void {
  writeChartSettings(normalizeChartSettings({ ...settings, text: { ...settings.text, ...patch } }));
}

function writeColors(settings: ChartSettings, colors: ChartColorSettings): void {
  writeChartSettings(normalizeChartSettings({ ...settings, colors }));
}

function ColorField({
  label,
  pickerLabel,
  value,
  fallback,
  onChange,
}: {
  label: string;
  pickerLabel: string;
  value: string;
  fallback: string;
  onChange: (color: string) => void;
}) {
  const enabled = value !== "";
  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-2 text-sm text-fg">
        <input type="checkbox" checked={enabled} onChange={(event) => onChange(event.target.checked ? fallback : "")} />
        {label}
      </label>
      {enabled && (
        <input
          type="color"
          aria-label={pickerLabel}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-10 cursor-pointer rounded border border-hairline bg-canvas p-0.5"
        />
      )}
    </div>
  );
}

function replaceChartColor(settings: ChartSettings, index: number, raw: string): void {
  const color = raw.trim().toLowerCase();
  const series = settings.colors.series;
  if (series[index] === color) return;
  if (series.some((item, itemIndex) => itemIndex !== index && item === color)) {
    writeColors(settings, settings.colors);
    return;
  }
  writeColors(settings, {
    ...settings.colors,
    series: series.map((item, itemIndex) => (itemIndex === index ? color : item)),
  });
}

function ChartColorList({ settings }: { settings: ChartSettings }) {
  const series = settings.colors.series;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-fg-muted">Chart colors, up to {CHART_COLOR_LIMIT}</span>
      <div className="flex flex-wrap items-center gap-2">
        {series.map((color, index) => (
          <span key={color} className="flex items-center gap-1">
            <input
              type="color"
              aria-label={`Chart color ${index + 1}`}
              value={color}
              onChange={(event) => replaceChartColor(settings, index, event.target.value)}
              className="h-8 w-10 cursor-pointer rounded border border-hairline bg-canvas p-0.5"
            />
            <button
              type="button"
              aria-label={`Remove chart color ${index + 1}`}
              onClick={() =>
                writeColors(settings, {
                  ...settings.colors,
                  series: series.filter((_, itemIndex) => itemIndex !== index),
                })
              }
              className="text-xs font-medium text-fg-muted hover:text-fg"
            >
              Remove
            </button>
          </span>
        ))}
      </div>
      {series.length < CHART_COLOR_LIMIT && (
        <button
          type="button"
          onClick={() => writeColors(settings, { ...settings.colors, series: [...series, nextChartColor(series)] })}
          className="self-start text-xs font-medium text-fg-muted hover:text-fg"
        >
          Add chart color
        </button>
      )}
    </div>
  );
}

/** The chart defaults, opened from the profile menu. */
export function ChartSettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useSyncExternalStore(subscribeChartSettings, readChartSettings, () => DEFAULT_CHART_SETTINGS);
  const theme = chartTheme(useEffectiveTheme());
  const categories = chartCategories();
  const [typeId, setTypeId] = useState(categories[0]?.id ?? "line");
  const category = categories.find((item) => item.id === typeId) ?? categories[0];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-6">
      <button
        type="button"
        aria-label="Dismiss chart settings"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <dialog
        open
        aria-label="Chart settings"
        className="relative m-0 mt-16 flex max-h-[min(40rem,calc(100dvh-6rem))] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-xl border border-hairline bg-raised p-4 text-fg"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Chart settings</h2>
          <button type="button" onClick={onClose} className="text-xs font-medium text-fg-muted hover:text-fg">
            Close
          </button>
        </div>
        <p className="text-sm text-fg-muted">
          Saved in this browser. A new chart starts from these choices, including its background, font color, and up to
          eight chart colors. Chart code you edit still wins.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-fg-muted">
            Font
            <select
              aria-label="Font"
              value={settings.text.fontFamily}
              onChange={(event) => writeText(settings, { fontFamily: event.target.value })}
              className="rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm text-fg"
            >
              {CHART_FONTS.map((font) => (
                <option key={font.id} value={font.id}>
                  {font.label}
                </option>
              ))}
            </select>
          </label>
          <SizeField
            label="Title size"
            value={settings.text.titleFontSize}
            onChange={(titleFontSize) => writeText(settings, { titleFontSize })}
          />
          <SizeField
            label="Axis label size"
            value={settings.text.axisFontSize}
            onChange={(axisFontSize) => writeText(settings, { axisFontSize })}
          />
          <SizeField
            label="Label size"
            value={settings.text.labelFontSize}
            onChange={(labelFontSize) => writeText(settings, { labelFontSize })}
          />
        </div>
        <Choice label="Legend" checked={settings.text.legend} onChange={(legend) => writeText(settings, { legend })} />
        <ColorField
          label="Background"
          pickerLabel="Background color"
          value={settings.colors.background}
          fallback={theme.exportBackground}
          onChange={(background) => writeColors(settings, { ...settings.colors, background })}
        />
        <ColorField
          label="Font color"
          pickerLabel="Font color value"
          value={settings.colors.font}
          fallback={theme.ink}
          onChange={(font) => writeColors(settings, { ...settings.colors, font })}
        />
        <ChartColorList settings={settings} />
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Chart
          <select
            aria-label="Chart"
            value={category?.id ?? ""}
            onChange={(event) => setTypeId(event.target.value)}
            className="rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm text-fg"
          >
            {categories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="sr-only">{category?.label ?? "Chart"} options</legend>
          {(category?.controls ?? []).map((control) => (
            <Choice
              key={control.id}
              label={control.label}
              checked={category !== undefined && settings.types[category.id]?.[control.id] === true}
              onChange={(checked) => {
                if (category === undefined) return;
                const current = settings.types[category.id] ?? {};
                writeChartSettings(
                  normalizeChartSettings({
                    ...settings,
                    types: { ...settings.types, [category.id]: { ...current, [control.id]: checked } },
                  }),
                );
              }}
            />
          ))}
        </fieldset>
        <button
          type="button"
          onClick={() => writeChartSettings(DEFAULT_CHART_SETTINGS)}
          className="self-start text-xs font-medium text-fg-muted hover:text-fg"
        >
          Reset
        </button>
      </dialog>
    </div>
  );
}
