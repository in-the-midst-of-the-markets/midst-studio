"use client";

import { useState } from "react";
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

/**
 * Opens a dbt project from GitHub, saves a model as a query, and places a MetricFlow
 * metric on the active dashboard.
 */
export default function DbtProjectPanel() {
  const [repo, setRepo] = useState("");
  const [directory, setDirectory] = useState("");
  const [ref, setRef] = useState("");
  const [token, setToken] = useState("");
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

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium">dbt project on GitHub</h2>
        <p className="max-w-2xl text-sm text-fg-muted">
          Both. GitHub stores the dbt project. Repository, directory, branch, and token read it from there. The
          connection is the warehouse those models run on.
        </p>
      </div>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void openProject();
        }}
      >
        <label className="flex flex-col gap-1 text-sm sm:col-span-2" htmlFor="dbt-repo">
          GitHub repository
          <Input
            id="dbt-repo"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="owner/repo"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm" htmlFor="dbt-directory">
          Directory
          <Input
            id="dbt-directory"
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder="folder in the repo, or blank for the root"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm" htmlFor="dbt-branch">
          Branch
          <Input
            id="dbt-branch"
            value={ref}
            onChange={(event) => setRef(event.target.value)}
            placeholder="default branch"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm" htmlFor="dbt-token">
          GitHub token
          <Input
            id="dbt-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="blank for a public repository"
            autoComplete="off"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm" htmlFor="dbt-connection">
          Warehouse connection
          <select
            id="dbt-connection"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
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
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy || repo.trim() === ""}>
            Open dbt project
          </Button>
        </div>
      </form>

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
