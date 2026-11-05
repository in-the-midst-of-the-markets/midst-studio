import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { GITHUB_FILE_CAP, GITHUB_FILE_CHARS, type GitFile } from "@/lib/git/github";

const STDERR_CAP = 8_000;
const COMPILED_FILE_CAP = 200_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const COMPILE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT"];
const UNSAFE_COMPILE = /\b(env_var|run_query|modules)\s*\(/;

export interface SpawnCapture {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PreparedProject {
  readonly projectDir: string;
  readonly profilesDir: string;
  cleanup: () => Promise<void>;
}

export interface CompileHooks {
  prepare: (files: readonly GitFile[], profileYaml: string) => Promise<PreparedProject | string>;
  spawn: (
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number },
  ) => Promise<SpawnCapture>;
}

/** Runs `dbt compile` in a temporary project. A missing binary is an error, not a crash. */
export async function compileProject(
  files: readonly GitFile[],
  profileYaml: string,
  hooks: Partial<CompileHooks> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  secrets: readonly string[] = [],
): Promise<{ files: Record<string, string> } | { error: string }> {
  const refused = projectCompileRefusal(files);
  if (refused !== null) return { error: refused };
  const prepare = hooks.prepare ?? prepareProject;
  const run = hooks.spawn ?? spawnCaptured;
  const prepared = await prepare(files, profileYaml);
  if (typeof prepared === "string") return { error: prepared };
  try {
    const result = await run(
      "dbt",
      [
        "compile",
        "--project-dir",
        prepared.projectDir,
        "--profiles-dir",
        prepared.profilesDir,
        "--profile",
        "midst",
        "--target",
        "dev",
      ],
      { cwd: prepared.projectDir, timeoutMs },
    );
    if (result.code !== 0) return { error: clip(redactSecrets(result.stderr, secrets)) || "dbt compile failed." };
    const compiled = await readCompiled(prepared.projectDir);
    if (typeof compiled === "string") return { error: compiled };
    if (Object.keys(compiled).length === 0) return { error: "dbt produced no compiled SQL." };
    const safe: Record<string, string> = {};
    for (const [path, sql] of Object.entries(compiled)) safe[path] = redactSecrets(sql, secrets);
    return { files: safe };
  } catch (error) {
    const message = error instanceof Error ? error.message : "dbt compile failed.";
    return { error: clip(redactSecrets(message, secrets)) || "dbt compile failed." };
  } finally {
    await prepared.cleanup().catch(() => undefined);
  }
}

/** Jinja that can read the server environment or query the warehouse during compile. */
export function projectCompileRefusal(files: readonly GitFile[]): string | null {
  for (const file of files) {
    if (UNSAFE_COMPILE.test(file.text)) return "This project uses a dbt feature compile will not run.";
  }
  return null;
}

/** Replaces a secret of at least 8 characters. Shorter values would erase ordinary SQL. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** The environment dbt is allowed to see. The server's own secrets are not in it. */
export function compileEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of COMPILE_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

/** Writes the project and `profiles.yml` under a temporary directory. */
export async function prepareProject(
  files: readonly GitFile[],
  profileYaml: string,
): Promise<PreparedProject | string> {
  if (files.length > GITHUB_FILE_CAP) return `This project has more than ${GITHUB_FILE_CAP} model files.`;
  for (const file of files) {
    if (safeRelative(file.path) === null) return "A project file has a path dbt will not be given.";
    if (file.text.length > GITHUB_FILE_CHARS) return "A model file is larger than 200KB.";
  }
  const root = await mkdtemp(join(tmpdir(), "midst-dbt-"));
  const projectDir = join(root, "project");
  await mkdir(projectDir, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const destination = join(projectDir, file.path);
    // oxlint-disable-next-line no-await-in-loop -- each model is written before the next, under the directory it names.
    await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
    // oxlint-disable-next-line no-await-in-loop -- the file is written after its directory exists.
    await writeFile(destination, file.text, { encoding: "utf8", mode: 0o600 });
  }
  await writeFile(join(root, "profiles.yml"), profileYaml, { encoding: "utf8", mode: 0o600 });
  return {
    projectDir,
    profilesDir: root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Captures a process run with `shell: false`. A missing command says dbt is not installed. */
export function spawnCaptured(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
): Promise<SpawnCapture> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: SpawnCapture): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: compileEnvironment(),
      shell: false,
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = clip(stdout + String(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = clip(stderr + String(chunk));
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        code: null,
        stdout,
        stderr: error.code === "ENOENT" ? "dbt is not installed on this server." : clip(error.message),
      });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

async function readCompiled(projectDir: string): Promise<Record<string, string> | string> {
  const root = join(projectDir, "target", "compiled");
  const files: Record<string, string> = {};
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) break;
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one directory of compiled SQL at a time.
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.name.endsWith(".sql")) {
        // oxlint-disable-next-line no-await-in-loop -- each compiled model is read after the one before it.
        const sql = await readFile(full, "utf8");
        if (sql.length > COMPILED_FILE_CAP) return "dbt produced SQL that is too large.";
        files[relative(root, full)] = sql;
      }
    }
  }
  return files;
}

function safeRelative(path: string): string | null {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return null;
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  if (!/^[\w./-]+$/.test(path)) return null;
  return path;
}

function clip(value: string): string {
  return value.length > STDERR_CAP ? value.slice(0, STDERR_CAP) : value;
}
