"use client";

import { useState, type ReactElement } from "react";
import { ArrowRight, Database, Eye, EyeOff, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { appFetch, withBasePath } from "@/lib/config/base-path";
import { dashboardName, freshDashboard, withChart } from "@/lib/dashboards/dashboard";
import { newLocalId } from "@/lib/ids";
import { storage } from "@/lib/storage";
import type { OpenedDbtProject, OpenedModel } from "@/lib/dbt/open";
import type { ProjectMetric } from "@/lib/metricflow/metrics";
import type { SavedChartConfig } from "@/lib/types";

function currentTime(): Date {
  return new Date();
}

function GithubMark({ className = "size-4" }: { className?: string }): ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={className} fill="currentColor">
      <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.22.48-2.69-1.07-2.69-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.77-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
    </svg>
  );
}

/**
 * Opens a dbt project from GitHub, saves a model as a query, and places a MetricFlow
 * metric on the active dashboard.
 */
export default function DbtProjectPanel() {
  const [repo, setRepo] = useState("");
  const [directory, setDirectory] = useState("");
  const [ref, setRef] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [connectionId, setConnectionId] = useState("");
  const [project, setProject] = useState<OpenedDbtProject | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [compiled, setCompiled] = useState<Record<string, string> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connections = storage.getConnections();
  const connection = connections.find((item) => item.id === connectionId) ?? null;
  const model = project?.models.find((item) => item.name === selected) ?? null;

  async function openProject(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    setCompiled(null);
    try {
      const response = await appFetch("/api/dbt/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, directory, ref, token, ...(connectionId !== "" ? { connectionId } : {}) }),
      });
      const body = (await response.json()) as OpenedDbtProject | { error?: string };
      if (!response.ok || !("models" in body)) {
        setProject(null);
        setError("error" in body && typeof body.error === "string" ? body.error : "The project could not be opened.");
        return;
      }
      setProject(body);
      setSelected(body.models[0]?.name ?? null);
    } catch {
      setError("The project could not be opened.");
    } finally {
      setBusy(false);
    }
  }

  function saveModel(current: OpenedModel): void {
    if (connection === null) return;
    const now = currentTime();
    storage.saveQuery({
      id: newLocalId(),
      name: current.name,
      query: current.preview,
      connectionType: connection.type,
      connectionId: connection.id,
      createdAt: now,
      updatedAt: now,
    });
    setNotice("saved");
  }

  function chartMetric(metric: ProjectMetric): void {
    if (connection === null || metric.sql === null) return;
    const chart: SavedChartConfig = {
      id: newLocalId(),
      name: metric.label,
      chartType: metric.timeDimension === null ? "bar" : "line",
      xAxis: metric.timeDimension ?? "bucket",
      yAxis: [metric.name],
      query: metric.sql,
      connectionId: connection.id,
      metricName: metric.name,
      createdAt: currentTime(),
    };
    storage.saveChart(chart);
    const dashboards = storage.getSavedDashboards();
    const active = dashboards.find((item) => item.id === storage.getActiveDashboardId()) ?? dashboards[0];
    const dashboard = withChart(active ?? freshDashboard(dashboardName(dashboards)), chart.id, 1200);
    storage.saveDashboard(dashboard);
    storage.setActiveDashboardId(dashboard.id);
    setNotice(`chart:${chart.id}`);
  }

  async function compileModel(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await appFetch("/api/dbt/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, directory, ref, token, connectionId }),
      });
      const body = (await response.json()) as { files?: Record<string, string>; error?: string };
      if (!response.ok || body.files === undefined) {
        setError(typeof body.error === "string" ? body.error : "dbt compile failed.");
        return;
      }
      setCompiled(body.files);
    } catch {
      setError("dbt compile failed.");
    } finally {
      setBusy(false);
    }
  }

  const fieldClass = "h-10 rounded-lg border-hairline-strong bg-raised px-3 text-sm";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-fg-muted">Models / Connect project</p>
        <h1 className="text-3xl font-semibold tracking-tight">dbt project on GitHub</h1>
        <p className="max-w-2xl text-sm text-fg-muted">
          Bring your dbt models into KnowSQL. Link your repository, then choose the warehouse they run on.
        </p>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <form
          className="overflow-hidden rounded-2xl border border-hairline bg-raised shadow-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void openProject();
          }}
        >
          <section className="flex flex-col gap-5 p-6">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-tint/15 text-brand">
                <GithubMark />
              </span>
              <div>
                <h2 className="text-base font-medium">GitHub project</h2>
                <p className="text-sm text-fg-muted">
                  Where your dbt project lives. KnowSQL reads your models from here.
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="dbt-repo" className="text-sm font-medium">
                GitHub repository
              </label>
              <Input
                id="dbt-repo"
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="owner/repo"
                className={fieldClass}
              />
              <p className="text-xs text-fg-muted">Enter the repository owner and name, separated by a slash.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="dbt-directory" className="text-sm font-medium">
                    Directory
                  </label>
                  <span className="text-xs text-fg-muted">Optional</span>
                </div>
                <Input
                  id="dbt-directory"
                  value={directory}
                  onChange={(event) => setDirectory(event.target.value)}
                  placeholder="folder in the repo, or blank for the root"
                  className={fieldClass}
                />
                <p className="text-xs text-fg-muted">Path to the folder containing dbt_project.yml.</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="dbt-branch" className="text-sm font-medium">
                  Branch
                </label>
                <Input
                  id="dbt-branch"
                  value={ref}
                  onChange={(event) => setRef(event.target.value)}
                  placeholder="default branch"
                  className={fieldClass}
                />
                <p className="text-xs text-fg-muted">The branch to read from GitHub.</p>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="dbt-token" className="text-sm font-medium">
                  GitHub token
                </label>
                {!showToken && <span className="text-xs text-fg-muted">Masked</span>}
              </div>
              <div className="relative">
                <Input
                  id="dbt-token"
                  type={showToken ? "text" : "password"}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="blank for a public repository"
                  autoComplete="off"
                  className={`${fieldClass} pr-10`}
                />
                <button
                  type="button"
                  aria-label={showToken ? "Hide token" : "Show token"}
                  onClick={() => setShowToken((current) => !current)}
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-fg-muted hover:text-fg"
                >
                  {showToken ? (
                    <EyeOff aria-hidden="true" className="size-4" />
                  ) : (
                    <Eye aria-hidden="true" className="size-4" />
                  )}
                </button>
              </div>
              <p className="text-xs text-fg-muted">Use a token with read access to this repository.</p>
            </div>
          </section>
          <section className="flex flex-col gap-5 border-t border-hairline p-6">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-tint/15 text-brand">
                <Database aria-hidden="true" className="size-4" strokeWidth={1.75} />
              </span>
              <div>
                <h2 className="text-base font-medium">Warehouse connection</h2>
                <p className="text-sm text-fg-muted">
                  Where your dbt models run. This is separate from your GitHub repository.
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="dbt-connection" className="text-sm font-medium">
                Warehouse connection
              </label>
              <select
                id="dbt-connection"
                className={`${fieldClass} w-full`}
                value={connectionId}
                onChange={(event) => setConnectionId(event.target.value)}
              >
                <option value="">Choose a warehouse</option>
                {connections.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-fg-muted">Select an existing connection for this project.</p>
            </div>
          </section>
          <div className="flex flex-col gap-3 border-t border-hairline px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-fg-muted">Add a repository and choose a warehouse to continue.</p>
            <Button
              type="submit"
              disabled={busy || repo.trim() === ""}
              className="h-10 rounded-lg bg-brand-solid px-4 text-white hover:bg-brand-solid-hover"
            >
              Open dbt project
              <ArrowRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </form>
        <aside className="flex flex-col gap-5 rounded-2xl border border-hairline bg-raised p-6 shadow-sm">
          <div>
            <h2 className="text-base font-medium">Code here. Data there.</h2>
            <p className="mt-1 text-sm text-fg-muted">
              Your repository and warehouse have different roles in your dbt project.
            </p>
          </div>
          <div className="flex flex-col gap-4 border-t border-hairline pt-4">
            <div className="flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint/15 text-brand">
                <GithubMark className="size-3.5" />
              </span>
              <div>
                <p className="text-[11px] font-medium tracking-wide text-fg-muted">PROJECT SOURCE</p>
                <p className="text-sm font-medium">GitHub repository</p>
                <p className="text-sm text-fg-muted">Stores your dbt project, model definitions, and configuration.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint/15 text-brand">
                <Database aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
              </span>
              <div>
                <p className="text-[11px] font-medium tracking-wide text-fg-muted">EXECUTION ENVIRONMENT</p>
                <p className="text-sm font-medium">Your warehouse</p>
                <p className="text-sm text-fg-muted">Holds the data your models query and transform.</p>
              </div>
            </div>
          </div>
          <div className="border-t border-hairline pt-4">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Info aria-hidden="true" className="size-3.5 text-fg-muted" />
              Before you open
            </p>
            <p className="mt-1 text-sm text-fg-muted">
              Have your repository path, a GitHub token, and an existing warehouse connection ready.
            </p>
            <a
              className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand"
              href="https://docs.getdbt.com/docs/core/connect-data-platform/profiles.yml"
              target="_blank"
              rel="noreferrer"
            >
              dbt connection guide
              <ArrowRight aria-hidden="true" className="size-3.5" />
            </a>
          </div>
        </aside>
      </div>

      {error !== null && <p className="text-sm text-destructive">{error}</p>}

      {project !== null && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">
            {project.name} <span className="text-sm font-normal text-fg-muted">{project.ref}</span>
          </h2>
          {project.profile.ready ? null : <p className="text-sm text-fg-muted">{project.profile.reason}</p>}
          <ul className="flex flex-col gap-1">
            {project.models.map((item) => (
              <li key={item.name}>
                <button type="button" className="text-left text-sm underline" onClick={() => setSelected(item.name)}>
                  {item.name}
                </button>
                {item.refs.length > 0 && (
                  <span className="ml-2 text-xs text-fg-muted">refs {item.refs.join(", ")}</span>
                )}
              </li>
            ))}
          </ul>
          {model !== null && (
            <div className="flex flex-col gap-2">
              <pre className="overflow-auto rounded-md border border-hairline bg-surface p-3 text-xs">
                {model.preview}
              </pre>
              {model.unresolved && (
                <p className="text-xs text-fg-muted">Compile with dbt to expand the rest of this model.</p>
              )}
              <div className="flex gap-2">
                <Button type="button" variant="outline" disabled={connection === null} onClick={() => saveModel(model)}>
                  Save query
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || connection === null || !project.profile.ready}
                  onClick={() => void compileModel()}
                >
                  Compile with dbt
                </Button>
              </div>
              {notice === "saved" && (
                <a className="text-sm underline" href={withBasePath("/")}>
                  Open the IDE
                </a>
              )}
            </div>
          )}
          {compiled !== null && (
            <pre className="overflow-auto rounded-md border border-hairline bg-surface p-3 text-xs">
              {Object.entries(compiled)
                .map(([path, sql]) => `-- ${path}\n${sql}`)
                .join("\n")}
            </pre>
          )}
          <ul className="flex flex-col gap-2">
            {project.metrics.map((metric) => (
              <li key={metric.name} className="flex items-center justify-between gap-3 text-sm">
                <span>{metric.label}</span>
                {metric.sql === null ? (
                  <span className="text-fg-muted">{metric.reason}</span>
                ) : (
                  <Button type="button" disabled={connection === null} onClick={() => chartMetric(metric)}>
                    Chart this metric
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {notice?.startsWith("chart:") === true && (
            <a className="text-sm underline" href={withBasePath("/create")}>
              Open the dashboard
            </a>
          )}
        </section>
      )}
    </div>
  );
}
