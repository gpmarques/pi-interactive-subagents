import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface PiWebAccessPreflightResult {
  durationMs: number;
  piExecutable: string;
}

const EXPECTED_TOOLS = [
  "fetch_content",
  "get_search_content",
  "source_check",
  "web_search",
] as const;
const PREFLIGHT_TIMEOUT_MS = 5_000;
const PREFLIGHT_MAX_BUFFER = 1024 * 1024;
const PREFLIGHT_PREFIX = "pi-web-access-preflight-";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function isInside(root: string, candidate: string, allowRoot = false): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return allowRoot;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function canonicalDirectory(path: string, label: string, requireCanonical = true): string {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  const canonical = realpathSync(path);
  if ((requireCanonical && canonical !== resolve(path)) || !statSync(canonical).isDirectory()) {
    throw new Error(`${label} must be a canonical directory: ${path}`);
  }
  return canonical;
}

function canonicalFile(path: string, boundary: string, label: string): string {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  const canonical = realpathSync(path);
  if (canonical !== resolve(path) || !statSync(canonical).isFile() || !isInside(boundary, canonical)) {
    throw new Error(`${label} must be a canonical file inside ${boundary}: ${path}`);
  }
  return canonical;
}

function findExecutable(command: string, env: NodeJS.ProcessEnv): string {
  if (command.includes("/") || command.includes("\\")) {
    const canonical = realpathSync(command);
    accessSync(canonical, constants.X_OK);
    return canonical;
  }
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Keep searching the exact effective PATH.
    }
  }
  throw new Error(`cannot resolve executable ${JSON.stringify(command)} on the effective PATH`);
}

function terminateDetachedProcessGroup(pid: number | undefined): void {
  if (pid === undefined || process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error: any) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function parseRpcOutput(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error: any) {
      throw new Error(`offline Pi RPC emitted malformed output: ${error?.message ?? String(error)}`);
    }
    if (!isPlainObject(parsed)) throw new Error("offline Pi RPC emitted a non-object record");
    events.push(parsed);
  }
  return events;
}

/** Start a bounded fresh offline Pi runtime and prove the canonical tools are active. */
export function preflightPiWebAccessCapabilities(params: {
  cwd: string;
  agentDir: string;
  extensionPath: string;
  inspectorPath: string;
  env?: NodeJS.ProcessEnv;
  piCommand?: string;
  timeoutMs?: number;
}): PiWebAccessPreflightResult {
  const started = Date.now();
  const env = { ...(params.env ?? process.env) };
  delete env.PI_SUBAGENT_LIFECYCLE_DISABLED;
  const piExecutable = findExecutable(params.piCommand ?? "pi", env);
  const cwd = canonicalDirectory(params.cwd, "researcher child cwd", false);
  const agentDir = canonicalDirectory(params.agentDir, "effective Pi agent directory");
  const extensionPath = canonicalFile(params.extensionPath, dirname(params.extensionPath), "pi-web-access entrypoint");
  const inspectorPath = canonicalFile(params.inspectorPath, dirname(params.inspectorPath), "capability inspector");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), PREFLIGHT_PREFIX));
  const snapshotPath = join(temporaryDirectory, "active-tools.json");
  const nonce = randomBytes(24).toString("hex");
  let processGroupId: number | undefined;

  env.PI_CODING_AGENT_DIR = agentDir;
  env.PI_OFFLINE = "1";
  env.PI_WEB_ACCESS_PREFLIGHT_OUTPUT = snapshotPath;
  env.PI_WEB_ACCESS_PREFLIGHT_NONCE = nonce;

  try {
    const result = spawnSync(
      piExecutable,
      [
        "--mode",
        "rpc",
        "--offline",
        "--no-session",
        "--no-extensions",
        "--tools",
        EXPECTED_TOOLS.join(","),
        "-e",
        extensionPath,
        "-e",
        inspectorPath,
      ],
      {
        cwd,
        env,
        encoding: "utf8",
        input: '{"id":"pi-web-access-preflight","type":"get_state"}\n',
        timeout: params.timeoutMs ?? PREFLIGHT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: PREFLIGHT_MAX_BUFFER,
        detached: process.platform !== "win32",
      },
    );
    processGroupId = result.pid;

    if (result.error) {
      const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
      throw new Error(timedOut
        ? `offline Pi capability preflight timed out after ${params.timeoutMs ?? PREFLIGHT_TIMEOUT_MS}ms`
        : `offline Pi capability preflight could not run: ${result.error.message}`);
    }
    if (result.status !== 0 || result.signal) {
      const detail = String(result.stderr ?? "").trim();
      throw new Error(
        `offline Pi capability preflight exited unsuccessfully ` +
          `(status ${String(result.status)}, signal ${String(result.signal)})${detail ? `: ${detail}` : ""}`,
      );
    }

    const stderr = String(result.stderr ?? "");
    if (stderr.trim() !== "") {
      throw new Error(`offline Pi capability preflight emitted unexpected stderr: ${stderr.trim()}`);
    }
    const events = parseRpcOutput(String(result.stdout ?? ""));
    const extensionError = events.find((event) => event.type === "extension_error");
    if (extensionError) {
      throw new Error(`offline Pi capability preflight reported an extension error: ${stableJson(extensionError)}`);
    }
    const stateResponses = events.filter(
      (event) =>
        event.type === "response" &&
        event.id === "pi-web-access-preflight" &&
        event.command === "get_state",
    );
    if (events.length !== 1 || stateResponses.length !== 1 || stateResponses[0].success !== true) {
      throw new Error("offline Pi RPC state could not be inspected as the only successful response");
    }

    let snapshot: unknown;
    try {
      snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    } catch (error: any) {
      throw new Error(`offline Pi active-tool state could not be inspected: ${error?.message ?? String(error)}`);
    }
    if (
      !isPlainObject(snapshot) ||
      stableJson(Object.keys(snapshot).sort()) !== stableJson(["activeTools", "nonce"]) ||
      snapshot.nonce !== nonce ||
      !Array.isArray(snapshot.activeTools) ||
      !snapshot.activeTools.every((tool) => typeof tool === "string")
    ) {
      throw new Error("offline Pi active-tool state was malformed or did not match this preflight");
    }
    const activeTools = [...snapshot.activeTools].sort();
    if (stableJson(activeTools) !== stableJson(EXPECTED_TOOLS)) {
      throw new Error(
        `offline Pi activated ${JSON.stringify(activeTools)}, expected exactly ${JSON.stringify(EXPECTED_TOOLS)}`,
      );
    }

    return { durationMs: Date.now() - started, piExecutable };
  } finally {
    let cleanupError: unknown;
    try {
      terminateDetachedProcessGroup(processGroupId);
    } catch (error) {
      cleanupError = error;
    }
    try {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) throw cleanupError;
  }
}
