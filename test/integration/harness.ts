/**
 * Integration test harness for pi-interactive-subagents.
 *
 * Provides utilities to:
 * - Detect the selected terminal multiplexer backend
 * - Create isolated test environments with test agent definitions
 * - Start real pi sessions in mux surfaces
 * - Poll for file creation and screen output
 * - Clean up surfaces and temp files after tests
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readdirSync,
  rmSync,
  existsSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  getMuxBackend,
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  shellEscape,
  type MuxBackend,
} from "../../pi-extension/subagents/mux.ts";

// Re-export mux primitives for tests
export {
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  shellEscape,
};

// ── Paths ──

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIR, "../..");
const TEST_AGENTS_SRC = join(HARNESS_DIR, "agents");

/**
 * Absolute path to the extension source in the working tree.
 *
 * Integration tests must exercise the code on the current branch — NOT the
 * version installed as a pi-package under `~/.pi/agent/git/...` or the project
 * mirror under `.pi/git/...`, which stays pinned to the last released tag.
 *
 * We force-load this file via `pi -ne -e <path>` in startPi() below so local
 * edits are always the code under test, regardless of what pi-packages are
 * installed on the host.
 */
const EXTENSION_SOURCE = join(PROJECT_ROOT, "pi-extension", "subagents", "index.ts");

// ── Configuration ──

/** Model used for integration tests. Override with PI_TEST_MODEL env var. */
export const TEST_MODEL = process.env.PI_TEST_MODEL ?? "openai-codex/gpt-5.6-sol";

/** Per-test timeout in ms. Override with PI_TEST_TIMEOUT env var. */
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "120000");

// ── Backend detection ──

/** Return only the backend selected by the public mux interface, or none. */
export function getAvailableBackends(): MuxBackend[] {
  const backend = getMuxBackend();
  return backend ? [backend] : [];
}

export function focusSurface(backend: MuxBackend, surface: string): void {
  if (backend !== "tmux") {
    throw new Error("Herdr focus is read-only in integration tests");
  }
  execFileSync("tmux", ["select-pane", "-t", surface], { encoding: "utf8" });
}

export interface HerdrWorkspaceSnapshot {
  workspaceId: string;
  focusedPaneId: string | null;
  paneIds: string[];
  paneCount: number;
  tabIds: string[];
  tabCount: number;
}

/** Read one Herdr workspace without changing focus, pane state, or tab state. */
export function getHerdrWorkspaceSnapshot(workspaceId: string): HerdrWorkspaceSnapshot {
  if (!workspaceId) throw new Error("HERDR_WORKSPACE_ID is required");

  const output = execFileSync(
    "herdr",
    ["pane", "list", "--workspace", workspaceId],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(output) as {
    result?: { panes?: Array<{ focused?: unknown; pane_id?: unknown }> };
  };
  const panes = parsed.result?.panes;
  if (!Array.isArray(panes)) {
    throw new Error(`Unexpected Herdr pane list for workspace ${workspaceId}: ${output.trim()}`);
  }

  const paneIds = panes.map((pane) => pane.pane_id);
  if (paneIds.some((paneId) => typeof paneId !== "string" || paneId.length === 0)) {
    throw new Error(`Herdr returned a pane without an id for workspace ${workspaceId}`);
  }
  if (new Set(paneIds).size !== paneIds.length) {
    throw new Error(`Herdr returned duplicate pane ids for workspace ${workspaceId}`);
  }

  const focused = panes.filter((pane) => pane.focused === true);
  if (focused.length > 1) {
    throw new Error(
      `Expected at most one focused Herdr pane in workspace ${workspaceId}, got ${focused.length}`,
    );
  }

  const tabOutput = execFileSync(
    "herdr",
    ["tab", "list", "--workspace", workspaceId],
    { encoding: "utf8" },
  );
  const tabParsed = JSON.parse(tabOutput) as {
    result?: { tabs?: Array<{ tab_id?: unknown }> };
  };
  const tabs = tabParsed.result?.tabs;
  if (!Array.isArray(tabs)) {
    throw new Error(`Unexpected Herdr tab list for workspace ${workspaceId}: ${tabOutput.trim()}`);
  }

  const tabIds = tabs.map((tab) => tab.tab_id);
  if (tabIds.some((tabId) => typeof tabId !== "string" || tabId.length === 0)) {
    throw new Error(`Herdr returned a tab without an id for workspace ${workspaceId}`);
  }
  if (new Set(tabIds).size !== tabIds.length) {
    throw new Error(`Herdr returned duplicate tab ids for workspace ${workspaceId}`);
  }

  const sortedPaneIds = (paneIds as string[]).sort();
  const sortedTabIds = (tabIds as string[]).sort();
  return {
    workspaceId,
    focusedPaneId: focused.length === 1 ? focused[0].pane_id as string : null,
    paneIds: sortedPaneIds,
    paneCount: sortedPaneIds.length,
    tabIds: sortedTabIds,
    tabCount: sortedTabIds.length,
  };
}

function sameHerdrWorkspace(
  actual: HerdrWorkspaceSnapshot,
  expected: HerdrWorkspaceSnapshot,
): boolean {
  return actual.focusedPaneId === expected.focusedPaneId &&
    actual.paneCount === expected.paneCount &&
    actual.paneIds.every((paneId, index) => paneId === expected.paneIds[index]) &&
    actual.tabCount === expected.tabCount &&
    actual.tabIds.every((tabId, index) => tabId === expected.tabIds[index]);
}

/** Boundedly wait for exact Herdr focus, pane-set, and tab-set restoration. */
export async function waitForHerdrWorkspaceRestored(
  expected: HerdrWorkspaceSnapshot,
  timeout: number = PI_TIMEOUT,
): Promise<HerdrWorkspaceSnapshot> {
  const start = Date.now();
  let latest: HerdrWorkspaceSnapshot | null = null;
  let latestError: unknown;

  while (Date.now() - start < timeout) {
    try {
      latest = getHerdrWorkspaceSnapshot(expected.workspaceId);
      latestError = undefined;
      if (sameHerdrWorkspace(latest, expected)) return latest;
    } catch (error) {
      latestError = error;
    }
    await sleep(200);
  }

  const expectedText =
    `focus=${expected.focusedPaneId}, ` +
    `panes(count=${expected.paneCount}, ids=[${expected.paneIds.join(", ")}]), ` +
    `tabs(count=${expected.tabCount}, ids=[${expected.tabIds.join(", ")}])`;
  const actualText = latest
    ? `focus=${latest.focusedPaneId}, ` +
      `panes(count=${latest.paneCount}, ids=[${latest.paneIds.join(", ")}]), ` +
      `tabs(count=${latest.tabCount}, ids=[${latest.tabIds.join(", ")}])`
    : `unavailable${latestError ? ` (${latestError instanceof Error ? latestError.message : String(latestError)})` : ""}`;
  throw new Error(
    `Herdr workspace ${expected.workspaceId} was not restored within ${timeout}ms; ` +
      `expected ${expectedText}; actual ${actualText}. Unknown panes/tabs were not closed.`,
  );
}

export function getFocusedSurface(backend: MuxBackend): string | null {
  try {
    if (backend === "tmux") {
      const panes = execFileSync("tmux", ["list-panes", "-F", "#{pane_id} #{pane_active}"], {
        encoding: "utf8",
      });
      const activeLine = panes.split("\n").find((line) => line.endsWith(" 1"));
      return activeLine?.split(" ")[0] ?? null;
    }

    const workspaceId = process.env.HERDR_WORKSPACE_ID;
    if (!workspaceId) return null;
    return getHerdrWorkspaceSnapshot(workspaceId).focusedPaneId;
  } catch {
    return null;
  }
}

export async function waitForFocusedSurface(
  backend: MuxBackend,
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (getFocusedSurface(backend) === surface) return;
    await sleep(200);
  }

  throw new Error(
    `Timeout (${timeout}ms) waiting for focused ${backend} surface ${surface}; ` +
      `current focus is ${getFocusedSurface(backend) ?? "unknown"}`,
  );
}

// ── Test environment ──

export interface TestEnv {
  /** Temp directory serving as the test project root */
  dir: string;
  /** Surfaces created during the test (cleaned up automatically) */
  surfaces: string[];
  /** Temp files to clean up */
  tempFiles: string[];
  /** Exact outer session files whose public spawn results identify owned children. */
  ownedOuterSessionFiles: string[];
}

/**
 * Create an isolated test environment with test agent definitions.
 * The temp dir has `.pi/agents/` containing copies of all test agents.
 */
export function createTestEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "pi-integ-"));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });

  // Copy test agent definitions into the project-local agents dir
  if (existsSync(TEST_AGENTS_SRC)) {
    for (const file of readdirSync(TEST_AGENTS_SRC)) {
      if (file.endsWith(".md")) {
        cpSync(join(TEST_AGENTS_SRC, file), join(agentsDir, file));
      }
    }
  }

  return { dir, surfaces: [], tempFiles: [], ownedOuterSessionFiles: [] };
}

/**
 * Clean up all resources created during the test.
 */
export function cleanupTestEnv(env: TestEnv): void {
  const errors: Error[] = [];
  const recordError = (action: string, target: string, error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    errors.push(new Error(`Failed to ${action} ${target}: ${detail}`));
  };
  const isMissingFile = (error: unknown): boolean =>
    (error as NodeJS.ErrnoException)?.code === "ENOENT";

  for (const surface of [...env.surfaces].reverse()) {
    try {
      closeSurface(surface);
    } catch (error) {
      recordError("close test surface", surface, error);
    }
  }
  env.surfaces = [];

  for (const file of env.tempFiles) {
    try {
      unlinkSync(file);
    } catch (error) {
      if (!isMissingFile(error)) recordError("remove test file", file, error);
    }
  }
  env.tempFiles = [];
  env.ownedOuterSessionFiles = [];

  try {
    rmSync(env.dir, { recursive: true, force: true });
  } catch (error) {
    if (!isMissingFile(error)) recordError("remove test directory", env.dir, error);
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `Test cleanup failed with ${errors.length} error(s)`);
  }
}

/**
 * Create a surface and register it for automatic cleanup.
 */
export function createTrackedSurface(env: TestEnv, name: string): string {
  const surface = createSurface(name);
  env.surfaces.push(surface);
  return surface;
}

export function createTrackedSurfaceSplit(
  env: TestEnv,
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const surface = createSurfaceSplit(name, direction, fromSurface);
  env.surfaces.push(surface);
  return surface;
}

/**
 * Remove a surface from tracking (after manual close).
 */
export function untrackSurface(env: TestEnv, surface: string): void {
  env.surfaces = env.surfaces.filter((s) => s !== surface);
}

// ── Pi session management ──

/**
 * Start a pi session in a mux surface with the subagents extension loaded.
 * Returns immediately — the pi process runs asynchronously in the surface.
 *
 * The command ends with a sentinel so we can detect when pi exits:
 *   `pi ...; echo '__TEST_DONE_'$?'__'`
 */
export function startPi(
  surface: string,
  testDir: string,
  task: string,
  opts?: { model?: string; extraArgs?: string },
): void {
  const model = opts?.model ?? TEST_MODEL;
  const extra = opts?.extraArgs ?? "";

  // Force pi to load the working-tree extension (not an installed pi-package
  // snapshot). `-ne` disables extension auto-discovery, `-e <path>` loads the
  // current branch's source directly. Without this, the tests silently run
  // against whatever version is checked out under `~/.pi/agent/git/...`.
  const cmd = [
    `cd ${shellEscape(testDir)} &&`,
    `pi`,
    `-ne`,
    `-e ${shellEscape(EXTENSION_SOURCE)}`,
    `--model ${shellEscape(model)}`,
    extra,
    shellEscape(task),
  ]
    .filter(Boolean)
    .join(" ");

  sendLongCommand(surface, `${cmd}; echo '__TEST_DONE_'$?'__'`, {
    scriptPath: join(testDir, `test-launch-${Date.now()}.sh`),
  });
}

// ── Polling helpers ──

/**
 * Poll until a regex pattern appears in the surface's screen output.
 * Throws on timeout with the last screen contents for debugging.
 */
export async function waitForScreen(
  surface: string,
  pattern: RegExp,
  timeout: number = PI_TIMEOUT,
  lines: number = 200,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const screen = await readScreenAsync(surface, lines);
      if (pattern.test(screen)) return screen;
    } catch {}
    await sleep(2000);
  }

  let finalScreen = "";
  try {
    finalScreen = readScreen(surface, lines);
  } catch {}
  throw new Error(
    `Timeout (${timeout}ms) waiting for pattern ${pattern}.\nLast screen:\n${finalScreen.slice(-1000)}`,
  );
}

/**
 * Poll until a file exists and optionally matches a content pattern.
 * Returns the file content on success.
 */
export async function waitForFile(
  path: string,
  timeout: number = PI_TIMEOUT,
  contentPattern?: RegExp,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (!contentPattern || contentPattern.test(content)) return content;
    }
    await sleep(2000);
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for file: ${path}` +
      (contentPattern ? ` matching ${contentPattern}` : ""),
  );
}

/**
 * Wait for the pi process in a surface to exit (sentinel detection).
 * Returns the exit code.
 */
export async function waitForPiExit(
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<number> {
  const screen = await waitForScreen(surface, /__TEST_DONE_(\d+)__/, timeout);
  const match = screen.match(/__TEST_DONE_(\d+)__/);
  return match ? parseInt(match[1], 10) : -1;
}

// ── Utilities ──

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Register a temp file for cleanup.
 */
export function trackTempFile(env: TestEnv, path: string): void {
  env.tempFiles.push(path);
}

/** Register an exact outer transcript as the ownership source for child cleanup. */
export function trackOwnedOuterSessionFile(env: TestEnv, path: string): void {
  env.ownedOuterSessionFiles.push(path);
}

/**
 * Collect child session paths only from explicitly owned outer transcripts.
 * Read/parse failures are returned alongside valid discoveries; no surrounding
 * directory is scanned, so unrelated sessions cannot become cleanup targets.
 */
export function collectOwnedChildSessionFiles(outerSessionFiles: string[]): {
  sessionFiles: string[];
  errors: Error[];
} {
  const childSessions = new Set<string>();
  const errors: Error[] = [];
  for (const outerSessionFile of outerSessionFiles) {
    let lines: string[];
    try {
      lines = readFileSync(outerSessionFile, "utf8").split("\n");
    } catch (error) {
      errors.push(new Error(
        `Failed to read owned outer transcript ${outerSessionFile}: ${error instanceof Error ? error.message : String(error)}`,
      ));
      continue;
    }
    for (const [lineIndex, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as {
          message?: {
            role?: unknown;
            toolName?: unknown;
            details?: { status?: unknown; sessionFile?: unknown };
          };
        };
        const message = entry.message;
        if (
          message?.role === "toolResult" &&
          message.toolName === "subagent" &&
          message.details?.status === "started" &&
          typeof message.details.sessionFile === "string" &&
          message.details.sessionFile.length > 0
        ) {
          childSessions.add(message.details.sessionFile);
        }
      } catch (error) {
        errors.push(new Error(
          `Malformed owned outer transcript ${outerSessionFile}:${lineIndex + 1}: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    }
  }
  return { sessionFiles: [...childSessions], errors };
}

/** Remove only exact owned child artifacts, then exact directories if empty. */
export function cleanupOwnedChildSessionFiles(sessionFiles: string[]): void {
  const errors: Error[] = [];
  const sessionDirs = new Set<string>();
  const isMissing = (error: unknown): boolean =>
    (error as NodeJS.ErrnoException)?.code === "ENOENT";

  for (const sessionFile of new Set(sessionFiles)) {
    sessionDirs.add(dirname(sessionFile));
    for (const suffix of ["", ".loadout.json", ".ask", ".exit"]) {
      const path = `${sessionFile}${suffix}`;
      try {
        unlinkSync(path);
      } catch (error) {
        if (!isMissing(error)) {
          errors.push(new Error(
            `Failed to remove owned child session file ${path}: ${error instanceof Error ? error.message : String(error)}`,
          ));
        }
      }
    }
    const settledDirectory = `${sessionFile}.idle`;
    try {
      rmSync(settledDirectory, { recursive: true, force: true });
    } catch (error) {
      errors.push(new Error(
        `Failed to remove owned child settled directory ${settledDirectory}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  for (const sessionDir of sessionDirs) {
    try {
      if (readdirSync(sessionDir).length === 0) rmdirSync(sessionDir);
    } catch (error) {
      if (!isMissing(error)) {
        errors.push(new Error(
          `Failed to inspect/remove owned child session directory ${sessionDir}: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "Owned child session cleanup failed");
  }
}
