/**
 * Terminal multiplexer module for subagent surfaces.
 *
 * Callers use one small, backend-neutral interface. Concrete tmux and Herdr
 * syntax, identity lookup, output parsing, and missing-pane classification stay
 * behind private adapters; lifecycle policy remains in this module.
 */
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isBackendAvailable,
  muxAdapterFor,
  type AdapterBackend,
  type MuxAdapter,
} from "./mux-adapters.ts";

// ── Availability and selection ──

export type MuxBackend = AdapterBackend;

type MuxPreference = MuxBackend | "invalid" | "auto";

const surfaceAdapters = new Map<string, MuxAdapter>();
const errorAdapters = new WeakMap<object, MuxAdapter>();

function muxPreference(): MuxPreference {
  const value = process.env.PI_SUBAGENT_MUX;
  if (value === undefined) return "auto";
  if (value === "tmux" || value === "herdr") return value;
  return "invalid";
}

/** True when running inside tmux with the tmux binary on PATH. */
export function isTmuxAvailable(): boolean {
  return isBackendAvailable("tmux");
}

/** True when Herdr, caller identity, and the Herdr binary are all available. */
export function isHerdrAvailable(): boolean {
  return isBackendAvailable("herdr");
}

/** Resolve the configured backend, or null when selection is invalid/unavailable. */
export function getMuxBackend(): MuxBackend | null {
  const preference = muxPreference();
  if (preference === "invalid") return null;
  if (preference === "tmux" || preference === "herdr") {
    return isBackendAvailable(preference) ? preference : null;
  }

  // Herdr must win when both marker sets coexist; nested/stale TMUX is common.
  if (isBackendAvailable("herdr")) return "herdr";
  if (isBackendAvailable("tmux")) return "tmux";
  return null;
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
  const preference = muxPreference();
  if (preference === "invalid") {
    return 'Set PI_SUBAGENT_MUX to exactly "tmux" or "herdr".';
  }
  if (preference === "tmux") {
    return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
  }
  if (preference === "herdr") {
    return "Start pi inside Herdr (`herdr`, then run `pi`).";
  }
  return "Start pi inside Herdr (`herdr`, then run `pi`) or tmux (`tmux new -A -s pi 'pi'`).";
}

function requireMuxAdapter(): MuxAdapter {
  const backend = getMuxBackend();
  if (!backend) {
    const prefix = muxPreference() === "invalid"
      ? `Invalid PI_SUBAGENT_MUX value ${JSON.stringify(process.env.PI_SUBAGENT_MUX)}.`
      : "No supported terminal multiplexer is available.";
    throw new Error(`${prefix} ${muxSetupHint()}`);
  }
  return muxAdapterFor(backend);
}

function adapterForSurface(surface: string): MuxAdapter {
  return surfaceAdapters.get(surface) ?? requireMuxAdapter();
}

function tagAdapterError(error: unknown, adapter: MuxAdapter): void {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    errorAdapters.set(error as object, adapter);
  }
}

function callAdapter<T>(adapter: MuxAdapter, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    tagAdapterError(error, adapter);
    throw error;
  }
}

async function callAdapterAsync<T>(adapter: MuxAdapter, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    tagAdapterError(error, adapter);
    throw error;
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Surface primitives ──

/** Create a new terminal surface for a subagent. */
export function createSurface(name: string): string {
  const adapter = requireMuxAdapter();
  const surface = callAdapter(adapter, () => adapter.createSurface(name));
  surfaceAdapters.set(surface, adapter);
  return surface;
}

/** Create a split in the requested direction from an optional source surface. */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const adapter = (fromSurface ? surfaceAdapters.get(fromSurface) : undefined)
    ?? requireMuxAdapter();
  const surface = callAdapter(
    adapter,
    () => adapter.createSurfaceSplit(name, direction, fromSurface),
  );
  surfaceAdapters.set(surface, adapter);
  return surface;
}

/** Send and execute one command in a surface. */
export function sendCommand(surface: string, command: string): void {
  const adapter = adapterForSurface(surface);
  callAdapter(adapter, () => adapter.sendCommand(surface, command));
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/** Read surface screen contents synchronously. */
export function readScreen(surface: string, lines = 50): string {
  const adapter = adapterForSurface(surface);
  return callAdapter(adapter, () => adapter.readScreen(surface, lines));
}

/** Read surface screen contents asynchronously. */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const adapter = adapterForSurface(surface);
  return callAdapterAsync(adapter, () => adapter.readScreenAsync(surface, lines));
}

/** Terminate the process in a surface and destroy the surface. */
export function killSurface(surface: string): void {
  const adapter = adapterForSurface(surface);
  try {
    callAdapter(adapter, () => adapter.killSurface(surface));
    surfaceAdapters.delete(surface);
  } catch (error) {
    if (adapter.isMissingSurfaceError(error)) surfaceAdapters.delete(surface);
    throw error;
  }
}

/** True only for the owning/selected backend's structured missing-surface errors. */
export function isMissingSurfaceError(error: unknown): boolean {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    const taggedAdapter = errorAdapters.get(error as object);
    if (taggedAdapter) return taggedAdapter.isMissingSurfaceError(error);
  }

  const preference = muxPreference();
  if (preference === "tmux" || preference === "herdr") {
    return muxAdapterFor(preference).isMissingSurfaceError(error);
  }
  const backend = getMuxBackend();
  // Preserve the historical tmux classifier when no backend can be selected.
  return muxAdapterFor(backend ?? "tmux").isMissingSurfaceError(error);
}

/** Close a pane after its child has exited; an already-absent pane is closed. */
export function closeSurface(surface: string): void {
  try {
    killSurface(surface);
  } catch (error) {
    if (!isMissingSurfaceError(error)) throw error;
  }
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error" | "disappeared";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and reports the pending question in its next immutable settled record.
 */
function interpretExitSidecar(data: unknown): PollResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const payload = data as Record<string, unknown>;
  if (payload.type === "done") return { reason: "done", exitCode: 0 };
  if (payload.type === "error") {
    const errorMessage =
      typeof payload.errorMessage === "string" && payload.errorMessage.trim() !== ""
        ? payload.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return null;
}

export const __pollForExitTest__ = { interpretExitSidecar };

function readTerminalSidecar(options: {
  sessionFile?: string;
  sentinelFile?: string;
}): PollResult | null {
  if (options.sessionFile) {
    try {
      const exitFile = `${options.sessionFile}.exit`;
      if (existsSync(exitFile)) {
        const data = JSON.parse(readFileSync(exitFile, "utf-8"));
        rmSync(exitFile, { force: true });
        return interpretExitSidecar(data);
      }
    } catch {
      // The writer may be between create and rename/write completion. A later
      // poll or disappearance confirmation rechecks the same sidecar.
    }
  }

  if (options.sentinelFile) {
    try {
      if (existsSync(options.sentinelFile)) {
        return { reason: "sentinel", exitCode: 0 };
      }
    } catch {}
  }

  return null;
}

function screenSentinel(screen: string): PollResult | null {
  const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
  return match
    ? { reason: "sentinel", exitCode: parseInt(match[1], 10) }
    : null;
}

function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection. A missing pane is confirmed once,
 * after a short bounded grace period for late sidecar publication, and then
 * becomes a terminal disappearance rather than an infinite poll.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
    /** Test seam for a hermetic pending-read/abort race. */
    readScreen?: (surface: string, lines: number) => Promise<string>;
  },
): Promise<PollResult> {
  const start = Date.now();
  const owningAdapter = surfaceAdapters.get(surface);
  const isMissing = owningAdapter
    ? (error: unknown) => owningAdapter.isMissingSurfaceError(error)
    : isMissingSurfaceError;

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    const terminalSidecar = readTerminalSidecar(options);
    if (terminalSidecar) return terminalSidecar;

    // Slow path: read terminal screen for sentinel (crash detection).
    const read = options.readScreen ?? readScreenAsync;
    try {
      const screen = await read(surface, 5);
      if (signal.aborted) {
        throw new Error("Aborted while waiting for subagent to finish");
      }
      const terminalScreen = screenSentinel(screen);
      if (terminalScreen) return terminalScreen;
    } catch (error) {
      if (signal.aborted) {
        throw new Error("Aborted while waiting for subagent to finish");
      }

      if (isMissing(error)) {
        // Child hooks and the shell can publish a sidecar at nearly the same time
        // the multiplexer reports the pane gone. Give that valid terminal signal
        // one bounded grace period, then confirm the pane is still absent. Never poll a known
        // missing pane indefinitely.
        const racedSidecar = readTerminalSidecar(options);
        if (racedSidecar) return racedSidecar;
        const confirmationDelay = Math.max(1, Math.min(options.interval, 250));
        await waitWithAbort(confirmationDelay, signal);
        const delayedSidecar = readTerminalSidecar(options);
        if (delayedSidecar) return delayedSidecar;

        try {
          const confirmationScreen = await read(surface, 5);
          if (signal.aborted) {
            throw new Error("Aborted while waiting for subagent to finish");
          }
          const terminalScreen = screenSentinel(confirmationScreen);
          if (terminalScreen) return terminalScreen;
          // A transient targeting/server race recovered. Continue normal polling.
        } catch (confirmationError) {
          if (signal.aborted) {
            throw new Error("Aborted while waiting for subagent to finish");
          }
          if (isMissing(confirmationError)) {
            const finalSidecar = readTerminalSidecar(options);
            if (finalSidecar) return finalSidecar;
            surfaceAdapters.delete(surface);
            return { reason: "disappeared", exitCode: 1 };
          }
          // A different multiplexer error does not prove that the pane is gone.
          // Treat it as transient and return to normal polling.
        }
      }
      // Non-missing multiplexer errors are transient unless a later capture
      // specifically and repeatedly proves that the target disappeared.
    }

    // Abort may happen while capture-pane is pending. Never cross the watcher
    // tick/question-delivery seam after kill, even if that read later resolves
    // or rejects successfully.
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }
    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await waitWithAbort(options.interval, signal);
  }
}
