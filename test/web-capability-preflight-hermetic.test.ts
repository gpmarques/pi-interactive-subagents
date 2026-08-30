import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CANONICAL_TOOLS = [
  "web_search",
  "fetch_content",
  "get_search_content",
  "source_check",
] as const;

function extensionSource(
  tools: readonly string[],
  expectedCwd: string,
  expectedAgentDir: string,
): string {
  return [
    "export default function (pi) {",
    `  if (process.cwd() !== ${JSON.stringify(expectedCwd)}) return;`,
    `  if (process.env.PI_CODING_AGENT_DIR !== ${JSON.stringify(expectedAgentDir)}) return;`,
    ...tools.map((name) => [
      "  pi.registerTool({",
      `    name: ${JSON.stringify(name)},`,
      `    label: ${JSON.stringify(name)},`,
      `    description: ${JSON.stringify(`fixture ${name}`)},`,
      '    parameters: { type: "object", properties: {} },',
      "    async execute() { return { content: [{ type: \"text\", text: \"unused\" }] }; },",
      "  });",
    ].join("\n")),
    "}",
    "",
  ].join("\n");
}

describe("production researcher capability preflight", { timeout: 30_000 }, () => {
  let root: string;
  let agentDir: string;
  let packageRoot: string;
  let entrypoint: string;
  let tmuxLog: string;
  let parentSession: string;
  let subagentTool: any;
  let testApi: any;
  let runningMap: Map<string, any>;
  let handlers: Map<string, Array<(...args: any[]) => void>>;
  let previousEnv: Record<string, string | undefined>;

  function installEntrypoint(tools: readonly string[]): void {
    writeFileSync(entrypoint, extensionSource(tools, root, agentDir));
  }

  function context() {
    return {
      cwd: root,
      hasUI: true,
      ui: { setWidget() {} },
      sessionManager: {
        getSessionFile() { return parentSession; },
        getSessionId() { return "web-preflight-parent"; },
        getSessionDir() { return root; },
      },
    } as any;
  }

  before(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-web-preflight-hermetic-")));
    agentDir = join(root, "agent");
    packageRoot = join(agentDir, "npm", "node_modules", "pi-web-access");
    entrypoint = join(packageRoot, "index.ts");
    tmuxLog = join(root, "tmux.log");
    parentSession = join(root, "parent.jsonl");
    const binDir = join(root, "bin");
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-web-access"] }));
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: "pi-web-access",
      version: "0.27.0",
      pi: { extensions: ["./index.ts"] },
    }));
    writeFileSync(
      parentSession,
      JSON.stringify({ type: "session", version: 3, id: "web-preflight-parent", cwd: root }) + "\n",
    );
    writeFileSync(
      join(binDir, "tmux"),
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$PI_FAKE_TMUX_LOG\"",
        "case \"$1\" in",
        "  split-window) printf '%s\\n' '%web-preflight-child' ;;",
        "  capture-pane) printf '%s\\n' '__SUBAGENT_DONE_0__' ;;",
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
      "PI_SUBAGENT_LIFECYCLE_DISABLED",
    ] as const;
    previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.PATH = `${binDir}:${previousEnv.PATH ?? ""}`;
    process.env.PI_SUBAGENT_MUX = "tmux";
    process.env.TMUX = `${join(root, "socket")},1,0`;
    process.env.TMUX_PANE = "%parent";
    process.env.PI_FAKE_TMUX_LOG = tmuxLog;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    delete process.env.PI_SUBAGENT_LIFECYCLE_DISABLED;

    const subagentsModule = await import("../pi-extension/subagents/index.ts");
    const registeredTools: any[] = [];
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
      sendMessage() {},
      getAllTools() { return []; },
    } as any);
    subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "subagent tool must be registered");
    testApi = subagentsModule.__test__;
    runningMap = testApi.runningSubagents;
    runningMap.clear();
  });

  after(async () => {
    for (const running of runningMap.values()) running.abortController?.abort();
    runningMap.clear();
    for (const handler of handlers.get("session_shutdown") ?? []) handler({}, {});
    await new Promise((resolve) => setTimeout(resolve, 180));
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("blocks zero, partial, and renamed registrations before a surface, but launches all four", async () => {
    const failingCases: Array<[string, readonly string[]]> = [
      ["zero", []],
      ["partial", CANONICAL_TOOLS.slice(0, 2)],
      ["renamed", CANONICAL_TOOLS.map((name) => `renamed_${name}`)],
    ];

    for (const [label, tools] of failingCases) {
      installEntrypoint(tools);
      assert.equal(
        testApi.resolvePiWebAccess(agentDir).extensionPath,
        entrypoint,
        `${label} fixture must pass registration/name/version/manifest/config validation`,
      );
      rmSync(tmuxLog, { force: true });
      const result = await subagentTool.execute(
        `web-preflight-${label}`,
        { agent: "researcher", name: `web-preflight-${label}`, task: "Must not launch." },
        undefined,
        undefined,
        context(),
      );
      assert.match(result.details.error, /fresh bounded offline Pi capability preflight failed/i);
      assert.match(result.details.error, /activated.*expected exactly/i);
      const tmuxCalls = existsSync(tmuxLog) ? readFileSync(tmuxLog, "utf8") : "";
      assert.doesNotMatch(tmuxCalls, /^split-window /m, `${label} must fail before tmux surface creation`);
      assert.equal(runningMap.size, 0);
    }

    installEntrypoint(CANONICAL_TOOLS);
    assert.equal(testApi.resolvePiWebAccess(agentDir).extensionPath, entrypoint);
    rmSync(tmuxLog, { force: true });
    const started = await subagentTool.execute(
      "web-preflight-all-four",
      { agent: "researcher", name: "web-preflight-all-four", task: "Launch only after preflight." },
      undefined,
      undefined,
      context(),
    );
    assert.equal(started.details.status, "started");
    assert.match(readFileSync(tmuxLog, "utf8"), /^split-window /m);
  });
});
