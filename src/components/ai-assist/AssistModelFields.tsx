"use client";

import { rankAssistModels, type AssistRankings } from "@/lib/ai/assist-model-rank";
import { COMMON_OPENROUTER_MODELS, type AssistModelOption, type AssistSettings } from "@/lib/ai/assist-settings";

/**
 * The model control shared by every chat. The API keys live under Connectors.
 * The choice is the browser's last selection, whichever page set it.
 */
export function AssistModelFields({
  settings,
  models,
  gatewayModels,
  modelStatus,
  gatewayStatus,
  rankings = null,
  onChange,
}: {
  settings: AssistSettings;
  models: readonly AssistModelOption[];
  gatewayModels: readonly AssistModelOption[];
  modelStatus: "loading" | "ready" | "failed";
  gatewayStatus: "loading" | "ready" | "failed";
  rankings?: AssistRankings | null;
  onChange: (patch: Partial<AssistSettings>) => void;
}) {
  const catalog = modelStatus === "ready" && models.length > 0 ? models : COMMON_OPENROUTER_MODELS;
  const modelOptions = catalog.some((item) => item.id === settings.openRouterModel)
    ? catalog
    : [{ id: settings.openRouterModel, name: settings.openRouterModel }, ...catalog];
  const ranked = rankAssistModels(modelOptions, rankings);

  if (settings.source === "fireworks") {
    return (
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Fine-tuned model
        <input
          aria-label="Fireworks model"
          value={settings.fireworksModel}
          placeholder="accounts/your-account/models/your-model"
          onChange={(event) => onChange({ fireworksModel: event.target.value })}
          className="rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm text-fg"
        />
      </label>
    );
  }

  if (settings.source === "gateway") {
    return (
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Model
          <input
            aria-label="Vercel AI Gateway model"
            list="vercel-gateway-models"
            value={settings.gatewayModel}
            placeholder="provider/model"
            onChange={(event) => onChange({ gatewayModel: event.target.value })}
            className="rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm text-fg"
          />
          <datalist id="vercel-gateway-models">
            {gatewayModels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </datalist>
        </label>
        {gatewayStatus === "failed" && (
          <output className="block text-xs text-fg-muted">The Vercel AI Gateway catalog could not be loaded.</output>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Model
        <select
          aria-label="OpenRouter model"
          value={settings.openRouterModel}
          onChange={(event) => onChange({ openRouterModel: event.target.value })}
          className="rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm text-fg"
        >
          {ranked.groups === null
            ? modelOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))
            : ranked.groups.map((group) => (
                <optgroup key={group.category} label={group.label}>
                  {group.models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </optgroup>
              ))}
        </select>
      </label>
      {ranked.citation !== null && <p className="text-xs text-fg-muted">{ranked.citation}</p>}
      {modelStatus === "failed" && (
        <output className="block text-xs text-fg-muted">The OpenRouter catalog could not be loaded.</output>
      )}
    </div>
  );
}
