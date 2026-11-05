import { dbtCompileProfile, dbtSchema } from "@/lib/dbt/profile";
import { previewModel, readDbtProject, sourceSchemas, type DbtSourceRef } from "@/lib/dbt/project";
import {
  parseGitDirectory,
  parseGitHubRepo,
  parseGitRef,
  parseGitToken,
  readGitHubProject,
  type GitHubFetch,
  type GitHubRepo,
} from "@/lib/git/github";
import { readMetrics, type ProjectMetric } from "@/lib/metricflow/metrics";
import type { DatabaseConnection } from "@/lib/types";

export interface DbtOpenRequest {
  readonly repo: GitHubRepo;
  readonly ref: string;
  readonly directory: string;
  readonly token: string;
  readonly connectionId: string | null;
}

export interface OpenedModel {
  readonly name: string;
  readonly path: string;
  readonly refs: readonly string[];
  readonly sources: readonly DbtSourceRef[];
  readonly sql: string;
  readonly preview: string;
  readonly unresolved: boolean;
}

export interface OpenedDbtProject {
  readonly name: string;
  readonly ref: string;
  readonly models: readonly OpenedModel[];
  readonly metrics: readonly ProjectMetric[];
  readonly profile: { ready: true } | { ready: false; reason: string };
}

/** The fields of a project or compile request. A problem is a sentence. */
export function readDbtRequest(body: Record<string, unknown>, requireConnection: boolean): DbtOpenRequest | string {
  const repoInput = body.repo;
  if (typeof repoInput !== "string") return "Enter a GitHub repository.";
  const repo = parseGitHubRepo(repoInput);
  if (typeof repo === "string") return repo;
  if (typeof body.ref !== "string" && body.ref !== undefined) return "Enter a branch or leave it empty.";
  if (typeof body.directory !== "string" && body.directory !== undefined) return "Enter a directory or leave it empty.";
  if (typeof body.token !== "string" && body.token !== undefined) return "Enter a token or leave it empty.";
  const ref = parseGitRef(typeof body.ref === "string" ? body.ref : "");
  const directory = parseGitDirectory(typeof body.directory === "string" ? body.directory : "");
  const token = parseGitToken(typeof body.token === "string" ? body.token : "");
  if (ref === null) return "Enter a branch or leave it empty.";
  if (directory === null) return "Enter a directory or leave it empty.";
  if (token === null) return "Enter a token or leave it empty.";
  const connectionId = readConnectionId(body.connectionId, requireConnection);
  if (typeof connectionId === "object" && connectionId !== null) return connectionId.error;
  return { repo, ref, directory, token, connectionId };
}

function readConnectionId(value: unknown, required: boolean): string | null | { error: string } {
  if (value === undefined || value === "") return required ? { error: "Choose a connection." } : null;
  if (typeof value !== "string" || value.length > 200) return { error: "Choose a connection." };
  return value;
}

/** Reads the repository and the models and metrics in it. A problem is a sentence. */
export async function openDbtProject(
  request: DbtOpenRequest,
  fetchImpl: GitHubFetch,
  connection: DatabaseConnection | null,
): Promise<OpenedDbtProject | string> {
  const project = await readGitHubProject(request.repo, {
    ref: request.ref,
    directory: request.directory,
    token: request.token,
    fetch: fetchImpl,
  });
  if (typeof project === "string") return project;
  const parsed = readDbtProject(project.files);
  if (typeof parsed === "string") return parsed;
  const schema = connection === null ? "public" : dbtSchema(connection);
  const schemas = sourceSchemas(project.files);
  const built = connection === null ? null : dbtCompileProfile(connection);
  return {
    name: parsed.name,
    ref: project.ref,
    models: parsed.models.map((model) => {
      const preview = previewModel(model.sql, schema, schemas);
      return {
        name: model.name,
        path: model.path,
        refs: model.refs,
        sources: model.sources,
        sql: model.sql,
        preview: preview.sql,
        unresolved: preview.unresolved,
      };
    }),
    metrics: readMetrics(project.files, schema),
    profile:
      built === null
        ? { ready: false, reason: "Choose a connection to compile with dbt." }
        : "yaml" in built
          ? { ready: true }
          : { ready: false, reason: built.error },
  };
}
