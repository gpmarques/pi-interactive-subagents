import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  nameRegistryPath,
  readNameRegistry,
} from "../pi-extension/subagents/session.ts";

describe("hermetic durable spawn registration", () => {
  it("does not create a child when its pending name ownership cannot be persisted", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-registry-hermetic-"));
    const binDir = join(root, "bin");
    const tmuxLog = join(root, "tmux.log");
    const agentDir = join(root, "agent-config");
    const parentId = "parent";
    const parentSession = join(root, "parent.jsonl");
    const artifactDir = join(root, "artifacts", parentId);
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "registry-test.md"),
      [
        "---",
        "name: registry-test",
        "description: Hermetic registry failure fixture",
        "tools: read",
        "auto-exit: true",
        "---",
        "Return a short result.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      parentSession,
      JSON.stringify({ type: "session", version: 3, id: parentId, cwd: root }) + "\n",
    );
    writeFileSync(
      join(binDir, "tmux"),
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$PI_FAKE_TMUX_LOG\"",
        "if [ \"$1\" = 'split-window' ]; then printf '%s\\n' '%fake-child'; fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, "tmux"), 0o755);

    // A directory at the registry path makes the atomic reservation fail.
    // No pane may be created without durable pending ownership.
    mkdirSync(nameRegistryPath(artifactDir), { recursive: true });

    const envNames = [
      "PATH",
      "TMUX",
      "TMUX_PANE",
      "PI_SUBAGENT_MUX",
      "PI_FAKE_TMUX_LOG",
      "PI_CODING_AGENT_DIR",
      "PI_SUBAGENT_SHELL_READY_DELAY_MS",
    ] as const;
    const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.PATH = `${binDir}:${previous.PATH ?? ""}`;
    process.env.PI_SUBAGENT_MUX = "tmux";
    process.env.TMUX = `${join(root, "socket")},1,0`;
    process.env.TMUX_PANE = "%parent";
    process.env.PI_FAKE_TMUX_LOG = tmuxLog;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";

    let runningMap: Map<string, any> | undefined;
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    try {
      const subagentsModule = await import("../pi-extension/subagents/index.ts");
      const registeredTools: any[] = [];
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
        sendMessage() {},
        getAllTools() { return []; },
      } as any);
      runningMap = subagentsModule.__test__.runningSubagents;
      runningMap.clear();
      const spawnTool = registeredTools.find((tool) => tool.name === "subagent");
      assert.ok(spawnTool);

      const result = await spawnTool.execute(
        "registry-failure",
        { agent: "registry-test", task: "Do not actually run." },
        undefined,
        undefined,
        {
          cwd: root,
          hasUI: true,
          ui: { setWidget() {} },
          sessionManager: {
            getSessionFile() { return parentSession; },
            getSessionId() { return parentId; },
            getSessionDir() { return root; },
          },
        },
      );

      assert.match(result.details.error, /registry|ownership|reserve/i);
      assert.equal(runningMap.size, 0, "an unreserved child must not remain live-tracked");
      assert.equal(existsSync(tmuxLog), false, "reservation failure must precede pane creation");
      assert.equal(existsSync(nameRegistryPath(artifactDir)), true);
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({}, {});
      runningMap?.clear();
      await new Promise((resolve) => setTimeout(resolve, 160));
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes an exact created surface and releases its pending name on pre-dispatch setup failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-predispatch-hermetic-"));
    const binDir = join(root, "bin");
    const tmuxLog = join(root, "tmux.log");
    const agentDir = join(root, "agent-config");
    const parentId = "predispatch-parent";
    const parentSession = join(root, "parent.jsonl");
    const artifactDir = join(root, "artifacts", parentId);
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "predispatch-test.md"),
      [
        "---",
        "name: predispatch-test",
        "description: Hermetic pre-dispatch failure fixture",
        "tools: read",
        "auto-exit: true",
        "---",
        "Return a short result.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      parentSession,
      JSON.stringify({ type: "session", version: 3, id: parentId, cwd: root }) + "\n",
    );
    // Context delivery needs this path to be a directory. A regular file injects
    // a real filesystem failure after pane creation but before ownership activation.
    writeFileSync(join(artifactDir, "context"), "block context directory");
    writeFileSync(
      join(binDir, "tmux"),
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$PI_FAKE_TMUX_LOG\"",
        "if [ \"$1\" = 'split-window' ]; then printf '%s\\n' '%predispatch-child'; fi",
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
    ] as const;
    const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.PATH = `${binDir}:${previous.PATH ?? ""}`;
    process.env.PI_SUBAGENT_MUX = "tmux";
    process.env.TMUX = `${join(root, "socket")},1,0`;
    process.env.TMUX_PANE = "%parent";
    process.env.PI_FAKE_TMUX_LOG = tmuxLog;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";

    let runningMap: Map<string, any> | undefined;
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    try {
      const subagentsModule = await import("../pi-extension/subagents/index.ts");
      const registeredTools: any[] = [];
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
        sendMessage() {},
        getAllTools() { return []; },
      } as any);
      runningMap = subagentsModule.__test__.runningSubagents;
      runningMap.clear();
      const spawnTool = registeredTools.find((tool) => tool.name === "subagent");
      assert.ok(spawnTool);

      const result = await spawnTool.execute(
        "predispatch-failure",
        { agent: "predispatch-test", task: "Do not dispatch." },
        undefined,
        undefined,
        {
          cwd: root,
          hasUI: true,
          ui: { setWidget() {} },
          sessionManager: {
            getSessionFile() { return parentSession; },
            getSessionId() { return parentId; },
            getSessionDir() { return root; },
          },
        },
      );

      assert.match(result.details.error, /launch|context|exist|directory/i);
      assert.equal(runningMap.size, 0);
      assert.deepEqual(readNameRegistry(artifactDir), {}, "pending ownership must be released");
      const tmuxCalls = readFileSync(tmuxLog, "utf8").trim().split("\n");
      assert.ok(tmuxCalls.some((line) => line.startsWith("split-window ")));
      assert.ok(
        tmuxCalls.some((line) => line === "kill-pane -t %predispatch-child"),
        "the exact created pane must close on setup failure",
      );
      assert.equal(
        tmuxCalls.some((line) => line.startsWith("send-keys ")),
        false,
        "no child command may be dispatched",
      );
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({}, {});
      runningMap?.clear();
      await new Promise((resolve) => setTimeout(resolve, 25));
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
