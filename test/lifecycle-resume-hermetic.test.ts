import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  activateReservedNameRun,
  claimCompletedNameRun,
  loadoutSidecarPath,
  markNameRunCompleted,
  nameRegistryPath,
  reserveNameRun,
  resolveNameInRegistry,
  writeSubagentLoadout,
  type SubagentLoadout,
} from "../pi-extension/subagents/session.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for resume lifecycle result`);
}

describe("hermetic safe subagent resume", () => {
  let root: string;
  let binDir: string;
  let tmuxLog: string;
  let tmuxCounter: string;
  let tmuxSentinel: string;
  let tmuxMode: string;
  let backingExtension: string;
  let subagentsExtensionPath: string;
  let subagentsModule: any;
  let resumeTool: any;
  let messageTool: any;
  let runningMap: Map<string, any>;
  let testApi: any;
  let registeredTools: any[];
  let sentMessages: Array<{ message: any; options: any }>;
  let sendMessageFailure: Error | undefined;
  let handlers: Map<string, Array<(...args: any[]) => void>>;
  let previousEnv: Record<string, string | undefined>;

  const parentId = "parent-a";
  const siblingId = "parent-b";

  function artifactDir(sessionId = parentId): string {
    return join(root, "artifacts", sessionId);
  }

  function context(sessionId = parentId) {
    const parentSession = join(root, `${sessionId}.jsonl`);
    if (!existsSync(parentSession)) {
      writeFileSync(parentSession, JSON.stringify({ type: "session", id: sessionId, cwd: root }) + "\n");
    }
    return {
      cwd: root,
      hasUI: true,
      ui: { setWidget() {} },
      sessionManager: {
        getSessionFile() { return parentSession; },
        getSessionId() { return sessionId; },
        getSessionDir() { return root; },
      },
    } as any;
  }

  function seedCompletedName(
    name: string,
    sessionFile: string,
    sessionId: string,
    parent = parentId,
  ): void {
    const runId = `${sessionId}-${name}-completed`;
    assert.equal(reserveNameRun(artifactDir(parent), name, runId), name);
    assert.equal(
      activateReservedNameRun(artifactDir(parent), name, runId, { sessionFile, sessionId }),
      true,
    );
    assert.equal(markNameRunCompleted(artifactDir(parent), sessionFile, runId), true);
  }

  function createChild(name: string, sessionId = `${name}-session`, parent = parentId): string {
    const sessionFile = join(root, "children", `${sessionId}.jsonl`);
    mkdirSync(join(root, "children"), { recursive: true });
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: root }),
        JSON.stringify({
          type: "message",
          id: `${sessionId}-old`,
          message: {
            role: "assistant",
            content: [{ type: "text", text: `STALE_${name}` }],
          },
        }),
      ].join("\n") + "\n",
    );
    seedCompletedName(name, sessionFile, sessionId, parent);
    return sessionFile;
  }

  function installPiWebAccessFixture(): {
    entrypoint: string;
    manifest: string;
    config: string;
    agentDir: string;
  } {
    const agentDir = join(root, "saved-agent-dir");
    const packageRoot = join(agentDir, "npm", "node_modules", "pi-web-access");
    const entrypoint = join(packageRoot, "index.ts");
    const manifest = join(packageRoot, "package.json");
    const config = join(agentDir, "web-search.json");
    rmSync(packageRoot, { recursive: true, force: true });
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-web-access"] }));
    writeFileSync(entrypoint, [
      "const names = [\"web_search\", \"fetch_content\", \"get_search_content\", \"source_check\"];",
      "export default function (pi) {",
      "  for (const name of names) pi.registerTool({",
      "    name, label: name, description: name,",
      '    parameters: { type: "object", properties: {} },',
      '    async execute() { return { content: [{ type: "text", text: "unused" }] }; },',
      "  });",
      "}",
      "",
    ].join("\n"));
    writeFileSync(manifest, JSON.stringify({
      name: "pi-web-access",
      version: "0.27.0",
      pi: { extensions: ["./index.ts"] },
    }));
    writeFileSync(config, "{}\n");
    return {
      entrypoint: realpathSync(entrypoint),
      manifest: realpathSync(manifest),
      config: realpathSync(config),
      agentDir: realpathSync(agentDir),
    };
  }

  function baseLoadout(overrides: Partial<SubagentLoadout> = {}): SubagentLoadout {
    const cwd = join(root, "saved-cwd");
    const agentDir = join(root, "saved-agent-dir");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    const loadout: SubagentLoadout = {
      agent: "worker",
      toolAllowlist: "read,write",
      toolExtensions: [backingExtension],
      toolExtensionIdentities: [],
      model: "openai-codex/gpt-5.6-sol",
      thinking: "xhigh",
      systemPromptMode: "append",
      identity: "EXACT SAVED IDENTITY",
      spawnable: null,
      autoExit: false,
      cwd,
      agentDir,
      ...overrides,
    };
    if (overrides.toolExtensionIdentities === undefined) {
      loadout.toolExtensionIdentities = testApi.createToolExtensionIdentities(
        loadout.toolExtensions,
        loadout.toolAllowlist,
        agentDir,
      );
      loadout.toolExtensions = loadout.toolExtensionIdentities?.map(
        (identity: { path: string }) => identity.path,
      ) ?? null;
    }
    return loadout;
  }

  function splitCount(): number {
    if (!existsSync(tmuxLog)) return 0;
    return readFileSync(tmuxLog, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("split-window ")).length;
  }

  function suppressRunning(): void {
    for (const running of runningMap.values()) {
      running.killed = true;
      running.abortController?.abort();
    }
    runningMap.clear();
    rmSync(tmuxSentinel, { force: true });
  }

  async function completeRun(started: any, summary: string): Promise<any> {
    const resultCountBefore = sentMessages.filter(
      ({ message }) => message.customType === "subagent_result",
    ).length;
    appendFileSync(
      started.details.sessionFile,
      JSON.stringify({
        type: "message",
        id: `current-${Date.now()}`,
        message: {
          role: "assistant",
          content: [{ type: "text", text: summary }],
        },
      }) + "\n",
    );
    writeFileSync(tmuxSentinel, "__SUBAGENT_DONE_0__\n");
    await waitFor(
      () => sentMessages.filter(({ message }) => message.customType === "subagent_result").length
        === resultCountBefore + 1,
    );
    rmSync(tmuxSentinel, { force: true });
    const delivery = sentMessages.filter(
      ({ message }) => message.customType === "subagent_result",
    ).at(-1)!;
    assert.deepEqual(
      delivery.options,
      { triggerTurn: true, deliverAs: "followUp" },
      "resume watcher success must queue a follow-up turn",
    );
    return delivery.message;
  }

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "subagent-resume-hermetic-"));
    binDir = join(root, "bin");
    tmuxLog = join(root, "tmux.log");
    tmuxCounter = join(root, "tmux-counter");
    tmuxSentinel = join(root, "tmux-sentinel");
    tmuxMode = join(root, "tmux-mode");
    backingExtension = join(root, "exact-backing-extension.ts");
    subagentsExtensionPath = fileURLToPath(
      new URL("../pi-extension/subagents/index.ts", import.meta.url),
    );
    mkdirSync(binDir, { recursive: true });
    writeFileSync(backingExtension, "export default () => {};\n");
    backingExtension = realpathSync(backingExtension);
    writeFileSync(tmuxCounter, "0\n");
    writeFileSync(
      join(binDir, "tmux"),
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$PI_FAKE_TMUX_LOG\"",
        "mode=''",
        "if [ -f \"$PI_FAKE_TMUX_MODE\" ]; then mode=$(cat \"$PI_FAKE_TMUX_MODE\"); fi",
        "case \"$1\" in",
        "  split-window)",
        "    n=$(cat \"$PI_FAKE_TMUX_COUNTER\")",
        "    n=$((n + 1))",
        "    printf '%s\\n' \"$n\" > \"$PI_FAKE_TMUX_COUNTER\"",
        "    printf '%%%s\\n' \"$n\"",
        "    ;;",
        "  send-keys)",
        "    case \"$mode\" in dispatch-fail|dispatch-close-fail) printf '%s\\n' 'dispatch uncertain' >&2; exit 1 ;; esac",
        "    ;;",
        "  kill-pane)",
        "    case \"$mode\" in close-fail|dispatch-close-fail) printf '%s\\n' 'close uncertain' >&2; exit 1 ;; esac",
        "    ;;",
        "  capture-pane)",
        "    sleep 0.02",
        "    if [ -f \"$PI_FAKE_TMUX_SENTINEL\" ]; then cat \"$PI_FAKE_TMUX_SENTINEL\"; fi",
        "    ;;",
        "esac",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, "tmux"), 0o755);

    const envNames = [
      "PATH",
      "TMUX",
      "TMUX_PANE",
      "PI_SUBAGENT_MUX",
      "PI_FAKE_TMUX_LOG",
      "PI_FAKE_TMUX_COUNTER",
      "PI_FAKE_TMUX_SENTINEL",
      "PI_FAKE_TMUX_MODE",
      "PI_SUBAGENT_SHELL_READY_DELAY_MS",
    ];
    previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.PATH = `${binDir}:${previousEnv.PATH ?? ""}`;
    process.env.PI_SUBAGENT_MUX = "tmux";
    process.env.TMUX = `${join(root, "socket")},1,0`;
    process.env.TMUX_PANE = "%parent";
    process.env.PI_FAKE_TMUX_LOG = tmuxLog;
    process.env.PI_FAKE_TMUX_COUNTER = tmuxCounter;
    process.env.PI_FAKE_TMUX_SENTINEL = tmuxSentinel;
    process.env.PI_FAKE_TMUX_MODE = tmuxMode;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "30";

    subagentsModule = await import("../pi-extension/subagents/index.ts");
    registeredTools = [];
    sentMessages = [];
    handlers = new Map();
    subagentsModule.default({
      on(event: string, handler: (...args: any[]) => void) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
      },
      registerTool(tool: any) { registeredTools.push(tool); },
      registerCommand() {},
      registerMessageRenderer() {},
      registerShortcut() {},
      sendUserMessage() {},
      sendMessage(message: any, options: any) {
        sentMessages.push({ message, options });
        if (message.customType === "subagent_result" && sendMessageFailure) {
          const error = sendMessageFailure;
          sendMessageFailure = undefined;
          throw error;
        }
      },
      getAllTools() { return []; },
    } as any);
    resumeTool = registeredTools.find((tool) => tool.name === "subagent_resume");
    messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
    assert.ok(resumeTool, "subagent_resume must be registered");
    assert.ok(messageTool, "subagent_message must be registered");
    testApi = subagentsModule.__test__;
    runningMap = testApi.runningSubagents as Map<string, any>;
  });

  beforeEach(() => {
    suppressRunning();
    sendMessageFailure = undefined;
    rmSync(tmuxMode, { force: true });
    testApi.reservedResumeNames.clear();
    testApi.reservedResumeSessions.clear();
  });

  after(async () => {
    suppressRunning();
    for (const handler of handlers.get("session_shutdown") ?? []) handler({}, {});
    // Let tmux.ts's debounced cosmetic rebalance finish against the fake binary
    // before restoring PATH/TMUX and deleting the fixture.
    await new Promise((resolve) => setTimeout(resolve, 160));
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("resumes only a valid current-parent name and retains its reusable mapping", async () => {
    const sessionFile = createChild("safe-name");
    writeSubagentLoadout(sessionFile, baseLoadout());
    mkdirSync(`${sessionFile}.idle`);
    writeFileSync(
      join(`${sessionFile}.idle`, "00000001.json"),
      JSON.stringify({ type: "settled", state: "idle", response: "STALE_PRE_RESUME_IDLE" }),
    );
    writeFileSync(`${sessionFile}.ask`, JSON.stringify({ question: "Legacy stale question" }));
    const idleCountBefore = sentMessages.filter(
      ({ message }) => message.customType === "subagent_idle",
    ).length;
    const started = await resumeTool.execute(
      "resume-valid",
      { name: "safe-name", message: "Continue with the safe follow-up." },
      undefined,
      undefined,
      context(),
    );
    assert.equal(started.details.status, "started");
    assert.equal(started.details.sessionFile, sessionFile);
    assert.equal(resolveNameInRegistry(artifactDir(), "safe-name")?.runState, "running");
    assert.deepEqual(
      readdirSync(dirname(sessionFile)).filter((name) =>
        name.startsWith(`${basename(sessionFile)}.ask`)
      ),
      [],
      "resume discards legacy question artifacts",
    );
    const running = runningMap.get(started.details.id);
    assert.ok(running);
    testApi.deliverPendingSettled(running);
    assert.equal(
      sentMessages.filter(({ message }) => message.customType === "subagent_idle").length,
      idleCountBefore,
      "resume must discard settled records from an earlier process",
    );

    const delivered = await completeRun(started, "CURRENT_RESUMED_RESULT");
    assert.match(delivered.content, /CURRENT_RESUMED_RESULT/);
    assert.doesNotMatch(delivered.content, /STALE_safe-name/);
    assert.equal(delivered.details.exitCode, 0);
    assert.equal(resolveNameInRegistry(artifactDir(), "safe-name")?.sessionFile, sessionFile);
    assert.equal(resolveNameInRegistry(artifactDir(), "safe-name")?.runState, "completed");

    const resumedAgain = await resumeTool.execute(
      "resume-again",
      { name: "safe-name", message: "Continue a second time." },
      undefined,
      undefined,
      context(),
    );
    assert.equal(resumedAgain.details.status, "started", "normal completion keeps the mapping resumable");

    // Exercise both callbacks at the resumed watcher's real promise seam. A
    // synchronous failure in the success delivery is handled by its adjacent
    // rejection callback.
    const resultCountBefore = sentMessages.filter(
      ({ message }) => message.customType === "subagent_result",
    ).length;
    sendMessageFailure = new Error("forced resume watcher delivery failure");
    appendFileSync(
      resumedAgain.details.sessionFile,
      JSON.stringify({
        type: "message",
        id: "current-resume-delivery-failure",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "RESUME_DELIVERY_RECOVERED" }],
        },
      }) + "\n",
    );
    writeFileSync(tmuxSentinel, "__SUBAGENT_DONE_0__\n");
    await waitFor(
      () => sentMessages.filter(({ message }) => message.customType === "subagent_result").length
        === resultCountBefore + 2,
    );
    rmSync(tmuxSentinel, { force: true });
    const deliveries = sentMessages.filter(
      ({ message }) => message.customType === "subagent_result",
    ).slice(resultCountBefore);
    assert.match(deliveries[0].message.content, /RESUME_DELIVERY_RECOVERED/);
    assert.deepEqual(
      deliveries[0].options,
      { triggerTurn: true, deliverAs: "followUp" },
      "resume watcher success must queue a follow-up turn",
    );
    assert.match(deliveries[1].message.content, /forced resume watcher delivery failure/);
    assert.deepEqual(
      deliveries[1].options,
      { triggerTurn: true, deliverAs: "followUp" },
      "resume watcher rejection must queue a follow-up turn",
    );
  });

  it("retains durable running proof when the watcher and close both fail", async () => {
    const sessionFile = createChild("watcher-close-uncertain");
    writeSubagentLoadout(sessionFile, baseLoadout());
    const resultCountBefore = sentMessages.filter(
      ({ message }) => message.customType === "subagent_result",
    ).length;
    const started = await resumeTool.execute(
      "resume-watcher-close-uncertain",
      { name: "watcher-close-uncertain", message: "Keep fail-closed proof." },
      undefined,
      undefined,
      context(),
    );
    assert.equal(started.details.status, "started");
    const running = [...runningMap.values()].find((candidate) => candidate.id === started.details.id);
    assert.ok(running);

    writeFileSync(tmuxMode, "close-fail");
    running.abortController.abort();
    await waitFor(
      () => sentMessages.filter(({ message }) => message.customType === "subagent_result").length
        === resultCountBefore + 1,
    );
    const uncertainDelivery = sentMessages.filter(
      ({ message }) => message.customType === "subagent_result",
    ).at(-1)!;
    assert.deepEqual(
      uncertainDelivery.options,
      { triggerTurn: true, deliverAs: "followUp" },
      "resume watcher errors must queue a follow-up turn",
    );

    assert.equal(resolveNameInRegistry(artifactDir(), "watcher-close-uncertain")?.runState, "running");
    assert.equal(resolveNameInRegistry(artifactDir(), "watcher-close-uncertain")?.runId, started.details.id);
    assert.equal(runningMap.get(started.details.id), running, "uncertain termination stays retry-killable");
  });

  it("retains durable running proof when resume dispatch and close are both uncertain", async () => {
    const sessionFile = createChild("dispatch-close-uncertain");
    writeSubagentLoadout(sessionFile, baseLoadout());
    writeFileSync(tmuxMode, "dispatch-close-fail");

    const result = await resumeTool.execute(
      "resume-dispatch-close-uncertain",
      { name: "dispatch-close-uncertain", message: "This dispatch is uncertain." },
      undefined,
      undefined,
      context(),
    );

    assert.match(result.details.error, /dispatch uncertain/);
    const persisted = resolveNameInRegistry(artifactDir(), "dispatch-close-uncertain");
    assert.equal(persisted?.runState, "running");
    assert.ok(
      [...runningMap.values()].some(
        (candidate) =>
          candidate.name === "dispatch-close-uncertain" && candidate.id === persisted?.runId,
      ),
      "uncertain dispatch must remain in memory for retry-kill",
    );
  });

  it("rolls a claimed resume back after dispatch failure with confirmed close", async () => {
    const sessionFile = createChild("dispatch-confirmed-close");
    writeSubagentLoadout(sessionFile, baseLoadout());
    writeFileSync(tmuxMode, "dispatch-fail");

    const result = await resumeTool.execute(
      "resume-dispatch-confirmed-close",
      { name: "dispatch-confirmed-close", message: "Fail before the child can continue." },
      undefined,
      undefined,
      context(),
    );

    assert.match(result.details.error, /dispatch uncertain/);
    assert.equal(resolveNameInRegistry(artifactDir(), "dispatch-confirmed-close")?.runState, "completed");
  });

  it("rolls a pre-dispatch cancellation back even when cosmetic pane close fails", async () => {
    const sessionFile = createChild("predispatch-cancelled");
    writeSubagentLoadout(sessionFile, baseLoadout());
    writeFileSync(tmuxMode, "close-fail");
    const controller = new AbortController();
    controller.abort();

    const result = await resumeTool.execute(
      "resume-predispatch-cancelled",
      { name: "predispatch-cancelled", message: "Do not dispatch." },
      controller.signal,
      undefined,
      context(),
    );

    assert.match(result.details.error, /cancelled before process launch/i);
    assert.equal(resolveNameInRegistry(artifactDir(), "predispatch-cancelled")?.runState, "completed");
  });

  it("keeps sibling-parent names invisible", async () => {
    const foreignSession = createChild("foreign-only", "foreign-session", siblingId);
    writeSubagentLoadout(foreignSession, baseLoadout());
    const before = splitCount();
    const result = await resumeTool.execute(
      "resume-foreign",
      { name: "foreign-only", message: "Try to cross the parent boundary." },
      undefined,
      undefined,
      context(parentId),
    );
    assert.match(result.details.error, /No completed subagent named/);
    assert.equal(splitCount(), before, "foreign lookup must not create a pane");
  });

  it("rejects both a running name and an alias mapped to the same running session", async () => {
    const sessionFile = createChild("live-name", "live-session");
    writeSubagentLoadout(sessionFile, baseLoadout());
    seedCompletedName("same-session-alias", sessionFile, "live-session");
    runningMap.set("live", {
      id: "live",
      name: "live-name",
      sessionFile,
      surface: "%live",
    });
    const before = splitCount();

    const byName = await resumeTool.execute(
      "resume-live-name",
      { name: "live-name", message: "Do not silently steer." },
      undefined,
      undefined,
      context(),
    );
    assert.match(byName.details.error, /currently running/);
    assert.match(byName.details.error, /subagent_message/);

    const bySession = await resumeTool.execute(
      "resume-live-session",
      { name: "same-session-alias", message: "Do not launch a second writer." },
      undefined,
      undefined,
      context(),
    );
    assert.match(bySession.details.error, /currently running/);
    assert.match(bySession.details.error, /subagent_message/);
    assert.equal(splitCount(), before);
    assert.equal(runningMap.get("live")?.surface, "%live", "explicit resume must never steer or replace it");
  });

  it("refuses persisted running or legacy-unproven sessions after parent in-memory state is lost", async () => {
    const runningSession = createChild("restart-running", "restart-running-session");
    writeSubagentLoadout(runningSession, baseLoadout());
    assert.deepEqual(
      claimCompletedNameRun(
        artifactDir(),
        "restart-running",
        runningSession,
        "previous-parent-run",
      ),
      { ok: true },
    );

    const legacySession = createChild("legacy-unproven", "legacy-unproven-session");
    writeSubagentLoadout(legacySession, baseLoadout());
    // Deliberate legacy fixture: old registries had no lifecycle owner proof.
    const registryPath = nameRegistryPath(artifactDir());
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    delete registry["legacy-unproven"].runState;
    delete registry["legacy-unproven"].runId;
    writeFileSync(registryPath, JSON.stringify(registry));

    const before = splitCount();
    for (const name of ["restart-running", "legacy-unproven"]) {
      const result = await resumeTool.execute(
        `resume-${name}`,
        { name, message: "Do not create a duplicate JSONL writer." },
        undefined,
        undefined,
        context(),
      );
      assert.match(result.details.error, /durable completion proof/);
      assert.equal(result.details.status, "not-completed");
    }
    assert.equal(splitCount(), before, "unproven sessions must fail before pane creation");
  });

  it("refuses missing, malformed, incomplete, and unavailable loadouts before pane creation", async () => {
    const cases = [
      ["missing-loadout", undefined],
      ["malformed-loadout", "not-json{"],
      ["incomplete-loadout", JSON.stringify({ toolAllowlist: "read" })],
      [
        "missing-extension",
        JSON.stringify(baseLoadout({
          toolExtensions: [join(root, "gone-extension.ts")],
          toolExtensionIdentities: [{
            path: join(root, "gone-extension.ts"),
            sha256: "0".repeat(64),
          }],
        })),
      ],
    ] as const;
    const before = splitCount();
    for (const [name, sidecar] of cases) {
      const sessionFile = createChild(name);
      if (sidecar !== undefined) writeFileSync(loadoutSidecarPath(sessionFile), sidecar);
      const result = await resumeTool.execute(
        `resume-${name}`,
        { name, message: "This must fail closed." },
        undefined,
        undefined,
        context(),
      );
      assert.match(result.details.error, /Cannot safely resume/);
      assert.equal(testApi.reservedResumeNames.size, 0, `${name} must release its name reservation`);
      assert.equal(testApi.reservedResumeSessions.size, 0, `${name} must release its session reservation`);
    }
    assert.equal(splitCount(), before, "invalid loadouts must fail before surface creation");
  });

  it("refuses extension byte drift and symlink replacement before pane creation", async () => {
    const digestSession = createChild("digest-drift");
    writeSubagentLoadout(digestSession, baseLoadout());
    writeFileSync(backingExtension, "export default function changed() {};\n");
    const beforeDigest = splitCount();
    const digestResult = await resumeTool.execute(
      "resume-digest-drift",
      { name: "digest-drift", message: "Do not replay changed bytes." },
      undefined,
      undefined,
      context(),
    );
    assert.match(digestResult.details.error, /digest drifted/i);
    assert.equal(splitCount(), beforeDigest);
    writeFileSync(backingExtension, "export default () => {};\n");

    const symlinkSession = createChild("symlink-replacement");
    writeSubagentLoadout(symlinkSession, baseLoadout());
    const replacement = join(root, "replacement-extension.ts");
    writeFileSync(replacement, "export default () => {};\n");
    rmSync(backingExtension);
    symlinkSync(replacement, backingExtension);
    const beforeSymlink = splitCount();
    const symlinkResult = await resumeTool.execute(
      "resume-symlink-replacement",
      { name: "symlink-replacement", message: "Do not follow a replacement symlink." },
      undefined,
      undefined,
      context(),
    );
    assert.match(symlinkResult.details.error, /path drifted|replaced by a symlink/i);
    assert.equal(splitCount(), beforeSymlink);
    rmSync(backingExtension);
    writeFileSync(backingExtension, "export default () => {};\n");
  });

  it("refuses pi-web-access manifest and relevant config drift before pane creation", async () => {
    const splitsBefore = splitCount();
    const installed = installPiWebAccessFixture();
    const webLoadout = () => baseLoadout({
      toolAllowlist: "read,web_search,fetch_content,get_search_content,source_check",
      toolExtensions: [installed.entrypoint],
      agentDir: installed.agentDir,
    });

    const manifestSession = createChild("manifest-drift");
    writeSubagentLoadout(manifestSession, webLoadout());
    writeFileSync(installed.manifest, JSON.stringify({
      name: "pi-web-access",
      version: "0.27.0",
      pi: { extensions: ["./index.ts"] },
      changedAfterSnapshot: true,
    }));
    const manifestRejected = await resumeTool.execute(
      "resume-manifest-drift",
      { name: "manifest-drift", message: "Continue." },
      undefined,
      undefined,
      context(),
    );
    assert.match(manifestRejected.content[0].text, /package\/version\/manifest or full config identity drifted/i);
    assert.equal(splitCount(), splitsBefore);
    assert.equal(runningMap.size, 0);

    // Restore package bytes before taking a distinct config-bound snapshot.
    installPiWebAccessFixture();
    const configSession = createChild("config-drift");
    writeSubagentLoadout(configSession, webLoadout());
    writeFileSync(installed.config, JSON.stringify({ webSearch: { enabled: true } }));
    const configRejected = await resumeTool.execute(
      "resume-config-drift",
      { name: "config-drift", message: "Continue." },
      undefined,
      undefined,
      context(),
    );
    assert.match(configRejected.content[0].text, /package\/version\/manifest or full config identity drifted/i);
    assert.equal(splitCount(), splitsBefore);
    assert.equal(runningMap.size, 0);
  });

  it("resumes an unchanged researcher identity only after the fresh capability preflight", async () => {
    const installed = installPiWebAccessFixture();
    const sessionFile = createChild("unchanged-web-identity");
    writeSubagentLoadout(sessionFile, baseLoadout({
      agent: "researcher",
      toolAllowlist: "web_search,fetch_content,get_search_content,source_check,ask_question",
      toolExtensions: [installed.entrypoint],
      agentDir: installed.agentDir,
    }));
    const before = splitCount();
    const result = await resumeTool.execute(
      "resume-unchanged-web-identity",
      { name: "unchanged-web-identity", message: "Resume unchanged researcher." },
      undefined,
      undefined,
      context(),
    );
    assert.equal(result.details.status, "started", JSON.stringify(result));
    assert.equal(splitCount(), before + 1);
    suppressRunning();
  });

  it("replays the exact saved model, identity, cwd, agent dir, tools, extensions, and autonomous behavior", async () => {
    const sessionFile = createChild("exact-sandbox");
    const loadout = baseLoadout();
    writeSubagentLoadout(sessionFile, loadout);
    const started = await resumeTool.execute(
      "resume-exact",
      { name: "exact-sandbox", message: "EXACT FOLLOW-UP MESSAGE" },
      undefined,
      undefined,
      context(),
    );
    const script = readFileSync(started.details.launchScriptFile, "utf8");
    assert.match(script, new RegExp(`cd '${loadout.cwd}' && env`));
    assert.match(script, new RegExp(`PI_CODING_AGENT_DIR='${loadout.agentDir}'`));
    assert.match(script, /--model 'openai-codex\/gpt-5\.6-sol:xhigh'/);
    assert.match(script, /--no-extensions/);
    assert.match(script, /--tools 'read,write'/);
    assert.match(script, new RegExp(`-e '${backingExtension}'`));
    assert.match(script, /PI_SUBAGENT_AUTO_EXIT=1/);
    assert.match(script, /PI_SUBAGENT_LIFECYCLE_DISABLED=1/);
    assert.doesNotMatch(script, /PI_SUBAGENT_INTERACTIVE/);

    const systemPromptMatch = script.match(/--append-system-prompt '([^']+)'/);
    assert.ok(systemPromptMatch);
    assert.equal(readFileSync(systemPromptMatch[1], "utf8"), loadout.identity);
    const messageMatch = script.match(/'@([^']+\/subagent-resume\/[^']+\.md)'/);
    assert.ok(messageMatch);
    assert.equal(readFileSync(messageMatch[1], "utf8"), "EXACT FOLLOW-UP MESSAGE");
  });

  it("strips lifecycle tools without a spawn whitelist and replays all five with a valid whitelist", async () => {
    const lifecycle = "read,subagent,subagent_message,subagent_resume,subagent_kill,subagents_list";
    const restrictedSession = createChild("no-nested-spawn");
    writeSubagentLoadout(
      restrictedSession,
      baseLoadout({
        toolAllowlist: lifecycle,
        toolExtensions: [subagentsExtensionPath],
        spawnable: null,
      }),
    );
    const restricted = await resumeTool.execute(
      "resume-no-nested",
      { name: "no-nested-spawn", message: "Continue without nested lifecycle access." },
      undefined,
      undefined,
      context(),
    );
    const restrictedScript = readFileSync(restricted.details.launchScriptFile, "utf8");
    assert.match(restrictedScript, /--tools 'read'/);
    assert.match(restrictedScript, /PI_SUBAGENT_LIFECYCLE_DISABLED=1/);
    assert.match(restrictedScript, /-u PI_SUBAGENT_ALLOWED/);
    assert.doesNotMatch(restrictedScript, /--tools '[^']*subagent_/);
    suppressRunning();

    const nestedSession = createChild("nested-spawn-ok");
    writeSubagentLoadout(
      nestedSession,
      baseLoadout({
        toolAllowlist: lifecycle,
        toolExtensions: [subagentsExtensionPath],
        spawnable: ["scout", "researcher"],
      }),
    );
    const nested = await resumeTool.execute(
      "resume-nested",
      { name: "nested-spawn-ok", message: "Continue with the saved nested boundary." },
      undefined,
      undefined,
      context(),
    );
    const nestedScript = readFileSync(nested.details.launchScriptFile, "utf8");
    assert.match(nestedScript, /--tools 'read,subagent,subagent_message,subagent_resume,subagent_kill,subagents_list'/);
    assert.match(nestedScript, /PI_SUBAGENT_ALLOWED='scout,researcher'/);
    assert.match(nestedScript, /-u PI_SUBAGENT_LIFECYCLE_DISABLED/);
    assert.doesNotMatch(nestedScript, /PI_SUBAGENT_LIFECYCLE_DISABLED=1/);
  });

  it("rejects legacy loadouts without immutable extension identity before pane creation", async () => {
    const sessionFile = createChild("legacy-null");
    const legacy = baseLoadout({
      toolAllowlist: null,
      toolExtensions: null,
      toolExtensionIdentities: null,
      spawnable: null,
    });
    const { toolExtensionIdentities: _omittedIdentity, ...legacySidecar } = legacy;
    writeFileSync(loadoutSidecarPath(sessionFile), JSON.stringify(legacySidecar));
    const before = splitCount();

    const result = await resumeTool.execute(
      "resume-legacy-null",
      { name: "legacy-null", message: "Do not replay a legacy identity." },
      undefined,
      undefined,
      context(),
    );
    assert.match(result.details.error, /Cannot safely resume/);
    assert.equal(splitCount(), before);
  });

  it("deduplicates concurrent explicit-resume/message attempts by mapped session before the first await", async () => {
    const sessionFile = createChild("race-explicit", "race-session");
    seedCompletedName("race-message-alias", sessionFile, "race-session");
    writeSubagentLoadout(sessionFile, baseLoadout());
    const before = splitCount();

    const [explicit, compatibility] = await Promise.all([
      resumeTool.execute(
        "resume-race-explicit",
        { name: "race-explicit", message: "First launch wins." },
        undefined,
        undefined,
        context(),
      ),
      messageTool.execute(
        "resume-race-message",
        { name: "race-message-alias", message: "Must not launch a second writer." },
        undefined,
        undefined,
        context(),
      ),
    ]);

    assert.equal(explicit.details.status, "started");
    assert.match(compatibility.details.error, /already resuming/);
    assert.equal(splitCount(), before + 1, "only one pane/process launch may win the race");
    assert.equal(runningMap.size, 1);
    assert.equal(testApi.reservedResumeNames.size, 0, "reservation hands off to running state");
    assert.equal(testApi.reservedResumeSessions.size, 0, "session reservation hands off to running state");
  });
});
