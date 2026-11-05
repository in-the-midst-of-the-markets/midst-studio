"use client";

import React, { useMemo } from "react";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import type { MaskingConfig } from "@/lib/data-masking";
import type { AgentArtifactHydration } from "@/components/agent/hydration";
import type { CellChange } from "@/components/ResultsGrid";
import { ResultsGrid } from "@/components/ResultsGrid";
import { QueryHistory } from "@/components/QueryHistory";
import { SavedQueries } from "@/components/SavedQueries";
import { ChunkBoundary, ViewLoading } from "@/components/LazyView";
import { lazyRetry } from "@/lib/lazy";

import { resolveExplainPlan } from "@/lib/explain";
import { hasGraphValues } from "@/lib/db/graph/result-graph";
import { cn } from "@/lib/utils";
import {
  ChartColumn,
  Bookmark,
  Clock,
  Columns3,
  FileText,
  GitCompare,
  LayoutGrid,
  Network,
  Terminal,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";

export type BottomPanelMode =
  | "results"
  | "graph"
  | "explain"
  | "history"
  | "saved"
  | "charts"
  | "pivot"
  | "docs"
  | "schemadiff";

/*
  The panel's heavy views, split out of the first load.

  Each one is already gated on `mode`, so only one of them can be on screen and most
  sessions never open the others — but a static import puts every one of them, and the
  libraries they pull in, into the bundle that has to arrive before the editor can be
  typed in. `QueryChart` brings ECharts; `VisualExplain` and `SchemaDiff` bring
  their own trees.

  `React.lazy` rather than `next/dynamic`: this file is reached from BOTH shells, and
  the embeddable one (`src/workspace/StudioWorkspace.tsx`) deliberately imports nothing
  from `next` — a `next/dynamic` here would put the framework into the published
  package's module graph. Next's bundler splits on the dynamic `import()` either way.

  Not split: `ResultsGrid` is the default view and would only trade a chunk for a
  flash, and `QueryHistory`/`SavedQueries` are small and pull in nothing heavy.

  Each loader is wrapped in `lazyRetry`, and the whole switch sits in a
  `ChunkBoundary`: a view that is no longer in the first load is a request that can
  fail, and this product runs where those fail — behind proxies, air-gapped, and
  across an upgrade that renames every chunk under an open tab.
*/
const PivotTable = React.lazy(
  lazyRetry(() => import("@/components/PivotTable").then((m) => ({ default: m.PivotTable }))),
);
const DatabaseDocs = React.lazy(
  lazyRetry(() => import("@/components/DatabaseDocs").then((m) => ({ default: m.DatabaseDocs }))),
);
const VisualExplain = React.lazy(
  lazyRetry(() => import("@/components/VisualExplain").then((m) => ({ default: m.VisualExplain }))),
);
const QueryChart = React.lazy(
  lazyRetry(() => import("@/components/charts/QueryChart").then((m) => ({ default: m.QueryChart }))),
);
const SchemaDiff = React.lazy(
  lazyRetry(() => import("@/components/SchemaDiff").then((m) => ({ default: m.SchemaDiff }))),
);
// The canvas library itself is a further dynamic import inside the view, so this
// chunk is the view's own code and the library arrives only once the tab is opened.
const GraphView = React.lazy(
  lazyRetry(() => import("@/components/results-graph/GraphView").then((m) => ({ default: m.GraphView }))),
);

interface BottomPanelProps {
  mode: BottomPanelMode;
  onSetMode: (mode: BottomPanelMode) => void;
  // What the panel draws of the tab, and nothing else (X5). The panel used to be handed
  // the whole `QueryTab`, whose identity changes on every keystroke because
  // `onContentChange` rewrites the query into the tab; these are the fields it reads.
  result: QueryResult | null;
  explainPlan: unknown;
  // The statement the explain view pairs with its plan. The shells hand it only while that
  // view is open: anywhere else it would be a prop that changes on every keystroke and
  // re-renders this memoized panel for a view that is not on screen (X5).
  explainQuery?: string;
  resultQuery: string | undefined;
  runError: string | undefined;
  schema: readonly DetailedObject[];
  schemaContext: string;
  activeConnection: DatabaseConnection | null;
  metadata: ProviderMetadata | null;
  historyKey: number;
  savedKey: number;
  // Masking
  maskingEnabled: boolean;
  onToggleMasking: (() => void) | undefined;
  userRole: string | undefined;
  maskingConfig: MaskingConfig;
  // Editing
  editingEnabled: boolean;
  pendingChanges: CellChange[];
  onCellChange: (change: CellChange) => void;
  onApplyChanges: () => void;
  onDiscardChanges: () => void;
  // Actions
  onLoadQuery: (query: string) => void;
  /** The editor statement while Charts is open, so its placeholders can be changed there. */
  chartQuery?: string;
  onChartFilter?: (sql: string) => void;
  onLoadMore: (() => void) | undefined;
  isLoadingMore: boolean | undefined;
  /**
   * A result an agent run stored, shown in the surface that already renders that
   * kind of result (#329 T11). Optional so every other caller — the embedded shell
   * included — is unchanged, and null whenever nothing is hydrated.
   */
  agentArtifact?: AgentArtifactHydration | null;
  onDismissAgentArtifact?: () => void;
}

export const BottomPanel = React.memo(function BottomPanel({
  mode: requestedMode,
  onSetMode,
  result,
  explainPlan,
  explainQuery,
  resultQuery,
  runError,
  schema,
  schemaContext,
  activeConnection,
  metadata,
  historyKey,
  savedKey,
  maskingEnabled,
  onToggleMasking,
  userRole,
  maskingConfig,
  editingEnabled,
  pendingChanges,
  onCellChange,
  onApplyChanges,
  onDiscardChanges,
  onLoadQuery,
  chartQuery,
  onChartFilter,
  onLoadMore,
  isLoadingMore,
  agentArtifact = null,
  onDismissAgentArtifact,
}: BottomPanelProps) {
  const explainInput = useMemo(() => resolveExplainPlan(explainPlan), [explainPlan]);
  /*
    The Graph tab is offered by the result's shape, not by the engine: only a result
    that holds a node, a relationship or a path at any depth has anything to draw.
    The mode is shell state and outlives the result it was chosen for (switching to a
    tab whose result has none keeps it), so it is read as Results until a graph is
    back, rather than leaving the panel on a tab the strip no longer shows.
  */
  const offersGraph = useMemo(() => hasGraphValues(result?.rows ?? [], result?.fields ?? []), [result]);
  const mode = requestedMode === "graph" && !offersGraph ? "results" : requestedMode;

  /*
    An agent artifact is shown in ONE surface — the one the RUN's own record names,
    which is its operation for a read or a plan and its composed answer for a chart —
    and the tab's own state is never overwritten to do it. So the grid, the explain
    view and the charts view each ask whether this artifact is theirs, every other
    view keeps showing the tab's own result, and dismissing the artifact restores the
    tab with nothing to undo.

    While one is shown the view is read-only: inline editing writes rows back through
    the tab's connection and pagination continues the tab's own query, so neither
    means anything for a stored result.
  */
  const hydratedResult = agentArtifact?.surface === "results" ? agentArtifact.result : null;
  const hydratedPlan = useMemo(
    () => (agentArtifact?.surface === "explain" ? resolveExplainPlan(agentArtifact.explainPlan) : null),
    [agentArtifact],
  );
  /*
    The run's own rows, drawn as the run said to draw them. `QueryChart` keeps a
    specification whose columns are in this result and ignores one that is not, so a
    chart here is never a picture of columns these rows do not have.
  */
  const hydratedChart = agentArtifact?.surface === "charts" ? agentArtifact.result : null;
  /** Null unless the run's own rows are what the charts view is showing. */
  const hydratedChartSpec = hydratedChart === null ? null : (agentArtifact?.chartSpec ?? null);
  const hydratedHere =
    agentArtifact !== null &&
    ((mode === "results" && hydratedResult !== null) ||
      (mode === "explain" && hydratedPlan !== null) ||
      (mode === "charts" && hydratedChart !== null));
  const displayedResult = hydratedResult ?? result;

  const tabs: { key: BottomPanelMode; label: string; icon: React.ReactNode; activeClass: string }[] = [
    {
      key: "results",
      label: "Results",
      icon: <LayoutGrid strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-brand border-brand-tint bg-fill",
    },
    {
      key: "graph",
      label: "Graph",
      icon: <Network strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-hue-green border-hue-green-tint bg-fill",
    },
    {
      key: "explain",
      label: "Explain",
      icon: <Zap strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-hue-amber border-hue-amber-tint bg-fill",
    },
    {
      key: "history",
      label: "History",
      icon: <Clock strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-hue-emerald border-hue-emerald-tint bg-fill",
    },
    {
      key: "saved",
      label: "Saved",
      icon: <Bookmark strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-hue-purple border-hue-purple-tint bg-fill",
    },
    {
      key: "charts",
      label: "Charts",
      icon: <ChartColumn strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-hue-cyan border-hue-cyan-tint bg-fill",
    },
    {
      key: "pivot",
      label: "Pivot",
      icon: <Columns3 strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-hue-orange border-hue-orange-tint bg-fill",
    },
    {
      key: "docs",
      label: "Docs",
      icon: <FileText strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-hue-teal border-hue-teal-tint bg-fill",
    },
    {
      key: "schemadiff",
      label: "Diff",
      icon: <GitCompare strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-hue-rose border-hue-rose-tint bg-fill",
    },
  ];

  const explainTabs = metadata?.capabilities.explainFormat ? tabs : tabs.filter((tab) => tab.key !== "explain");
  // The Graph tab is offered only for a result that holds a graph value (U72); every other tab is unaffected.
  const visibleTabs = offersGraph ? explainTabs : explainTabs.filter((tab) => tab.key !== "graph");

  return (
    /*
      A container, not the viewport: everything in this header is sized against the
      PANEL's width, and the panel loses width to things the viewport knows nothing
      about — the agent rail opening, the sidebar staying open, a narrowed window.
    */
    <div className="h-full flex flex-col bg-sunken @container/panel">
      <div className="h-9 bg-surface border-b border-hairline flex items-center justify-between gap-2 px-2">
        {/*
          The tab strip is the part that yields. It scrolls (without a visible bar in
          a 36px-tall row) rather than pushing the row count out of the header.
        */}
        <div className="flex items-center h-full gap-1 min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {visibleTabs.map((tab) => (
            <button
              key={tab.key}
              data-testid={tab.key === "explain" ? "bottom-panel-tab-explain" : undefined}
              onClick={() => onSetMode(tab.key)}
              className={cn(
                "h-full px-3 text-xs font-medium transition-all border-b-2 flex items-center gap-2",
                mode === tab.key ? tab.activeClass : "text-fg-muted border-transparent hover:text-fg-secondary",
              )}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {displayedResult && mode === "results" && (
          <span className="hidden @4xl/panel:inline shrink-0 text-xs font-mono text-fg-muted">
            {displayedResult.rowCount} rows • {displayedResult.executionTime}ms
          </span>
        )}
      </div>

      {/*
        Provenance, stated where the rows are read rather than only in the rail: these
        rows were produced by a run, not by the statement in the editor above them.
      */}
      {hydratedHere && agentArtifact !== null && (
        <div
          data-testid="agent-provenance"
          className="flex items-center justify-between gap-2 px-3 py-1 border-b border-brand-tint/20 bg-brand-tint/5"
        >
          <span className="text-xs text-brand">
            Stored by agent run <span className="font-mono text-[0.625rem]">{agentArtifact.runId}</span> via{" "}
            <span className="font-mono text-[0.625rem]">{agentArtifact.operationId}</span>{" "}
            {/* The audit correlation id: what joins these rows to the audit line for
                the statement that produced them. */}
            <span className="font-mono text-[0.625rem] text-fg-muted">{agentArtifact.correlationId}</span> — read-only
          </span>
          <button
            type="button"
            data-testid="agent-provenance-dismiss"
            onClick={onDismissAgentArtifact}
            className="p-1 rounded text-fg-tertiary hover:bg-fill hover:text-fg transition-colors"
            aria-label="Dismiss the agent result"
          >
            <X strokeWidth={1.5} className="w-3 h-3" />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-hidden relative">
        {/* One pair of boundaries for the whole switch: only one view is ever mounted,
            so the fallback is what the user sees while a split chunk is in flight and
            the error boundary is what they see when it never arrives or a view throws.
            The boundary outlives every result, mode and tab, so it is reset by what it
            shows: one result a view cannot draw must not fail every later one. The docs
            and diff views draw the schema and the connection, so those reset it too. */}
        <ChunkBoundary
          label="This view"
          resetKeys={[mode, result, agentArtifact, explainPlan, schema, activeConnection]}
        >
          <React.Suspense fallback={<ViewLoading label="Loading the panel" />}>
            {mode === "pivot" ? (
              <PivotTable
                result={result}
                maskingEnabled={maskingEnabled}
                userRole={userRole}
                maskingConfig={maskingConfig}
                maskingExemptColumns={metadata?.capabilities.maskingExemptColumns}
                onLoadQuery={(q) => {
                  onLoadQuery(q);
                  onSetMode("results");
                }}
                databaseType={activeConnection?.type}
                // Only where the engine says it reads SQL: on a JSON engine the generated statement
                // replaces the reader's own request with something that cannot run.
                offersGeneratedSql={
                  metadata?.capabilities.queryLanguage === undefined
                    ? undefined
                    : metadata.capabilities.queryLanguage === "sql"
                }
              />
            ) : mode === "docs" ? (
              <DatabaseDocs
                schema={schema}
                schemaContext={schemaContext}
                databaseType={activeConnection?.type}
                capabilities={metadata?.capabilities}
              />
            ) : mode === "history" ? (
              <QueryHistory
                refreshTrigger={historyKey}
                activeConnectionId={activeConnection?.id}
                onSelectQuery={(q) => {
                  onLoadQuery(q);
                  onSetMode("results");
                }}
              />
            ) : mode === "saved" ? (
              <SavedQueries
                refreshTrigger={savedKey}
                connectionType={activeConnection?.type}
                onSelectQuery={(q) => {
                  onLoadQuery(q);
                  onSetMode("results");
                }}
              />
            ) : mode === "charts" ? (
              <QueryChart
                result={hydratedChart ?? result}
                spec={hydratedChartSpec}
                query={chartQuery}
                connectionId={activeConnection?.id}
                onFilterChange={onChartFilter}
                maskingEnabled={maskingEnabled}
                userRole={userRole}
                maskingConfig={maskingConfig}
                maskingExemptColumns={metadata?.capabilities.maskingExemptColumns}
              />
            ) : mode === "graph" && result ? (
              <GraphView
                result={result}
                maskingEnabled={maskingEnabled}
                userRole={userRole}
                maskingConfig={maskingConfig}
              />
            ) : mode === "schemadiff" ? (
              <SchemaDiff schema={schema} connection={activeConnection} />
            ) : mode === "explain" ? (
              <VisualExplain
                plan={hydratedPlan ?? explainInput}
                /*
              A run's plan travels without the editor's statement. The AI analysis in
              this view posts the query and the plan together, so pairing a hydrated
              plan with whatever happens to be in the editor would ask for an
              explanation of a statement that never produced it; with no query the view
              says so itself instead.
            */
                query={hydratedPlan === null ? explainQuery : undefined}
                schemaContext={schemaContext}
                databaseType={activeConnection?.type}
                onLoadQuery={(q) => {
                  onLoadQuery(q);
                  onSetMode("results");
                }}
              />
            ) : displayedResult ? (
              <div className="h-full flex flex-col">
                {/*
                  A result AND a run error on the same tab is a script that stopped on a failing
                  statement (#1385): the earlier statements' rows stay, the failure stands above
                  them, and a grid with no rows is left out because its "The operation was
                  successful" would contradict the banner. A hydrated result is another run's.
                */}
                {runError !== undefined && !hydratedHere && (
                  <div
                    role="alert"
                    // The same token swap as the failure block below, for the same measurement: the
                    // text is the engine's own sentence and `--destructive` is a surface red.
                    className="shrink-0 px-3 py-2 border-b border-danger/30 bg-danger/10 text-danger"
                    data-testid="script-failure"
                  >
                    <p className="text-xs font-medium">The script stopped at a failing statement.</p>
                    <p
                      className="mt-1 break-words whitespace-pre-wrap font-mono text-xs"
                      data-testid="script-failure-message"
                    >
                      {runError}
                    </p>
                  </div>
                )}
                {(runError === undefined || hydratedHere || displayedResult.rows.length > 0) && (
                  <div className="flex-1 min-h-0">
                    <ResultsGrid
                      result={displayedResult}
                      onLoadMore={hydratedHere ? undefined : onLoadMore}
                      isLoadingMore={isLoadingMore}
                      supportsResultPagination={metadata?.capabilities.supportsResultPagination}
                      // The statement these ROWS came from, for the ordering notice. Withheld
                      // for a hydrated result for the same reason `onLoadMore` is: those rows
                      // are an agent run's, and the tab's own statement did not produce them.
                      resultQuery={hydratedHere ? undefined : resultQuery}
                      databaseType={activeConnection?.type}
                      maskingEnabled={maskingEnabled}
                      onToggleMasking={onToggleMasking}
                      userRole={userRole}
                      maskingConfig={maskingConfig}
                      editingEnabled={hydratedHere ? false : editingEnabled}
                      inlineEditRefusedColumns={metadata?.capabilities.inlineEditRefusedColumns}
                      maskingExemptColumns={metadata?.capabilities.maskingExemptColumns}
                      pendingChanges={pendingChanges}
                      onCellChange={onCellChange}
                      onApplyChanges={onApplyChanges}
                      onDiscardChanges={onDiscardChanges}
                    />
                  </div>
                )}
              </div>
            ) : runError !== undefined ? (
              /*
                The tab's last run failed, and its failure stands where its rows would.
                After the grid, so a hydrated result keeps its precedence, and before the
                empty state, which would read as "nothing ran". Rendered here rather than
                left to the toast: the embedded shell mounts no Toaster, so in that product
                this block is the only failure signal there is.
              */
              <div
                role="alert"
                className="h-full flex flex-col items-center justify-center px-3 text-center bg-surface"
                data-testid="run-failure"
              >
                {/*
                  `danger` RATHER THAN `destructive`, and that is a contrast measurement, not taste:
                  in the dark theme `--destructive` is `#7f1d1d`, a SURFACE red, and this block drew
                  the whole failure in it at 1.98:1 against the panel - the engine's own sentence,
                  which is the only thing a reader has when a query is refused, was effectively
                  unreadable. `--studio-danger` is the foreground red the rest of the product uses
                  for the same job (#ff6467 in dark, 6.85:1 here; #9f0712 in light). Measured in a
                  browser on an OPC UA refusal, which is the engine whose request shape is stated
                  nowhere else.
                */}
                <TriangleAlert aria-hidden="true" strokeWidth={1.5} className="mb-2 h-8 w-8 text-danger opacity-50" />
                <p className="text-xs font-medium text-danger">The query failed.</p>
                {/*
                  Left-aligned inside the centred block: an engine's message can span lines with a caret under
                  the failing name, and centring each line on its own moves the caret off its column.
                */}
                <p
                  className="mt-1 max-w-xl break-words whitespace-pre-wrap text-left font-mono text-xs text-danger"
                  data-testid="run-failure-message"
                >
                  {runError}
                </p>
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center opacity-20 bg-surface">
                <Terminal strokeWidth={1.5} className="w-12 h-12 mb-4" />
                <p className="text-xs font-medium">Execute a query or check history</p>
                <p className="text-xs mt-2">Ready to query</p>
              </div>
            )}
          </React.Suspense>
        </ChunkBoundary>
      </div>
    </div>
  );
});
