import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, existsSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

import {
  getLeafId,
  getNewEntries,
  countSessionEntryLines,
  getSessionId,
  activateReservedNameRun,
  claimCompletedNameRun,
  markNameRunCompleted,
  readNameRegistry,
  readSubagentLoadout,
  removeOwnedNameRun,
  reserveNameRun,
  resolveNameInRegistry,
  nameRegistryPath,
  writeSubagentLoadout,
  loadoutSidecarPath,
  type SubagentLoadout,
  resetSessionIndexCache,
  resolveSessionFileById,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
  seedSubagentSessionFile,
  summarizeSessionStats,
} from "../pi-extension/subagents/session.ts";

import { pollForExit, shellEscape } from "../pi-extension/subagents/mux.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
  parseStatusConfig,
} from "../pi-extension/subagents/status.ts";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "../pi-extension/subagents/activity.ts";
import {
  shouldMarkUserTookOver,
  shouldAutoExitOnAgentEnd,
  findLatestAssistantError,
  runningChildrenCount,
} from "../pi-extension/subagents/subagent-done.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { __pollForExitTest__ } from "../pi-extension/subagents/mux.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeSettledRecord(
  sessionFile: string,
  payload: Record<string, unknown> | string,
  name: string,
): void {
  const directory = `${sessionFile}.idle`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, name),
    typeof payload === "string" ? payload : JSON.stringify(payload),
    "utf8",
  );
}

function readSettledRecords(sessionFile: string): Array<Record<string, unknown>> {
  return readdirSync(`${sessionFile}.idle`)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(`${sessionFile}.idle`, name), "utf8")));
}

function settledRunning(sessionFile: string, id: string) {
  return {
    id,
    name: "Planner",
    agent: "planner",
    task: "Plan",
    surface: `%${id}`,
    startTime: Date.now(),
    sessionFile,
    interactive: true,
    statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }),
  };
}

function seedRegistryRun(
  artifactDir: string,
  name: string,
  entry: {
    sessionFile: string;
    sessionId: string | null;
    runState?: "running" | "completed";
    runId?: string;
  },
): void {
  const runId = entry.runId ?? `fixture-${name}`;
  assert.equal(reserveNameRun(artifactDir, name, runId), name);
  assert.equal(
    activateReservedNameRun(artifactDir, name, runId, {
      sessionFile: entry.sessionFile,
      sessionId: entry.sessionId,
    }),
    true,
  );
  if ((entry.runState ?? "completed") === "completed") {
    assert.equal(markNameRunCompleted(artifactDir, entry.sessionFile, runId), true);
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    api: {
      on() {},
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

function fakeExtensionIdentities(paths: string[]) {
  return paths.map((path, index) => ({
    path,
    sha256: String(index + 1).repeat(64).slice(0, 64),
  }));
}

function writePiSettings(agentDir: string, packages: unknown[] = ["npm:pi-web-access@0.27.0"]): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }));
}

function writePiWebAccessPackage(
  packageRoot: string,
  options: {
    name?: string;
    version?: string;
    extensions?: unknown[];
    entrypoint?: string;
    entrypointSource?: string;
  } = {},
): string {
  const entrypoint = options.entrypoint ?? "./runtime/web-tools.ts";
  const entrypointPath = join(packageRoot, entrypoint);
  const packageName = options.name ?? "pi-web-access";
  const packageVersion = options.version ?? "0.27.0";
  mkdirSync(dirname(entrypointPath), { recursive: true });
  writeFileSync(entrypointPath, options.entrypointSource ?? "export default () => {};\n");
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      version: packageVersion,
      pi: { extensions: options.extensions ?? [entrypoint] },
    }),
  );
  return entrypointPath;
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });

    it("countSessionEntryLines matches getNewEntries(0).length without parsing", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(countSessionEntryLines(file), getNewEntries(file, 0).length);
      assert.equal(countSessionEntryLines(file), 4);
    });

    it("countSessionEntryLines ignores blank lines and returns 0 for missing files", () => {
      const file = join(dir, "blanks.jsonl");
      writeFileSync(file, JSON.stringify({ type: "session", id: "x" }) + "\n\n\n");
      assert.equal(countSessionEntryLines(file), 1);
      assert.equal(countSessionEntryLines(join(dir, "does-not-exist.jsonl")), 0);
    });
  });

  describe("getSessionId / resolveSessionFileById", () => {
    function writeSession(d: string, fname: string, id: string): string {
      const p = join(d, fname);
      writeFileSync(p, JSON.stringify({ type: "session", id, version: 3 }) + "\n");
      return p;
    }

    // The resolver caches an id→file index per root; reset it so each test
    // builds a fresh index from the current on-disk state.
    beforeEach(() => {
      resetSessionIndexCache();
    });

    it("reads the header id from a session file", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getSessionId(file), "sess-001");
    });

    it("returns null for a file without a session header", () => {
      const file = createSessionFile(dir, [USER_MSG]);
      assert.equal(getSessionId(file), null);
    });

    it("resolves a session file by exact id under the root", () => {
      const a = writeSession(dir, "a.jsonl", "019f-aaaa");
      writeSession(dir, "b.jsonl", "019f-bbbb");
      assert.equal(resolveSessionFileById("019f-aaaa", dir), a);
    });

    it("resolves a session file by id prefix", () => {
      const a = writeSession(dir, "p.jsonl", "019f-prefix-match");
      assert.equal(resolveSessionFileById("019f-prefix", dir), a);
    });

    it("returns null when no session matches", () => {
      writeSession(dir, "c.jsonl", "abc");
      assert.equal(resolveSessionFileById("zzz", dir), null);
    });

    it("picks up newly added sessions on repeat calls without a reset", () => {
      // Prime the index (first call builds it).
      writeSession(dir, "first.jsonl", "id-first");
      assert.equal(resolveSessionFileById("id-first", dir) !== null, true);
      // Add a new session AFTER the index was built — no reset. The resolver's
      // cheap refresh should index it.
      const b = writeSession(dir, "second.jsonl", "id-second");
      assert.equal(resolveSessionFileById("id-second", dir), b);
    });
  });

  describe("subagent loadout snapshot", () => {
    const sample: SubagentLoadout = {
      agent: "worker",
      toolAllowlist: "read,write,edit,safe_bash,web_search,subagent,ask_question",
      toolExtensions: ["/extensions/safe-bash.ts", "/extensions/web-search.ts"],
      toolExtensionIdentities: fakeExtensionIdentities([
        "/extensions/safe-bash.ts",
        "/extensions/web-search.ts",
      ]),
      model: "openrouter/z-ai/glm-5.2",
      thinking: "medium",
      systemPromptMode: "append",
      identity: "You are a worker agent.",
      spawnable: ["scout", "researcher"],
      autoExit: true,
      cwd: "/work/dir",
      agentDir: "/home/u/.pi/agent",
    };

    it("writes the sidecar next to the session file", () => {
      const sf = join(dir, "s1.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.equal(loadoutSidecarPath(sf), sf + ".loadout.json");
      assert.ok(existsSync(sf + ".loadout.json"));
    });

    it("round-trips the full loadout", () => {
      const sf = join(dir, "s2.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.deepEqual(readSubagentLoadout(sf), sample);
    });

    it("returns null when the sidecar is absent", () => {
      assert.equal(readSubagentLoadout(join(dir, "missing.jsonl")), null);
    });

    it("returns null when the sidecar is corrupt", () => {
      const sf = join(dir, "s3.jsonl");
      writeFileSync(sf + ".loadout.json", "not json{", "utf8");
      assert.equal(readSubagentLoadout(sf), null);
    });

    it("refuses missing, malformed, and empty tool allowlists", () => {
      const invalid = [
        { ...sample, toolAllowlist: 42 },
        { ...sample, toolAllowlist: [] },
        { ...sample, toolAllowlist: "" },
        { ...sample, toolAllowlist: " ,  , " },
        { ...sample, toolAllowlist: "read,,write" },
      ];
      invalid.forEach((value, index) => {
        const sf = join(dir, `invalid-loadout-${index}.jsonl`);
        writeFileSync(loadoutSidecarPath(sf), JSON.stringify(value), "utf8");
        assert.equal(readSubagentLoadout(sf), null);
      });
    });

    it("refuses incomplete legacy null-allowlist snapshots", () => {
      const unrestricted = {
        ...sample,
        toolAllowlist: null,
        toolExtensions: null,
        toolExtensionIdentities: null,
        spawnable: null,
      };
      for (const field of Object.keys(unrestricted).filter((field) => field !== "toolExtensions")) {
        const incomplete: Record<string, unknown> = { ...unrestricted };
        delete incomplete[field];
        const sf = join(dir, `incomplete-legacy-${field}.jsonl`);
        writeFileSync(loadoutSidecarPath(sf), JSON.stringify(incomplete), "utf8");
        assert.equal(readSubagentLoadout(sf), null, `missing ${field}`);
      }
    });

    it("refuses missing and malformed required loadout fields", () => {
      for (const field of Object.keys(sample)) {
        const incomplete: Record<string, unknown> = { ...sample };
        delete incomplete[field];
        const sf = join(dir, `missing-${field}.jsonl`);
        writeFileSync(loadoutSidecarPath(sf), JSON.stringify(incomplete), "utf8");
        assert.equal(readSubagentLoadout(sf), null, `missing ${field}`);
      }

      const malformed = [
        { ...sample, agent: 42 },
        { ...sample, model: false },
        { ...sample, thinking: [] },
        { ...sample, systemPromptMode: "merge" },
        { ...sample, identity: {} },
        { ...sample, autoExit: "true" },
        { ...sample, cwd: 42 },
        { ...sample, model: "" },
        { ...sample, cwd: "  " },
        { ...sample, identity: "worker", systemPromptMode: null },
        { ...sample, agentDir: [] },
        { ...sample, toolExtensions: null },
        { ...sample, toolExtensions: ["relative-extension.ts"] },
        { ...sample, toolExtensions: ["/extension.ts", "/extension.ts"] },
      ];
      malformed.forEach((value, index) => {
        const sf = join(dir, `malformed-field-${index}.jsonl`);
        writeFileSync(loadoutSidecarPath(sf), JSON.stringify(value), "utf8");
        assert.equal(readSubagentLoadout(sf), null);
      });
    });

    it("refuses invalid spawnable values and arrays", () => {
      const invalidSpawnable = [[], [""], ["scout", 42], ["scout,researcher"], "scout", {}];
      invalidSpawnable.forEach((spawnable, index) => {
        const sf = join(dir, `invalid-spawnable-${index}.jsonl`);
        writeFileSync(
          loadoutSidecarPath(sf),
          JSON.stringify({ ...sample, spawnable }),
          "utf8",
        );
        assert.equal(readSubagentLoadout(sf), null);
      });
    });

    it("rejects legacy unrestricted snapshots without extension identity fields", () => {
      const sf = join(dir, "legacy-unrestricted.jsonl");
      const unrestricted: Record<string, unknown> = {
        ...sample,
        toolAllowlist: null,
        toolExtensions: null,
        spawnable: null,
      };
      delete unrestricted.toolExtensionIdentities;
      writeFileSync(loadoutSidecarPath(sf), JSON.stringify(unrestricted), "utf8");
      assert.equal(readSubagentLoadout(sf), null);
    });

    it("strips lifecycle tools unless spawnable is a valid non-empty string array", () => {
      const lifecycle = "read,subagent,subagent_message,subagent_resume,subagent_kill,subagents_list,write";
      const stale = join(dir, "stale-lifecycle.jsonl");
      writeFileSync(
        loadoutSidecarPath(stale),
        JSON.stringify({
          ...sample,
          toolAllowlist: lifecycle,
          toolExtensions: [],
          toolExtensionIdentities: [],
          spawnable: null,
        }),
        "utf8",
      );
      const restricted = readSubagentLoadout(stale);
      assert.ok(restricted);
      assert.equal(restricted.toolAllowlist, "read,write");
      assert.equal(restricted.spawnable, null);

      const sf = join(dir, "valid-lifecycle.jsonl");
      writeFileSync(
        loadoutSidecarPath(sf),
        JSON.stringify({
          ...sample,
          toolAllowlist: lifecycle,
          toolExtensions: ["/extensions/subagents.ts"],
          toolExtensionIdentities: fakeExtensionIdentities(["/extensions/subagents.ts"]),
          spawnable: [" scout ", "researcher"],
        }),
        "utf8",
      );
      const loaded = readSubagentLoadout(sf);
      assert.ok(loaded);
      assert.equal(loaded.toolAllowlist, lifecycle);
      assert.deepEqual(loaded.spawnable, ["scout", "researcher"]);
    });
  });

  describe("subagent name registry", () => {
    it("activates and resolves a name to its session file", () => {
      const adir = join(dir, "art-1");
      seedRegistryRun(adir, "worker", {
        sessionFile: "/s/worker.jsonl",
        sessionId: "id-worker",
      });
      const entry = resolveNameInRegistry(adir, "worker");
      assert.deepEqual(entry, {
        sessionFile: "/s/worker.jsonl",
        sessionId: "id-worker",
        runState: "completed",
        runId: "fixture-worker",
      });
      assert.ok(existsSync(nameRegistryPath(adir)));
    });

    it("accumulates names without overwriting an existing owner", () => {
      const adir = join(dir, "art-2");
      seedRegistryRun(adir, "scout", {
        sessionFile: "/s/scout.jsonl",
        sessionId: "id-scout",
      });
      seedRegistryRun(adir, "scout-2", {
        sessionFile: "/s/scout2.jsonl",
        sessionId: "id-scout2",
      });
      const reg = readNameRegistry(adir);
      assert.deepEqual(Object.keys(reg).sort(), ["scout", "scout-2"]);

      const next = reserveNameRun(adir, "scout", "third-owner");
      assert.equal(next, "scout-3");
      assert.equal(resolveNameInRegistry(adir, "scout")!.sessionFile, "/s/scout.jsonl");
      assert.equal(removeOwnedNameRun(adir, next, "", "third-owner", "pending"), true);
    });

    it("waits for ownerless cross-process contention without reaping the live lock", async () => {
      const adir = join(dir, "art-lock-contention");
      mkdirSync(adir, { recursive: true });
      const lockPath = `${nameRegistryPath(adir)}.lock`;
      writeFileSync(lockPath, "owner-metadata-not-yet-written", "utf8");
      const remover = spawn(process.execPath, [
        "-e",
        `setTimeout(() => require("node:fs").unlinkSync(${JSON.stringify(lockPath)}), 350)`,
      ]);
      const removerExit = new Promise<number | null>((resolve) => {
        remover.once("exit", (code) => resolve(code));
      });

      assert.equal(reserveNameRun(adir, "worker", "run-1"), "worker");

      assert.equal(await removerExit, 0, "the original holder must release its own lock");
      assert.equal(resolveNameInRegistry(adir, "worker")?.runId, "run-1");
    });

    it("atomically reserves distinct names across parent processes without overwriting owners", async () => {
      const adir = join(dir, "art-cross-process-reservations");
      const barrier = join(dir, "release-reservations");
      const workerCount = 8;
      const sessionModuleUrl = new URL(
        "../pi-extension/subagents/session.ts",
        import.meta.url,
      ).href;
      const workers = Array.from({ length: workerCount }, (_, index) => {
        const owner = `owner-${index}`;
        const ready = join(dir, `ready-${index}`);
        const script = [
          `import { existsSync, writeFileSync } from "node:fs";`,
          `import * as registry from ${JSON.stringify(sessionModuleUrl)};`,
          `writeFileSync(${JSON.stringify(ready)}, "ready");`,
          `while (!existsSync(${JSON.stringify(barrier)})) await new Promise((resolve) => setTimeout(resolve, 5));`,
          `const name = registry.reserveNameRun(${JSON.stringify(adir)}, "Worker", ${JSON.stringify(owner)});`,
          `console.log(JSON.stringify({ name, owner: ${JSON.stringify(owner)} }));`,
        ].join("\n");
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        return {
          ready,
          result: new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
            child.once("exit", (code) => resolve({ code, stdout, stderr }));
          }),
        };
      });

      const readyDeadline = Date.now() + 5_000;
      while (workers.some((worker) => !existsSync(worker.ready)) && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        workers.every((worker) => existsSync(worker.ready)),
        true,
        "all child processes must reach the same registry barrier",
      );
      writeFileSync(barrier, "go");

      const results = await Promise.all(workers.map((worker) => worker.result));
      for (const result of results) {
        assert.equal(result.code, 0, result.stderr);
      }
      const reservations = results.map((result) => JSON.parse(result.stdout.trim()) as {
        name: string;
        owner: string;
      });
      assert.equal(new Set(reservations.map(({ name }) => name)).size, workerCount);
      assert.deepEqual(
        reservations.map(({ name }) => name).sort(),
        ["Worker", ...Array.from({ length: workerCount - 1 }, (_, index) => `Worker-${index + 2}`)].sort(),
      );

      const registry = readNameRegistry(adir);
      for (const { name, owner } of reservations) {
        assert.equal(registry[name]?.runState, "pending");
        assert.equal(registry[name]?.runId, owner, `${name} must retain its reserving owner`);
      }
    });

    it("activates and removes only the exact reservation owner", async () => {
      const registryApi = await import("../pi-extension/subagents/session.ts") as any;
      const adir = join(dir, "art-owned-reservation");
      const name = registryApi.reserveNameRun(adir, "Worker", "owner-a");

      assert.equal(
        registryApi.activateReservedNameRun(adir, name, "owner-b", {
          sessionFile: "/sessions/wrong.jsonl",
          sessionId: "wrong",
        }),
        false,
      );
      assert.equal(resolveNameInRegistry(adir, name)?.runState, "pending");
      assert.equal(resolveNameInRegistry(adir, name)?.runId, "owner-a");

      assert.equal(
        registryApi.activateReservedNameRun(adir, name, "owner-a", {
          sessionFile: "/sessions/owned.jsonl",
          sessionId: "owned",
        }),
        true,
      );
      assert.equal(resolveNameInRegistry(adir, name)?.runState, "running");
      assert.equal(
        registryApi.removeOwnedNameRun(adir, name, "/sessions/owned.jsonl", "owner-b", "running"),
        false,
      );
      assert.equal(resolveNameInRegistry(adir, name)?.runId, "owner-a");
      assert.equal(
        registryApi.removeOwnedNameRun(adir, name, "/sessions/owned.jsonl", "owner-a", "running"),
        true,
      );
      assert.equal(resolveNameInRegistry(adir, name), null);
    });

    it("atomically claims completed session aliases and requires the owning run to complete them", () => {
      const adir = join(dir, "art-run-state");
      const sessionFile = "/s/shared.jsonl";
      for (const name of ["worker", "worker-alias"]) {
        seedRegistryRun(adir, name, {
          sessionFile,
          sessionId: "shared",
          runId: `old-run-${name}`,
        });
      }

      assert.deepEqual(claimCompletedNameRun(adir, "worker", sessionFile, "new-run"), { ok: true });
      assert.equal(resolveNameInRegistry(adir, "worker")?.runState, "running");
      assert.equal(resolveNameInRegistry(adir, "worker-alias")?.runId, "new-run");
      assert.deepEqual(
        claimCompletedNameRun(adir, "worker-alias", sessionFile, "other-run"),
        { ok: false, reason: "not-completed", conflictingName: "worker-alias" },
      );
      assert.equal(markNameRunCompleted(adir, sessionFile, "other-run"), false);
      assert.equal(markNameRunCompleted(adir, sessionFile, "new-run"), true);
      assert.equal(resolveNameInRegistry(adir, "worker")?.runState, "completed");
      assert.equal(resolveNameInRegistry(adir, "worker-alias")?.runState, "completed");
    });

    it("fails closed without writing when completed ownership has a missing or empty run id", () => {
      for (const [label, malformedRunId] of [
        ["missing", undefined],
        ["empty", ""],
      ] as const) {
        const adir = join(dir, `art-malformed-owner-${label}`);
        mkdirSync(adir, { recursive: true });
        const entry: Record<string, unknown> = {
          sessionFile: "/s/malformed-owner.jsonl",
          sessionId: "malformed-owner",
          runState: "completed",
        };
        if (malformedRunId !== undefined) entry.runId = malformedRunId;
        writeFileSync(nameRegistryPath(adir), JSON.stringify({ Worker: entry }));
        const before = readFileSync(nameRegistryPath(adir), "utf8");

        const result = claimCompletedNameRun(
          adir,
          "Worker",
          "/s/malformed-owner.jsonl",
          "new-owner",
        );

        assert.equal(result.ok, false, `${label} runId must not be claimed`);
        assert.equal(readFileSync(nameRegistryPath(adir), "utf8"), before);
      }
    });

    it("fails closed without writing when any same-session alias is malformed", () => {
      const adir = join(dir, "art-malformed-alias");
      mkdirSync(adir, { recursive: true });
      const sessionFile = "/s/shared-malformed-alias.jsonl";
      writeFileSync(nameRegistryPath(adir), JSON.stringify({
        Worker: {
          sessionFile,
          sessionId: "shared",
          runState: "completed",
          runId: "old-worker",
        },
        "Worker-alias": {
          sessionFile,
          sessionId: "",
          runState: "completed",
          runId: "old-alias",
        },
      }));
      const before = readFileSync(nameRegistryPath(adir), "utf8");

      const result = claimCompletedNameRun(adir, "Worker", sessionFile, "new-owner");

      assert.equal(result.ok, false);
      assert.equal(readFileSync(nameRegistryPath(adir), "utf8"), before);
    });

    it("does not export path-only registry mutation helpers", async () => {
      const registryApi = await import("../pi-extension/subagents/session.ts") as Record<string, unknown>;
      assert.equal("registerName" in registryApi, false);
      assert.equal("removeNameIfSession" in registryApi, false);
    });

    it("returns null for unknown names and {} for a missing/corrupt registry", () => {
      const adir = join(dir, "art-3");
      assert.equal(resolveNameInRegistry(adir, "nope"), null);
      assert.deepEqual(readNameRegistry(adir), {});
      mkdirSync(adir, { recursive: true });
      writeFileSync(nameRegistryPath(adir), "not json{", "utf8");
      assert.deepEqual(readNameRegistry(adir), {});
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Subagent error: Anthropic 529 Overloaded after 3 retries",
      );
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("creates a forked child session with copied context before the triggering user turn", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "fork-child.jsonl");

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.equal(entries[1].type, "model_change");
      assert.equal(entries.some((entry) => entry.type === "session" && entry.parentSession !== parentFile), false);
      assert.equal(entries.some((entry) => entry.type === "message"), false);
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });

  describe("summarizeSessionStats", () => {
    const asstWithUsage = (id: string, opts: {
      model?: string;
      tools?: string[];
      usage?: Record<string, unknown>;
    }) => ({
      type: "message",
      id,
      parentId: "user-001",
      message: {
        role: "assistant",
        ...(opts.model ? { model: opts.model } : {}),
        content: [
          { type: "text", text: "ok" },
          ...(opts.tools ?? []).map((name, i) => ({ type: "toolCall", name, id: `${id}-tc${i}` })),
        ],
        ...(opts.usage ? { usage: opts.usage } : {}),
      },
    });

    it("aggregates tokens/cost cumulatively and tracks last context size", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "claude-sonnet-4-6" },
        USER_MSG,
        asstWithUsage("a1", {
          tools: ["read", "grep"],
          usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200, totalTokens: 1350, cost: { total: 0.01 } },
        }),
        asstWithUsage("a2", {
          tools: ["write"],
          usage: { input: 30, output: 70, cacheRead: 2000, cacheWrite: 0, totalTokens: 3500, cost: { total: 0.02 } },
        }),
      ]);
      const stats = summarizeSessionStats(file)!;
      assert.equal(stats.model, "claude-sonnet-4-6");
      assert.equal(stats.toolCount, 3);
      assert.equal(stats.inputTokens, 130);
      assert.equal(stats.outputTokens, 120);
      assert.equal(stats.cacheReadTokens, 3000);
      assert.equal(stats.cacheWriteTokens, 200);
      // contextTokens is the LAST assistant turn's totalTokens, not the sum.
      assert.equal(stats.contextTokens, 3500);
      assert.ok(Math.abs(stats.cost - 0.03) < 1e-9);
    });

    it("prefers per-message model over model_change", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "claude-haiku-4-5" },
        asstWithUsage("a1", { model: "claude-sonnet-4-6", usage: { totalTokens: 10, cost: { total: 0 } } }),
      ]);
      assert.equal(summarizeSessionStats(file)!.model, "claude-sonnet-4-6");
    });

    it("handles missing usage gracefully", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const stats = summarizeSessionStats(file)!;
      assert.equal(stats.toolCount, 0);
      assert.equal(stats.inputTokens, 0);
      assert.equal(stats.cost, 0);
      assert.equal(stats.contextTokens, 0);
    });

    it("returns null for an unreadable file", () => {
      assert.equal(summarizeSessionStats(join(dir, "does-not-exist.jsonl")), null);
    });
  });
});

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
    });
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(new URL("../config.json.example", import.meta.url));
    const config = loadStatusConfig(examplePath);

    assert.deepEqual(config, {
      enabled: true,
      lineLimit: 4,
    });
  });

  it("loads the shared example when local config is absent", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      const config = loadStatusConfig(join(dir, "config.json"), examplePath);

      assert.deepEqual(config, {
        enabled: true,
        lineLimit: 4,
      });
    });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: "false" } }),
      /status\.enabled must be a boolean/,
    );
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, defaultCadenceSeconds: 60 } }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
  });

  it("reports when neither local nor shared config exists", () => {
    withTempDir((dir) => {
      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), join(dir, "config.json.example")),
        /Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
      );
    });
  });

  it("reports invalid JSON from the shared example path", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, "{\n");

      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      );
    });
  });

  it("fails on invalid local config instead of falling back to the shared example", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, "{\n");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      assert.throws(
        () => loadStatusConfig(configPath, examplePath),
        /Invalid JSON in subagent config .*config\.json/,
      );
    });
  });

  it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    assert.equal(classifyStatus(state, 60_999).kind, "starting");
    const stalled = classifyStatus(state, 61_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, null);
  });

  it("classifies active snapshots without aging into stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
      latestEvent: "tool_execution_start",
    }, 5_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.activityLabel, "bash");
    assert.equal(snapshot.activeDurationText, "3m");
  });

  it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingDurationText, "3m");
  });

  it("uses elapsed-only fallback for claude-backed subagents", () => {
    const state = createStatusState({ source: "claude", startTimeMs: 0 });
    const snapshot = classifyStatus(state, 125_000);

    assert.equal(snapshot.kind, "running");
    assert.equal(snapshot.elapsedText, "2m");
  });

  it("detects stalled transitions and recovery", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    let advanced = advanceStatusState(state, 95_000);
    assert.equal(advanced.transition, "stalled");
    assert.equal(advanced.snapshot.kind, "stalled");

    state = observeStatus(advanced.nextState, {
      snapshot: "present",
      updatedAt: 96_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 96_000,
      latestEvent: "agent_end",
    }, 96_000);
    advanced = advanceStatusState(state, 97_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("keeps the last healthy kind during transient snapshot loss", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 5_000,
    }, 5_000);
    state = advanceStatusState(state, 6_000).nextState;
    state = observeStatus(state, { snapshot: "missing" }, 10_000);

    const snapshot = classifyStatus(state, 20_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("forces an active state to waiting after interrupt", () => {
    const now = 20_000;
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);

    assert.equal(classifyStatus(state, now).kind, "active");

    const forced = forceStatusAfterInterrupt(state, now);
    const snapshot = classifyStatus(forced, now);

    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");
    assert.equal(snapshot.waitingDurationText, "0s");
    assert.equal(forced.activeNow, false);
  });

  it("orders same-millisecond snapshots by sequence", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 10_000,
      activityLabel: "bash",
    }, 10_000);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 3,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_001);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.latestEvent, "agent_end");
  });

  it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = observeStatus(state, { snapshot: "missing" }, 10_000);
    assert.equal(classifyStatus(state, 10_000).statusLabel, null);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 11_000);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = forceStatusAfterInterrupt(state, 20_000);

    const stale = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 21_000);
    let snapshot = classifyStatus(stale, 21_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const sameTimestamp = observeStatus(stale, {
      snapshot: "present",
      updatedAt: 20_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 20_000,
      activityLabel: "bash",
    }, 22_000);
    snapshot = classifyStatus(sameTimestamp, 22_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const resumed = observeStatus(sameTimestamp, {
      snapshot: "present",
      sequence: 2,
      updatedAt: 25_000,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 25_000,
      activityLabel: "streaming",
    }, 25_000);
    snapshot = classifyStatus(resumed, 25_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(resumed.activeScope, "streaming");
  });

  it("normalizes and truncates long newline-heavy names", () => {
    const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
    const stalledState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "missing" },
      1_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 299_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 299_000,
        activityLabel: "write",
      },
      299_000,
    );
    const line = formatStatusLine(longName, classifyStatus(stalledState, 240_000));
    const recovered = formatTransitionLine(longName, classifyStatus(activeState, 300_000), "recovered");

    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(recovered, /\n/);
    assert.ok(line.length <= 120, `expected bounded line length, got ${line.length}`);
    assert.ok(recovered.length <= 120, `expected bounded line length, got ${recovered.length}`);
  });

  it("caps visible status lines and reports overflow consistently", () => {
    const waitingState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "present", updatedAt: 180_000, sequence: 1, phase: "waiting", waitingSince: 180_000 },
      180_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 419_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 419_000,
        activityLabel: "bash",
      },
      419_000,
    );
    const waitingLine = formatStatusLine("Worker", classifyStatus(waitingState, 300_000));
    const recoveredLine = formatTransitionLine("Worker", classifyStatus(activeState, 420_000), "recovered");
    const lines = [waitingLine, recoveredLine, "Scout running 2m.", "Reviewer running 4m.", "Planner running 6m."];
    const capped = capStatusLines(lines, 3);
    const aggregate = formatStatusAggregate(lines, 3);

    assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
    assert.equal(recoveredLine, "Worker running 7m, recovered; active (bash 1s).");
    assert.deepEqual(capped.visibleLines, [waitingLine, recoveredLine, "Scout running 2m."]);
    assert.equal(capped.overflow, 2);
    assert.match(aggregate, /^Subagent status:/);
    assert.match(aggregate, /\+2 more running\./);
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        [
          "name: interactive-unset-test-agent",
          "model: anthropic/test-interactive-unset",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolveEffectiveInteractive defaults to the inverse of auto-exit", () => {
    // Autonomous agents (auto-exit: true) are NOT interactive — parent gets stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true }),
      false,
    );
    // Agents without auto-exit ARE interactive — parent does not receive status transition pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: false }),
      true,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, {}),
      true,
    );
    // Bare spawn with no agent defs (e.g. /iterate fork) is interactive by default.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null),
      true,
    );
  });

  it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: true, interactive: true },
      ),
      true,
    );
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { interactive: false },
      ),
      false,
    );
  });

  it("bundled scout/researcher/worker all resolve as non-interactive (auto-exit)", () => {
    for (const name of ["scout", "researcher", "worker"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(
        testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
        false,
        `${name} should resolve as non-interactive (autonomous, auto-exit)`,
      );
    }
  });

  it("bundled reviewer is read-only, autonomous, and cannot use lifecycle tools", async () => {
    await withIsolatedAgentEnv(() => {
      const reviewer = testApi.loadAgentDefaults("reviewer");
      assert.ok(reviewer, "expected bundled reviewer to be discoverable");
      assert.deepEqual(reviewer.tools?.split(",").map((tool: string) => tool.trim()), ["read", "bash"]);
      assert.equal(reviewer.model, "openai-codex/gpt-5.6-sol");
      assert.equal(reviewer.thinking, "high");
      assert.equal(reviewer.systemPromptMode, "append");
      assert.equal(reviewer.autoExit, true);
      assert.equal(
        testApi.resolveEffectiveInteractive({ name: "reviewer", task: "" }, reviewer),
        false,
      );
      assert.equal(reviewer.subagentAgents, undefined);

      const allowlist = new Set(
        testApi.buildSubagentToolAllowlist(reviewer.tools, { grantSpawning: false })!.split(","),
      );
      for (const tool of [
        "subagent",
        "subagent_message",
        "subagent_resume",
        "subagent_kill",
        "subagents_list",
      ]) {
        assert.equal(allowlist.has(tool), false, `reviewer must not receive lifecycle tool ${tool}`);
      }
    });
  });

  it("bundled planner is interactive, constrained, and granted lifecycle tools through its spawn gate", async () => {
    await withIsolatedAgentEnv(() => {
      const planner = testApi.loadAgentDefaults("planner");
      assert.ok(planner, "expected bundled planner to be discoverable");
      assert.deepEqual(planner.tools?.split(",").map((tool: string) => tool.trim()), [
        "read",
        "write",
        "bash",
      ]);
      assert.equal(planner.model, "openai-codex/gpt-5.6-sol");
      assert.equal(planner.thinking, "high");
      assert.equal(planner.systemPromptMode, "append");
      assert.equal(planner.interactive, true);
      assert.equal(planner.autoExit, false);
      assert.equal(
        testApi.resolveEffectiveInteractive({ name: "planner", task: "" }, planner),
        true,
      );
      assert.deepEqual(planner.subagentAgents, ["scout", "researcher"]);

      const allowlist = new Set(
        testApi.buildSubagentToolAllowlist(planner.tools, {
          grantSpawning: !!planner.subagentAgents?.length,
        })!.split(","),
      );
      for (const tool of [
        "subagent",
        "subagent_message",
        "subagent_resume",
        "subagent_kill",
        "subagents_list",
      ]) {
        assert.equal(allowlist.has(tool), true, `planner should receive lifecycle tool ${tool}`);
      }
      assert.equal(allowlist.has("edit"), false, "planner must not receive the edit tool");
    });
  });

  it("worker is granted the spawning toolset restricted to scout and researcher", () => {
    const worker = testApi.loadAgentDefaults("worker");
    assert.ok(worker, "expected bundled worker to be discoverable");
    assert.deepEqual(worker.subagentAgents, ["scout", "researcher"]);
    assert.deepEqual(worker.tools?.split(",").map((tool: string) => tool.trim()), [
      "read",
      "write",
      "edit",
      "bash",
    ]);

    const allowlist = testApi.buildSubagentToolAllowlist(worker.tools, { grantSpawning: true });
    assert.ok(allowlist, "expected an allowlist");
    const tools = new Set(allowlist!.split(","));
    for (const t of ["subagent", "subagent_message", "subagent_resume", "subagent_kill", "subagents_list"]) {
      assert.ok(tools.has(t), `expected spawning tool ${t} in worker allowlist`);
    }
    assert.ok(tools.has("bash"), "expected worker to keep bash");
  });

  it("grants all pi-web-access tools only to the bundled researcher", () => {
    const webTools = ["web_search", "fetch_content", "get_search_content", "source_check"];
    const researcher = testApi.loadAgentDefaults("researcher");
    assert.ok(researcher, "expected bundled researcher to be discoverable");
    assert.deepEqual(researcher.tools?.split(",").map((tool: string) => tool.trim()), [
      ...webTools,
      "safe_bash",
    ]);
    assert.deepEqual(
      testApi.buildSubagentToolAllowlist(researcher.tools)?.split(","),
      [...webTools, "safe_bash", "ask_question"],
      "researcher should receive exactly its five profile tools plus normal question support",
    );

    for (const name of ["planner", "reviewer", "scout", "visual-tester", "worker"]) {
      const profile = testApi.loadAgentDefaults(name);
      assert.ok(profile, `expected bundled ${name} to be discoverable`);
      const requested = new Set(
        (profile.tools ?? "").split(",").map((tool: string) => tool.trim()).filter(Boolean),
      );
      for (const tool of webTools) {
        assert.equal(requested.has(tool), false, `${name} must not request web tool ${tool}`);
      }
    }
  });

  it("scout and researcher are not granted spawning tools", () => {
    for (const name of ["scout", "researcher"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(defs.subagentAgents, undefined, `${name} should not declare subagent_agents`);
    }
  });

  it("resolves all four web tools from the exact pinned pi-web-access selector", () => {
    withTempDir((dir) => {
      const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
      const previousPackageDir = process.env.PI_PACKAGE_DIR;
      const agentDir = join(dir, "agent");
      const packageRoot = join(agentDir, "npm", "node_modules", "pi-web-access");
      writePiSettings(agentDir, ["npm:pi-web-access@0.27.0"]);
      const entrypoint = writePiWebAccessPackage(packageRoot, {
        entrypoint: "./runtime/nonstandard-entry.ts",
      });
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_PACKAGE_DIR = join(dir, "isolated-pi-package");

      try {
        assert.equal(testApi.getToolExtensionPath("read"), undefined);
        assert.equal(testApi.getToolExtensionPath("bash"), undefined);
        const canonicalEntrypoint = realpathSync(entrypoint);
        for (const tool of [
          "web_search",
          "fetch_content",
          "get_search_content",
          "source_check",
        ]) {
          assert.equal(testApi.getToolExtensionPath(tool), canonicalEntrypoint);
        }
        assert.deepEqual(
          testApi.resolveToolBackingExtensions(
            "web_search,fetch_content,get_search_content,source_check",
          ),
          [canonicalEntrypoint],
        );
        assert.ok(testApi.getToolExtensionPath("safe_bash")?.endsWith("tools/safe-bash.ts"));
        // Spawning tools are registered by this extension itself.
        assert.ok(testApi.getToolExtensionPath("subagent")?.endsWith("index.ts"));
        assert.ok(testApi.getToolExtensionPath("subagent_resume")?.endsWith("index.ts"));
        assert.ok(testApi.getToolExtensionPath("subagent_kill")?.endsWith("index.ts"));
      } finally {
        restoreEnvVar("PI_CODING_AGENT_DIR", previousConfigDir);
        restoreEnvVar("PI_PACKAGE_DIR", previousPackageDir);
      }
    });
  });

  it("does not fall back to a stale package beside Pi's own installation", () => {
    withTempDir((dir) => {
      const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
      const previousPackageDir = process.env.PI_PACKAGE_DIR;
      const agentDir = join(dir, "agent");
      const nodeModules = join(dir, "global", "node_modules");
      const piPackageDir = join(nodeModules, "@earendil-works", "pi-coding-agent");
      writePiSettings(agentDir);
      writePiWebAccessPackage(join(nodeModules, "pi-web-access"));
      mkdirSync(piPackageDir, { recursive: true });
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_PACKAGE_DIR = piPackageDir;

      try {
        assert.throws(
          () => testApi.resolvePiWebAccessExtension(),
          /unavailable under Pi's effective npm root/i,
        );
      } finally {
        restoreEnvVar("PI_CODING_AGENT_DIR", previousConfigDir);
        restoreEnvVar("PI_PACKAGE_DIR", previousPackageDir);
      }
    });
  });

  it("fails closed with repair guidance for missing or invalid pi-web-access packages", () => {
    withTempDir((dir) => {
      const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
      const previousPackageDir = process.env.PI_PACKAGE_DIR;
      const agentDir = join(dir, "agent");
      const packageRoot = join(agentDir, "npm", "node_modules", "pi-web-access");
      writePiSettings(agentDir);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_PACKAGE_DIR = join(dir, "isolated-pi-package");

      try {
        assert.throws(
          () => testApi.getToolExtensionPath("web_search"),
          /unavailable under Pi's effective npm root.*pi install npm:pi-web-access@0\.27\.0.*fresh subagent/i,
        );

        writePiWebAccessPackage(packageRoot, { name: "unrelated-package" });
        assert.throws(
          () => testApi.getToolExtensionPath("fetch_content"),
          /invalid package identity.*expected name "pi-web-access".*repair/i,
        );

        writeFileSync(join(packageRoot, "package.json"), "{not-json");
        assert.throws(
          () => testApi.getToolExtensionPath("get_search_content"),
          /invalid manifest.*package\.json.*repair/i,
        );

        writeFileSync(
          join(packageRoot, "package.json"),
          JSON.stringify({ name: "pi-web-access", version: "0.27.0", pi: { extensions: ["./one.ts", "./two.ts"] } }),
        );
        assert.throws(
          () => testApi.getToolExtensionPath("web_search"),
          /pi\.extensions must name exactly one concrete extension entrypoint/i,
        );

        writeFileSync(
          join(packageRoot, "package.json"),
          JSON.stringify({ name: "pi-web-access", version: "0.27.0", pi: { extensions: ["../outside.ts"] } }),
        );
        assert.throws(
          () => testApi.getToolExtensionPath("source_check"),
          /unsupported or escaping extension entrypoint/i,
        );

        writeFileSync(
          join(packageRoot, "package.json"),
          JSON.stringify({ name: "pi-web-access", version: "0.27.0", pi: { extensions: ["./missing.ts"] } }),
        );
        assert.throws(
          () => testApi.getToolExtensionPath("source_check"),
          /extension entrypoint is unavailable.*missing\.ts.*immutable/i,
        );
      } finally {
        restoreEnvVar("PI_CODING_AGENT_DIR", previousConfigDir);
        restoreEnvVar("PI_PACKAGE_DIR", previousPackageDir);
      }
    });
  });

  it("rejects missing, unpinned, wrong-pin, duplicate, filtered, and ambiguous selectors", () => {
    withTempDir((dir) => {
      const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
      const agentDir = join(dir, "agent");
      const packageRoot = join(agentDir, "npm", "node_modules", "pi-web-access");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        writePiWebAccessPackage(packageRoot);
        const localAlternative = join(dir, "local-web-package");
        writePiWebAccessPackage(localAlternative);
        const rejectedSelectors: Array<[string, unknown[]]> = [
          ["missing", []],
          ["unpinned", ["npm:pi-web-access"]],
          ["wrong exact pin", ["npm:pi-web-access@0.26.0"]],
          ["version range", ["npm:pi-web-access@^0.27.0"]],
          ["filtered pinned", [{ source: "npm:pi-web-access@0.27.0" }]],
          ["filtered unpinned", [{ source: "npm:pi-web-access" }]],
          ["duplicate pinned", ["npm:pi-web-access@0.27.0", "npm:pi-web-access@0.27.0"]],
          ["pinned plus unpinned", ["npm:pi-web-access@0.27.0", "npm:pi-web-access"]],
          ["git alternative", ["git:github.com/example/pi-web-access"]],
          ["local alternative", ["../pi-web-access"]],
          [
            "pinned plus git alternative",
            ["npm:pi-web-access@0.27.0", "git:https://github.com/example/pi-web-access.git#main"],
          ],
          ["pinned plus local alternative", ["npm:pi-web-access@0.27.0", "../local-web-package"]],
        ];
        for (const [label, packages] of rejectedSelectors) {
          writePiSettings(agentDir, packages);
          assert.throws(
            () => testApi.resolvePiWebAccessExtension(),
            /register exactly one unfiltered string.*npm:pi-web-access@0\.27\.0/i,
            label,
          );
        }
      } finally {
        restoreEnvVar("PI_CODING_AGENT_DIR", previousConfigDir);
      }
    });
  });

  it("rejects package-version mismatch and incompatible pi-web-access config", () => {
    withTempDir((dir) => {
      const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
      const agentDir = join(dir, "agent");
      const packageRoot = join(agentDir, "npm", "node_modules", "pi-web-access");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        writePiSettings(agentDir);
        writePiWebAccessPackage(packageRoot, { version: "0.10.7" });
        assert.throws(
          () => testApi.resolvePiWebAccessExtension(),
          /unsupported pi-web-access version "0\.10\.7".*exactly 0\.27\.0/i,
        );

        writePiWebAccessPackage(packageRoot);
        const configPath = join(agentDir, "web-search.json");
        const incompatibleConfigs = [
          { webSearch: { enabled: false } },
          { tools: { sourceCheck: { enabled: false } } },
          { tools: { fetchContent: { enabled: false } } },
          { toolNames: { webSearch: "internet_search" } },
          { toolNames: { getSearchContent: "read_search_result" } },
        ];
        for (const config of incompatibleConfigs) {
          writeFileSync(configPath, JSON.stringify(config));
          assert.throws(
            () => testApi.resolvePiWebAccessExtension(),
            /disables|must remain the canonical name/i,
          );
        }
      } finally {
        restoreEnvVar("PI_CODING_AGENT_DIR", previousConfigDir);
      }
    });
  });

  it("rejects package-root, manifest, entrypoint, and config path escapes", () => {
    withTempDir((dir) => {
      const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
      const agentDir = join(dir, "agent");
      const nodeModules = join(agentDir, "npm", "node_modules");
      const packageRoot = join(nodeModules, "pi-web-access");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      writePiSettings(agentDir);
      try {
        const outsidePackage = join(dir, "outside-package");
        writePiWebAccessPackage(outsidePackage);
        mkdirSync(nodeModules, { recursive: true });
        symlinkSync(outsidePackage, packageRoot, "dir");
        assert.throws(
          () => testApi.resolvePiWebAccessExtension(),
          /package root is symlinked or resolves outside/i,
        );

        rmSync(packageRoot, { force: true });
        const entrypoint = writePiWebAccessPackage(packageRoot);
        const outsideEntrypoint = join(dir, "outside-entry.ts");
        writeFileSync(outsideEntrypoint, "export default () => {};\n");
        rmSync(entrypoint);
        symlinkSync(outsideEntrypoint, entrypoint);
        assert.throws(
          () => testApi.resolvePiWebAccessExtension(),
          /extension entrypoint resolves outside/i,
        );

        rmSync(packageRoot, { recursive: true, force: true });
        const internalEntrypoint = writePiWebAccessPackage(packageRoot);
        const internalEntrypointTarget = join(packageRoot, "internal-entry.ts");
        writeFileSync(internalEntrypointTarget, "export default () => {};\n");
        rmSync(internalEntrypoint);
        symlinkSync(internalEntrypointTarget, internalEntrypoint);
        assert.throws(
          () => testApi.resolvePiWebAccessExtension(),
          /extension entrypoint must not be a symlink/i,
        );

        rmSync(packageRoot, { recursive: true, force: true });
        writePiWebAccessPackage(packageRoot);
        for (const extensionSpec of [
          "../escape.ts",
          "/absolute/escape.ts",
          "file:./index.ts",
          "https://example.test/index.ts",
          "./runtime/*.ts",
          ".\\runtime\\index.ts",
        ]) {
          writeFileSync(
            join(packageRoot, "package.json"),
            JSON.stringify({
              name: "pi-web-access",
              version: "0.27.0",
              pi: { extensions: [extensionSpec] },
            }),
          );
          assert.throws(
            () => testApi.resolvePiWebAccessExtension(),
            /unsupported or escaping extension entrypoint/i,
            extensionSpec,
          );
        }

        writePiWebAccessPackage(packageRoot);
        const outsideConfig = join(dir, "outside-web-search.json");
        writeFileSync(outsideConfig, "{}");
        symlinkSync(outsideConfig, join(agentDir, "web-search.json"));
        assert.throws(
          () => testApi.resolvePiWebAccessExtension(),
          /config resolves outside its allowed root/i,
        );

        rmSync(join(agentDir, "web-search.json"));
        const internalConfig = join(agentDir, "internal-web-search.json");
        writeFileSync(internalConfig, "{}");
        symlinkSync(internalConfig, join(agentDir, "web-search.json"));
        assert.throws(
          () => testApi.resolvePiWebAccessExtension(),
          /config must not be a symlink/i,
        );

        rmSync(join(agentDir, "web-search.json"));
        rmSync(internalConfig);
        symlinkSync(join(agentDir, "missing-web-search.json"), join(agentDir, "web-search.json"));
        assert.throws(
          () => testApi.resolvePiWebAccessExtension(),
          /config is unavailable/i,
        );
      } finally {
        restoreEnvVar("PI_CODING_AGENT_DIR", previousConfigDir);
      }
    });
  });

  it("binds resume identity to canonical extension bytes and pi-web-access package/config state", () => {
    withTempDir((dir) => {
      const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
      const agentDir = join(dir, "agent");
      const packageRoot = join(agentDir, "npm", "node_modules", "pi-web-access");
      writePiSettings(agentDir);
      const entrypoint = writePiWebAccessPackage(packageRoot);
      const configPath = join(agentDir, "web-search.json");
      writeFileSync(configPath, JSON.stringify({ provider: "one" }));
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        const allowlist = "web_search,fetch_content,get_search_content,source_check,ask_question";
        const toolExtensions = testApi.resolveToolBackingExtensions(allowlist, agentDir);
        const toolExtensionIdentities = testApi.createToolExtensionIdentities(
          toolExtensions,
          allowlist,
          agentDir,
        );
        const loadout: SubagentLoadout = {
          agent: "researcher",
          toolAllowlist: allowlist,
          toolExtensions,
          toolExtensionIdentities,
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: true,
          cwd: dir,
          agentDir,
        };
        assert.equal(testApi.verifySavedToolExtensions(loadout), null);

        writeFileSync(join(agentDir, "web-search.json"), JSON.stringify({
          toolNames: { webSearch: "internet_search" },
        }));
        assert.match(testApi.verifySavedToolExtensions(loadout), /canonical name/i);
        writeFileSync(configPath, JSON.stringify({ provider: "two" }));
        assert.match(testApi.verifySavedToolExtensions(loadout), /full config identity drifted/i);
        writeFileSync(configPath, JSON.stringify({ provider: "one" }));

        writeFileSync(entrypoint, "export default function changed() {}\n");
        assert.match(testApi.verifySavedToolExtensions(loadout), /digest drifted/i);
      } finally {
        restoreEnvVar("PI_CODING_AGENT_DIR", previousConfigDir);
      }
    });
  });

  it("fails closed and cleans up bounded preflight errors, malformed state, extension errors, and timeouts", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      const extensionPath = join(dir, "web-extension.ts");
      const inspectorPath = join(dir, "inspector.ts");
      mkdirSync(agentDir);
      writeFileSync(extensionPath, "export default () => {};\n");
      writeFileSync(inspectorPath, "export default () => {};\n");
      const temporaryPreflights = () => readdirSync(tmpdir())
        .filter((name) => name.startsWith("pi-web-access-preflight-"))
        .sort();
      const beforeTemporary = temporaryPreflights();

      const writeFakePi = (name: string, body: string): string => {
        const path = join(dir, `${name}.mjs`);
        writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
        chmodSync(path, 0o755);
        return path;
      };
      const run = (piCommand: string, timeoutMs = 2_000) =>
        testApi.preflightPiWebAccessCapabilities({
          cwd: realpathSync(dir),
          agentDir: realpathSync(agentDir),
          extensionPath: realpathSync(extensionPath),
          inspectorPath: realpathSync(inspectorPath),
          piCommand,
          timeoutMs,
        });
      const validSnapshot = [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.env.PI_WEB_ACCESS_PREFLIGHT_OUTPUT, JSON.stringify({",
        "  nonce: process.env.PI_WEB_ACCESS_PREFLIGHT_NONCE,",
        "  activeTools: [\"fetch_content\",\"get_search_content\",\"source_check\",\"web_search\"],",
        "}));",
      ].join("\n");

      const nonzero = writeFakePi("nonzero", "process.exit(7);");
      assert.throws(() => run(nonzero), /exited unsuccessfully.*status 7/i);

      const malformed = writeFakePi(
        "malformed",
        `${validSnapshot}\nprocess.stdout.write("not-json\\n");`,
      );
      assert.throws(() => run(malformed), /emitted malformed output/i);

      const extensionError = writeFakePi(
        "extension-error",
        `${validSnapshot}\n` +
          'console.log(JSON.stringify({type:"extension_error",extensionPath:"fixture",error:"boom"}));\n' +
          'console.log(JSON.stringify({type:"response",id:"pi-web-access-preflight",command:"get_state",success:true}));',
      );
      assert.throws(() => run(extensionError), /reported an extension error/i);

      const noSnapshot = writeFakePi(
        "no-snapshot",
        'console.log(JSON.stringify({type:"response",id:"pi-web-access-preflight",command:"get_state",success:true}));',
      );
      assert.throws(() => run(noSnapshot), /active-tool state could not be inspected/i);

      const extraRecord = writeFakePi(
        "extra-record",
        `${validSnapshot}\n` +
          'console.log(JSON.stringify({type:"response",id:"pi-web-access-preflight",command:"get_state",success:true}));\n' +
          'console.log(JSON.stringify({type:"unexpected"}));',
      );
      assert.throws(() => run(extraRecord), /only successful response/i);

      const stderr = writeFakePi(
        "stderr",
        `${validSnapshot}\n` +
          'console.log(JSON.stringify({type:"response",id:"pi-web-access-preflight",command:"get_state",success:true}));\n' +
          'console.error("unexpected warning");',
      );
      assert.throws(() => run(stderr), /unexpected stderr/i);

      const pidPath = join(dir, "timeout.pid");
      const childPidPath = join(dir, "timeout-child.pid");
      const timeout = writeFakePi("timeout", [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n"));
      const started = Date.now();
      assert.throws(() => run(timeout, 500), /timed out after 500ms/i);
      assert.ok(Date.now() - started < 1_500, "timeout must stay tightly bounded");

      const assertProcessGone = (path: string): void => {
        const pid = Number(readFileSync(path, "utf8"));
        const deadline = Date.now() + 500;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
          } catch (error: any) {
            if (error?.code === "ESRCH") return;
            throw error;
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        assert.fail(`preflight process ${pid} remained alive after timeout cleanup`);
      };
      assertProcessGone(pidPath);
      assertProcessGone(childPidPath);
      assert.deepEqual(temporaryPreflights(), beforeTemporary, "all temporary snapshots must be removed");
    });
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves session mode from frontmatter (standalone default)", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "standalone");
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "fork" }),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,ask_question",
    );
  });

  it("defaults an unconfigured named profile to the child control tool", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), "ask_question");
    assert.equal(testApi.buildSubagentToolAllowlist(""), "ask_question");
  });

  it("does not let explicit tools bypass the nested-spawn gate", () => {
    const allowlist = testApi.buildSubagentToolAllowlist(
      "read,subagent,subagent_kill,subagents_list",
      { grantSpawning: false },
    );
    assert.equal(allowlist, "read,ask_question");
  });

  it("maps supported Pi profile tools to a strict Claude built-in policy", () => {
    assert.deepEqual(
      testApi.resolveClaudeToolPolicy(
        "read,write,edit,bash,grep,find,web_search,web_fetch",
        undefined,
      ),
      { tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "WebSearch", "WebFetch"] },
    );
    assert.deepEqual(testApi.resolveClaudeToolPolicy(undefined, undefined), { tools: [] });
  });

  it("refuses Claude profiles whose requested restrictions cannot be honored", () => {
    assert.match(testApi.resolveClaudeToolPolicy("read,safe_bash", undefined).error, /safe_bash/);
    assert.match(testApi.resolveClaudeToolPolicy("read,ls", undefined).error, /ls/);
    assert.match(
      testApi.resolveClaudeToolPolicy("read", ["scout"]).error,
      /nested subagents|subagent_agents/i,
    );
  });

  it("requires installed Claude help to advertise every fail-closed policy flag", () => {
    const supported = [
      "--tools <tools...>",
      "--allowedTools, --allowed-tools <tools...>",
      "--permission-mode <mode> (choices: dontAsk)",
      "--setting-sources <sources>",
      "--mcp-config <configs...>",
      "--strict-mcp-config",
    ].join("\n");
    assert.equal(testApi.claudePolicyHelpError(supported), null);
    assert.match(testApi.claudePolicyHelpError(supported.replace("--strict-mcp-config", "")), /strict-mcp/);
  });

  it("builds Claude launches without bypass permissions or ambient MCP/settings", () => {
    const parts = ["claude"];
    testApi.applyClaudeToolPolicy(parts, ["Read", "Grep"]);
    const joined = parts.join(" ");
    assert.match(joined, /--tools 'Read,Grep'/);
    assert.match(joined, /--allowedTools 'Read,Grep'/);
    assert.match(joined, /--permission-mode dontAsk/);
    assert.match(joined, /--setting-sources ''/);
    assert.match(joined, /--strict-mcp-config/);
    assert.match(joined, /--mcp-config/);
    assert.doesNotMatch(joined, /dangerously-skip-permissions|bypassPermissions/);

    const noTools = ["claude"];
    testApi.applyClaudeToolPolicy(noTools, []);
    assert.match(noTools.join(" "), /--tools ''/);
    assert.equal(noTools.includes("--allowedTools"), false);
  });

  it("keeps a stale lifecycle-only resume loadout restricted without loading this extension", () => {
    withTempDir((d) => {
      const sessionFile = join(d, "stale.jsonl");
      writeFileSync(
        loadoutSidecarPath(sessionFile),
        JSON.stringify({
          agent: "worker",
          toolAllowlist: "subagent,subagent_message,subagent_resume,subagent_kill,subagents_list",
          toolExtensions: [],
          toolExtensionIdentities: [],
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: true,
          cwd: null,
          agentDir: null,
        }),
      );
      const loaded = readSubagentLoadout(sessionFile);
      assert.ok(loaded);
      assert.equal(loaded.toolAllowlist, "");

      const parts: string[] = [];
      testApi.applySandboxToParts(parts, loaded, { artifactDir: d, name: "worker" });
      assert.ok(parts.includes("--no-extensions"));
      assert.ok(parts.includes("--tools"));
      assert.equal(parts.some((part) => part.includes("index.ts")), false);
    });
  });

  it("applies default-deny flags for a named profile that omits tools", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: "custom",
          toolAllowlist: testApi.buildSubagentToolAllowlist(undefined),
          toolExtensions: [],
          toolExtensionIdentities: [],
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: true,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "custom" },
      );
      assert.ok(parts.includes("--no-extensions"));
      assert.ok(parts.includes("--tools"));
      assert.ok(parts.some((part) => part.includes("ask_question")));
    });
  });

  it("applySandboxToParts replays model, identity, and default-deny tool restriction", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: "worker",
          toolAllowlist: "read,write,safe_bash",
          toolExtensions: [],
          toolExtensionIdentities: [],
          model: "openrouter/z-ai/glm-5.2",
          thinking: "medium",
          systemPromptMode: "append",
          identity: "You are a worker.",
          spawnable: ["scout"],
          autoExit: true,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "worker" },
      );
      const joined = parts.join(" ");
      // Model with thinking suffix.
      assert.ok(joined.includes("--model"), "expected --model");
      assert.ok(joined.includes("openrouter/z-ai/glm-5.2:medium"), "expected model:thinking");
      // Identity written to a file and appended.
      assert.ok(joined.includes("--append-system-prompt"), "expected --append-system-prompt");
      // Default-deny restriction.
      assert.ok(parts.includes("--no-extensions"), "expected --no-extensions");
      const toolsIdx = parts.indexOf("--tools");
      assert.ok(toolsIdx >= 0, "expected --tools");
      // The value is shell-escaped (single-quoted) before joining.
      assert.ok(
        parts[toolsIdx + 1].includes("read,write,safe_bash"),
        "expected the tool allowlist as the --tools value",
      );
    });
  });

  it("applySandboxToParts omits restriction flags when the loadout was unrestricted", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: null,
          toolAllowlist: null,
          toolExtensions: null,
          toolExtensionIdentities: null,
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: false,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "fork" },
      );
      assert.deepEqual(parts, []);
    });
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review,lint", taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: undefined, taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review", taskDelivery: "direct", taskArg: "do the task" }),
      ["/skill:review", "do the task"],
    );
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });
});
describe("subagent-done.ts", () => {
  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("auto-exits after normal completion even when the user sent the prompt", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
    });

    it("still exits when the latest turn ended with stopReason=error", () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", content: [] },
        { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
        stopReason: "error",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.equal(info!.stopReason, "error");
      assert.match(info!.errorMessage, /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });

  describe("runningChildrenCount", () => {
    const KEY = Symbol.for("pi-subagents/running-children-count");
    function withGlobal(value: unknown, run: () => void) {
      const prev = (globalThis as any)[KEY];
      (globalThis as any)[KEY] = value;
      try {
        run();
      } finally {
        (globalThis as any)[KEY] = prev;
      }
    }

    it("returns 0 when the spawning tools aren't loaded (no global)", () => {
      withGlobal(undefined, () => {
        assert.equal(runningChildrenCount(), 0);
      });
    });

    it("reflects the live child count published by index.ts", () => {
      withGlobal(() => 3, () => {
        assert.equal(runningChildrenCount(), 3);
      });
    });

    it("treats zero/negative/non-number/throwing getters as 0", () => {
      withGlobal(() => 0, () => assert.equal(runningChildrenCount(), 0));
      withGlobal(() => -1, () => assert.equal(runningChildrenCount(), 0));
      withGlobal(() => "two", () => assert.equal(runningChildrenCount(), 0));
      withGlobal(() => { throw new Error("boom"); }, () => assert.equal(runningChildrenCount(), 0));
    });
  });

  describe("ask_question tool", () => {
    function setupSubagentExtension(sessionFile: string) {
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-2";
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      const mock = createMockExtensionApi();
      subagentDoneExtension(mock.api);
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      return { mock, restore };
    }

    it("registers ask_question (and no caller_ping) with a single freeform question param", () => {
      const dir = createTestDir();
      const { mock, restore } = setupSubagentExtension(join(dir, "s.jsonl"));
      try {
        const names = mock.registeredTools.map((t) => t.name);
        assert.ok(names.includes("ask_question"));
        assert.ok(!names.includes("caller_ping"));
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        assert.deepEqual(Object.keys(tool.parameters.properties), ["question"]);
        assert.match(tool.description, /orchestrator/i);
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("records a pending question without shutting down or creating sidecar IPC", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { mock, restore } = setupSubagentExtension(sessionFile);
      try {
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        let shutdownCalled = false;
        const ctx = { shutdown() { shutdownCalled = true; } } as any;
        const out = await tool.execute("call-1", { question: "Which API base URL?" }, undefined, undefined, ctx);

        assert.equal(shutdownCalled, false, "ask_question must keep the session open");
        assert.match(out.content[0].text, /wait/i);

        assert.ok(!existsSync(`${sessionFile}.ask`), "ask_question uses settled records, not sidecar IPC");
        assert.ok(!existsSync(`${sessionFile}.exit`), "the session is not exiting");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rejects empty and whitespace-only questions before changing lifecycle state", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "empty-question.jsonl");
      const { mock, restore } = setupSubagentExtension(sessionFile);
      try {
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        await assert.rejects(
          tool.execute("call-empty", { question: "  \n\t " }, undefined, undefined, { shutdown() {} }),
          /non-empty question/,
        );
        assert.equal(existsSync(`${sessionFile}.idle`), false);
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // A mid-run reply fires `input` but not necessarily `agent_start`, so input
    // is the authoritative boundary that clears the pending question.
    function setupCapturingExtension(
      sessionFile: string,
      autoExit = true,
      extension = subagentDoneExtension,
    ) {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const tools: any[] = [];
      const api = {
        on(event: string, handler: (...args: any[]) => void) {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(handler);
        },
        registerTool(t: any) { tools.push(t); },
        registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
        sendUserMessage() {}, sendMessage() {}, getAllTools() { return []; },
      } as any;
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-2";
      process.env.PI_SUBAGENT_AGENT = "scout";
      if (autoExit) process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      else delete process.env.PI_SUBAGENT_AUTO_EXIT;
      extension(api);
      const emit = (event: string, ...args: any[]) =>
        (handlers.get(event) ?? []).forEach((h) => h(...args));
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      const ask = async () => {
        const tool = tools.find((t) => t.name === "ask_question");
        await tool.execute("c1", { question: "v1 or v2?" }, undefined, undefined, { shutdown() {} });
      };
      return { emit, ask, restore };
    }

    it("publishes every interactive settled cycle and batches accumulated delivery", () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "interactive.jsonl");
      const { emit, restore } = setupCapturingExtension(sessionFile, false);
      try {
        emit("agent_start");
        emit(
          "agent_end",
          {
            messages: [{
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "First checkpoint" }],
            }],
          },
          { shutdown() { assert.fail("interactive child must remain alive"); } },
        );
        assert.equal(existsSync(`${sessionFile}.idle`), false, "agent_end is not settled");
        emit("agent_settled", {}, { isIdle() { return true; } });

        emit("input");
        emit("agent_start");
        emit(
          "agent_end",
          {
            messages: [{
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "Second checkpoint" }],
            }],
          },
          { shutdown() { assert.fail("interactive child must remain alive"); } },
        );
        emit("agent_settled", {}, { isIdle() { return true; } });

        const notifications = readSettledRecords(sessionFile);
        assert.equal(notifications.length, 2);
        assert.equal(notifications[0].state, "idle");
        assert.equal(notifications[0].response, "First checkpoint");
        assert.equal(notifications[1].state, "idle");
        assert.equal(notifications[1].response, "Second checkpoint");

        const parent = createMockExtensionApi();
        (subagentsModule as any).default(parent.api);
        const running = settledRunning(sessionFile, "interactive-child");
        (subagentsModule as any).__test__.deliverPendingSettled(running);
        assert.equal(parent.sentMessages.length, 1, "accumulated settlements are one parent turn");
        assert.equal(parent.sentMessages[0].message.details.settledCount, 2);
        assert.deepEqual(parent.sentMessages[0].message.details.states, ["idle", "idle"]);
        assert.equal(parent.sentMessages[0].message.details.response, "Second checkpoint");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps publication order monotonic when Date.now moves backwards", () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "clock-rollback.jsonl");
      const { emit, restore } = setupCapturingExtension(sessionFile, false);
      const realNow = Date.now;
      let now = 2_000;
      Date.now = () => now;
      try {
        emit("agent_start");
        emit("agent_end", {
          messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "First" }] }],
        }, { shutdown() {} });
        emit("agent_settled", {}, { isIdle() { return true; } });

        now = 1_000;
        emit("input");
        emit("agent_start");
        emit("agent_end", {
          messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Second" }] }],
        }, { shutdown() {} });
        emit("agent_settled", {}, { isIdle() { return true; } });

        const records = readSettledRecords(sessionFile);
        assert.deepEqual(records.map((record) => record.response), ["First", "Second"]);
        assert.deepEqual(records.map((record) => record.settledAt), [2_000, 1_000]);
      } finally {
        Date.now = realNow;
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps sequence order across extension module reload with retained records", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "extension-reload.jsonl");
      const moduleUrl = new URL("../pi-extension/subagents/subagent-done.ts", import.meta.url).href;
      let restoreFirst: (() => void) | undefined;
      let restoreSecond: (() => void) | undefined;
      try {
        const beforeReload = await import(`${moduleUrl}?settled-sequence=before`);
        const first = setupCapturingExtension(sessionFile, false, beforeReload.default);
        restoreFirst = first.restore;
        first.emit("agent_start");
        first.emit("agent_end", {
          messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Before reload" }] }],
        }, { shutdown() {} });
        first.emit("agent_settled", {}, { isIdle() { return true; } });
        restoreFirst();
        restoreFirst = undefined;

        const afterReload = await import(`${moduleUrl}?settled-sequence=after`);
        const second = setupCapturingExtension(sessionFile, false, afterReload.default);
        restoreSecond = second.restore;
        second.emit("agent_start");
        await second.ask();
        second.emit("agent_end", {
          messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "After reload" }] }],
        }, { shutdown() {} });
        second.emit("agent_settled", {}, { isIdle() { return true; } });

        const files = readdirSync(`${sessionFile}.idle`).filter((name) => name.endsWith(".json"));
        assert.ok(files.every((name) => name.split("-", 1)[0].length === 20));
        const byResponse = new Map(files.map((name) => {
          const payload = JSON.parse(readFileSync(join(`${sessionFile}.idle`, name), "utf8"));
          return [payload.response, BigInt(name.split("-", 1)[0])];
        }));
        assert.ok(byResponse.get("After reload")! > byResponse.get("Before reload")!);
        assert.deepEqual(
          readSettledRecords(sessionFile).map((record) => record.state),
          ["idle", "awaiting_answer"],
        );

        const parent = createMockExtensionApi();
        (subagentsModule as any).default(parent.api);
        (subagentsModule as any).__test__.deliverPendingSettled(
          settledRunning(sessionFile, "extension-reload"),
        );
        assert.equal(parent.sentMessages[0].message.customType, "subagent_question");
        assert.equal(parent.sentMessages[0].message.details.response, "After reload");
      } finally {
        restoreSecond?.();
        restoreFirst?.();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("waits for agent_settled across retries and queued continuations before publishing idle", () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "retry.jsonl");
      const { emit, restore } = setupCapturingExtension(sessionFile, false);
      try {
        emit("agent_start");
        emit("agent_end", {
          messages: [{
            role: "assistant",
            stopReason: "error",
            content: [{ type: "text", text: "Retrying" }],
          }],
        }, { shutdown() {} });
        emit("agent_start");
        emit("agent_end", {
          messages: [{
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Continuation complete" }],
          }],
        }, { shutdown() {} });
        assert.equal(existsSync(`${sessionFile}.idle`), false);

        emit("agent_settled", {}, { isIdle() { return true; } });
        const [notification] = readSettledRecords(sessionFile);
        assert.equal(notification.state, "idle");
        assert.equal(notification.response, "Continuation complete");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("publishes waiting_on_children even when settled context is not idle", () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "nested-wait.jsonl");
      const symbol = Symbol.for("pi-subagents/running-children-count");
      const previous = (globalThis as any)[symbol];
      (globalThis as any)[symbol] = () => 1;
      const { emit, restore } = setupCapturingExtension(sessionFile);
      try {
        emit("agent_start");
        let shutdown = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, false, "a live nested child suppresses auto-exit");
        emit("agent_settled", {}, { isIdle() { return false; } });
        const records = readSettledRecords(sessionFile);
        assert.equal(records.length, 1);
        assert.equal(records[0].state, "waiting_on_children");
      } finally {
        if (previous === undefined) delete (globalThis as any)[symbol];
        else (globalThis as any)[symbol] = previous;
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("exits (does not park) when the reply arrives mid-run via input", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask(); // sets the pending question mid-run
        // Reply arrives MID-RUN as a steer: input fires, no new agent_start.
        emit("input");
        let shutdown = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, true, "reply consumed mid-run → agent_end should exit, not park");
        emit("agent_settled", {}, { isIdle() { return true; } });
        assert.equal(
          existsSync(join(dir, "s.jsonl.idle")),
          false,
          "auto-exit completion must deliver only the terminal result path",
        );
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("retains and later batches a settled question when delivery fails after input settles", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "late-rejection.jsonl");
      const { emit, ask, restore } = setupCapturingExtension(sessionFile, false);
      try {
        emit("agent_start");
        await ask();
        emit("agent_end", { messages: [] }, { shutdown() {} });
        emit("agent_settled", {}, { isIdle() { return true; } });

        const parent = createMockExtensionApi();
        const acceptedSend = parent.api.sendMessage;
        let forcedInterleaving = false;
        parent.api.sendMessage = () => {
          forcedInterleaving = true;
          emit("input");
          emit("agent_start");
          emit("agent_end", {
            messages: [{
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "Input handled while parent send failed" }],
            }],
          }, { shutdown() {} });
          emit("agent_settled", {}, { isIdle() { return true; } });
          throw new Error("parent busy");
        };
        (subagentsModule as any).default(parent.api);
        const running = settledRunning(sessionFile, "late-rejection");
        const deliver = (subagentsModule as any).__test__.deliverPendingSettled;
        deliver(running);
        assert.equal(forcedInterleaving, true);
        assert.deepEqual(
          readSettledRecords(sessionFile).map((record) => record.state),
          ["awaiting_answer", "idle"],
          "immutable records survive the late rejected send",
        );

        parent.api.sendMessage = acceptedSend;
        deliver(running);
        deliver(running);
        assert.equal(parent.sentMessages.length, 1, "the retained batch wakes the parent once");
        assert.equal(parent.sentMessages[0].message.customType, "subagent_idle");
        assert.deepEqual(
          parent.sentMessages[0].message.details.states,
          ["awaiting_answer", "idle"],
        );
        assert.match(parent.sentMessages[0].message.content, /awaiting_answer \(v1 or v2\?\)/);
        assert.equal(
          parent.sentMessages[0].message.details.response,
          "Input handled while parent send failed",
        );
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps a question pending across automatic retries until actual input arrives", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "ask-retry.jsonl");
      const { emit, ask, restore } = setupCapturingExtension(sessionFile, false);
      try {
        emit("agent_start");
        await ask();

        emit("agent_end", {
          messages: [{ role: "assistant", stopReason: "error", content: [] }],
        }, { shutdown() {} });
        // Pi may start another low-level run for retry, compaction recovery, or
        // an automatic continuation. No external reply has arrived.
        emit("agent_start");
        emit("agent_end", {
          messages: [{ role: "assistant", stopReason: "stop", content: [] }],
        }, { shutdown() {} });
        emit("agent_settled", {}, { isIdle() { return true; } });
        assert.deepEqual(readSettledRecords(sessionFile)[0], {
          type: "settled",
          state: "awaiting_answer",
          name: "scout-2",
          agent: "scout",
          settledAt: readSettledRecords(sessionFile)[0].settledAt,
          question: "v1 or v2?",
        });

        // Actual pane/user input is the authoritative answer/supersession edge.
        emit("input");
        emit("agent_start");
        emit("agent_end", {
          messages: [{
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Reply incorporated after retry" }],
          }],
        }, { shutdown() {} });
        emit("agent_settled", {}, { isIdle() { return true; } });
        const records = readSettledRecords(sessionFile);
        assert.deepEqual(records.map((record) => record.state), ["awaiting_answer", "idle"]);
        assert.equal(records[1].response, "Reply incorporated after retry");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("parks as waiting at agent_end while the reply is still pending (no input yet)", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask();
        // No input yet — the orchestrator has not replied.
        let shutdown = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, false, "pending question with no reply must park, not exit");
        emit("agent_settled", {}, { isIdle() { return true; } });
        const [record] = readSettledRecords(join(dir, "s.jsonl"));
        assert.equal(record.state, "awaiting_answer");
        assert.equal(record.question, "v1 or v2?");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("exits when input supplies the reply before a new turn", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask();
        let shutdown1 = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown1 = true; } });
        assert.equal(shutdown1, false, "parks while waiting");
        // Reply arrives as a fresh turn after the subagent had parked.
        emit("input");
        emit("agent_start");
        let shutdown2 = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown2 = true; } });
        assert.equal(shutdown2, true, "after the reply turn, agent_end should exit");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("does not let partial or corrupt publication block a later settled record", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "partial-idle-child.jsonl");
      writeSettledRecord(sessionFile, `{"type":"settled","state":"idle"`, ".partial.tmp");
      writeSettledRecord(sessionFile, `{"type":"settled","state":"idle"`, "00000000.json");
      writeSettledRecord(
        sessionFile,
        { type: "settled", state: "awaiting_answer", question: "   " },
        "00000000-whitespace.json",
      );
      writeSettledRecord(
        sessionFile,
        { type: "settled", state: "idle", response: "Valid checkpoint" },
        "00000001.json",
      );
      const { api, sentMessages } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const running = settledRunning(sessionFile, "partial-idle-child");

      const deliver = (subagentsModule as any).__test__.deliverPendingSettled;
      deliver(running);
      deliver(running);
      assert.deepEqual(
        sentMessages.map(({ message }) => message.details.response),
        ["Valid checkpoint"],
      );
      assert.equal(
        existsSync(join(`${sessionFile}.idle`, "00000000.json")),
        false,
        "a malformed finalized record is retired rather than retried forever",
      );
      assert.equal(
        existsSync(join(`${sessionFile}.idle`, "00000000-whitespace.json")),
        false,
        "an invalid awaiting state cannot diverge into an idle notification",
      );
    });
  });

  it("batches ordered settled records and retries the whole rejected batch once", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "idle-child.jsonl");
      writeSettledRecord(
        sessionFile,
        { type: "settled", state: "idle", response: "First checkpoint" },
        "00000001.json",
      );
      writeSettledRecord(
        sessionFile,
        { type: "settled", state: "waiting_on_children", response: "Second checkpoint" },
        "00000002.json",
      );
      const { api, sentMessages } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const running = settledRunning(sessionFile, "idle-child");
      const deliver = (subagentsModule as any).__test__.deliverPendingSettled;

      deliver(running);
      deliver(running);
      assert.equal(sentMessages.length, 1, "accumulated records produce one parent wakeup");
      assert.deepEqual(sentMessages[0].message.details.states, ["idle", "waiting_on_children"]);
      assert.equal(sentMessages[0].message.details.status, "waiting_on_children");
      assert.equal(sentMessages[0].message.details.response, "Second checkpoint");
      assert.equal(sentMessages[0].message.details.running, true);
      assert.match(sentMessages[0].message.content, /waiting on child sub-agents/);
      assert.deepEqual(sentMessages[0].options, { triggerTurn: true, deliverAs: "steer" });

      writeSettledRecord(
        sessionFile,
        { type: "settled", state: "idle", response: "Third checkpoint" },
        "00000003.json",
      );
      deliver(running);
      assert.equal(sentMessages.length, 2, "a later settled cycle wakes exactly once");
      assert.equal(sentMessages[1].message.details.response, "Third checkpoint");

      writeSettledRecord(
        sessionFile,
        { type: "settled", state: "idle", response: "Retryable checkpoint" },
        "00000004.json",
      );
      const sendMessage = api.sendMessage;
      api.sendMessage = () => { throw new Error("parent busy"); };
      deliver(running);
      assert.equal(sentMessages.length, 2, "a rejected send must not consume the record");
      api.sendMessage = sendMessage;
      deliver(running);
      deliver(running);
      assert.equal(sentMessages.length, 3, "the retried record is accepted exactly once");
      assert.equal(sentMessages[2].message.details.response, "Retryable checkpoint");

      writeSettledRecord(
        sessionFile,
        { type: "settled", state: "awaiting_answer", question: "Choose A or B?" },
        "00000005.json",
      );
      deliver(running);
      assert.equal(sentMessages[3].message.customType, "subagent_question");
      assert.equal(sentMessages[3].message.details.status, "awaiting_answer");
      assert.equal(sentMessages[3].message.details.question, "Choose A or B?");
    });
  });
});

describe("tmux.ts interpretExitSidecar", () => {
  const { interpretExitSidecar } = __pollForExitTest__;

  it("rejects ping payloads because ask_question keeps the session open", () => {
    assert.equal(
      interpretExitSidecar({ type: "ping", name: "Worker", message: "need help" }),
      null,
    );
  });

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("rejects null, empty, and unknown terminal payloads", () => {
    assert.equal(interpretExitSidecar({}), null);
    assert.equal(interpretExitSidecar(null), null);
    assert.equal(interpretExitSidecar({ type: "future-terminal" }), null);
    assert.equal(interpretExitSidecar("malformed-shape"), null);
  });
});

describe("tmux.ts missing-pane polling", () => {
  const missingPaneError = () => Object.assign(
    new Error("tmux capture-pane failed: can't find pane: %42"),
    { stderr: JSON.stringify({ error: { code: "pane_not_found" } }) },
  );

  it("terminates after a missing pane is confirmed", async () => {
    let reads = 0;
    const result = await pollForExit("%42", new AbortController().signal, {
      interval: 1,
      readScreen: async () => {
        reads++;
        throw missingPaneError();
      },
    });

    assert.deepEqual(result, { reason: "disappeared", exitCode: 1 });
    assert.equal(reads, 2, "one failed capture plus one confirmation is sufficient");
  });

  it("recovers when a missing-pane capture succeeds on confirmation", async () => {
    let reads = 0;
    const result = await pollForExit("%42", new AbortController().signal, {
      interval: 1,
      readScreen: async () => {
        reads++;
        if (reads === 1) throw missingPaneError();
        if (reads === 2) return "";
        return "__SUBAGENT_DONE_0__";
      },
    });

    assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
    assert.equal(reads, 3);
  });

  it("ignores an unknown sidecar and continues to a real terminal sentinel", async () => {
    const dir = createTestDir();
    const sessionFile = join(dir, "unknown-sidecar.jsonl");
    let reads = 0;
    try {
      writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "ping" }));
      const result = await pollForExit("%42", new AbortController().signal, {
        interval: 1,
        sessionFile,
        readScreen: async () => {
          reads++;
          return "__SUBAGENT_DONE_7__";
        },
      });

      assert.deepEqual(result, { reason: "sentinel", exitCode: 7 });
      assert.equal(reads, 1, "unknown sidecars must not terminate polling");
      assert.equal(existsSync(`${sessionFile}.exit`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let malformed sidecar JSON block a real terminal sentinel", async () => {
    const dir = createTestDir();
    const sessionFile = join(dir, "malformed-sidecar.jsonl");
    try {
      writeFileSync(`${sessionFile}.exit`, "{not-json");
      const result = await pollForExit("%42", new AbortController().signal, {
        interval: 1,
        sessionFile,
        readScreen: async () => "__SUBAGENT_DONE_3__",
      });

      assert.deepEqual(result, { reason: "sentinel", exitCode: 3 });
      assert.equal(
        existsSync(`${sessionFile}.exit`),
        true,
        "malformed payloads are not consumed or promoted to completion",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not classify a generic transient tmux error as disappearance", async () => {
    let reads = 0;
    const result = await pollForExit("%42", new AbortController().signal, {
      interval: 1,
      readScreen: async () => {
        reads++;
        if (reads === 1) throw new Error("tmux server temporarily unavailable");
        return "__SUBAGENT_DONE_0__";
      },
    });

    assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
    assert.equal(reads, 2);
  });

  it("prefers an error sidecar racing with pane disappearance", async () => {
    const dir = createTestDir();
    const sessionFile = join(dir, "raced.jsonl");
    let reads = 0;
    try {
      const result = await pollForExit("%42", new AbortController().signal, {
        interval: 1,
        sessionFile,
        readScreen: async () => {
          reads++;
          writeFileSync(
            `${sessionFile}.exit`,
            JSON.stringify({ type: "error", errorMessage: "provider exhausted retries" }),
          );
          throw missingPaneError();
        },
      });

      assert.equal(result.reason, "error");
      assert.equal(result.exitCode, 1);
      assert.equal(result.errorMessage, "provider exhausted retries");
      assert.equal(reads, 1);
      assert.equal(existsSync(`${sessionFile}.exit`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("integration harness owned child cleanup", () => {
  it("collects only exact owned outer-session children and preserves unknown files", async () => {
    const harness = await import("./integration/harness.ts") as any;
    const dir = createTestDir();
    try {
      const ownedOuter = join(dir, "owned-outer.jsonl");
      const unownedOuter = join(dir, "unowned-outer.jsonl");
      const ownedDir = join(dir, "owned-child-dir");
      const unownedDir = join(dir, "unowned-child-dir");
      const ownedChild = join(ownedDir, "owned.jsonl");
      const unownedChild = join(unownedDir, "unowned.jsonl");
      mkdirSync(ownedDir, { recursive: true });
      mkdirSync(unownedDir, { recursive: true });
      for (const path of [ownedChild, `${ownedChild}.loadout.json`, `${ownedChild}.ask`, `${ownedChild}.exit`]) {
        writeFileSync(path, "owned");
      }
      mkdirSync(join(`${ownedChild}.idle`, "nested"), { recursive: true });
      writeFileSync(join(`${ownedChild}.idle`, "nested", "record.json"), "owned");
      const unknownFile = join(ownedDir, "keep.me");
      writeFileSync(unknownFile, "unknown");
      writeFileSync(unownedChild, "unowned");
      const outerEntry = (sessionFile: string) => JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          details: { status: "started", sessionFile },
          content: [],
        },
      }) + "\n";
      writeFileSync(ownedOuter, outerEntry(ownedChild));
      writeFileSync(unownedOuter, outerEntry(unownedChild));

      const collected = harness.collectOwnedChildSessionFiles([ownedOuter]);
      assert.deepEqual(collected.sessionFiles, [ownedChild]);
      assert.deepEqual(collected.errors, []);
      harness.cleanupOwnedChildSessionFiles(collected.sessionFiles);

      assert.equal(existsSync(ownedChild), false);
      assert.equal(existsSync(`${ownedChild}.loadout.json`), false);
      assert.equal(existsSync(`${ownedChild}.ask`), false);
      assert.equal(existsSync(`${ownedChild}.exit`), false);
      assert.equal(existsSync(`${ownedChild}.idle`), false, "owned settled queue is removed recursively");
      assert.equal(existsSync(unknownFile), true, "unknown files must prevent exact-dir removal");
      assert.equal(existsSync(ownedDir), true);
      assert.equal(existsSync(unownedChild), true, "unowned outer sessions must never be scanned");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports malformed and unreadable owned transcripts while preserving discovered cleanup", async () => {
    const harness = await import("./integration/harness.ts") as any;
    const dir = createTestDir();
    try {
      const validOuter = join(dir, "valid-outer.jsonl");
      const malformedOuter = join(dir, "malformed-outer.jsonl");
      const missingOuter = join(dir, "missing-outer.jsonl");
      const child = join(dir, "child.jsonl");
      const unknown = join(dir, "unknown.jsonl");
      writeFileSync(child, "owned");
      writeFileSync(unknown, "unknown");
      writeFileSync(validOuter, JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          details: { status: "started", sessionFile: child },
        },
      }) + "\n");
      writeFileSync(malformedOuter, "{not-json}\n");

      const collected = harness.collectOwnedChildSessionFiles([
        validOuter,
        malformedOuter,
        missingOuter,
      ]);
      assert.deepEqual(collected.sessionFiles, [child]);
      assert.equal(collected.errors.length, 2);
      assert.match(collected.errors[0].message, /malformed/i);
      assert.match(collected.errors[1].message, /read/i);

      harness.cleanupOwnedChildSessionFiles(collected.sessionFiles);
      assert.equal(existsSync(child), false, "valid discoveries are still cleaned");
      assert.equal(existsSync(unknown), true, "unknown files remain untouched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aggregates exact-file cleanup failures after attempting the remaining owned files", async () => {
    const harness = await import("./integration/harness.ts") as any;
    const dir = createTestDir();
    try {
      const child = join(dir, "child.jsonl");
      writeFileSync(child, "owned");
      mkdirSync(`${child}.ask`);
      writeFileSync(`${child}.loadout.json`, "owned");

      assert.throws(
        () => harness.cleanupOwnedChildSessionFiles([child]),
        (error: any) => error instanceof AggregateError && error.errors.length === 1,
      );
      assert.equal(existsSync(child), false);
      assert.equal(existsSync(`${child}.loadout.json`), false);
      assert.equal(existsSync(`${child}.ask`), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("commands", () => {
  it("/subagent emits a spawn tool call for a known agent", () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    const subagent = registeredCommands.find((command) => command.name === "subagent");
    assert.ok(subagent, "expected /subagent to be registered");

    subagent.handler("scout map the auth code", {
      ui: { notify() {} },
    });

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /agent: "scout"/);
    assert.match(sentUserMessages[0], /map the auth code/);
  });

  it("does not register the removed /iterate or /plan commands", () => {
    const { api, registeredCommands } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    assert.equal(registeredCommands.find((c) => c.name === "iterate"), undefined);
    assert.equal(registeredCommands.find((c) => c.name === "plan"), undefined);
  });
});

describe("tool registration", () => {
  it("always resumes subagents as autonomous (auto-exit, non-interactive tracking)", () => {
    const testApi = (subagentsModule as any).__test__;

    assert.deepEqual(testApi.resolveResumeLaunchBehavior(), {
      autoExit: true,
      interactive: false,
    });
  });


  it("rejects a top-level spawn with no agent and no fork", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const result = await subagentTool.execute("call-1", { name: "x", task: "do it" });
    assert.equal(result.details?.error, "agent required");
    assert.match(result.content[0].text, /specify which agent/i);
  });

  it("rejects a top-level spawn naming an unknown agent", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const result = await subagentTool.execute("call-1", {
      name: "x",
      task: "do it",
      agent: "wizard",
    });
    assert.equal(result.details?.error, "unknown agent");
    assert.match(result.content[0].text, /not a known agent/i);
  });

  it("exposes a debloated schema: agent+task required, name/model/cwd optional, no override knobs", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const props = subagentTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["agent", "cwd", "model", "name", "task"],
      "only agent/task/name/model/cwd should remain",
    );
    assert.deepEqual(
      [...(subagentTool.parameters.required ?? [])].sort(),
      ["agent", "task"],
      "agent and task must be required",
    );
    // `name` is now optional and purely cosmetic.
    assert.match(props.name.description, /cosmetic/i);
    // The removed override knobs must be gone.
    for (const gone of ["tools", "skills", "systemPrompt", "fork", "interactive", "resumeSessionId"]) {
      assert.equal(props[gone], undefined, `expected ${gone} param to be removed`);
    }
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers subagent_message with name + message both required (name-only addressing)", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
    assert.ok(messageTool, "expected subagent_message tool to be registered");

    const props = messageTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["message", "name"],
      "only name/message should remain (sessionId dropped)",
    );
    assert.equal(props.message.type, "string");
    assert.equal(props.name.type, "string");
    assert.deepEqual(
      messageTool.parameters.required?.slice().sort(),
      ["message", "name"],
      "name and message should both be required",
    );
    assert.equal(props.sessionId, undefined, "sessionId should be removed");
    assert.equal(props.autoExit, undefined, "autoExit knob should be removed");
  });

  it("registers the completed-only safe resume and kill tools, but not interrupt", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const names = registeredTools.map((tool) => tool.name);
    assert.equal(names.includes("subagent_interrupt"), false);
    assert.equal(names.includes("subagent_kill"), true);
    assert.equal(names.includes("subagent_resume"), true);

    const kill = registeredTools.find((tool) => tool.name === "subagent_kill");
    assert.deepEqual(Object.keys(kill.parameters.properties), ["name"]);
    assert.deepEqual(kill.parameters.required, ["name"]);

    const lifecycleNames = [
      "subagent", "subagent_message", "subagent_resume", "subagent_kill", "subagents_list",
    ];
    assert.equal(
      lifecycleNames.filter((name) => names.includes(name)).length,
      5,
      "the parent system-prompt surface should contain five lifecycle tools",
    );

    const resume = registeredTools.find((tool) => tool.name === "subagent_resume");
    assert.deepEqual(Object.keys(resume.parameters.properties).sort(), ["message", "name"]);
    assert.deepEqual(resume.parameters.required?.slice().sort(), ["message", "name"]);
    for (const forbidden of [
      "sessionPath", "sessionId", "cwd", "model", "tools", "autoExit", "interactive",
    ]) {
      assert.equal(resume.parameters.properties[forbidden], undefined);
    }
    assert.match(resume.description, /current parent session|parent-scoped/i);
    assert.match(resume.promptSnippet, /completed/i);
    assert.match(resume.promptSnippet, /subagent_message.*live|live.*subagent_message/i);
    assert.doesNotMatch(resume.promptSnippet, /session path|session id/i);

    const message = registeredTools.find((tool) => tool.name === "subagent_message");
    assert.match(message.promptSnippet, /backward compatibility/i);
    assert.match(message.promptSnippet, /prefer subagent_resume/i);
  });
});

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.activeScope, "tool");
      assert.equal(read.activity.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        reason: "wrong-id",
      });
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentSettledWaiting();
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.latestEvent, "agent_settled");
      assert.equal(read.activity.waitingSince, 3_000);

      currentNow = 4_000;
      recorder.agentEndDone();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.agentActive, false);
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({ runningChildId: `child-${index}`, ...overrides });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal((read as { ok: false; reason: string }).reason, "invalid");
      }
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.activity.toolActive, false);
      assert.equal(read.activity.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "starting");
      assert.equal(read.activity.latestEvent, "session_start");
    });
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.activity.phase, "starting");
          assert.equal(read.activity.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagent interruption", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  it("registers subagent_message and explicit resume, but not the old interrupt tool", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const names = registeredTools.map((tool) => tool.name);
    assert.equal(names.includes("subagent_message"), true);
    assert.equal(names.includes("subagent_resume"), true);
    assert.equal(names.includes("subagent_interrupt"), false);
  });

  it("kills Pi and Claude children through the lifecycle seam", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    withTempDir((dir) => {
      for (const cli of [undefined, "claude"]) {
        const sessionFile = join(dir, `${cli ?? "pi"}.jsonl`);
        const registryDir = join(dir, `registry-${cli ?? "pi"}`);
        writeFileSync(sessionFile, "{}\n");
        const runId = `kill-${cli ?? "pi"}`;
        seedRegistryRun(registryDir, "Worker", {
          sessionFile,
          sessionId: null,
          runState: "running",
          runId,
        });
        let aborted = false;
        const running = {
          id: runId,
          name: "Worker",
          task: "",
          surface: `pane-${cli ?? "pi"}`,
          startTime: 0,
          sessionFile,
          registryArtifactDir: registryDir,
          cli,
          abortController: { abort() { aborted = true; } },
          interactive: false,
          statusState: createStatusState({ source: cli === "claude" ? "claude" : "pi", startTimeMs: 0 }),
        };
        runningMap.set(running.id, running);
        const result = testApi.handleSubagentKill({ name: "Worker" }, () => {});
        assert.equal(result.details.status, "killed");
        assert.equal(aborted, true);
        assert.equal(runningMap.has(running.id), false);
        assert.equal(testApi.shouldSuppressWatcherMessage(running), true);
        assert.equal(resolveNameInRegistry(registryDir, "Worker"), null);
        assert.equal(existsSync(sessionFile), true, "kill must preserve the transcript");
        const replacement = join(dir, `${cli ?? "pi"}-replacement.jsonl`);
        seedRegistryRun(registryDir, "Worker", { sessionFile: replacement, sessionId: null });
        assert.equal(resolveNameInRegistry(registryDir, "Worker")?.sessionFile, replacement);
      }
    });
    runningMap.clear();
  });

  it("does not delete a newer mapping when stale ownership performs cleanup", () => {
    withTempDir((dir) => {
      seedRegistryRun(dir, "Worker", {
        sessionFile: "/old.jsonl",
        sessionId: null,
        runState: "running",
        runId: "old-owner",
      });
      assert.equal(
        removeOwnedNameRun(dir, "Worker", "/old.jsonl", "old-owner", "running"),
        true,
      );
      seedRegistryRun(dir, "Worker", {
        sessionFile: "/new.jsonl",
        sessionId: null,
        runState: "running",
        runId: "new-owner",
      });

      assert.equal(
        removeOwnedNameRun(dir, "Worker", "/old.jsonl", "old-owner", "running"),
        false,
      );
      assert.equal(resolveNameInRegistry(dir, "Worker")?.sessionFile, "/new.jsonl");
    });
  });

  it("reports unknown names and termination failures without claiming success", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();
    assert.match(testApi.handleSubagentKill({ name: "Ghost" }, () => {}).content[0].text, /No running/);

    withTempDir((dir) => {
      const completed = join(dir, "completed.jsonl");
      writeFileSync(completed, "{}\n");
      seedRegistryRun(dir, "Completed", { sessionFile: completed, sessionId: null });
      // Kill addresses the live map only; a completed registry entry is not killable.
      assert.match(testApi.handleSubagentKill({ name: "Completed" }, () => {}).content[0].text, /No running/);
    });

    withTempDir((dir) => {
      const sessionFile = join(dir, "worker.jsonl");
      writeFileSync(sessionFile, "{}\n");
      seedRegistryRun(dir, "Worker", {
        sessionFile,
        sessionId: null,
        runState: "running",
        runId: "failed-kill",
      });
      const running = {
        id: "failed-kill", name: "Worker", task: "", surface: "pane", startTime: 0,
        sessionFile, registryArtifactDir: dir, interactive: false,
        statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      };
      runningMap.set(running.id, running);
      const result = testApi.handleSubagentKill({ name: "Worker" }, () => { throw new Error("kill-pane failed"); });
      assert.match(result.content[0].text, /process may still be running/);
      assert.equal(runningMap.has(running.id), true);
      assert.ok(resolveNameInRegistry(dir, "Worker"));
      runningMap.clear();
    });
  });

  it("surfaces registry cleanup failures after terminating the process", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();
    withTempDir((dir) => {
      const sessionFile = join(dir, "worker.jsonl");
      writeFileSync(sessionFile, "{}\n");
      seedRegistryRun(dir, "Worker", {
        sessionFile,
        sessionId: null,
        runState: "running",
        runId: "registry-failure",
      });
      rmSync(nameRegistryPath(dir), { force: true });
      mkdirSync(nameRegistryPath(dir));
      const running = {
        id: "registry-failure", name: "Worker", task: "", surface: "pane", startTime: 0,
        sessionFile, registryArtifactDir: dir, interactive: false,
        statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      };
      runningMap.set(running.id, running);
      const result = testApi.handleSubagentKill({ name: "Worker" }, () => {});
      assert.match(result.content[0].text, /registry could not be cleaned up/);
      assert.equal(runningMap.has(running.id), false);
    });
    runningMap.clear();
  });

  it("resolves a running subagent by exact name and reports ambiguity", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "a1", sessionFile: "a1.jsonl" }));
      runningMap.set("b2", makeRunning({ id: "b2", name: "Worker", surface: "b2", sessionFile: "b2.jsonl" }));
      runningMap.set("c3", makeRunning({ id: "c3", name: "Scout", surface: "c3", sessionFile: "c3.jsonl" }));

      const byName = testApi.resolveRunningByName("Scout");
      assert.equal(byName.running.id, "c3");

      const ambiguous = testApi.resolveRunningByName("Worker");
      assert.match(ambiguous.error, /Ambiguous subagent name/);

      const missing = testApi.resolveRunningByName("Ghost");
      assert.match(missing.error, /No running subagent named "Ghost"/);
    } finally {
      runningMap.clear();
    }
  });

  it("uniqueRunningName suffixes defaulted names that collide with running subagents", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      // No collision: base name is returned untouched.
      assert.equal(testApi.uniqueRunningName("worker"), "worker");

      runningMap.set("a1", makeRunning({ id: "a1", name: "worker", surface: "a1" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-2");

      runningMap.set("b2", makeRunning({ id: "b2", name: "worker-2", surface: "b2" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-3");

      // A distinct base is unaffected by the worker collisions.
      assert.equal(testApi.uniqueRunningName("scout"), "scout");
    } finally {
      runningMap.clear();
    }
  });

  it("uniqueRunningName also avoids names already taken in the persistent registry", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // A finished subagent's name lives in the registry even though nothing is
      // running — a fresh default must skip it so names stay unique session-wide.
      const registryNames = new Set(["worker", "worker-2"]);
      assert.equal(testApi.uniqueRunningName("worker", registryNames), "worker-3");
      // A name not in the registry (or running/reserved) is unaffected.
      assert.equal(testApi.uniqueRunningName("scout", registryNames), "scout");
      // An empty registry behaves like before.
      assert.equal(testApi.uniqueRunningName("worker", new Set()), "worker");
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("uniqueRunningName also avoids names reserved by in-flight parallel spawns", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // Simulate the first parallel spawn reserving its default name before it
      // has registered in runningSubagents.
      reserved.add(testApi.uniqueRunningName("scout")); // "scout"
      // The second spawn, running concurrently, must not reuse it.
      assert.equal(testApi.uniqueRunningName("scout"), "scout-2");
      reserved.add("scout-2");
      assert.equal(testApi.uniqueRunningName("scout"), "scout-3");
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("deduplicates and reserves serial explicit names", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    withTempDir((dir) => {
      try {
        const first = testApi.reserveSpawnName("Reviewer", "scout", dir);
        assert.equal(first.name, "Reviewer");
        testApi.releaseSpawnName(first);
        seedRegistryRun(dir, first.name, {
          sessionFile: "/reviewer.jsonl",
          sessionId: "first",
          runState: "running",
          runId: "first",
        });
        runningMap.set("first", makeRunning({ id: "first", name: first.name }));

        const second = testApi.reserveSpawnName("Reviewer", "scout", dir);
        assert.equal(second.name, "Reviewer-2");
        assert.equal(reserved.has("Reviewer-2"), true);
        testApi.releaseSpawnName(second);
      } finally {
        runningMap.clear();
        reserved.clear();
      }
    });
  });

  it("deduplicates explicit names already persisted in the registry", () => {
    const testApi = (subagentsModule as any).__test__;
    const reserved = testApi.reservedNames as Set<string>;
    reserved.clear();

    withTempDir((dir) => {
      try {
        seedRegistryRun(dir, "Reviewer", { sessionFile: "/done.jsonl", sessionId: "done" });
        const reservation = testApi.reserveSpawnName(" Reviewer ", "scout", dir);
        assert.equal(reservation.name, "Reviewer-2");
        testApi.releaseSpawnName(reservation);
      } finally {
        reserved.clear();
      }
    });
  });

  it("atomically reserves parallel explicit names and acknowledges the actual name", () => {
    const testApi = (subagentsModule as any).__test__;
    const reserved = testApi.reservedNames as Set<string>;
    reserved.clear();

    withTempDir((dir) => {
      try {
        const first = testApi.reserveSpawnName("Reviewer", "scout", dir);
        const second = testApi.reserveSpawnName("Reviewer", "scout", dir);
        assert.deepEqual([first.name, second.name], ["Reviewer", "Reviewer-2"]);

        const acknowledgement = testApi.createSpawnStartedAcknowledgement({
          id: "second",
          name: second.name,
          task: "review",
          agent: "scout",
          sessionFile: "/reviewer-2.jsonl",
          launchScriptFile: "/reviewer-2.sh",
        });
        assert.equal(acknowledgement.details.name, "Reviewer-2");
        assert.match(acknowledgement.content[0].text, /"Reviewer-2" launched/);
        testApi.releaseSpawnName(first);
        testApi.releaseSpawnName(second);
      } finally {
        reserved.clear();
      }
    });
  });

  it("does not poll or deliver settled records after kill aborts a pending screen read", async () => {
    const controller = new AbortController();
    let releaseRead!: (screen: string) => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const pendingRead = new Promise<string>((resolve) => { releaseRead = resolve; });
    let ticks = 0;

    const polling = pollForExit("pane", controller.signal, {
      interval: 1,
      readScreen: async () => {
        readStarted();
        return pendingRead;
      },
      onTick: () => { ticks++; },
    });

    await started;
    controller.abort();
    releaseRead("");
    await assert.rejects(polling, /Aborted/);
    assert.equal(ticks, 0, "the watcher delivery seam must not run after abort");
  });

  it("steers a running subagent by typing into its pane (newlines flattened)", () => {
    const testApi = (subagentsModule as any).__test__;
    let sentSurface = "";
    let sentText = "";
    const running = makeRunning();

    const result = testApi.steerSubagent(running, "do this\nthen that", (surface: string, text: string) => {
      sentSurface = surface;
      sentText = text;
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(sentSurface, "pane-1");
    assert.equal(sentText, "do this then that");
  });

  it("returns an explicit error when steering delivery fails", () => {
    const testApi = (subagentsModule as any).__test__;
    const running = makeRunning();

    const result = testApi.steerSubagent(running, "hi", () => {
      throw new Error("mux write failed");
    });

    assert.match(result.error, /Failed to deliver message/);
  });

  it("delivers a steer message and forces local status waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    let sentText = "";
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentSteer({ name: "Worker", message: "keep going" }, (surface: string, text: string) => {
          sentSurface = surface;
          sentText = text;
        }),
      );

      assert.equal(sentSurface, "pane-1");
      assert.equal(sentText, "keep going");
      assert.equal(result.content[0].text.includes('Message delivered to running subagent "Worker"'), true);
      assert.deepEqual(result.details, { id: "a1", name: "Worker", status: "steered" });
      const snapshot = classifyStatus(runningMap.get("a1").statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("requires a message when steering", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();
    try {
      runningMap.set("a1", makeRunning());
      const result = testApi.handleSubagentSteer({ name: "Worker", message: "  " }, () => {});
      assert.match(result.content[0].text, /`message` is required/);
    } finally {
      runningMap.clear();
    }
  });

  it("leaves status unchanged when steering delivery fails in the tool path", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentSteer({ name: "Worker", message: "go" }, () => {
          throw new Error("mux write failed");
        }),
      );

      assert.match(result.content[0].text, /Failed to deliver message/);
      assert.equal(classifyStatus(runningMap.get("a1").statusState, 20_000).kind, "active");
    } finally {
      runningMap.clear();
    }
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
        sessionId: "019f-abc",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    // Completed follow-ups use the explicit safe name-based tool (not a session id).
    assert.match(presentation, /subagent_resume\(\{ name: "Worker"/);
    assert.doesNotMatch(presentation, /Session id:/);
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        sessionId: "019f-xyz",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.match(presentation, /provider\/agent error — auto-retry exhausted/);
    assert.match(presentation, /Error: Anthropic 529 Overloaded after 3 retries/);
    assert.match(presentation, /subagent_resume\(\{ name: "Worker"/);
    assert.doesNotMatch(presentation, /Session id:/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  it("renders only capped lines plus overflow", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const visibleLines = [
      "Worker running 5m, active (bash 2m).",
      "Scout running 3m, waiting 1m.",
      "Reviewer running 2m, active (streaming 30s).",
      "Planner running 4m, waiting 2m.",
    ];
    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    );
    const output = rendered.render(80).join("\n");

    assert.match(output, /Subagent status/);
    for (const line of visibleLines) {
      assert.match(output, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(output, /\+2 more running\./);
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: { lines: ["Worker running 5m, active (bash 2m)."], overflow: 0 },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });
});
describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: 1_000_000 - 13_000,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 13_000 }),
        },
        {
          id: "a2",
          name: "B",
          task: "",
          surface: "s2",
          startTime: 1_000_000 - 21_000,
          sessionFile: "sess2",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 21_000 }),
        },
        {
          id: "a3",
          name: "C",
          task: "",
          surface: "s3",
          startTime: 1_000_000 - 27_000,
          sessionFile: "sess3",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 27_000 }),
        },
      ], 16);

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
        },
      ], width);

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent display helpers", () => {
  const testApi = (subagentsModule as any).__test__;

  describe("formatTokens", () => {
    it("renders raw counts below 1k, 1 decimal below 10k, rounded k above", () => {
      assert.equal(testApi.formatTokens(850), "850");
      assert.equal(testApi.formatTokens(3200), "3.2k");
      assert.equal(testApi.formatTokens(45000), "45k");
    });
  });

  describe("contextWindowFor", () => {
    it("maps known model families and returns undefined otherwise", () => {
      assert.equal(testApi.contextWindowFor("claude-sonnet-4-6"), 200_000);
      assert.equal(testApi.contextWindowFor("gemini-2.5-pro"), 1_000_000);
      assert.equal(testApi.contextWindowFor("some-unknown-model"), undefined);
      assert.equal(testApi.contextWindowFor(null), undefined);
    });
  });

  describe("formatContextUsage", () => {
    it("shows a percent gauge when the window is known", () => {
      assert.equal(testApi.formatContextUsage(36_000, 200_000), "18.0%/200k");
      assert.equal(testApi.formatContextUsage(500_000, 1_000_000), "50.0%/1.0M");
    });

    it("falls back to a window-less ctx label when unknown", () => {
      assert.equal(testApi.formatContextUsage(37_000, undefined), "37k ctx");
    });
  });

  describe("formatUsageSegments", () => {
    it("emits arrow/cache/cost segments, skipping zero fields", () => {
      const segs = testApi.formatUsageSegments({
        model: "claude-sonnet-4-6",
        toolCount: 3,
        inputTokens: 3200,
        outputTokens: 890,
        cacheReadTokens: 45000,
        cacheWriteTokens: 0,
        contextTokens: 7000,
        cost: 0.042,
      });
      assert.deepEqual(segs, ["↑3.2k", "↓890", "R45k", "$0.042"]);
    });

    it("returns an empty list when there is no usage", () => {
      assert.deepEqual(
        testApi.formatUsageSegments({
          model: null,
          toolCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          contextTokens: 0,
          cost: 0,
        }),
        [],
      );
    });
  });

  describe("widgetIcon", () => {
    it("maps active/running to a glyph and waiting/starting to another", () => {
      const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
      assert.equal(strip(testApi.widgetIcon("active")), "⟳");
      assert.equal(strip(testApi.widgetIcon("running")), "⟳");
      assert.equal(strip(testApi.widgetIcon("stalled")), "⟳");
      assert.equal(strip(testApi.widgetIcon("waiting")), "○");
      assert.equal(strip(testApi.widgetIcon("starting")), "○");
    });
  });
});

describe("tmux.ts", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });
});
