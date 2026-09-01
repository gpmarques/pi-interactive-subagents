import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  lstatSync,
  unlinkSync,
  rmSync,
  renameSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  sendCommand,
  sendLongCommand,
  pollForExit,
  closeSurface,
  killSurface,
  isMissingSurfaceError,
  shellEscape,
  readScreen,
} from "./mux.ts";

import {
  activateReservedNameRun,
  claimCompletedNameRun,
  countSessionEntryLines,
  findLastAssistantMessage,
  getNewEntries,
  getSessionId,
  readNameRegistry,
  readSubagentLoadout,
  markNameRunCompleted,
  removeOwnedNameRun,
  reserveNameRun,
  resolveNameInRegistry,
  seedSubagentSessionFile,
  summarizeSessionStats,
  SUBAGENT_LIFECYCLE_TOOLS,
  writeSubagentLoadout,
  type PiWebAccessPackageIdentity,
  type SessionStats,
  type SubagentLoadout,
  type ToolExtensionIdentity,
} from "./session.ts";
import { preflightPiWebAccessCapabilities } from "./pi-web-access-runtime.ts";
import {
  type StatusSnapshot,
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));
const PI_WEB_ACCESS_PREFLIGHT_INSPECTOR = join(SUBAGENTS_DIR, "pi-web-access-preflight.ts");

// Survive /reload: clear timers from the previous module load. Poll loops are
// quiesced and awaited by session_shutdown before ownership is handed off; a
// top-level abort here would race that handoff and close live child surfaces.
// See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");
const RUNNING_HANDOFF_KEY = Symbol.for("pi-subagents/running-handoff");
const RUNNING_HANDOFF_VERSION = 1;

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (!prevAbort || prevAbort.signal.aborted) {
    (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
  }
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

const SubagentParams = Type.Object({
  agent: Type.String({
    description:
      "Which agent to spawn (e.g. 'worker', 'scout', 'researcher'). This loads the agent's " +
      "fixed profile — its model, tool loadout, and system prompt. Must be one of the available agents.",
  }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  name: Type.Optional(
    Type.String({
      description:
        "Optional cosmetic label for the subagent's pane and widget row. Defaults to the agent name. " +
        "Has no effect on which agent runs — use `agent` for that.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
});

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  /**
   * If set (non-empty), this agent is granted the full subagent spawning
   * toolset and may only spawn the listed agents. Presence of this field —
   * not the `tools` list — is what grants spawning. Enforced in the child via
   * the PI_SUBAGENT_ALLOWED env var.
   */
  subagentAgents?: string[];
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/**
 * The full subagent lifecycle/spawning toolset registered by this extension.
 * An agent is granted these (and this extension is loaded into its child
 * process) only when its frontmatter declares a non-empty `subagent_agents`.
 */
const SPAWNING_TOOLS = SUBAGENT_LIFECYCLE_TOOLS;

/**
 * A resumed session without a valid nested-spawn whitelist must not regain
 * lifecycle tools through ambient extension discovery (notably legacy
 * unrestricted loadouts). Restricted launches normally exclude this extension
 * via `--tools`; this env guard covers the unrestricted compatibility case.
 */
const LIFECYCLE_TOOLS_DISABLED = process.env.PI_SUBAGENT_LIFECYCLE_DISABLED === "1";

/** Built-in tools pi provides natively — no extension needs to be loaded. */
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return getAgentDir();
}

const PI_WEB_ACCESS_PACKAGE = "pi-web-access";
const SUPPORTED_PI_WEB_ACCESS_VERSION = "0.27.0";
const PI_WEB_ACCESS_SOURCE = `npm:${PI_WEB_ACCESS_PACKAGE}@${SUPPORTED_PI_WEB_ACCESS_VERSION}` as const;
const PI_WEB_ACCESS_TOOL_NAMES = {
  webSearch: "web_search",
  fetchContent: "fetch_content",
  getSearchContent: "get_search_content",
  sourceCheck: "source_check",
} as const;
const PI_WEB_ACCESS_TOOLS = new Set(Object.values(PI_WEB_ACCESS_TOOL_NAMES));

interface ResolvedPiWebAccess {
  extensionPath: string;
  packageIdentity: PiWebAccessPackageIdentity;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPathInside(root: string, candidate: string, allowRoot = false): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return allowRoot;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readCanonicalFile(path: string, boundaryRoot: string, label: string): {
  path: string;
  content: Buffer;
} {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(path);
    if (!statSync(canonicalPath).isFile()) throw new Error("not a file");
  } catch (error: any) {
    throw piWebAccessError(`${label} is unavailable at ${path}: ${error?.message ?? String(error)}`);
  }
  if (!isPathInside(boundaryRoot, canonicalPath)) {
    throw piWebAccessError(`${label} resolves outside its allowed root: ${path}`);
  }
  return { path: canonicalPath, content: readFileSync(canonicalPath) };
}

function configuredPackageSource(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return isPlainObject(value) && typeof value.source === "string" ? value.source : undefined;
}

function sourceLooksLikePiWebAccess(source: string, settingsDir: string): boolean {
  if (source.startsWith("npm:")) {
    return /^npm:pi-web-access(?:@|$)/.test(source);
  }

  const withoutFragment = source.replace(/[?#].*$/, "");
  const withoutRef = withoutFragment.replace(/@[^/@]*$/, "");
  const basenameLike = withoutRef
    .replace(/[\\/]+$/, "")
    .split(/[\\/:]/)
    .at(-1)
    ?.replace(/\.git$/, "");
  if (basenameLike === PI_WEB_ACCESS_PACKAGE) return true;

  if (/^(?:git:|https?:|ssh:|git:)/.test(source)) return false;
  try {
    const localPath = isAbsolute(source) ? source : resolve(settingsDir, source);
    const manifestPath = statSync(localPath).isDirectory()
      ? join(localPath, "package.json")
      : localPath;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return isPlainObject(manifest) && manifest.name === PI_WEB_ACCESS_PACKAGE;
  } catch {
    return false;
  }
}

function piWebAccessError(reason: string): Error {
  return new Error(
    `Cannot provide pi-web-access tools: ${reason}. ` +
      `Register, install, or repair exactly \`${PI_WEB_ACCESS_SOURCE}\` with ` +
      `\`pi install ${PI_WEB_ACCESS_SOURCE}\`, then start a fresh subagent; ` +
      "saved loadouts keep immutable canonical entrypoint, package/version/manifest, and full-config identity.",
  );
}

function readPiWebAccessRegistration(agentDir: string): {
  canonicalAgentDir: string;
  settingsPath: string;
} {
  let canonicalAgentDir: string;
  try {
    canonicalAgentDir = realpathSync(agentDir);
    if (!statSync(canonicalAgentDir).isDirectory()) throw new Error("not a directory");
  } catch (error: any) {
    throw piWebAccessError(
      `Pi's effective agent directory is unavailable at ${agentDir}: ${error?.message ?? String(error)}`,
    );
  }

  const settings = readCanonicalFile(
    join(agentDir, "settings.json"),
    canonicalAgentDir,
    "effective Pi settings",
  );
  if (settings.path !== join(canonicalAgentDir, "settings.json")) {
    throw piWebAccessError("effective Pi settings must not be a symlink or redirected path");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(settings.content.toString("utf8"));
  } catch (error: any) {
    throw piWebAccessError(`invalid effective Pi settings at ${settings.path}: ${error?.message ?? String(error)}`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.packages)) {
    throw piWebAccessError(`effective Pi settings at ${settings.path} must contain a packages array`);
  }

  const exact = parsed.packages.filter((entry) => entry === PI_WEB_ACCESS_SOURCE);
  const alternatives = parsed.packages
    .map(configuredPackageSource)
    .filter((source): source is string => !!source)
    .filter((source) => source !== PI_WEB_ACCESS_SOURCE && sourceLooksLikePiWebAccess(source, dirname(settings.path)));
  const filteredExact = parsed.packages.some(
    (entry) => isPlainObject(entry) && entry.source === PI_WEB_ACCESS_SOURCE,
  );
  if (exact.length !== 1 || alternatives.length > 0 || filteredExact) {
    const detail = alternatives.length > 0
      ? `; unsupported alternatives were also configured: ${alternatives.join(", ")}`
      : filteredExact
        ? "; object/filter registrations are not accepted"
        : "";
    throw piWebAccessError(
      `effective Pi settings must register exactly one unfiltered string \"${PI_WEB_ACCESS_SOURCE}\"${detail}`,
    );
  }

  return { canonicalAgentDir, settingsPath: settings.path };
}

function readRelevantPiWebAccessConfig(canonicalAgentDir: string): {
  configPath: string;
  configState: "absent" | "file";
  configSha256: string;
  relevantConfigSha256: string;
} {
  const declaredPath = join(canonicalAgentDir, "web-search.json");
  let configPath = declaredPath;
  let configState: "absent" | "file" = "absent";
  let configSha256 = sha256("pi-web-access-config-absent\0");
  let config: Record<string, unknown> = {};
  let configEntryExists = false;
  try {
    lstatSync(declaredPath);
    configEntryExists = true;
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw piWebAccessError(
        `pi-web-access config cannot be inspected at ${declaredPath}: ${error?.message ?? String(error)}`,
      );
    }
  }
  if (configEntryExists) {
    const configFile = readCanonicalFile(declaredPath, canonicalAgentDir, "pi-web-access config");
    if (configFile.path !== declaredPath) {
      throw piWebAccessError("pi-web-access config must not be a symlink or redirected path");
    }
    configPath = configFile.path;
    configState = "file";
    configSha256 = sha256(configFile.content);
    try {
      const parsed = JSON.parse(configFile.content.toString("utf8"));
      if (!isPlainObject(parsed)) throw new Error("expected a JSON object");
      config = parsed;
    } catch (error: any) {
      throw piWebAccessError(`invalid pi-web-access config at ${configPath}: ${error?.message ?? String(error)}`);
    }
  }

  const relevant: Record<string, unknown> = {};
  for (const section of ["webSearch", "tools", "toolNames"] as const) {
    relevant[section] = Object.hasOwn(config, section)
      ? { present: true, value: config[section] }
      : { present: false };
  }

  if (Object.hasOwn(config, "webSearch")) {
    if (!isPlainObject(config.webSearch)) {
      throw piWebAccessError(`webSearch in ${configPath} must be an object`);
    }
    if (
      Object.hasOwn(config.webSearch, "enabled") &&
      typeof config.webSearch.enabled !== "boolean"
    ) {
      throw piWebAccessError(`webSearch.enabled in ${configPath} must be a boolean`);
    }
    if (config.webSearch.enabled === false) {
      throw piWebAccessError(`webSearch.enabled in ${configPath} disables canonical web tools`);
    }
  }

  if (Object.hasOwn(config, "tools") && !isPlainObject(config.tools)) {
    throw piWebAccessError(`tools in ${configPath} must be an object`);
  }
  const toolsConfig = isPlainObject(config.tools) ? config.tools : {};
  for (const key of Object.keys(PI_WEB_ACCESS_TOOL_NAMES)) {
    if (!Object.hasOwn(toolsConfig, key)) continue;
    const value = toolsConfig[key];
    if (!isPlainObject(value)) {
      throw piWebAccessError(`tools.${key} in ${configPath} must be an object`);
    }
    if (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean") {
      throw piWebAccessError(`tools.${key}.enabled in ${configPath} must be a boolean`);
    }
    if (value.enabled === false) {
      throw piWebAccessError(`tools.${key}.enabled in ${configPath} disables a required canonical tool`);
    }
  }

  if (Object.hasOwn(config, "toolNames") && !isPlainObject(config.toolNames)) {
    throw piWebAccessError(`toolNames in ${configPath} must be an object`);
  }
  const configuredNames = isPlainObject(config.toolNames) ? config.toolNames : {};
  for (const [key, canonicalName] of Object.entries(PI_WEB_ACCESS_TOOL_NAMES)) {
    if (!Object.hasOwn(configuredNames, key)) continue;
    if (configuredNames[key] !== canonicalName) {
      throw piWebAccessError(
        `toolNames.${key} in ${configPath} must remain the canonical name \"${canonicalName}\"`,
      );
    }
  }

  return {
    configPath,
    configState,
    configSha256,
    relevantConfigSha256: sha256(JSON.stringify(relevant)),
  };
}

/** Resolve only the effectively registered user npm package and verify its declared four-tool surface. */
function resolvePiWebAccessMetadata(agentDir = getAgentConfigDir()): ResolvedPiWebAccess {
  const { canonicalAgentDir } = readPiWebAccessRegistration(agentDir);
  const declaredNpmRoot = join(agentDir, "npm", "node_modules");
  let canonicalNpmRoot: string;
  let packageRoot: string;
  try {
    canonicalNpmRoot = realpathSync(declaredNpmRoot);
    if (!statSync(canonicalNpmRoot).isDirectory()) throw new Error("npm root is not a directory");
    packageRoot = realpathSync(join(declaredNpmRoot, PI_WEB_ACCESS_PACKAGE));
    if (!statSync(packageRoot).isDirectory()) throw new Error("package root is not a directory");
  } catch (error: any) {
    throw piWebAccessError(
      `the registered package is unavailable under Pi's effective npm root ${declaredNpmRoot}: ${error?.message ?? String(error)}`,
    );
  }
  if (
    !isPathInside(canonicalNpmRoot, packageRoot) ||
    relative(canonicalNpmRoot, packageRoot) !== PI_WEB_ACCESS_PACKAGE
  ) {
    throw piWebAccessError(
      `the ${PI_WEB_ACCESS_PACKAGE} package root is symlinked or resolves outside Pi's effective npm root`,
    );
  }

  const manifestFile = readCanonicalFile(
    join(packageRoot, "package.json"),
    packageRoot,
    `${PI_WEB_ACCESS_PACKAGE} manifest`,
  );
  if (manifestFile.path !== join(packageRoot, "package.json")) {
    throw piWebAccessError(`${PI_WEB_ACCESS_PACKAGE} manifest must not be a symlink`);
  }

  let manifest: Record<string, any>;
  try {
    const parsed = JSON.parse(manifestFile.content.toString("utf8"));
    if (!isPlainObject(parsed)) throw new Error("expected a JSON object");
    manifest = parsed;
  } catch (error: any) {
    throw piWebAccessError(`invalid manifest at ${manifestFile.path}: ${error?.message ?? String(error)}`);
  }
  if (manifest.name !== PI_WEB_ACCESS_PACKAGE) {
    throw piWebAccessError(
      `invalid package identity at ${manifestFile.path} (expected name \"${PI_WEB_ACCESS_PACKAGE}\")`,
    );
  }
  if (manifest.version !== SUPPORTED_PI_WEB_ACCESS_VERSION) {
    throw piWebAccessError(
      `unsupported ${PI_WEB_ACCESS_PACKAGE} version ${JSON.stringify(manifest.version)}; ` +
        `verified compatibility requires exactly ${SUPPORTED_PI_WEB_ACCESS_VERSION}`,
    );
  }

  const extensions = manifest.pi?.extensions;
  if (
    !Array.isArray(extensions) ||
    extensions.length !== 1 ||
    typeof extensions[0] !== "string" ||
    extensions[0].trim() === ""
  ) {
    throw piWebAccessError(
      `invalid ${PI_WEB_ACCESS_PACKAGE} manifest at ${manifestFile.path} ` +
        "(pi.extensions must name exactly one concrete extension entrypoint)",
    );
  }

  const extensionSpec = extensions[0];
  const traversal = extensionSpec.split(/[\\/]+/).includes("..");
  if (
    extensionSpec !== extensionSpec.trim() ||
    /[\0\r\n]/.test(extensionSpec) ||
    isAbsolute(extensionSpec) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(extensionSpec) ||
    extensionSpec.startsWith("~") ||
    extensionSpec.includes("\\") ||
    traversal ||
    /[*?{}[\]!]/.test(extensionSpec)
  ) {
    throw piWebAccessError(
      `unsupported or escaping extension entrypoint in ${manifestFile.path}: ${extensionSpec}`,
    );
  }

  const declaredEntrypoint = resolve(packageRoot, extensionSpec);
  if (!isPathInside(packageRoot, declaredEntrypoint)) {
    throw piWebAccessError(
      `extension entrypoint escapes the package root in ${manifestFile.path}: ${extensionSpec}`,
    );
  }
  const extensionFile = readCanonicalFile(
    declaredEntrypoint,
    packageRoot,
    "pi-web-access extension entrypoint",
  );
  if (extensionFile.path !== declaredEntrypoint) {
    throw piWebAccessError("pi-web-access extension entrypoint must not be a symlink or redirected path");
  }
  const configIdentity = readRelevantPiWebAccessConfig(canonicalAgentDir);
  return {
    extensionPath: extensionFile.path,
    packageIdentity: {
      source: PI_WEB_ACCESS_SOURCE,
      packageRoot,
      packageName: PI_WEB_ACCESS_PACKAGE,
      packageVersion: manifest.version,
      manifestSha256: sha256(manifestFile.content),
      ...configIdentity,
    },
  };
}

function hasPiWebAccessTools(toolAllowlist: string | null): boolean {
  if (toolAllowlist === null) return false;
  const tools = new Set(toolAllowlist.split(","));
  const requested = [...PI_WEB_ACCESS_TOOLS].filter((tool) => tools.has(tool));
  if (requested.length > 0 && requested.length !== PI_WEB_ACCESS_TOOLS.size) {
    throw piWebAccessError("a restricted loadout must request all four canonical web tools together");
  }
  return requested.length === PI_WEB_ACCESS_TOOLS.size;
}

function findResolvedPiWebAccessExtension(
  toolExtensions: string[] | null,
  agentDir: string,
): string {
  let packageRoot: string;
  try {
    packageRoot = realpathSync(join(agentDir, "npm", "node_modules", PI_WEB_ACCESS_PACKAGE));
  } catch (error: any) {
    throw piWebAccessError(
      `validated package root became unavailable before capability preflight: ${error?.message ?? String(error)}`,
    );
  }
  const matches = (toolExtensions ?? []).filter((path) => isPathInside(packageRoot, path));
  if (matches.length !== 1) {
    throw piWebAccessError("the resolved restricted extension list does not contain exactly one package entrypoint");
  }
  return matches[0];
}

function preflightResolvedPiWebAccess(params: {
  cwd: string;
  agentDir: string;
  extensionPath: string;
}): { durationMs: number; piExecutable: string } {
  try {
    return preflightPiWebAccessCapabilities({
      ...params,
      inspectorPath: PI_WEB_ACCESS_PREFLIGHT_INSPECTOR,
    });
  } catch (error: any) {
    throw piWebAccessError(
      `fresh bounded offline Pi capability preflight failed: ${error?.message ?? String(error)}`,
    );
  }
}

function resolvePiWebAccessExtension(agentDir = getAgentConfigDir()): string {
  return resolvePiWebAccessMetadata(agentDir).extensionPath;
}

// ── Runtime tool-extension registration ─────────────────────────────────────
// `getToolExtensionPath` otherwise only knows a closed set of tool names. Other
// pi extensions that bundle a tool for subagents (e.g. a project-local
// extension exposing a bespoke tool) register its name → extension-file path
// here at load/session_start time so a child process can be launched with
// `--no-extensions` + an explicit `-e <path>` for it. Mirrors the legacy
// `subagents` extension's `registerToolExtension` hook.
const EXTRA_TOOL_EXTENSIONS = new Map<string, string>();

/** Register (or re-register) a custom tool's backing extension file. */
export function registerToolExtension(name: string, extensionPath: string): void {
  if (BUILTIN_TOOLS.has(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a built-in pi tool`);
  }
  if ((SPAWNING_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a spawning tool`);
  }
  if (PI_WEB_ACCESS_TOOLS.has(name)) {
    throw new Error(`Cannot register custom tool "${name}": reserved for ${PI_WEB_ACCESS_PACKAGE}`);
  }
  const existing = EXTRA_TOOL_EXTENSIONS.get(name);
  if (existing === extensionPath) return; // idempotent / reload-safe
  if (existing !== undefined) {
    throw new Error(
      `Tool extension already registered for "${name}": ${existing} (refusing to overwrite with ${extensionPath})`,
    );
  }
  EXTRA_TOOL_EXTENSIONS.set(name, extensionPath);
}

// Expose registration on a process-global so project-local extensions loaded
// via jiti (separate module instances) can reach this shared map. Set at module
// load so it's available before any `session_start` listener runs.
(globalThis as any).__pi_interactive_subagents = {
  registerToolExtension,
};

/**
 * Map a custom (non-built-in) tool name to the pi-extension file that
 * registers it. Used to build the child's `--extension` whitelist after
 * `--no-extensions` disables global discovery. Returns undefined for built-in
 * tools and for unknown names (which simply won't be granted). Requested
 * pi-web-access tools instead fail closed when the named package or its
 * manifest entrypoint cannot be validated.
 */
function getToolExtensionPath(
  tool: string,
  agentDir = getAgentConfigDir(),
): string | undefined {
  if (BUILTIN_TOOLS.has(tool)) return undefined;
  if (tool === "ask_question") return join(SUBAGENTS_DIR, "subagent-done.ts");
  // The spawning/lifecycle tools are registered by THIS extension.
  if ((SPAWNING_TOOLS as readonly string[]).includes(tool)) {
    return fileURLToPath(import.meta.url);
  }
  if (PI_WEB_ACCESS_TOOLS.has(tool)) {
    return resolvePiWebAccessExtension(agentDir);
  }
  const extBase = join(agentDir, "extensions");
  const map: Record<string, string> = {
    video_extract: join(extBase, "video-extract", "index.ts"),
    youtube_search: join(extBase, "youtube-search", "index.ts"),
    google_image_search: join(extBase, "google-image-search", "index.ts"),
    safe_bash: join(SUBAGENTS_DIR, "tools", "safe-bash.ts"),
  };
  // Prefer the built-in path, but fall back to a runtime-registered extension
  // when that path no longer exists on disk (e.g. a built-in tool extension
  // was disabled/removed but a project-local extension re-registered it).
  const builtin = map[tool];
  if (builtin && existsSync(builtin)) return builtin;
  return EXTRA_TOOL_EXTENSIONS.get(tool);
}

/**
 * When this process was spawned as a restricted subagent, the parent pins the
 * set of agents it may itself spawn via PI_SUBAGENT_ALLOWED. `null` means no
 * restriction (top-level session, or an unrestricted child).
 */
const SUBAGENT_ALLOWLIST: Set<string> | null = (() => {
  const raw = process.env.PI_SUBAGENT_ALLOWED;
  if (!raw) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
})();

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

/** Parse a comma-separated frontmatter value into a trimmed list (or undefined). */
function parseCommaList(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    subagentAgents: parseCommaList(getFrontmatterValue(frontmatter, "subagent_agents")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  // When this process is itself a restricted subagent, only expose the agents
  // it is permitted to spawn (PI_SUBAGENT_ALLOWED). Top-level sessions see all.
  const all = [...agents.values()];
  return SUBAGENT_ALLOWLIST ? all.filter((a) => SUBAGENT_ALLOWLIST.has(a.name)) : all;
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` frontmatter field on the agent.
 *   2. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, researcher) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (worker) and stall pings are noise.
 */
function resolveEffectiveInteractive(
  _params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/** Compact token count: 850, 3.2k, 45k. */
function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/**
 * Known context-window sizes by model id substring, used for the context-usage
 * gauge. Unknown models fall back to a window-less "Nk ctx" label.
 */
function contextWindowFor(model: string | null | undefined): number | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes("claude")) return 200_000;
  if (m.includes("gpt-4.1") || m.includes("gpt-4o")) return 128_000;
  if (m.includes("gemini")) return 1_000_000;
  return undefined;
}

/** Context-usage gauge: "18.0%/200k" when window known, else "37k ctx". */
function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
  if (!contextWindow) return `${formatTokens(tokens)} ctx`;
  const pct = (tokens / contextWindow) * 100;
  const maxStr =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1000)}k`;
  return `${pct.toFixed(1)}%/${maxStr}`;
}

/**
 * Build the dim usage line for a completed subagent, mirroring the format of
 * the in-process subagents extension: "↑in ↓out R… W… $cost · ctx".
 * `theme.fg` is applied by the caller; this returns plain segments joined.
 */
function formatUsageSegments(stats: SessionStats): string[] {
  const segs: string[] = [];
  if (stats.inputTokens) segs.push(`↑${formatTokens(stats.inputTokens)}`);
  if (stats.outputTokens) segs.push(`↓${formatTokens(stats.outputTokens)}`);
  if (stats.cacheReadTokens) segs.push(`R${formatTokens(stats.cacheReadTokens)}`);
  if (stats.cacheWriteTokens) segs.push(`W${formatTokens(stats.cacheWriteTokens)}`);
  if (stats.cost) segs.push(`$${stats.cost.toFixed(3)}`);
  return segs;
}

/** ANSI colors for widget status icons (raw, since the widget bypasses theme). */
const ICON_GREEN = "\x1b[38;2;126;186;103m";
const ICON_YELLOW = "\x1b[38;2;214;181;94m";
const ICON_RED = "\x1b[38;2;224;108;117m";
const ICON_DIM = "\x1b[38;2;128;128;128m";

/** Map a live status kind to a colored single-char icon for the widget. */
function widgetIcon(kind: StatusSnapshot["kind"]): string {
  switch (kind) {
    case "active":
    case "running":
      return `${ICON_YELLOW}⟳${RST}`;
    case "stalled":
      return `${ICON_RED}⟳${RST}`;
    case "waiting":
    case "starting":
    default:
      return `${ICON_DIM}○${RST}`;
  }
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
      },
    ],
    details: { error: "terminal multiplexer not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

const statusConfig = loadStatusConfig();

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "sessionId" | "errorMessage"
  > & { terminalProof?: TerminalProof },
  name: string,
): string {
  if (result.terminalProof === "unproven") {
    return `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}`;
  }

  // Completion leaves the parent-scoped name resumable. Prefer the explicit
  // completed-only tool; subagent_message retains its compatibility fallback.
  const sessionRef =
    `\n\nResume completed work with subagent_resume({ name: "${name}", message: "…" }). ` +
    `subagent_message remains compatible and is the tool for live steering.`;

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or safely resume this completed session.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
type TerminalProof = "natural" | "termination-confirmed" | "unproven";

interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  /** Canonical session header id, used for follow-ups via subagent_message. */
  sessionId?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  /** Aggregate usage/model/tool stats parsed from the completed session file. */
  stats?: SessionStats;
  /** Internal proof governing whether durable running ownership may be completed. */
  terminalProof: TerminalProof;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  /** Session entry count captured before this process was launched. */
  sessionEntryCountBefore?: number;
  /** Finalized settled record names already accepted by the parent API. */
  deliveredSettledRecords?: Set<string>;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  /** Settles only after the watcher's delivery continuation has finished. */
  watcherContinuation?: Promise<void>;
  /** Suppress cleanup and delivery while ownership moves to a reloaded module. */
  reloadQuiescing?: boolean;
  /** Naturally completed result awaiting delivery by the reloaded module. */
  reloadPendingResult?: SubagentResult;
  /** Artifact directory containing this caller's persistent name registry. */
  registryArtifactDir: string;
  /** Set before termination so the watcher cannot deliver a stale result. */
  killed?: boolean;
  cli?: string;
  sentinelFile?: string;
  statusState: SubagentStatusState;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

// When this extension is loaded inside a subagent that itself spawns children
// (e.g. a worker delegating to scout/researcher), `subagent-done.ts` runs in the
// same process and needs to know whether this session still has children in
// flight — so it can suppress auto-exit and keep the session open until they all
// report back. Expose a live count through a process-global symbol that both
// modules share. (subagent-done.ts reads it; if absent it assumes zero.)
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = () => runningSubagents.size;

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;
/** Latest ExtensionAPI, used to deliver live child notifications from the watcher. */
let latestPi: ExtensionAPI | null = null;

/** Result delivery must schedule a fresh parent turn, never steer the active one. */
const SUBAGENT_RESULT_DELIVERY_OPTIONS = {
  triggerTurn: true,
  deliverAs: "followUp",
} as const;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const icon = widgetIcon(snapshot.kind);
    const left = ` ${icon} ${elapsed}  ${agent.name}${agentTag} `;
    const right = statusConfig.enabled
      ? formatWidgetRightLabel(snapshot)
      : agent.cli === "claude"
        ? " running… "
        : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
const SUBAGENT_CONTROL_TOOLS = ["ask_question"] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call ask_question.
 */
function buildSubagentToolAllowlist(
  effectiveTools?: string,
  opts?: { grantSpawning?: boolean },
): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  const grantSpawning = opts?.grantSpawning ?? false;

  // Named profiles are fail-closed even when they omit `tools`: allow only the
  // child lifecycle control tool so --no-extensions is still applied. A null
  // allowlist remains reserved for legacy unrestricted loadout snapshots and
  // is handled by applySandboxToParts when replaying them.

  // Lifecycle tools are granted only as a bundle to profiles that declare
  // nested agents. Do not let an explicit `tools` entry bypass that gate.
  const allow = new Set(
    requested.filter(
      (tool) => grantSpawning || !(SPAWNING_TOOLS as readonly string[]).includes(tool),
    ),
  );
  if (grantSpawning) {
    for (const tool of SPAWNING_TOOLS) allow.add(tool);
  }
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

const CLAUDE_TOOL_BY_PROFILE_TOOL: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  find: "Glob",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
};

/** Translate only capability-equivalent profile tools into Claude built-ins. */
function resolveClaudeToolPolicy(
  effectiveTools?: string,
  spawnable?: string[],
): { tools: string[] } | { error: string } {
  if (spawnable && spawnable.length > 0) {
    return {
      error:
        "Claude CLI profiles cannot declare subagent_agents: Pi lifecycle/spawning tools " +
        "cannot be enforced inside Claude Code.",
    };
  }

  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  const unsupported = requested.filter((tool) => !CLAUDE_TOOL_BY_PROFILE_TOOL[tool]);
  if (unsupported.length > 0) {
    return {
      error:
        `Claude CLI cannot safely honor profile tool restriction(s): ${unsupported.join(", ")}. ` +
        `Supported profile tools: ${Object.keys(CLAUDE_TOOL_BY_PROFILE_TOOL).join(", ")}.`,
    };
  }

  return { tools: [...new Set(requested.map((tool) => CLAUDE_TOOL_BY_PROFILE_TOOL[tool]))] };
}

/** Return an error unless installed Claude help advertises every policy primitive we rely on. */
function claudePolicyHelpError(help: string): string | null {
  const required = [
    { label: "--tools", present: help.includes("--tools <tools...>") },
    {
      label: "--allowedTools",
      present: help.includes("--allowedTools") || help.includes("--allowed-tools"),
    },
    {
      label: "--permission-mode dontAsk",
      present: help.includes("--permission-mode") && help.includes("dontAsk"),
    },
    { label: "--setting-sources", present: help.includes("--setting-sources") },
    { label: "--mcp-config", present: help.includes("--mcp-config") },
    { label: "--strict-mcp-config", present: help.includes("--strict-mcp-config") },
  ];
  const missing = required.filter((item) => !item.present).map((item) => item.label);
  return missing.length > 0
    ? `Installed Claude CLI cannot enforce the required fail-closed policy; missing help semantics: ${missing.join(", ")}.`
    : null;
}

function applyClaudeToolPolicy(parts: string[], tools: string[]): void {
  const toolList = tools.join(",");
  parts.push("--tools", shellEscape(toolList));
  if (tools.length > 0) {
    parts.push("--allowedTools", shellEscape(toolList));
  }
  parts.push("--permission-mode", "dontAsk");
  parts.push("--setting-sources", shellEscape(""));
  parts.push("--strict-mcp-config");
  parts.push("--mcp-config", shellEscape('{"mcpServers":{}}'));
}

let claudePolicyHelpVerified = false;

function verifyInstalledClaudePolicy(): void {
  if (claudePolicyHelpVerified) return;
  let help: string;
  try {
    help = execFileSync("claude", ["--help"], { encoding: "utf8" });
  } catch (error: any) {
    throw new Error(`Cannot verify Claude CLI tool policy: ${error?.message ?? String(error)}`);
  }
  const policyError = claudePolicyHelpError(help);
  if (policyError) throw new Error(policyError);
  claudePolicyHelpVerified = true;
}

/**
 * Apply a loadout snapshot's sandbox to a pi command's `parts` array: model,
 * identity (system prompt), and the default-deny tool/extension restriction
 * (`--no-extensions` + `--tools` + one `-e` per tool-backing extension).
 *
 * This is the single source of truth for reconstructing a subagent's sandbox,
 * used both by the initial `launchSubagent` and by the shared safe resume path
 * behind `subagent_resume` and `subagent_message`, so they can never drift.
 * Env vars (PI_SUBAGENT_AGENT /
 * PI_SUBAGENT_ALLOWED / PI_CODING_AGENT_DIR) and cwd are the caller's
 * responsibility since they differ slightly between launch and resume.
 */
function resolveToolBackingExtensions(
  toolAllowlist: string | null,
  agentDir = getAgentConfigDir(),
): string[] | null {
  if (toolAllowlist === null) return null;
  const extensionPaths = new Set<string>();
  let piWebAccessExtension: string | undefined;
  for (const tool of toolAllowlist.split(",")) {
    const isPiWebAccessTool = PI_WEB_ACCESS_TOOLS.has(tool);
    const extensionPath = isPiWebAccessTool
      ? (piWebAccessExtension ??= resolvePiWebAccessExtension(agentDir))
      : getToolExtensionPath(tool, agentDir);
    if (!extensionPath) continue;
    try {
      const canonicalPath = realpathSync(extensionPath);
      if (!statSync(canonicalPath).isFile()) throw new Error("not a file");
      extensionPaths.add(canonicalPath);
    } catch (error: any) {
      if (isPiWebAccessTool) {
        throw piWebAccessError(
          `validated extension entrypoint became unavailable: ${extensionPath} ` +
            `(${error?.message ?? String(error)})`,
        );
      }
      throw new Error(
        `Tool-backing extension is unavailable for \"${tool}\": ${extensionPath} ` +
          `(${error?.message ?? String(error)})`,
      );
    }
  }
  return [...extensionPaths];
}

function createToolExtensionIdentities(
  toolExtensions: string[] | null,
  toolAllowlist: string | null,
  agentDir = getAgentConfigDir(),
): ToolExtensionIdentity[] | null {
  if (toolExtensions === null || toolAllowlist === null) return null;
  const needsPiWebAccess = hasPiWebAccessTools(toolAllowlist);
  const piWebAccess = needsPiWebAccess ? resolvePiWebAccessMetadata(agentDir) : undefined;

  const identities = toolExtensions.map((extensionPath) => {
    const canonicalPath = realpathSync(extensionPath);
    if (!statSync(canonicalPath).isFile()) {
      throw new Error(`Tool-backing extension is not a file: ${extensionPath}`);
    }
    const identity: ToolExtensionIdentity = {
      path: canonicalPath,
      sha256: sha256(readFileSync(canonicalPath)),
    };
    if (piWebAccess && canonicalPath === piWebAccess.extensionPath) {
      identity.piWebAccess = piWebAccess.packageIdentity;
    }
    return identity;
  });
  if (piWebAccess && !identities.some((identity) => identity.piWebAccess)) {
    throw piWebAccessError(
      "the validated extension entrypoint changed while its immutable launch identity was being captured",
    );
  }
  return identities;
}

function samePiWebAccessIdentity(
  saved: PiWebAccessPackageIdentity,
  current: PiWebAccessPackageIdentity,
): boolean {
  return saved.source === current.source &&
    saved.packageRoot === current.packageRoot &&
    saved.packageName === current.packageName &&
    saved.packageVersion === current.packageVersion &&
    saved.manifestSha256 === current.manifestSha256 &&
    saved.configPath === current.configPath &&
    saved.configState === current.configState &&
    saved.configSha256 === current.configSha256 &&
    saved.relevantConfigSha256 === current.relevantConfigSha256;
}

function verifySavedToolExtensions(loadout: SubagentLoadout): string | null {
  if (loadout.toolAllowlist === null) {
    return loadout.toolExtensions === null && loadout.toolExtensionIdentities === null
      ? null
      : "the unrestricted snapshot has inconsistent extension identity fields";
  }
  if (!loadout.toolExtensions || !loadout.toolExtensionIdentities) {
    return "the restricted snapshot does not contain exact tool-backing extension identities";
  }
  if (loadout.toolExtensions.length !== loadout.toolExtensionIdentities.length) {
    return "the saved extension path and identity counts differ";
  }

  let webToolsRequested: boolean;
  try {
    webToolsRequested = hasPiWebAccessTools(loadout.toolAllowlist);
  } catch (error: any) {
    return error?.message ?? String(error);
  }
  const webIdentities = loadout.toolExtensionIdentities.filter((identity) => identity.piWebAccess);
  if (webToolsRequested !== (webIdentities.length === 1)) {
    return "the saved pi-web-access tool request and package identity do not match";
  }

  let currentPiWebAccess: ResolvedPiWebAccess | undefined;
  for (let index = 0; index < loadout.toolExtensions.length; index++) {
    const savedPath = loadout.toolExtensions[index];
    const identity = loadout.toolExtensionIdentities[index];
    if (identity.path !== savedPath) {
      return `saved extension identity path does not match its loadout path: ${savedPath}`;
    }

    let canonicalPath: string;
    try {
      canonicalPath = realpathSync(savedPath);
      if (!statSync(canonicalPath).isFile()) throw new Error("not a file");
    } catch (error: any) {
      return `saved tool-backing extension is unavailable: ${savedPath} (${error?.message ?? String(error)})`;
    }
    if (canonicalPath !== savedPath) {
      return `saved tool-backing extension path drifted or was replaced by a symlink: ${savedPath}`;
    }
    if (sha256(readFileSync(canonicalPath)) !== identity.sha256) {
      return `saved tool-backing extension digest drifted: ${savedPath}`;
    }

    if (identity.piWebAccess) {
      if (!loadout.agentDir) {
        return "the pi-web-access identity has no saved effective Pi agent directory";
      }
      try {
        currentPiWebAccess ??= resolvePiWebAccessMetadata(loadout.agentDir);
      } catch (error: any) {
        return error?.message ?? String(error);
      }
      if (currentPiWebAccess.extensionPath !== savedPath) {
        return "the effective pi-web-access extension path no longer matches the saved canonical path";
      }
      if (!samePiWebAccessIdentity(identity.piWebAccess, currentPiWebAccess.packageIdentity)) {
        return "the effective pi-web-access package/version/manifest or full config identity drifted";
      }
    }
  }
  return null;
}

function applySandboxToParts(
  parts: string[],
  loadout: SubagentLoadout,
  opts: { artifactDir: string; name: string },
): void {
  if (loadout.model) {
    const model = loadout.thinking ? `${loadout.model}:${loadout.thinking}` : loadout.model;
    parts.push("--model", shellEscape(model));
  }

  if (loadout.identity) {
    const flag = loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = opts.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const spPath = join(opts.artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(spPath), { recursive: true });
    writeFileSync(spPath, loadout.identity, "utf8");
    parts.push(flag, shellEscape(spPath));
  }

  // Default-deny: disable global extension discovery and re-enable only the
  // extensions backing the whitelisted tools. A null allowlist means the spawn
  // was intentionally unrestricted (e.g. a fork clone) and is replayed as-is.
  if (loadout.toolAllowlist !== null) {
    parts.push("--no-extensions");
    parts.push("--tools", shellEscape(loadout.toolAllowlist));

    for (const extensionPath of loadout.toolExtensions ?? []) {
      parts.push("-e", shellEscape(extensionPath));
    }
  }
}

function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  if (running.cli === "claude") return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
    }, observedAt);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt);
}

/**
 * Names claimed by spawns that are mid-launch but not yet registered in
 * `runningSubagents`. Parallel `subagent` tool calls run their synchronous
 * prefix (name defaulting) before any of them finishes `launchSubagent` and
 * registers, so without this they'd all see an empty map and pick the same
 * name. Reserved synchronously for explicit and defaulted names, then released
 * once the subagent registers (or its launch fails).
 */
const reservedNames = new Set<string>();

/**
 * Return `base`, or `base-2`, `base-3`, … so the result is unique within this
 * spawner session. Considers (a) currently-running subagents, (b) names
 * reserved by parallel in-flight spawns, and (c) every name already recorded in
 * the spawner's persistent registry — so an explicit or defaulted name never
 * collides with a finished subagent. This lets `subagent_message({ name })` address any
 * subagent of this session unambiguously, running or finished.
 *
 * `registryNames` is the set of names already taken in the registry (empty when
 * there is no session file / artifact dir yet).
 */
function uniqueRunningName(base: string, registryNames?: Set<string>): string {
  const taken = new Set(Array.from(runningSubagents.values()).map((r) => r.name));
  for (const reserved of reservedNames) taken.add(reserved);
  if (registryNames) for (const n of registryNames) taken.add(n);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

interface SpawnNameReservation {
  artifactDir: string;
  name: string;
  runId: string;
}

/** Choose and durably reserve the final public name before launch awaits. */
function reserveSpawnName(
  requestedName: string | undefined,
  agentName: string,
  registryArtifactDir: string,
): SpawnNameReservation {
  const base = requestedName?.trim() || agentName;
  const runId = Math.random().toString(16).slice(2, 10);
  const name = reserveNameRun(registryArtifactDir, base, runId);
  reservedNames.add(name);
  return { artifactDir: registryArtifactDir, name, runId };
}

function releaseSpawnName(reservation: SpawnNameReservation): void {
  reservedNames.delete(reservation.name);
  try {
    removeOwnedNameRun(
      reservation.artifactDir,
      reservation.name,
      "",
      reservation.runId,
      "pending",
    );
  } catch {
    // An uncertain cleanup leaves the durable pending claim fail-closed.
  }
}

function resolveRunningByName(name: string):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedName = name.trim();
  if (!requestedName) {
    return { error: "Provide the exact display name of a running subagent." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    const names = Array.from(runningSubagents.values()).map((r) => r.name);
    const hint = names.length
      ? ` Currently running: ${[...new Set(names)].join(", ")}.`
      : " No subagents are currently running.";
    return { error: `No running subagent named "${requestedName}".${hint}` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

/**
 * Type a follow-up message into a running subagent's live pane. Newlines are
 * collapsed to spaces because each newline submits a turn in the child's TUI
 * editor; a multi-line message would otherwise fire as several partial turns.
 */
function steerSubagent(
  running: RunningSubagent,
  message: string,
  send: (surface: string, command: string) => void = sendCommand,
): { ok: true } | { error: string } {
  const flattened = message.replace(/\s*\n\s*/g, " ").trim();
  try {
    send(running.surface, flattened);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to deliver message to subagent "${running.name}" via the terminal multiplexer: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentSteer(
  params: { name?: string; message?: string },
  send: (surface: string, command: string) => void = sendCommand,
) {
  const message = params.message?.trim();
  if (!message) {
    const err = "`message` is required to steer a running subagent.";
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  const resolved = resolveRunningByName(params.name ?? "");
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const now = Date.now();
  observeRunningSubagent(running, now);

  const steer = steerSubagent(running, message, send);
  if ("error" in steer) {
    return {
      content: [{ type: "text" as const, text: steer.error }],
      details: { error: steer.error, id: running.id, name: running.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  updateWidget();

  return {
    content: [{
      type: "text" as const,
      text:
        `Message delivered to running subagent "${running.name}". It picks this up at its next ` +
        `turn boundary. When it settles, its next result or idle report still arrives automatically.`,
    }],
    details: { id: running.id, name: running.name, status: "steered" },
  };
}

type TerminateSurface = (surface: string) => void;

function shouldSuppressWatcherMessage(running: RunningSubagent): boolean {
  return running.killed === true || running.reloadQuiescing === true;
}

// Compatibility cleanup for stale files created by older child extensions.
function discardLegacyQuestionArtifacts(sessionFile: string): void {
  const directory = dirname(sessionFile);
  const prefix = `${basename(sessionFile)}.ask`;
  try {
    for (const name of readdirSync(directory)) {
      if (name === prefix || name.startsWith(`${prefix}.`)) {
        try {
          unlinkSync(join(directory, name));
        } catch {}
      }
    }
  } catch {}
}

function discardSettledRecords(sessionFile: string): void {
  try {
    rmSync(`${sessionFile}.idle`, { recursive: true, force: true });
  } catch {}
}

/**
 * Terminate a running child and forget its persistent name. Termination is
 * attempted first: generic multiplexer failures retain tracking because the
 * process may still be alive; a recognized already-missing pane completes cleanup.
 */
function killSubagent(
  running: RunningSubagent,
  terminate: TerminateSurface = killSurface,
): { ok: true } | { error: string } {
  try {
    terminate(running.surface);
  } catch (error: any) {
    if (!isMissingSurfaceError(error)) {
      return {
        error:
          `Failed to terminate subagent "${running.name}" via the terminal multiplexer; ` +
          `its process may still be running: ${error?.message ?? String(error)}`,
      };
    }
    // The requested terminal state already holds. Complete the same cleanup
    // and suppression path as a successful kill instead of reviving tracking.
  }

  // Set this before aborting/removing anything. Any watcher completion queued
  // by the pane termination must observe it and suppress its follow-up notification.
  running.killed = true;
  discardLegacyQuestionArtifacts(running.sessionFile);
  discardSettledRecords(running.sessionFile);
  let watcherAbortError: string | undefined;
  try {
    running.abortController?.abort();
  } catch (error: any) {
    watcherAbortError = error?.message ?? String(error);
  }
  if (runningSubagents.get(running.id) === running) {
    runningSubagents.delete(running.id);
  }
  updateWidget();

  try {
    const removed = removeOwnedNameRun(
      running.registryArtifactDir,
      running.name,
      running.sessionFile,
      running.id,
      "running",
    );
    // false means the mapping was already absent or was replaced by a newer
    // session. In either case, never delete the newer mapping.
    void removed;
    if (watcherAbortError) {
      return {
        error:
          `Subagent "${running.name}" was terminated, but its watcher could not be aborted: ` +
          watcherAbortError,
      };
    }
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Subagent "${running.name}" was terminated, but its name registry could not be cleaned up: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentKill(
  params: { name?: string },
  terminate: TerminateSurface = killSurface,
) {
  const resolved = resolveRunningByName(params.name ?? "");
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const result = killSubagent(resolved.running, terminate);
  if ("error" in result) {
    return {
      content: [{ type: "text" as const, text: result.error }],
      details: { error: result.error, name: resolved.running.name },
    };
  }
  return {
    content: [{
      type: "text" as const,
      text: `Killed subagent "${resolved.running.name}" and forgot its name.`,
    }],
    details: { name: resolved.running.name, status: "killed" },
  };
}

function createSpawnStartedAcknowledgement(
  running: Pick<
    RunningSubagent,
    "id" | "name" | "task" | "agent" | "sessionFile" | "launchScriptFile"
  >,
) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Sub-agent "${running.name}" launched and is now running in the background. ` +
          `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
          `When it settles, the harness will automatically deliver its final result if it exited or an idle report if it remains alive. ` +
          `Until then, move on to other work or tell the user you're waiting.`,
      },
    ],
    details: {
      id: running.id,
      name: running.name,
      task: running.task,
      agent: running.agent,
      sessionFile: running.sessionFile,
      launchScriptFile: running.launchScriptFile,
      status: "started",
    },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

// Resuming a finished session is always autonomous: the relaunched agent runs
// its follow-up task to completion and the harness delivers the result as a
// follow-up notification (fire-and-forget). An interactive resume would park the pane
// waiting for the user, contradicting that result-delivery model.
function resolveResumeLaunchBehavior(): { autoExit: boolean; interactive: boolean } {
  return { autoExit: true, interactive: false };
}

type ResumeCaller = "explicit" | "message";

type ResumeContext = {
  sessionManager: {
    getSessionFile(): string | null;
    getSessionId(): string;
    getSessionDir(): string;
  };
  cwd: string;
};

interface ResumeReservation {
  nameKey: string;
  sessionKey: string;
}

const reservedResumeNames = new Set<string>();
const reservedResumeSessions = new Set<string>();

function resumeError(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details: { error: text, ...details },
  };
}

function resumeNameKey(parentArtifactDir: string, name: string): string {
  return `${resolve(parentArtifactDir)}\0${name}`;
}

function releaseResumeReservation(reservation: ResumeReservation): void {
  reservedResumeNames.delete(reservation.nameKey);
  reservedResumeSessions.delete(reservation.sessionKey);
}

function reserveCompletedResume(params: {
  parentArtifactDir: string;
  name: string;
  sessionFile: string;
}): { reservation: ResumeReservation } | {
  conflict: "running" | "resuming";
  runningName?: string;
} {
  const sessionKey = resolve(params.sessionFile);
  const running = Array.from(runningSubagents.values()).find(
    (candidate) =>
      candidate.name === params.name || resolve(candidate.sessionFile) === sessionKey,
  );
  if (running) {
    return { conflict: "running", runningName: running.name };
  }

  const nameKey = resumeNameKey(params.parentArtifactDir, params.name);
  if (reservedResumeNames.has(nameKey) || reservedResumeSessions.has(sessionKey)) {
    return { conflict: "resuming" };
  }

  const reservation = { nameKey, sessionKey };
  reservedResumeNames.add(nameKey);
  reservedResumeSessions.add(sessionKey);
  return { reservation };
}

function resumeConflictMessage(
  name: string,
  conflict: "running" | "resuming",
  runningName: string | undefined,
  caller: ResumeCaller,
): string {
  if (conflict === "running") {
    const target = runningName ?? name;
    return caller === "explicit"
      ? `Cannot resume "${name}": that name or its mapped session is currently running as "${target}". ` +
          `Use subagent_message({ name: "${target}", message: "…" }) to steer the live session.`
      : `Subagent "${name}" maps to a session currently running as "${target}". ` +
          `Use subagent_message with the exact running name "${target}" to steer it.`;
  }

  return caller === "explicit"
    ? `Cannot resume "${name}": that name or its mapped session is already resuming. ` +
        `Do not launch it again; once it is live, use subagent_message for additional instructions.`
    : `Subagent "${name}" is already resuming. No second process was launched; ` +
        `wait for automatic result delivery or message it once the live session is registered.`;
}

/**
 * Safely relaunch one completed, parent-scoped Pi session. Both public resume
 * entrypoints use this implementation so registry scoping, validation,
 * sandbox replay, reservations, watcher delivery, and current-run extraction
 * cannot drift.
 */
async function resumeRegisteredSubagent(
  pi: ExtensionAPI,
  params: { name?: string; message?: string },
  signal: AbortSignal | undefined,
  ctx: ResumeContext,
  caller: ResumeCaller,
) {
  const name = params.name?.trim();
  if (!name) {
    return resumeError("Provide the completed subagent's exact `name`.");
  }
  const message = params.message;
  if (typeof message !== "string" || message.trim() === "") {
    return resumeError("Provide a non-empty follow-up `message`.", { name });
  }
  if (!isMuxAvailable()) return muxUnavailableResult();

  const parentArtifactDir = getArtifactDir(
    ctx.sessionManager.getSessionDir(),
    ctx.sessionManager.getSessionId(),
  );
  const entry = resolveNameInRegistry(parentArtifactDir, name);
  if (!entry) {
    const known = Object.keys(readNameRegistry(parentArtifactDir));
    return resumeError(
      `No completed subagent named "${name}" in this parent session. ` +
        (known.length > 0
          ? `Known subagents: ${known.join(", ")}.`
          : "No subagents have been spawned in this session yet."),
      { name },
    );
  }

  const sessionPath = entry.sessionFile;
  if (!sessionPath || !existsSync(sessionPath)) {
    return resumeError(
      `Subagent "${name}" is registered in this parent session, but its session file is gone ` +
        `(${sessionPath}). It cannot be resumed. Spawn a fresh subagent instead.`,
      { name },
    );
  }

  // This synchronous name+session reservation is deliberately acquired before
  // the first await. Parallel resume/message calls cannot both reach pane
  // creation or mutate the same JSONL.
  const reserved = reserveCompletedResume({
    parentArtifactDir,
    name,
    sessionFile: sessionPath,
  });
  if ("conflict" in reserved) {
    return resumeError(
      resumeConflictMessage(name, reserved.conflict, reserved.runningName, caller),
      { name, status: reserved.conflict },
    );
  }
  const reservation = reserved.reservation;

  let surface: string | undefined;
  let claimedRunId: string | undefined;
  let handedOff = false;
  let safeToRollbackClaim = true;
  let uncertainRunning: RunningSubagent | undefined;
  try {
    // A valid sidecar and every saved backing extension are required before
    // pane/process creation. There is no profile rediscovery or ambient fallback.
    const loadout = readSubagentLoadout(sessionPath);
    if (!loadout) {
      return resumeError(
        `Cannot safely resume "${name}": no complete, structurally valid sandbox snapshot ` +
          `was found for this session. Resuming without it could expand the child capability set, ` +
          `so this is refused. Spawn a fresh subagent instead.`,
        { name },
      );
    }
    const extensionError = verifySavedToolExtensions(loadout);
    if (extensionError) {
      return resumeError(
        `Cannot safely resume "${name}": ${extensionError}. ` +
          `The exact saved sandbox cannot be replayed, so no pane was created.`,
        { name },
      );
    }
    if (hasPiWebAccessTools(loadout.toolAllowlist)) {
      preflightResolvedPiWebAccess({
        cwd: loadout.cwd ?? process.cwd(),
        agentDir: loadout.agentDir!,
        extensionPath: findResolvedPiWebAccessExtension(loadout.toolExtensions, loadout.agentDir!),
      });
      const postPreflightError = verifySavedToolExtensions(loadout);
      if (postPreflightError) {
        return resumeError(
          `Cannot safely resume "${name}": ${postPreflightError}. ` +
            `The recorded package/config identity changed during capability preflight, so no pane was created.`,
          { name },
        );
      }
    }

    const { autoExit, interactive } = resolveResumeLaunchBehavior();
    const startTime = Date.now();
    const id = Math.random().toString(16).slice(2, 10);

    // Persist the claim before pane creation. In-memory reservations prevent
    // duplicate calls in this extension process; this registry transition also
    // blocks another parent process, including one restarted mid-child-run.
    const claim = claimCompletedNameRun(parentArtifactDir, name, sessionPath, id);
    if (!claim.ok) {
      const detail = claim.reason === "not-completed"
        ? `the registry does not contain durable completion proof${claim.conflictingName ? ` for "${claim.conflictingName}"` : ""}`
        : `the parent registry ${claim.reason === "changed" ? "changed during resume" : "no longer contains that name"}`;
      return resumeError(
        `Cannot resume "${name}": ${detail}. ` +
          `No second process was launched against the session.`,
        { name, status: claim.reason },
      );
    }
    claimedRunId = id;

    const resumedSessionId = entry.sessionId ?? getSessionId(sessionPath) ?? name;
    const entryCountBefore = countSessionEntryLines(sessionPath);
    // The completed process cannot publish again. Remove any records or claim
    // markers left by an earlier watcher before the resumed process starts.
    discardLegacyQuestionArtifacts(sessionPath);
    discardSettledRecords(sessionPath);
    const artifactDir = parentArtifactDir;
    const activityFile = getSubagentActivityFile(artifactDir, id);
    mkdirSync(dirname(activityFile), { recursive: true });

    const parts = ["pi", "--session", shellEscape(sessionPath)];
    applySandboxToParts(parts, loadout, { artifactDir, name });

    const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
    const safeName = name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "resume";
    const resumeMsgFile = join(
      artifactDir,
      "subagent-resume",
      `${safeName}-${msgTimestamp}-${id}.md`,
    );
    mkdirSync(dirname(resumeMsgFile), { recursive: true });
    writeFileSync(resumeMsgFile, message, "utf8");
    parts.push(shellEscape(`@${resumeMsgFile}`));

    // Use `env -u` for nullable legacy fields so a nested parent's ambient
    // identity/config cannot leak into a resumed child. New snapshots persist
    // concrete cwd and agentDir values.
    const resumeEnvUnset: string[] = [];
    const resumeEnvAssignments: string[] = [];
    if (loadout.agentDir) {
      resumeEnvAssignments.push(`PI_CODING_AGENT_DIR=${shellEscape(loadout.agentDir)}`);
    } else {
      resumeEnvUnset.push("-u", "PI_CODING_AGENT_DIR");
    }
    if (loadout.spawnable && loadout.spawnable.length > 0) {
      resumeEnvAssignments.push(`PI_SUBAGENT_ALLOWED=${shellEscape(loadout.spawnable.join(","))}`);
      resumeEnvUnset.push("-u", "PI_SUBAGENT_LIFECYCLE_DISABLED");
    } else {
      resumeEnvUnset.push("-u", "PI_SUBAGENT_ALLOWED");
      resumeEnvAssignments.push("PI_SUBAGENT_LIFECYCLE_DISABLED=1");
    }
    if (loadout.agent) {
      resumeEnvAssignments.push(`PI_SUBAGENT_AGENT=${shellEscape(loadout.agent)}`);
    } else {
      resumeEnvUnset.push("-u", "PI_SUBAGENT_AGENT");
    }
    resumeEnvAssignments.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
    resumeEnvAssignments.push(`PI_SUBAGENT_SESSION=${shellEscape(sessionPath)}`);
    resumeEnvAssignments.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
    resumeEnvAssignments.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
    if (autoExit) resumeEnvAssignments.push("PI_SUBAGENT_AUTO_EXIT=1");
    const resumeEnvParts = ["env", ...resumeEnvUnset, ...resumeEnvAssignments];

    const resumeCdPrefix = loadout.cwd ? `cd ${shellEscape(loadout.cwd)} && ` : "";
    const command =
      `${resumeCdPrefix}${resumeEnvParts.join(" ")} ${parts.join(" ")}; ` +
      `echo '__SUBAGENT_DONE_'$?'__'`;
    const launchScriptFile = join(
      artifactDir,
      "subagent-scripts",
      `${safeName}-resume-${Date.now()}-${id}.sh`,
    );

    surface = createSurface(name);
    await new Promise<void>((done) => setTimeout(done, getShellReadyDelayMs()));
    if (signal?.aborted) throw new Error("Resume cancelled before process launch.");

    const running: RunningSubagent = {
      id,
      name,
      task: message,
      agent: loadout.agent ?? undefined,
      surface,
      startTime,
      sessionFile: sessionPath,
      sessionEntryCountBefore: entryCountBefore,
      launchScriptFile,
      registryArtifactDir: artifactDir,
      activityFile,
      interactive,
      statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
    };
    uncertainRunning = running;
    safeToRollbackClaim = false;
    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      scriptPreamble: [
        `# Subagent resume script for ${name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Session: ${sessionPath}`,
        `# Surface: ${surface}`,
        `# Resume message file: ${resumeMsgFile}`,
      ].join("\n"),
    });

    runningSubagents.set(id, running);
    handedOff = true;
    releaseResumeReservation(reservation);

    startWidgetRefresh();
    startStatusRefresh(pi);
    attachWatcher(running, pi);

    return {
      content: [{ type: "text" as const, text: `Completed subagent "${name}" resumed safely.` }],
      details: {
        id,
        name,
        sessionId: resumedSessionId,
        sessionFile: sessionPath,
        launchScriptFile,
        status: "started",
      },
    };
  } catch (error: any) {
    if (surface && !handedOff) {
      try {
        closeSurface(surface);
        safeToRollbackClaim = true;
      } catch {}
    }
    if (!safeToRollbackClaim && uncertainRunning) {
      runningSubagents.set(uncertainRunning.id, uncertainRunning);
    }
    return resumeError(
      `Cannot resume "${name}": ${error?.message ?? String(error)}`,
      { name },
    );
  } finally {
    if (!handedOff) {
      if (claimedRunId && safeToRollbackClaim) {
        try { markNameRunCompleted(parentArtifactDir, sessionPath, claimedRunId); } catch {}
      }
      releaseResumeReservation(reservation);
    }
  }
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  resolveClaudeToolPolicy,
  claudePolicyHelpError,
  applyClaudeToolPolicy,
  resolveToolBackingExtensions,
  createToolExtensionIdentities,
  verifySavedToolExtensions,
  applySandboxToParts,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  observeRunningSubagent,
  getToolExtensionPath,
  resolvePiWebAccess: resolvePiWebAccessMetadata,
  resolvePiWebAccessExtension,
  preflightPiWebAccessCapabilities,
  preflightResolvedPiWebAccess,
  resolveRunningByName,
  uniqueRunningName,
  reserveSpawnName,
  releaseSpawnName,
  reservedNames,
  steerSubagent,
  handleSubagentSteer,
  killSubagent,
  handleSubagentKill,
  shouldSuppressWatcherMessage,
  createSpawnStartedAcknowledgement,
  deliverPendingSettled,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  reserveCompletedResume,
  releaseResumeReservation,
  reservedResumeNames,
  reservedResumeSessions,
  runningSubagents,
  formatElapsed,
  formatTokens,
  formatContextUsage,
  contextWindowFor,
  formatUsageSegments,
  widgetIcon,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/** Activate reserved ownership before command dispatch, or close the new pane and fail. */
function launchWithDurableOwnership(
  running: RunningSubagent,
  reservation: SpawnNameReservation,
  sendCommand: () => void,
): void {
  let activated = false;
  let commandDispatchStarted = false;
  try {
    if (
      reservation.artifactDir !== running.registryArtifactDir ||
      reservation.name !== running.name ||
      reservation.runId !== running.id ||
      !activateReservedNameRun(
        running.registryArtifactDir,
        running.name,
        running.id,
        {
          sessionFile: running.sessionFile,
          sessionId: getSessionId(running.sessionFile),
        },
      )
    ) {
      throw new Error("the durable spawn reservation is no longer owned by this launch");
    }
    activated = true;
    commandDispatchStarted = true;
    sendCommand();
    runningSubagents.set(running.id, running);
  } catch (error: any) {
    let terminated = false;
    let terminationError: string | undefined;
    try {
      closeSurface(running.surface);
      terminated = true;
    } catch (cleanupError: any) {
      terminationError = cleanupError?.message ?? String(cleanupError);
    }

    let registryCleanupError: string | undefined;
    if (activated && !terminated) {
      runningSubagents.set(running.id, running);
    }
    if (activated && terminated) {
      try {
        removeOwnedNameRun(
          running.registryArtifactDir,
          running.name,
          running.sessionFile,
          running.id,
          "running",
        );
      } catch (cleanupError: any) {
        registryCleanupError = cleanupError?.message ?? String(cleanupError);
      }
    }

    const phase = commandDispatchStarted ? "command dispatch" : "durable ownership activation";
    const cleanup = [
      terminationError ? `pane cleanup failed: ${terminationError}` : "",
      registryCleanupError ? `registry rollback failed: ${registryCleanupError}` : "",
    ].filter(Boolean).join("; ");
    throw new Error(
      `Subagent launch failed during ${phase}: ${error?.message ?? String(error)}` +
        (cleanup ? ` (${cleanup})` : ""),
    );
  }
}

/**
 * Launch a subagent: creates the multiplexer pane, durably records its run,
 * then sends the command. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string }; cwd: string },
  options: { surface?: string; reservation: SpawnNameReservation },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = options.reservation.runId;

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = agentDefs?.tools;
  const effectiveSkills = agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);
  // A non-empty subagent_agents list is the sole gate for lifecycle tools.
  const grantSpawning = !!(agentDefs?.subagentAgents && agentDefs.subagentAgents.length > 0);
  const { effectiveCwd, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;

  let claudeToolPolicy: { tools: string[] } | null = null;
  if (agentDefs?.cli === "claude") {
    const policy = resolveClaudeToolPolicy(effectiveTools, agentDefs.subagentAgents);
    if ("error" in policy) throw new Error(policy.error);
    verifyInstalledClaudePolicy();
    claudeToolPolicy = policy;
  }

  // Resolve every Pi-backed extension before creating a terminal surface. In
  // particular, a missing or invalid pi-web-access package must fail closed
  // without leaving behind a pane or a partially written saved loadout.
  const toolAllowlist =
    agentDefs?.cli === "claude"
      ? null
      : buildSubagentToolAllowlist(effectiveTools, { grantSpawning });
  const toolExtensions = agentDefs?.cli === "claude"
    ? null
    : resolveToolBackingExtensions(toolAllowlist, effectiveAgentDir);
  if (hasPiWebAccessTools(toolAllowlist)) {
    preflightResolvedPiWebAccess({
      cwd: targetCwdForSession,
      agentDir: effectiveAgentDir,
      extensionPath: findResolvedPiWebAccessExtension(toolExtensions, effectiveAgentDir),
    });
  }
  // Record the validated entrypoint/package/config identity after the fresh probe.
  const toolExtensionIdentities = agentDefs?.cli === "claude"
    ? null
    : createToolExtensionIdentities(toolExtensions, toolAllowlist, effectiveAgentDir);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSurface(params.name);
  let durableLaunchAttempted = false;
  try {
    if (!surfacePreCreated) {
      await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
    }

    const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }
  // Forked sessions already contain inherited assistant messages. Keep the
  // launch boundary so completion extraction can only inspect this run's
  // appended entries.
  const sessionEntryCountBefore = countSessionEntryLines(subagentSessionFile);

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = agentDefs?.autoExit
    ? "Complete your task autonomously. When you are finished, simply stop — your session ends automatically."
    : "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";
  const identity = agentDefs?.body ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;
  // ── Claude Code CLI path ──
  if (agentDefs?.cli === "claude") {
    const sentinelFile = `/tmp/pi-claude-${id}-done`;
    const pluginDir = join(SUBAGENTS_DIR, "plugin");

    const claudeTools = claudeToolPolicy?.tools ?? [];
    const cmdParts: string[] = [];
    cmdParts.push(`PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`);
    cmdParts.push("claude");
    // Fail-closed Claude policy, verified against the installed `claude --help`:
    // expose only translated built-ins, auto-allow only those tools, deny
    // interactive permission escalation, ignore ambient settings/MCP servers.
    applyClaudeToolPolicy(cmdParts, claudeTools);

    if (existsSync(pluginDir)) {
      cmdParts.push("--plugin-dir", shellEscape(pluginDir));
    }

    if (effectiveModel) {
      cmdParts.push("--model", shellEscape(effectiveModel));
    }

    const sp = agentDefs.body;
    if (sp) {
      cmdParts.push("--append-system-prompt", shellEscape(sp));
    }

    // Always pass the task as the prompt — even for resumed sessions,
    // the caller's task is the follow-up instruction.
    cmdParts.push(shellEscape(params.task));

    const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";
    const command = `${cdPrefix}${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

    const launchScriptName = `${(params.name || "subagent")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
    const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);

    const running: RunningSubagent = {
      id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      surface,
      startTime,
      sessionFile: subagentSessionFile,
      sessionEntryCountBefore,
      launchScriptFile,
      registryArtifactDir: artifactDir,
      cli: "claude",
      sentinelFile,
      interactive: effectiveInteractive,
      statusState: createStatusState({
        source: "claude",
        startTimeMs: startTime,
      }),
    };

    durableLaunchAttempted = true;
    launchWithDurableOwnership(running, options.reservation, () => {
      sendLongCommand(surface, command, {
        scriptPath: launchScriptFile,
        scriptPreamble: [
          `# Claude Code subagent launch script for ${params.name}`,
          `# Generated: ${new Date().toISOString()}`,
          `# Surface: ${surface}`,
        ].join("\n"),
      });
    });
    return running;
  }

  // ── Pi CLI path ──

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  // Resolve the config dir the child sees: a target-local .pi/agent/ wins,
  // else the propagated global dir. Captured once so the launch env and the
  // resume snapshot agree.
  const resolvedAgentDir = effectiveAgentDir;

  // Snapshot the fully-resolved sandbox beside the session file so explicit
  // subagent_resume (and subagent_message's compatibility path) can replay the
  // exact same restriction instead of loading ambient extensions + tools.
  const loadout: SubagentLoadout = {
    agent: params.agent ?? null,
    toolAllowlist,
    toolExtensions,
    toolExtensionIdentities,
    model: effectiveModel ?? null,
    thinking: effectiveThinking ?? null,
    systemPromptMode: systemPromptMode ?? null,
    identity: identityInSystemPrompt ? identity : null,
    spawnable: agentDefs?.subagentAgents ?? null,
    autoExit: agentDefs?.autoExit ?? false,
    cwd: targetCwdForSession,
    agentDir: resolvedAgentDir,
  };
  writeSubagentLoadout(subagentSessionFile, loadout);

  // Apply model, identity, and the default-deny tool/extension restriction via
  // the shared helper (same code path resume uses — they can't drift).
  applySandboxToParts(parts, loadout, { artifactDir, name: params.name });

  // Build env prefix: subagent identity + config dir propagation + spawn allowlist
  const envParts: string[] = [];

  if (resolvedAgentDir) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(resolvedAgentDir)}`);
  }

  if (grantSpawning && agentDefs?.subagentAgents) {
    envParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(agentDefs.subagentAgents.join(","))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (agentDefs?.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
  const envPrefix = envParts.join(" ") + " ";

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // strip everything except alphanumeric, spaces, hyphens
      .replace(/\s+/g, "-") // spaces to hyphens
      .replace(/-+/g, "-") // collapse multiple hyphens
      .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
    const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }

  for (const promptArg of buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  })) {
    parts.push(shellEscape(promptArg));
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths.
  // This was already computed above so session placement, PI_CODING_AGENT_DIR, and cd agree.
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
  const launchScriptName = `${(params.name || "subagent")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    sessionEntryCountBefore,
    launchScriptFile,
    registryArtifactDir: artifactDir,
    activityFile,
    interactive: effectiveInteractive,
    statusState: createStatusState({
      source: "pi",
      startTimeMs: startTime,
    }),
  };

  durableLaunchAttempted = true;
  launchWithDurableOwnership(running, options.reservation, () => {
    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      scriptPreamble: [
        `# Subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Session: ${subagentSessionFile}`,
        `# Surface: ${surface}`,
      ].join("\n"),
    });
  });
  return running;
  } catch (error) {
    // Before durable activation/dispatch, this function exclusively owns the
    // exact created (or parallel-precreated) surface and must not orphan it.
    // launchWithDurableOwnership performs owner-safe cleanup after this handoff.
    if (!durableLaunchAttempted) {
      try { closeSurface(surface); } catch {}
    }
    throw error;
  }
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, and cleans up proven terminal state.
 * Unproven disappearance remains tracked until exact-name kill cleanup.
 */
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/tmp",
  ".pi", "agent", "sessions", "claude-code",
);

function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const filename = transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
    const dest = join(CLAUDE_SESSIONS_DIR, filename);
    copyFileSync(transcriptPath, dest);
    return filename;
  } catch {
    return null;
  }
}

/**
 * Deliver all accumulated immutable settled snapshots in one ordered parent
 * turn. Atomic publication hides partial files; corrupt finalized records are
 * retired independently. The whole valid batch remains when sendMessage throws.
 */
function deliverPendingSettled(running: RunningSubagent): void {
  if (running.killed || !latestPi) return;
  const directory = `${running.sessionFile}.idle`;
  let recordNames: string[];
  try {
    recordNames = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return;
  }

  const delivered = running.deliveredSettledRecords ??= new Set<string>();
  const remove = (path: string): boolean => {
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  };
  recordNames = recordNames.filter((name) => {
    if (!delivered.has(name)) return true;
    if (remove(join(directory, name))) delivered.delete(name);
    return false;
  });

  const records: Array<{ name: string; payload: Record<string, unknown> }> = [];
  for (const name of recordNames) {
    const path = join(directory, name);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      remove(path);
      continue;
    }
    const state = String(payload.state);
    if (
      payload.type !== "settled" ||
      !["idle", "awaiting_answer", "waiting_on_children"].includes(state) ||
      (state === "awaiting_answer" &&
        (typeof payload.question !== "string" || !payload.question.trim()))
    ) {
      remove(path);
      continue;
    }
    records.push({ name, payload });
  }
  if (records.length === 0 || running.killed) return;

  const newest = records.at(-1)!.payload;
  const state = String(newest.state);
  const response = typeof newest.response === "string" && newest.response.trim()
    ? newest.response
    : null;
  const question = state === "awaiting_answer"
    ? (newest.question as string).trim()
    : null;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  const stateLabel = state === "awaiting_answer"
    ? "awaiting an answer"
    : state === "waiting_on_children" ? "waiting on child sub-agents" : "idle";
  const history = records.length > 1
    ? `\n\nSettled states (oldest → newest): ${records.map(({ payload }) =>
      payload.state === "awaiting_answer" ? `awaiting_answer (${payload.question})` : payload.state
    ).join(" → ")}.`
    : "";
  const responseText = response ? `\n\nLatest assistant response:\n\n${response}` : "";
  const replyText = question
    ? `\n\nQuestion:\n\n${question}\n\nReply with subagent_message({ name: "${running.name}", message: "…" }).`
    : `\n\nContinue it with subagent_message({ name: "${running.name}", message: "…" }) ` +
      "or interact with its pane directly.";

  try {
    latestPi.sendMessage(
      {
        customType: state === "awaiting_answer" ? "subagent_question" : "subagent_idle",
        content:
          `Sub-agent "${running.name}" is ${stateLabel} and still running ` +
          `(${formatElapsed(elapsed)}).${history}${responseText}${replyText}`,
        display: true,
        details: {
          name: running.name,
          agent: running.agent,
          status: state,
          running: true,
          elapsed,
          sessionFile: running.sessionFile,
          settledCount: records.length,
          states: records.map(({ payload }) => payload.state),
          ...(response ? { response } : {}),
          ...(question ? { question } : {}),
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  } catch {
    return;
  }

  for (const { name } of records) delivered.add(name);
  for (const { name } of records) {
    if (remove(join(directory, name))) delivered.delete(name);
  }
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;
  let naturalTerminalProven = false;

  try {
    const pollSignal = AbortSignal.any([signal, getModuleAbortSignal()]);
    let result = await pollForExit(surface, pollSignal, {
      interval: 1000,
      sessionFile,
      sentinelFile: running.sentinelFile,
      onTick() {
        if (pollSignal.aborted || running.killed) return;
        observeRunningSubagent(running);
        if (pollSignal.aborted || running.killed) return;
        deliverPendingSettled(running);
      },
    });

    discardLegacyQuestionArtifacts(running.sessionFile);
    discardSettledRecords(running.sessionFile);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    naturalTerminalProven = result.reason !== "disappeared";

    if (result.reason === "disappeared") {
      // Pi records `phase: done` synchronously at agent_end before shutdown. If
      // the multiplexer removes the pane before the shell sentinel can be captured, that
      // durable transition still proves the final session message is a valid
      // completion rather than stale transcript content.
      let completedBeforePaneDisappeared = false;
      if (running.cli !== "claude" && running.activityFile && existsSync(sessionFile)) {
        const activityRead = readSubagentActivityFile(running.activityFile, running.id);
        if (
          activityRead.ok &&
          activityRead.activity.phase === "done" &&
          activityRead.activity.latestEvent === "agent_end"
        ) {
          running.activity = activityRead.activity;
          try {
            const currentRunEntries = getNewEntries(
              sessionFile,
              running.sessionEntryCountBefore ?? 0,
            );
            completedBeforePaneDisappeared =
              findLastAssistantMessage(currentRunEntries) !== null;
          } catch {
            // A missing/malformed current-run transcript cannot prove success.
          }
        }
      }

      if (!completedBeforePaneDisappeared) {
        const subagentSessionId = existsSync(sessionFile) ? getSessionId(sessionFile) : null;
        return {
          name,
          task,
          summary:
            "Subagent pane disappeared before a completion signal was observed, so no successful result was produced. " +
            `It remains tracked; call subagent_kill({ name: ${JSON.stringify(name)} }) ` +
            "to confirm cleanup and forget this exact run before reusing or resuming its name.",
          sessionFile,
          ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
          exitCode: 1,
          elapsed,
          error: "pane-disappeared",
          terminalProof: "unproven",
        };
      }

      // Recover the completion path below. The pane was only the transport for
      // the shell sentinel; the done activity and transcript are authoritative.
      naturalTerminalProven = true;
      result = { reason: "done", exitCode: 0 };
    }

    if (running.cli === "claude") {
      // Claude Code result extraction
      let summary = "";

      if (running.sentinelFile) {
        try {
          summary = readFileSync(running.sentinelFile, "utf-8").trim();
        } catch {}
      }

      if (!summary) {
        summary = readScreen(surface, 200)
          .replace(/__SUBAGENT_DONE_\d+__/, "")
          .trimEnd();
      }

      if (!summary) {
        summary = result.exitCode !== 0
          ? `Claude Code exited with code ${result.exitCode}`
          : "Claude Code exited without output";
      }

      // Copy Claude session transcript
      let sessionId: string | null = null;
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile);
        try { unlinkSync(running.sentinelFile); } catch {}
        try { unlinkSync(running.sentinelFile + ".transcript"); } catch {}
      }

      try {
        closeSurface(surface);
      } catch {
        // Completion is already proven; a transient multiplexer cleanup error must not
        // suppress the result. The stale pane can be cleaned up externally.
      }
      if (runningSubagents.get(running.id) === running) {
        runningSubagents.delete(running.id);
      }

      return {
        name,
        task,
        summary,
        exitCode: result.exitCode,
        elapsed,
        terminalProof: "natural",
        ...(sessionId ? { claudeSessionId: sessionId } : {}),
      };
    }

    // Pi subagent result extraction
    let summary: string;
    if (existsSync(sessionFile)) {
      const currentRunEntries = getNewEntries(
        sessionFile,
        running.sessionEntryCountBefore ?? 0,
      );
      summary =
        findLastAssistantMessage(currentRunEntries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output");
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output";
    }

    const stats = existsSync(sessionFile) ? summarizeSessionStats(sessionFile) : null;
    const subagentSessionId = existsSync(sessionFile) ? getSessionId(sessionFile) : null;

    try {
      closeSurface(surface);
    } catch {
      // Completion is already proven; a transient multiplexer cleanup error must not
      // suppress the result. The stale pane can be cleaned up externally.
    }
    if (runningSubagents.get(running.id) === running) {
      runningSubagents.delete(running.id);
    }

    return {
      name,
      task,
      summary,
      sessionFile,
      ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
      exitCode: result.exitCode,
      elapsed,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(stats ? { stats } : {}),
      terminalProof: "natural",
    };
  } catch (err: any) {
    if (running.reloadQuiescing) {
      return {
        name,
        task,
        summary: "Subagent watcher quiesced for extension reload.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "reload",
        sessionFile,
        terminalProof: "unproven",
      };
    }
    discardLegacyQuestionArtifacts(running.sessionFile);
    discardSettledRecords(running.sessionFile);
    let terminationConfirmed = running.killed === true;
    if (!running.killed) {
      try {
        closeSurface(surface);
        terminationConfirmed = true;
      } catch {}
    }
    if (
      (naturalTerminalProven || terminationConfirmed) &&
      runningSubagents.get(running.id) === running
    ) {
      runningSubagents.delete(running.id);
    }
    const terminalProof: TerminalProof = naturalTerminalProven
      ? "natural"
      : terminationConfirmed
        ? "termination-confirmed"
        : "unproven";

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
        sessionFile,
        terminalProof,
      };
    }
    return {
      name,
      task,
      summary: `Subagent watcher error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
      terminalProof,
    };
  }
}

function deliverWatcherResult(
  running: RunningSubagent,
  pi: ExtensionAPI,
  result: SubagentResult,
): void {
  if (result.terminalProof !== "unproven") {
    try {
      markNameRunCompleted(
        running.registryArtifactDir,
        running.sessionFile,
        running.id,
      );
    } catch {
      // Keep fail-closed persisted running state if completion proof cannot
      // be written; result delivery itself remains valid.
    }
  }
  if (shouldSuppressWatcherMessage(running)) return;
  updateWidget();

  pi.sendMessage(
    {
      customType: "subagent_result",
      content: resolveResultPresentation(result, running.name),
      display: true,
      details: {
        name: running.name,
        task: running.task,
        agent: running.agent,
        exitCode: result.exitCode,
        elapsed: result.elapsed,
        sessionFile: result.sessionFile,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
        ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
        ...(result.stats ? { stats: result.stats } : {}),
      },
    },
    SUBAGENT_RESULT_DELIVERY_OPTIONS,
  );
}

function deliverWatcherError(
  running: RunningSubagent,
  pi: ExtensionAPI,
  error: any,
): void {
  if (shouldSuppressWatcherMessage(running)) return;
  updateWidget();
  pi.sendMessage(
    {
      customType: "subagent_result",
      content: `Sub-agent "${running.name}" error: ${error?.message ?? String(error)}`,
      display: true,
      details: {
        name: running.name,
        task: running.task,
        error: error?.message,
      },
    },
    SUBAGENT_RESULT_DELIVERY_OPTIONS,
  );
}

function attachWatcher(running: RunningSubagent, pi: ExtensionAPI): void {
  running.reloadQuiescing = false;

  let continuation: Promise<void>;
  const pendingResult = running.reloadPendingResult;
  if (pendingResult) {
    running.reloadPendingResult = undefined;
    continuation = Promise.resolve()
      .then(() => {
        if (runningSubagents.get(running.id) === running) {
          runningSubagents.delete(running.id);
        }
        deliverWatcherResult(running, pi, pendingResult);
      })
      .catch((error) => deliverWatcherError(running, pi, error))
      .finally(() => {
        if (running.watcherContinuation === continuation) {
          running.watcherContinuation = undefined;
        }
      });
    running.watcherContinuation = continuation;
    return;
  }

  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;
  continuation = watchSubagent(running, watcherAbort.signal)
    .then((result) => {
      if (running.reloadQuiescing) {
        if (!running.killed && result.terminalProof !== "unproven") {
          running.reloadPendingResult = result;
          runningSubagents.set(running.id, running);
        }
        return;
      }
      deliverWatcherResult(running, pi, result);
    })
    .catch((error) => deliverWatcherError(running, pi, error))
    .finally(() => {
      if (running.watcherContinuation === continuation) {
        running.watcherContinuation = undefined;
      }
    });
  running.watcherContinuation = continuation;
}

function consumeRunningHandoff(): RunningSubagent[] {
  const handoff = (globalThis as any)[RUNNING_HANDOFF_KEY] as
    | { version?: unknown; records?: unknown }
    | undefined;
  delete (globalThis as any)[RUNNING_HANDOFF_KEY];
  if (handoff?.version !== RUNNING_HANDOFF_VERSION || !Array.isArray(handoff.records)) {
    return [];
  }
  return handoff.records as RunningSubagent[];
}

export default function subagentsExtension(pi: ExtensionAPI) {
  // Fail closed when a resume deliberately suppresses lifecycle capabilities.
  // `subagent-done.ts` is loaded separately, so ask_question remains available.
  if (LIFECYCLE_TOOLS_DISABLED) return;

  latestPi = pi;
  // Capture the UI context for widget updates
  pi.on("session_start", (event, ctx) => {
    latestCtx = ctx;
    // pi runs multiple sessions in one process. A prior session's shutdown
    // aborts the shared module poll-abort controller; install a fresh one so
    // subagents spawned in this session aren't watched against a dead signal.
    // See https://github.com/HazAT/pi-interactive-subagents/issues/5
    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }

    if (event.reason === "reload") {
      for (const running of consumeRunningHandoff()) {
        running.abortController = undefined;
        running.watcherContinuation = undefined;
        runningSubagents.set(running.id, running);
        attachWatcher(running, pi);
      }
      if (runningSubagents.size > 0) {
        startWidgetRefresh();
        startStatusRefresh(pi);
      }
    }
  });

  // Clean up on session shutdown. Reload is distinct: watcher continuations
  // are quiesced before their live ownership records move to the next module.
  pi.on("session_shutdown", async (event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }

    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (event.reason === "reload") {
      latestCtx = null;
      latestPi = null;
      const quiescingRecords = Array.from(runningSubagents.values());
      for (const running of quiescingRecords) running.reloadQuiescing = true;
      moduleAbort?.abort();
      for (const running of quiescingRecords) running.abortController?.abort();
      await Promise.all(quiescingRecords.map((running) => running.watcherContinuation));

      // Kill and natural-completion continuations can change authoritative
      // ownership while the blocked watchers settle. Publish only the records
      // still owned now; never resurrect the pre-await snapshot.
      const records = Array.from(runningSubagents.values()).filter(
        (running) => !running.killed,
      );
      for (const running of records) {
        running.abortController = undefined;
        running.watcherContinuation = undefined;
      }
      (globalThis as any)[RUNNING_HANDOFF_KEY] = {
        version: RUNNING_HANDOFF_VERSION,
        records,
      };
      runningSubagents.clear();
      return;
    }

    if (moduleAbort) moduleAbort.abort();
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
  });

  // The spawning tools are always registered here. Whether a child process can
  // actually see/use them is governed by the parent's `--tools` allowlist and
  // by which extensions are loaded into the child (default-deny --no-extensions
  // + explicit -e). See launchSubagent().

  // ── subagent tool ──
  pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When a Pi-backed child fully settles, the harness AUTOMATICALLY reports either its final result after exit or that it is idle and still running — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result or idle report when it is ready.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When a Pi-backed child fully settles, the harness AUTOMATICALLY reports either its final result after exit or that it is idle and still running — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result or idle report when it is ready.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Strict whitelist at every depth. The caller's permitted set is:
        //   • a restricted subagent (PI_SUBAGENT_ALLOWED) → only its pinned agents;
        //   • a top-level session → every discoverable agent, i.e. exactly what
        //     `subagents_list` shows.
        // Every spawn must name an agent in that set. The lone exception is a
        // top-level `fork: true` clone, which has no role and inherits the
        // caller's own already-trusted toolset. Without this guard a missing or
        // unknown `agent` silently launches an unrestricted, full-toolset child.
        const permittedAgents = SUBAGENT_ALLOWLIST
          ? [...SUBAGENT_ALLOWLIST]
          : discoverAgentDefinitions().map((a) => a.name);
        const permittedSet = new Set(permittedAgents);
        const permittedList = permittedAgents.join(", ") || "(none)";

        if (!params.agent) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You must specify which agent to spawn via the "agent" field. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: { error: "agent required" },
          };
        } else if (!permittedSet.has(params.agent)) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You may not spawn the "${params.agent}" agent — it is not ` +
                  `${SUBAGENT_ALLOWLIST ? "in your allowlist" : "a known agent"}. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: {
              error: SUBAGENT_ALLOWLIST ? "agent not in allowlist" : "unknown agent",
            },
          };
        }

        // Validate prerequisites (need mux + a session file to derive the
        // artifact dir that hosts this session's name registry).
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // This spawner session's artifact dir hosts its persistent name
        // registry (artifacts/<parentSessionId>/subagent-registry.json).
        const parentArtifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );

        // Explicit and defaulted names share one deduplication path. Choose and
        // reserve the final name synchronously before launch reaches its first
        // await, considering running, persisted, and other in-flight names.
        let reservation: SpawnNameReservation;
        try {
          reservation = reserveSpawnName(params.name, params.agent, parentArtifactDir);
        } catch (error: any) {
          const requestedName = params.name?.trim() || params.agent;
          const message =
            `Failed to reserve subagent name "${requestedName}": ${error?.message ?? String(error)}`;
          return {
            content: [{ type: "text" as const, text: message }],
            details: { error: message, name: requestedName },
          };
        }
        const reservedName = reservation.name;
        params.name = reservedName;

        // Launch activates this exact durable reservation before command
        // dispatch. Failures clean up only the same owner when termination is
        // confirmed; uncertain claims remain fail-closed.
        let running;
        try {
          running = await launchSubagent(params, ctx, { reservation });
        } catch (error: any) {
          const message = `Failed to launch subagent "${reservedName}": ${error?.message ?? String(error)}`;
          return {
            content: [{ type: "text" as const, text: message }],
            details: { error: message, name: reservedName },
          };
        } finally {
          releaseSpawnName(reservation);
        }

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget: start watching in background. The continuation is
        // retained so reload can quiesce it before rebinding to the new API.
        attachWatcher(running, pi);

        // Return immediately, exposing the final deduplicated name rather than
        // the caller's possibly-colliding request.
        return createSpawnStartedAcknowledgement(running);
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const agentName =
          typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : agentName || "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        // Only show the agent tag separately when a distinct cosmetic name was given.
        const agent =
          agentName && name !== agentName ? theme.fg("dim", ` (${agentName})`) : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "○ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_kill tool ──
  // Included in SPAWNING_TOOLS: only profiles with subagent_agents receive
  // this extension tool in their child sandbox.
  pi.registerTool({
    name: "subagent_kill",
    label: "Kill Subagent",
    description:
      "Destructively terminate a running child by its exact persistent display name. " +
      "Kills its terminal surface/process, aborts tracking, removes it from the running list, " +
      "and forgets the name mapping. The session transcript is preserved, but the name " +
      "cannot be resumed after killing.",
    promptSnippet:
      "Kill a running subagent by exact persistent display name. Terminates its process " +
      "and forgets the name while preserving the transcript.",
    parameters: Type.Object({
      name: Type.String({ description: "Exact persistent display name of the running subagent" }),
    }),

    async execute(_toolCallId, params) {
      return handleSubagentKill(params);
    },

    renderCall(args, theme) {
      const target = args.name ?? "(unknown)";
      return new Text(
        theme.fg("error", "✕") + " " +
          theme.fg("toolTitle", theme.bold(target)) +
          theme.fg("dim", " — kill"),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      if (details?.status === "killed") {
        return new Text(
          theme.fg("success", "✓") + " " +
            theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
            theme.fg("dim", " — killed"),
          0,
          0,
        );
      }
      const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
      return new Text(theme.fg("error", text), 0, 0);
    },
  });

  // ── subagents_list tool ──
  pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── subagent_message tool ──
  pi.registerTool({
      name: "subagent_message",
      label: "Message Subagent",
      description:
        "Send a message to a subagent by exact parent-scoped name. Running names are steered immediately. " +
        "For backward compatibility, a completed Pi-backed name is resumed through the same validated safe path as subagent_resume; " +
        "prefer subagent_resume when you explicitly intend to relaunch completed work. `name` and `message` are required. " +
        "A resumed result is delivered automatically as a later follow-up notification. Never poll session files or fabricate results.",
      promptSnippet:
        "Steer a running subagent by exact name. For backward compatibility, completed names safely resume; " +
        "prefer subagent_resume for an explicit completed-session relaunch. Results arrive automatically; do not poll.",
      parameters: Type.Object({
        name: Type.String({
          description:
            "Exact parent-scoped display name. Steers it when running; safely resumes it when completed for compatibility.",
        }),
        message: Type.String({
          description:
            "The message to deliver: a follow-up instruction for a running subagent, or the next task for a resumed session.",
        }),
      }),

      renderCall(args, theme) {
        const target = args.name ?? "(unknown)";
        return new Text(
          "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — message"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;

        if (details?.status === "steered") {
          return new Text(
            theme.fg("success", "✓") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
              theme.fg("dim", " — message delivered"),
            0,
            0,
          );
        }

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback / error
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const requestedName = params.name?.trim();
        if (!requestedName) {
          return resumeError(
            "Provide the subagent's exact `name` to steer it or safely resume it.",
          );
        }
        if (typeof params.message !== "string" || params.message.trim() === "") {
          return resumeError("Provide a non-empty `message`.", { name: requestedName });
        }
        if (!isMuxAvailable()) return muxUnavailableResult();

        // Backward compatibility: exact live names still steer. Completed
        // names use the same safe resume implementation as subagent_resume.
        const runningMatch = Array.from(runningSubagents.values()).find(
          (running) => running.name === requestedName,
        );
        if (runningMatch) {
          return handleSubagentSteer({ name: requestedName, message: params.message });
        }
        return resumeRegisteredSubagent(pi, params, signal, ctx, "message");
      },
    });

  // ── subagent_resume tool ──
  pi.registerTool({
    name: "subagent_resume",
    label: "Resume Subagent",
    description:
      "Safely resume a completed Pi-backed subagent using its exact name from the current parent session and a required follow-up message. " +
      "This tool accepts no session path, session id, cwd, model, tool, or launch controls. It refuses running or already-resuming names; " +
      "use subagent_message to steer a live child. The saved model, thinking, identity, cwd, agent dir, tool sandbox, backing extensions, " +
      "and nested-spawn boundary are validated and replayed exactly. The autonomous result arrives asynchronously as a follow-up notification. " +
      "Do not poll or fabricate results.",
    promptSnippet:
      "Resume a completed subagent by exact parent-scoped name with a follow-up message. " +
      "Completed-only: use subagent_message for live children. The saved sandbox is replayed and the result arrives automatically.",
    parameters: Type.Object({
      name: Type.String({
        description: "Exact completed-subagent name in the current parent session's registry",
      }),
      message: Type.String({
        description: "Required follow-up instruction for the resumed completed session",
      }),
    }),

    renderCall(args, theme) {
      return new Text(
        "○ " +
          theme.fg("toolTitle", theme.bold(args.name ?? "(unknown)")) +
          theme.fg("dim", " — resume completed"),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      if (details?.status === "started") {
        return new Text(
          theme.fg("accent", "⟳") +
            " " +
            theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
            theme.fg("dim", " — resumed safely"),
          0,
          0,
        );
      }
      const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return resumeRegisteredSubagent(pi, params, signal, ctx, "explicit");
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const stats = (details.stats ?? null) as SessionStats | null;
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const modelTag = stats?.model ? theme.fg("dim", ` (${stats.model})`) : "";
        const titleSegment = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${modelTag} ${theme.fg("dim", "—")} `;

        // Success: icon already conveys "completed", so show "N tools · duration"
        // like the in-process extension. Failure: surface the failure reason.
        let header: string;
        if (failed) {
          const reason = errorMessage ? "failed (provider/agent error)" : `failed (exit ${exitCode})`;
          header = `${titleSegment}${theme.fg("error", reason)} ${theme.fg("dim", `· ${elapsed}`)}`;
        } else {
          const toolPart = stats ? `${stats.toolCount} tools · ${elapsed}` : elapsed;
          header = `${titleSegment}${theme.fg("dim", toolPart)}`;
        }

        // Usage line: ↑in ↓out R… W… $cost · context-gauge (color-coded by %).
        let usageLine: string | null = null;
        if (stats) {
          const segs = formatUsageSegments(stats).map((s) => theme.fg("dim", s));
          if (stats.contextTokens > 0) {
            const window = contextWindowFor(stats.model);
            const ctxStr = formatContextUsage(stats.contextTokens, window);
            const pct = window ? (stats.contextTokens / window) * 100 : 0;
            const coloredCtx =
              pct > 90 ? theme.fg("error", ctxStr) : pct > 70 ? theme.fg("warning", ctxStr) : theme.fg("dim", ctxStr);
            segs.push(coloredCtx);
          }
          if (segs.length > 0) usageLine = segs.join(theme.fg("dim", " "));
        }

        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove follow-up ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nResume completed work with subagent_resume[\s\S]+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];
        if (usageLine) contentLines.push(usageLine);

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.name || details.sessionFile) {
            contentLines.push("");
            if (details.name) {
              contentLines.push(
                theme.fg(
                  "dim",
                  `Resume:  subagent_resume({ name: "${details.name}", message: "…" })`,
                ),
              );
            }
            if (details.sessionFile) {
              contentLines.push(theme.fg("muted", `Session file: ${details.sessionFile}`));
            }
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_question message renderer ──
  pi.registerMessageRenderer("subagent_question", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— asks a question")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.question ?? "");
          contentLines.push("");
          contentLines.push(
            theme.fg("dim", `Reply: subagent_message({ name: "${name}", message: "…" })`),
          );
        } else {
          const preview = (details.question ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

}
