import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AdapterBackend = "tmux" | "herdr";
export type SplitDirection = "left" | "right" | "up" | "down";

export interface MuxAdapter {
  readonly backend: AdapterBackend;
  isAvailable(): boolean;
  createSurface(name: string): string;
  createSurfaceSplit(name: string, direction: SplitDirection, fromSurface?: string): string;
  sendCommand(surface: string, command: string): void;
  readScreen(surface: string, lines: number): string;
  readScreenAsync(surface: string, lines: number): Promise<string>;
  killSurface(surface: string): void;
  isMissingSurfaceError(error: unknown): boolean;
}

function hasCommand(command: string): boolean {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    try {
      accessSync(join(directory, command), constants.X_OK);
      return true;
    } catch {
      // Keep searching PATH. Availability is intentionally not cached.
    }
  }
  return false;
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const value = error as { message?: unknown; stderr?: unknown };
  const stderr = typeof value.stderr === "string"
    ? value.stderr
    : Buffer.isBuffer(value.stderr)
      ? value.stderr.toString("utf8")
      : "";
  return `${typeof value.message === "string" ? value.message : ""}\n${stderr}`;
}

// ── tmux adapter ──

const SUBAGENT_TMUX_LAYOUT = "even-horizontal";
let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

function rebalanceTmuxSurfaces(hintPane?: string): void {
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      execFileSync("tmux", ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
      });
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

function createTmuxSurfaceSplit(
  _name: string,
  direction: SplitDirection,
  fromSurface?: string,
): string {
  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  rebalanceTmuxSurfaces(pane);
  return pane;
}

const tmuxAdapter: MuxAdapter = {
  backend: "tmux",

  isAvailable(): boolean {
    return !!process.env.TMUX && hasCommand("tmux");
  },

  createSurface(name: string): string {
    return createTmuxSurfaceSplit(name, "right", process.env.TMUX_PANE);
  },

  createSurfaceSplit: createTmuxSurfaceSplit,

  sendCommand(surface: string, command: string): void {
    execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
  },

  readScreen(surface: string, lines: number): string {
    return execFileSync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
  },

  async readScreenAsync(surface: string, lines: number): Promise<string> {
    const { stdout } = await execFileAsync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
    return stdout;
  },

  killSurface(surface: string): void {
    execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
    rebalanceTmuxSurfaces();
  },

  isMissingSurfaceError(error: unknown): boolean {
    return /(?:can't|cannot) find (?:pane|window|session)|no such (?:pane|window|session)|no server running|error connecting to .*no such file/i.test(
      errorText(error),
    );
  },
};

// ── Herdr adapter ──

type HerdrPaneIdentity = {
  paneId: string;
  workspaceId: string;
};

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function unexpectedHerdrOutput(context: string, output: string): Error {
  return new Error(`Unexpected Herdr ${context} output: ${output.trim() || "(empty)"}`);
}

function extractHerdrPaneId(output: string, context: string, root: boolean): string {
  const parsed = parseJson(output) as {
    result?: { pane?: { pane_id?: unknown }; root_pane?: { pane_id?: unknown } };
  } | null;
  const paneId = root ? parsed?.result?.root_pane?.pane_id : parsed?.result?.pane?.pane_id;
  if (!nonEmptyString(paneId)) throw unexpectedHerdrOutput(context, output);
  return paneId;
}

function herdrExec(args: string[]): string {
  return execFileSync("herdr", args, { encoding: "utf8" });
}

async function herdrExecAsync(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8" });
  return stdout;
}

function readCurrentHerdrIdentity(): HerdrPaneIdentity {
  const output = herdrExec(["pane", "current", "--current"]);
  const parsed = parseJson(output) as {
    result?: { pane?: { pane_id?: unknown; workspace_id?: unknown } };
  } | null;
  const paneId = parsed?.result?.pane?.pane_id;
  const workspaceId = parsed?.result?.pane?.workspace_id;
  if (!nonEmptyString(paneId) || !nonEmptyString(workspaceId)) {
    throw unexpectedHerdrOutput("pane current --current", output);
  }
  return { paneId, workspaceId };
}

function resolveHerdrIdentity(): HerdrPaneIdentity {
  const paneId = process.env.HERDR_PANE_ID;
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (paneId && workspaceId) return { paneId, workspaceId };

  const current = readCurrentHerdrIdentity();
  return {
    paneId: paneId || current.paneId,
    workspaceId: workspaceId || current.workspaceId,
  };
}

function renameHerdrPaneBestEffort(paneId: string, name: string): void {
  try {
    herdrExec(["pane", "rename", paneId, name]);
  } catch {
    // A pane label is cosmetic and must not fail surface creation.
  }
}

function herdrReadArgs(surface: string, source: "recent" | "visible", lines: number): string[] {
  return [
    "pane",
    "read",
    surface,
    "--source",
    source,
    "--lines",
    String(Math.max(1, lines)),
  ];
}

function herdrStderr(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === "string") return stderr;
  if (Buffer.isBuffer(stderr)) return stderr.toString("utf8");
  return null;
}

const herdrAdapter: MuxAdapter = {
  backend: "herdr",

  isAvailable(): boolean {
    if (process.env.HERDR_ENV !== "1" || !hasCommand("herdr")) return false;
    try {
      resolveHerdrIdentity();
      return true;
    } catch {
      return false;
    }
  },

  createSurface(name: string): string {
    const workspaceId = process.env.HERDR_WORKSPACE_ID || resolveHerdrIdentity().workspaceId;
    const output = herdrExec([
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      process.cwd(),
      "--label",
      name,
      "--no-focus",
    ]);
    const paneId = extractHerdrPaneId(output, "tab create", true);
    renameHerdrPaneBestEffort(paneId, name);
    return paneId;
  },

  createSurfaceSplit(name: string, direction: SplitDirection, fromSurface?: string): string {
    if (direction === "left" || direction === "up") {
      throw new Error(
        `Herdr supports only right/down splits without changing focus; ${direction} is unavailable.`,
      );
    }

    const targetPane = fromSurface || process.env.HERDR_PANE_ID || resolveHerdrIdentity().paneId;
    const output = herdrExec([
      "pane",
      "split",
      targetPane,
      "--direction",
      direction,
      "--cwd",
      process.cwd(),
      "--no-focus",
    ]);
    const paneId = extractHerdrPaneId(output, "pane split", false);
    renameHerdrPaneBestEffort(paneId, name);
    return paneId;
  },

  sendCommand(surface: string, command: string): void {
    herdrExec(["pane", "run", surface, command]);
  },

  readScreen(surface: string, lines: number): string {
    const recent = herdrExec(herdrReadArgs(surface, "recent", lines));
    return recent === ""
      ? herdrExec(herdrReadArgs(surface, "visible", lines))
      : recent;
  },

  async readScreenAsync(surface: string, lines: number): Promise<string> {
    const recent = await herdrExecAsync(herdrReadArgs(surface, "recent", lines));
    return recent === ""
      ? herdrExecAsync(herdrReadArgs(surface, "visible", lines))
      : recent;
  },

  killSurface(surface: string): void {
    herdrExec(["pane", "close", surface]);
  },

  isMissingSurfaceError(error: unknown): boolean {
    const stderr = herdrStderr(error);
    if (stderr === null) return false;
    const parsed = parseJson(stderr.trim()) as { error?: { code?: unknown } } | null;
    return parsed?.error?.code === "pane_not_found";
  },
};

export function muxAdapterFor(backend: AdapterBackend): MuxAdapter {
  return backend === "herdr" ? herdrAdapter : tmuxAdapter;
}

export function isBackendAvailable(backend: AdapterBackend): boolean {
  return muxAdapterFor(backend).isAvailable();
}
