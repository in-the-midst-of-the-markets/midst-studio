/**
 * A dbt project read from GitHub.
 *
 * The studio does not clone a repository. It asks the GitHub API for the tree and the
 * model files, and it only talks to api.github.com with an owner and repo it has checked.
 */

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9._/-]{1,250}$/;
const TOKEN = /^[A-Za-z0-9._-]{1,256}$/;

export const GITHUB_FILE_CAP = 80;
export const GITHUB_FILE_CHARS = 200_000;

const UNREADABLE = "This repository could not be read. Check the name and the token.";
const UNREACHABLE = "GitHub could not be reached.";

export interface GitHubRepo {
  readonly owner: string;
  readonly repo: string;
}

export interface GitFile {
  /** Path inside the dbt project, using `/`. */
  readonly path: string;
  readonly text: string;
}

export interface GitHubProject {
  readonly ref: string;
  readonly files: readonly GitFile[];
}

type GitResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** `owner/repo` or a github.com URL for that repository. A problem is a sentence. */
export function parseGitHubRepo(input: string): GitHubRepo | string {
  const trimmed = input.trim();
  if (trimmed === "") return "Enter a GitHub repository.";
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return "Enter a GitHub repository as owner/repo or a github.com URL.";
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hostname !== "github.com") {
      return "Enter a GitHub repository as owner/repo or a github.com URL.";
    }
    const parts = url.pathname.split("/").filter((part) => part !== "");
    const repoName = parts[1]?.replace(/\.git$/, "") ?? "";
    if (parts.length < 2) return "Enter a GitHub repository as owner/repo or a github.com URL.";
    return namedRepo(parts[0] ?? "", repoName);
  }
  const [owner, repo, extra] = trimmed.split("/");
  if (extra !== undefined) return "Enter a GitHub repository as owner/repo or a github.com URL.";
  return namedRepo(owner ?? "", (repo ?? "").replace(/\.git$/, ""));
}

function namedRepo(owner: string, repo: string): GitHubRepo | string {
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") {
    return "Enter a GitHub repository as owner/repo or a github.com URL.";
  }
  return { owner, repo };
}

/** A branch or tag, or an empty string when the repository's default branch should be used. */
export function parseGitRef(input: string): string | null {
  const ref = input.trim();
  if (ref === "") return "";
  if (!REF.test(ref) || ref.includes("..") || ref.startsWith("/") || ref.endsWith("/")) return null;
  return ref;
}

/** A directory inside the repository. Empty means the repository root. */
export function parseGitDirectory(input: string): string | null {
  const directory = input.trim().replace(/^\.\/|\/$/g, "");
  if (directory === "") return "";
  const parts = directory.split("/");
  if (
    directory.startsWith("/") ||
    directory.includes("\\") ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    !/^[\w./-]{1,200}$/.test(directory)
  ) {
    return null;
  }
  return directory;
}

/** A token GitHub would accept, or an empty string when the repository is public. */
export function parseGitToken(input: string): string | null {
  const token = input.trim();
  if (token === "") return "";
  return TOKEN.test(token) ? token : null;
}

interface TreeEntry {
  readonly path: string;
  readonly type: string;
}

export interface GitFileRequest {
  readonly path: string;
  readonly relative: string;
}

/** The project files to download: `dbt_project.yml` and the model SQL and YAML under `modelPaths`. */
export function selectProjectFiles(
  entries: readonly TreeEntry[],
  directory: string,
  modelPaths: readonly string[],
): GitFileRequest[] | string {
  const prefix = directory === "" ? "" : `${directory}/`;
  const projectFile = `${prefix}dbt_project.yml`;
  if (!entries.some((entry) => entry.type === "blob" && entry.path === projectFile)) {
    return "This repository has no dbt_project.yml.";
  }
  const wanted = new Set<string>([projectFile]);
  for (const entry of entries) {
    if (entry.type !== "blob" || !entry.path.startsWith(prefix)) continue;
    const relative = entry.path.slice(prefix.length);
    if (relative === "packages.yml" || isModelFile(relative, modelPaths)) wanted.add(entry.path);
  }
  if (wanted.size > GITHUB_FILE_CAP) return `This project has more than ${GITHUB_FILE_CAP} model files.`;
  return [...wanted].map((path) => ({ path, relative: path.slice(prefix.length) }));
}

function isModelFile(relative: string, modelPaths: readonly string[]): boolean {
  if (!/\.(sql|ya?ml)$/.test(relative)) return false;
  return modelPaths.some((modelPath) => relative === modelPath || relative.startsWith(`${modelPath}/`));
}

/** A fetch implementation. Compile and project reads never call `preconnect`. */
export type GitHubFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface GitHubClient {
  readonly fetch: GitHubFetch;
  readonly signal?: AbortSignal;
  readonly token: string;
}

/** Reads the dbt project at `repo`. A problem is a sentence. */
export async function readGitHubProject(
  repo: GitHubRepo,
  options: { ref: string; directory: string; token: string; fetch: GitHubFetch; signal?: AbortSignal },
): Promise<GitHubProject | string> {
  const client: GitHubClient = { fetch: options.fetch, signal: options.signal, token: options.token };
  const branch = options.ref === "" ? await defaultBranch(repo, client) : { ok: true as const, value: options.ref };
  if (!branch.ok) return branch.error;
  const tree = await repositoryTree(repo, branch.value, client);
  if (!tree.ok) return tree.error;
  const projectPath = options.directory === "" ? "dbt_project.yml" : `${options.directory}/dbt_project.yml`;
  if (!tree.value.some((entry) => entry.type === "blob" && entry.path === projectPath)) {
    return "This repository has no dbt_project.yml.";
  }
  const project = await readRawFile(repo, branch.value, projectPath, client);
  if (!project.ok) return project.error;
  const selected = selectProjectFiles(tree.value, options.directory, modelPathsOf(project.value));
  if (typeof selected === "string") return selected;
  const files: GitFile[] = [];
  for (const request of selected) {
    let text: GitResult<string> = project;
    if (request.relative !== "dbt_project.yml") {
      // oxlint-disable-next-line no-await-in-loop -- the first file GitHub refuses stops the read.
      text = await readRawFile(repo, branch.value, request.path, client);
    }
    if (!text.ok) return text.error;
    if (text.value.length > GITHUB_FILE_CHARS) return "A model file is larger than 200KB.";
    files.push({ path: request.relative, text: text.value });
  }
  return { ref: branch.value, files };
}

/** The `model-paths` named in a project file, or `models` when it names none. */
export function modelPathsOf(projectYaml: string): string[] {
  const inline = projectYaml.match(/model-paths:\s*\[([^\]]*)\]/);
  if (inline?.[1] !== undefined) {
    const paths = quotedPaths(inline[1]);
    if (paths.length > 0) return paths;
  }
  const block = projectYaml.match(/model-paths:\s*\n((?:\s+-\s+\S+\n?)+)/);
  if (block?.[1] !== undefined) {
    const paths = [...block[1].matchAll(/-\s+(\S+)/g)]
      .map((item) => (item[1] ?? "").replace(/["']/g, ""))
      .filter((item) => item !== "");
    if (paths.length > 0) return paths;
  }
  return ["models"];
}

function quotedPaths(value: string): string[] {
  return [...value.matchAll(/["']([^"']+)["']/g)].map((item) => item[1] ?? "").filter((item) => item !== "");
}

async function defaultBranch(repo: GitHubRepo, client: GitHubClient): Promise<GitResult<string>> {
  const body = await githubJson(`repos/${repo.owner}/${repo.repo}`, client);
  if (!body.ok) return body;
  const branch = asRecord(body.value)?.default_branch;
  if (typeof branch !== "string" || parseGitRef(branch) === null)
    return { ok: false, error: "GitHub did not name a branch." };
  return { ok: true, value: branch };
}

async function repositoryTree(repo: GitHubRepo, ref: string, client: GitHubClient): Promise<GitResult<TreeEntry[]>> {
  const body = await githubJson(
    `repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    client,
  );
  if (!body.ok) return body;
  const record = asRecord(body.value);
  if (record?.truncated === true) return { ok: false, error: "This repository tree is too large to read." };
  if (!Array.isArray(record?.tree)) return { ok: false, error: "GitHub did not return the repository tree." };
  const entries: TreeEntry[] = [];
  for (const item of record.tree) {
    const row = asRecord(item);
    if (typeof row?.path === "string" && typeof row.type === "string") entries.push({ path: row.path, type: row.type });
  }
  return { ok: true, value: entries };
}

async function readRawFile(
  repo: GitHubRepo,
  ref: string,
  path: string,
  client: GitHubClient,
): Promise<GitResult<string>> {
  const encoded = path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const response = await githubResponse(
    `repos/${repo.owner}/${repo.repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
    client,
    "application/vnd.github.raw",
  );
  if (!response.ok) return response;
  if (!response.value.ok) return { ok: false, error: UNREADABLE };
  return { ok: true, value: await response.value.text() };
}

async function githubJson(path: string, client: GitHubClient): Promise<GitResult<unknown>> {
  const response = await githubResponse(path, client, "application/vnd.github+json");
  if (!response.ok) return response;
  if (!response.value.ok) return { ok: false, error: UNREADABLE };
  try {
    return { ok: true, value: await response.value.json() };
  } catch {
    return { ok: false, error: "GitHub returned a response that could not be read." };
  }
}

async function githubResponse(path: string, client: GitHubClient, accept: string): Promise<GitResult<Response>> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "midst-studio",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (client.token !== "") headers.Authorization = `Bearer ${client.token}`;
  try {
    return {
      ok: true,
      value: await client.fetch(`https://api.github.com/${path}`, { headers, signal: client.signal }),
    };
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
