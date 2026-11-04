"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, Cpu, Landmark, SlidersHorizontal } from "lucide-react";
import { ASSIST_RANK_ALL, rankAssistModels, rankingDomains, type AssistRankings } from "@/lib/ai/assist-model-rank";
import { COMMON_OPENROUTER_MODELS, type AssistModelOption, type AssistSettings } from "@/lib/ai/assist-settings";

const FIELD_CLASS = "w-full rounded-lg border border-hairline bg-control py-2.5 pl-10 text-sm text-fg";
const INPUT_CLASS = `${FIELD_CLASS} pr-3`;
const SELECT_CLASS = `${FIELD_CLASS} appearance-none pr-9`;

/**
 * The model control shared by every chat. The API keys live under Connectors.
 * The choice is the browser's last selection, whichever page set it.
 * OpenRouter models can be ordered by a domain the person picks. All is overall use.
 * The header opens and closes the fields. The chat starts with them closed.
 */
export function AssistModelFields({
  settings,
  models,
  gatewayModels,
  modelStatus,
  gatewayStatus,
  rankings = null,
  open,
  onToggle,
  accessory,
  onChange,
}: {
  settings: AssistSettings;
  models: readonly AssistModelOption[];
  gatewayModels: readonly AssistModelOption[];
  modelStatus: "loading" | "ready" | "failed";
  gatewayStatus: "loading" | "ready" | "failed";
  rankings?: AssistRankings | null;
  open: boolean;
  onToggle: () => void;
  /** A control that sits on the configuration header, such as the history limit. */
  accessory?: ReactNode;
  onChange: (patch: Partial<AssistSettings>) => void;
}) {
  const [domain, setDomain] = useState(ASSIST_RANK_ALL);
  const catalog = modelStatus === "ready" && models.length > 0 ? models : COMMON_OPENROUTER_MODELS;
  const modelOptions = catalog.some((item) => item.id === settings.openRouterModel)
    ? catalog
    : [{ id: settings.openRouterModel, name: settings.openRouterModel }, ...catalog];
  const domains = rankingDomains(rankings);
  const activeDomain = domains.some((item) => item.id === domain) ? domain : ASSIST_RANK_ALL;
  const ranked = rankAssistModels(modelOptions, rankings, activeDomain);

  let fields: ReactNode;
  if (settings.source === "fireworks") {
    fields = (
      <FieldShell label="Fine-tuned model" icon={<Cpu className="size-4" aria-hidden="true" />}>
        <input
          aria-label="Fireworks model"
          value={settings.fireworksModel}
          placeholder="accounts/your-account/models/your-model"
          onChange={(event) => onChange({ fireworksModel: event.target.value })}
          className={INPUT_CLASS}
        />
      </FieldShell>
    );
  } else if (settings.source === "gateway") {
    fields = (
      <div className="flex flex-col gap-1.5">
        <FieldShell label="Model" icon={<Cpu className="size-4" aria-hidden="true" />}>
          <input
            aria-label="Vercel AI Gateway model"
            list="vercel-gateway-models"
            value={settings.gatewayModel}
            placeholder="provider/model"
            onChange={(event) => onChange({ gatewayModel: event.target.value })}
            className={INPUT_CLASS}
          />
          <datalist id="vercel-gateway-models">
            {gatewayModels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </datalist>
        </FieldShell>
        {gatewayStatus === "failed" && (
          <output className="block text-xs text-fg-muted">The Vercel AI Gateway catalog could not be loaded.</output>
        )}
      </div>
    );
  } else {
    fields = (
      <div className="flex flex-col gap-3">
        {domains.length > 0 && (
          <FieldShell label="Domain" icon={<Landmark className="size-4" aria-hidden="true" />} chevron>
            <select
              aria-label="Model domain"
              value={activeDomain}
              onChange={(event) => setDomain(event.target.value)}
              className={SELECT_CLASS}
            >
              <option value={ASSIST_RANK_ALL}>All</option>
              {domains.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </FieldShell>
        )}
        <FieldShell label="Model" icon={<Cpu className="size-4" aria-hidden="true" />} chevron>
          <select
            aria-label="OpenRouter model"
            value={settings.openRouterModel}
            onChange={(event) => onChange({ openRouterModel: event.target.value })}
            className={SELECT_CLASS}
          >
            {ranked.models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </FieldShell>
        {ranked.citation !== null && <p className="text-xs text-fg-muted">{ranked.citation}</p>}
        {modelStatus === "failed" && (
          <output className="block text-xs text-fg-muted">The OpenRouter catalog could not be loaded.</output>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-fg-muted hover:text-fg"
        >
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
          Model configuration
        </button>
        {accessory}
      </div>
      {open && fields}
    </div>
  );
}

function FieldShell({
  label,
  icon,
  chevron = false,
  children,
}: {
  label: string;
  icon: ReactNode;
  chevron?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
      {label}
      <span className="relative block">
        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-muted">{icon}</span>
        {children}
        {chevron && (
          <ChevronDown
            className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
        )}
      </span>
    </label>
  );
}
