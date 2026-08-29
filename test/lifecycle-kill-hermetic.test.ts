import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  activateReservedNameRun,
  reserveNameRun,
  resolveNameInRegistry,
} from "../pi-extension/subagents/session.ts";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
} from "../pi-extension/subagents/activity.ts";
import subagentDoneExtension, {
  runningChildrenCount,
} from "../pi-extension/subagents/subagent-done.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 750): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for lifecycle result`);
}

describe("hermetic lifecycle kill", () => {
  it("treats an already-missing pane as killed and suppresses pending watcher output", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-kill-hermetic-"));
    const binDir = join(root, "bin");
    const tmuxLog = join(root, "tmux.log");
    const fakeTmux = join(binDir, "tmux");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      fakeTmux,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$PI_FAKE_TMUX_LOG\"",
        "if [ \"$1\" = 'kill-pane' ]; then",
        "  printf '%s\\n' \"can't find pane: $3\" >&2",
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(fakeTmux, 0o755);

    const previous = {
      PATH: process.env.PATH,
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
      PI_SUBAGENT_MUX: process.env.PI_SUBAGENT_MUX,
      PI_FAKE_TMUX_LOG: process.env.PI_FAKE_TMUX_LOG,
    };
    process.env.PATH = `${binDir}:${previous.PATH ?? ""}`;
    process.env.PI_SUBAGENT_MUX = "tmux";
    process.env.TMUX = `${join(root, "socket")},1,0`;
    delete process.env.TMUX_PANE;
    process.env.PI_FAKE_TMUX_LOG = tmuxLog;
    let runningMap: Map<string, any> | undefined;

    try {
      const [subagentsModule, tmuxModule] = await Promise.all([
        import("../pi-extension/subagents/index.ts"),
        import("../pi-extension/subagents/tmux.ts"),
      ]);
      const sentMessages: unknown[] = [];
      (subagentsModule as any).default({
        on() {},
        registerTool() {},
        registerCommand() {},
        registerMessageRenderer() {},
        registerShortcut() {},
        sendUserMessage() {},
        sendMessage(message: unknown) { sentMessages.push(message); },
        getAllTools() { return []; },
      });

      const testApi = (subagentsModule as any).__test__;
      runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();

      const sessionFile = join(root, "child.jsonl");
      const otherSessionFile = join(root, "other.jsonl");
      writeFileSync(sessionFile, '{"type":"session","id":"child"}\n');
      writeFileSync(otherSessionFile, '{"type":"session","id":"other"}\n');
      writeFileSync(`${sessionFile}.ask`, JSON.stringify({ question: "Ship now?" }));
      assert.equal(reserveNameRun(root, "Worker", "child-1"), "Worker");
      assert.equal(
        activateReservedNameRun(root, "Worker", "child-1", {
          sessionFile,
          sessionId: "child",
        }),
        true,
      );
      assert.equal(reserveNameRun(root, "Other", "child-2"), "Other");
      assert.equal(
        activateReservedNameRun(root, "Other", "child-2", {
          sessionFile: otherSessionFile,
          sessionId: "other",
        }),
        true,
      );

      const watcherAbort = new AbortController();
      const running = {
        id: "child-1",
        name: "Worker",
        task: "work",
        surface: "%fake-child",
        startTime: Date.now(),
        sessionFile,
        registryArtifactDir: root,
        abortController: watcherAbort,
        interactive: false,
        statusState: {},
      };
      const otherRunning = {
        ...running,
        id: "child-2",
        name: "Other",
        surface: "%other-child",
        sessionFile: otherSessionFile,
        abortController: new AbortController(),
      };
      runningMap.set(running.id, running);
      runningMap.set(otherRunning.id, otherRunning);

      let releaseRead!: (screen: string) => void;
      let markReadStarted!: () => void;
      const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
      const pendingRead = new Promise<string>((resolve) => { releaseRead = resolve; });
      const polling = tmuxModule.pollForExit(running.surface, watcherAbort.signal, {
        interval: 1,
        readScreen: async () => {
          markReadStarted();
          return pendingRead;
        },
        onTick: () => testApi.deliverPendingQuestion(running),
      });
      const watcherDelivery = polling.then(
        () => {
          if (!testApi.shouldSuppressWatcherMessage(running)) sentMessages.push("completion");
        },
        () => {
          if (!testApi.shouldSuppressWatcherMessage(running)) sentMessages.push("error");
        },
      );

      await readStarted;
      const killed = testApi.handleSubagentKill({ name: "Worker" });
      assert.equal(killed.details.status, "killed");
      releaseRead("");
      await assert.rejects(polling, /Aborted/);
      await watcherDelivery;
      assert.equal(testApi.shouldSuppressWatcherMessage(running), true);
      // Defense in depth: even a stale caller that reaches the delivery helper
      // after abort must observe the killed flag and stay silent.
      testApi.deliverPendingQuestion(running);

      assert.equal(readFileSync(tmuxLog, "utf8").trim(), "kill-pane -t %fake-child");
      assert.equal(watcherAbort.signal.aborted, true);
      assert.equal(runningMap.has(running.id), false);
      assert.equal(runningMap.get(otherRunning.id), otherRunning);
      assert.equal(otherRunning.abortController.signal.aborted, false);
      assert.equal(resolveNameInRegistry(root, "Worker"), null);
      assert.equal(resolveNameInRegistry(root, "Other")?.sessionId, "other");
      assert.equal(existsSync(sessionFile), true, "kill preserves the child transcript");
      assert.equal(sentMessages.length, 0, "no pending .ask question is steered after kill");
    } finally {
      runningMap?.clear();
      if (previous.PATH === undefined) delete process.env.PATH;
      else process.env.PATH = previous.PATH;
      if (previous.TMUX === undefined) delete process.env.TMUX;
      else process.env.TMUX = previous.TMUX;
      if (previous.TMUX_PANE === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = previous.TMUX_PANE;
      if (previous.PI_SUBAGENT_MUX === undefined) delete process.env.PI_SUBAGENT_MUX;
      else process.env.PI_SUBAGENT_MUX = previous.PI_SUBAGENT_MUX;
      if (previous.PI_FAKE_TMUX_LOG === undefined) delete process.env.PI_FAKE_TMUX_LOG;
      else process.env.PI_FAKE_TMUX_LOG = previous.PI_FAKE_TMUX_LOG;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on shutdown-only pane loss and delivers only a current agent_end result", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-disappearance-hermetic-"));
    const binDir = join(root, "bin");
    const tmuxLog = join(root, "tmux.log");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "tmux"),
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$PI_FAKE_TMUX_LOG\"",
        "case \"$1\" in",
        "  split-window) printf '%s\\n' '%fake-child' ;;",
        "  capture-pane|kill-pane) printf '%s\\n' \"can't find pane: %fake-child\" >&2; exit 1 ;;",
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
      "PI_CODING_AGENT_DIR",
      "PI_SUBAGENT_SHELL_READY_DELAY_MS",
      "PI_SUBAGENT_SESSION",
      "PI_SUBAGENT_NAME",
      "PI_SUBAGENT_AGENT",
      "PI_SUBAGENT_AUTO_EXIT",
      "PI_SUBAGENT_ID",
      "PI_SUBAGENT_ACTIVITY_FILE",
    ] as const;
    const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.PATH = `${binDir}:${previous.PATH ?? ""}`;
    process.env.PI_SUBAGENT_MUX = "tmux";
    process.env.TMUX = `${join(root, "socket")},1,0`;
    delete process.env.TMUX_PANE;
    process.env.PI_FAKE_TMUX_LOG = tmuxLog;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent-config");
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    process.env.PI_SUBAGENT_SESSION = join(root, "outer-worker.jsonl");
    process.env.PI_SUBAGENT_NAME = "outer-worker";
    process.env.PI_SUBAGENT_AGENT = "worker";
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    delete process.env.PI_SUBAGENT_ID;
    delete process.env.PI_SUBAGENT_ACTIVITY_FILE;

    const agentDefinitionsDir = join(process.env.PI_CODING_AGENT_DIR, "agents");
    mkdirSync(agentDefinitionsDir, { recursive: true });
    writeFileSync(
      join(agentDefinitionsDir, "scout.md"),
      [
        "---",
        "name: scout",
        "description: Hermetic forked scout",
        "tools: read",
        "auto-exit: true",
        "session-mode: fork",
        "---",
        "Return only the current run's result.",
        "",
      ].join("\n"),
    );

    const indexHandlers = new Map<string, Array<(...args: any[]) => void>>();
    const parentHandlers = new Map<string, Array<(...args: any[]) => void>>();
    const registeredTools: any[] = [];
    const sentMessages: any[] = [];
    const widgetStates: unknown[] = [];
    let sendMessageFailure: Error | undefined;
    let subagentsModule: any;

    try {
      subagentsModule = await import("../pi-extension/subagents/index.ts");
      const api = {
        on(event: string, handler: (...args: any[]) => void) {
          if (!indexHandlers.has(event)) indexHandlers.set(event, []);
          indexHandlers.get(event)!.push(handler);
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
      } as any;
      subagentsModule.default(api);

      subagentDoneExtension({
        on(event: string, handler: (...args: any[]) => void) {
          if (!parentHandlers.has(event)) parentHandlers.set(event, []);
          parentHandlers.get(event)!.push(handler);
        },
        registerTool() {},
        registerCommand() {},
        registerMessageRenderer() {},
        registerShortcut() {},
        sendUserMessage() {},
        sendMessage() {},
        getAllTools() { return []; },
      } as any);

      const parentSessionFile = join(root, "parent.jsonl");
      writeFileSync(
        parentSessionFile,
        [
          JSON.stringify({ type: "session", id: "outer-worker" }),
          JSON.stringify({
            type: "message",
            id: "inherited-user",
            message: { role: "user", content: [{ type: "text", text: "Earlier task" }] },
          }),
          JSON.stringify({
            type: "message",
            id: "inherited-assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "INHERITED_PARENT_OUTPUT" }],
            },
          }),
          JSON.stringify({
            type: "message",
            id: "spawn-trigger",
            message: { role: "user", content: [{ type: "text", text: "Delegate now" }] },
          }),
        ].join("\n") + "\n",
      );
      const ctx = {
        cwd: root,
        hasUI: true,
        ui: {
          setWidget(_name: string, widget: unknown) { widgetStates.push(widget); },
        },
        sessionManager: {
          getSessionFile() { return parentSessionFile; },
          getSessionId() { return "outer-worker"; },
          getSessionDir() { return root; },
        },
      } as any;
      for (const handler of indexHandlers.get("session_start") ?? []) handler({}, ctx);

      const spawn = registeredTools.find((tool) => tool.name === "subagent");
      assert.ok(spawn, "subagent tool should be registered");
      const artifactDir = join(root, "artifacts", "outer-worker");
      let shutdowns = 0;
      const endParentTurn = () => {
        for (const handler of parentHandlers.get("agent_end") ?? []) {
          handler(
            { messages: [{ role: "assistant", stopReason: "stop" }] },
            { shutdown() { shutdowns++; } },
          );
        }
      };

      // A pane can vanish after session_shutdown("quit") writes phase=done but
      // without a current agent_end or assistant response. Inherited fork text
      // must never be promoted to this run's completion.
      const shutdownOnly = await spawn.execute(
        "shutdown-only-call",
        { agent: "scout", name: "shutdown-only", task: "exit before answering" },
        undefined,
        undefined,
        ctx,
      );
      const shutdownSession = shutdownOnly.details.sessionFile as string;
      const shutdownId = shutdownOnly.details.id as string;
      assert.match(readFileSync(shutdownSession, "utf8"), /INHERITED_PARENT_OUTPUT/);
      const shutdownRecorder = createSubagentActivityRecorder({
        runningChildId: shutdownId,
        activityFile: getSubagentActivityFile(artifactDir, shutdownId),
      });
      shutdownRecorder.sessionStart();
      shutdownRecorder.sessionShutdown("quit");
      writeFileSync(`${shutdownSession}.ask`, JSON.stringify({ question: "Stale question" }));

      assert.equal(runningChildrenCount(), 1);
      endParentTurn();
      assert.equal(shutdowns, 0, "outer worker must park while the child is tracked");
      await waitFor(() => sentMessages.some(
        ({ message }) => message.customType === "subagent_result" &&
          message.details?.name === "shutdown-only",
      ));
      const shutdownDelivery = sentMessages.find(
        ({ message }) => message.customType === "subagent_result" &&
          message.details?.name === "shutdown-only",
      )!;
      assert.deepEqual(
        shutdownDelivery.options,
        { triggerTurn: true, deliverAs: "followUp" },
        "initial watcher errors must queue a follow-up turn",
      );
      const shutdownResult = shutdownDelivery.message;
      assert.equal(shutdownResult.details.exitCode, 1);
      assert.equal(shutdownResult.details.error, "pane-disappeared");
      assert.doesNotMatch(shutdownResult.content, /INHERITED_PARENT_OUTPUT/);
      assert.match(shutdownResult.content, /subagent_kill.*shutdown-only/i);
      assert.equal(existsSync(`${shutdownSession}.ask`), false);
      assert.equal(runningChildrenCount(), 1, "unproven disappearance stays parent-tracked");
      const runningMap = subagentsModule.__test__.runningSubagents as Map<string, any>;
      assert.equal(runningMap.has(shutdownId), true, "exact retry-kill handle must remain in memory");
      assert.equal(
        resolveNameInRegistry(artifactDir, "shutdown-only")?.runState,
        "running",
        "unproven pane disappearance must remain fail-closed on disk",
      );
      endParentTurn();
      assert.equal(shutdowns, 0, "outer worker remains parked until explicit kill cleanup");

      const killTool = registeredTools.find((tool) => tool.name === "subagent_kill");
      assert.ok(killTool, "subagent_kill tool should be registered");
      const killed = await killTool.execute(
        "kill-disappeared-call",
        { name: "shutdown-only" },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(killed.details.status, "killed");
      assert.equal(runningMap.has(shutdownId), false);
      assert.equal(runningChildrenCount(), 0);
      assert.equal(resolveNameInRegistry(artifactDir, "shutdown-only"), null);
      assert.match(readFileSync(tmuxLog, "utf8"), /kill-pane -t %fake-child/);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(
        sentMessages.filter(({ message }) =>
          message.customType === "subagent_result" &&
          message.details?.name === "shutdown-only"
        ).length,
        1,
        "kill cleanup must not duplicate the watcher result",
      );
      endParentTurn();
      assert.equal(shutdowns, 1, "outer worker can exit after exact kill cleanup");

      // A real current-run agent_end plus a post-launch assistant entry is
      // recoverable even though the shell sentinel disappeared with the pane.
      const completed = await spawn.execute(
        "completed-call",
        { agent: "scout", name: "nested-map", task: "map the lifecycle" },
        undefined,
        undefined,
        ctx,
      );
      const completedSession = completed.details.sessionFile as string;
      const completedId = completed.details.id as string;
      assert.match(readFileSync(completedSession, "utf8"), /INHERITED_PARENT_OUTPUT/);
      appendFileSync(
        completedSession,
        JSON.stringify({
          type: "message",
          id: "current-final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "CURRENT_RUN_COMPLETION" }],
          },
        }) + "\n",
      );
      const completedRecorder = createSubagentActivityRecorder({
        runningChildId: completedId,
        activityFile: getSubagentActivityFile(artifactDir, completedId),
      });
      completedRecorder.sessionStart();
      completedRecorder.agentEndDone();
      writeFileSync(`${completedSession}.ask`, JSON.stringify({ question: "Still needed?" }));

      assert.equal(runningChildrenCount(), 1);
      endParentTurn();
      assert.equal(shutdowns, 1, "outer worker remains parked for the second child");
      await waitFor(() => sentMessages.some(
        ({ message }) => message.customType === "subagent_result" &&
          message.details?.name === "nested-map",
      ));
      const completedResults = sentMessages.filter(
        ({ message }) => message.customType === "subagent_result" &&
          message.details?.name === "nested-map",
      );
      assert.equal(completedResults.length, 1);
      assert.deepEqual(
        completedResults[0].options,
        { triggerTurn: true, deliverAs: "followUp" },
        "initial watcher success must queue a follow-up turn",
      );
      assert.match(completedResults[0].message.content, /CURRENT_RUN_COMPLETION/);
      assert.doesNotMatch(completedResults[0].message.content, /INHERITED_PARENT_OUTPUT/);
      assert.equal(completedResults[0].message.details.exitCode, 0);
      assert.equal(completedResults[0].message.details.error, undefined);
      assert.equal(
        sentMessages.filter(({ message }) => message.customType === "subagent_question").length,
        0,
        "terminal children must not deliver stale questions",
      );
      assert.equal(existsSync(`${completedSession}.ask`), false);
      assert.equal(
        resolveNameInRegistry(artifactDir, "nested-map")?.runState,
        "completed",
        "current agent_end plus current assistant output proves natural completion",
      );

      // Resumes capture a fresh baseline too: pane-loss recovery may return
      // only the assistant response appended by this resumed process.
      const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
      assert.ok(messageTool, "subagent_message tool should be registered");
      const resumed = await messageTool.execute(
        "resume-call",
        { name: "nested-map", message: "continue once" },
        undefined,
        undefined,
        ctx,
      );
      const resumedId = resumed.details.id as string;
      appendFileSync(
        completedSession,
        JSON.stringify({
          type: "message",
          id: "resumed-final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "RESUMED_CURRENT_RUN" }],
          },
        }) + "\n",
      );
      const resumedRecorder = createSubagentActivityRecorder({
        runningChildId: resumedId,
        activityFile: getSubagentActivityFile(artifactDir, resumedId),
      });
      resumedRecorder.sessionStart();
      resumedRecorder.agentEndDone();

      assert.equal(runningChildrenCount(), 1);
      endParentTurn();
      assert.equal(shutdowns, 1, "outer worker remains parked for the resumed child");
      await waitFor(() => sentMessages.filter(
        ({ message }) => message.customType === "subagent_result" &&
          message.details?.name === "nested-map",
      ).length === 2);
      const resumedResult = sentMessages.filter(
        ({ message }) => message.customType === "subagent_result" &&
          message.details?.name === "nested-map",
      ).at(-1)!.message;
      assert.match(resumedResult.content, /RESUMED_CURRENT_RUN/);
      assert.doesNotMatch(
        resumedResult.content,
        /INHERITED_PARENT_OUTPUT|CURRENT_RUN_COMPLETION/,
      );
      assert.equal(resumedResult.details.exitCode, 0);
      assert.equal(resumedResult.details.error, undefined);
      assert.equal(resolveNameInRegistry(artifactDir, "nested-map")?.runState, "completed");

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        sentMessages.filter(({ message }) => message.customType === "subagent_result").length,
        3,
        "each normal terminal result must be delivered exactly once",
      );

      // Exercise the initial watcher's rejection handler at its real promise
      // seam: a synchronous delivery failure in the success callback is
      // handled by the adjacent catch callback.
      const deliveryFailure = await spawn.execute(
        "delivery-failure-call",
        { agent: "scout", name: "delivery-failure", task: "complete despite delivery failure" },
        undefined,
        undefined,
        ctx,
      );
      const deliveryFailureSession = deliveryFailure.details.sessionFile as string;
      const deliveryFailureId = deliveryFailure.details.id as string;
      sendMessageFailure = new Error("forced initial watcher delivery failure");
      appendFileSync(
        deliveryFailureSession,
        JSON.stringify({
          type: "message",
          id: "delivery-failure-final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "INITIAL_DELIVERY_RECOVERED" }],
          },
        }) + "\n",
      );
      const deliveryFailureRecorder = createSubagentActivityRecorder({
        runningChildId: deliveryFailureId,
        activityFile: getSubagentActivityFile(artifactDir, deliveryFailureId),
      });
      deliveryFailureRecorder.sessionStart();
      deliveryFailureRecorder.agentEndDone();
      await waitFor(() => sentMessages.filter(
        ({ message }) => message.customType === "subagent_result" &&
          message.details?.name === "delivery-failure",
      ).length === 2);
      const deliveryFailureMessages = sentMessages.filter(
        ({ message }) => message.customType === "subagent_result" &&
          message.details?.name === "delivery-failure",
      );
      assert.match(deliveryFailureMessages[0].message.content, /INITIAL_DELIVERY_RECOVERED/);
      assert.deepEqual(
        deliveryFailureMessages[0].options,
        { triggerTurn: true, deliverAs: "followUp" },
        "initial watcher success must queue a follow-up turn",
      );
      assert.match(
        deliveryFailureMessages[1].message.content,
        /forced initial watcher delivery failure/,
      );
      assert.deepEqual(
        deliveryFailureMessages[1].options,
        { triggerTurn: true, deliverAs: "followUp" },
        "initial watcher rejection must queue a follow-up turn",
      );

      assert.equal(runningMap.size, 0, "watchers must remove all proven terminal children");
      assert.equal(runningChildrenCount(), 0);
      assert.equal(widgetStates.at(-1), undefined, "the running-child widget must be cleared");
      assert.equal(resolveNameInRegistry(artifactDir, "shutdown-only"), null);
      assert.ok(resolveNameInRegistry(artifactDir, "nested-map"));
      assert.ok(resolveNameInRegistry(artifactDir, "delivery-failure"));

      endParentTurn();
      assert.equal(shutdowns, 2, "outer worker can auto-exit after proven children complete");
    } finally {
      for (const handler of indexHandlers.get("session_shutdown") ?? []) handler({}, {});
      subagentsModule?.__test__.runningSubagents.clear();
      for (const name of envNames) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
