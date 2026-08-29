import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

const LIFECYCLE_TOOLS = [
  "subagent",
  "subagent_message",
  "subagent_resume",
  "subagent_kill",
  "subagents_list",
];

describe("bundled visual-tester agent", () => {
  it("is an isolated autonomous agent-browser visual QA profile", () => {
    const root = mkdtempSync(join(tmpdir(), "visual-tester-agent-"));
    const projectDir = join(root, "project");
    const agentDir = join(root, "agent-config");
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    try {
      process.chdir(projectDir);
      process.env.PI_CODING_AGENT_DIR = agentDir;

      const testApi = (subagentsModule as any).__test__;
      const visual = testApi.discoverAgentDefinitions().find(
        (agent: any) => agent.name === "visual-tester",
      );
      assert.ok(visual, "expected bundled visual-tester to be discoverable");
      assert.deepEqual(
        {
          name: visual.name,
          description: visual.description,
          tools: visual.tools,
          model: visual.model,
          thinking: visual.thinking,
          systemPromptMode: visual.systemPromptMode,
          autoExit: visual.autoExit,
          interactive: visual.interactive,
          subagentAgents: visual.subagentAgents,
        },
        {
          name: "visual-tester",
          description:
            "Autonomous visual QA specialist that tests web UIs with agent-browser and reports evidence without changing implementation",
          tools: "read, write, bash",
          model: "openai-codex/gpt-5.6-sol",
          thinking: "high",
          systemPromptMode: "append",
          autoExit: true,
          interactive: undefined,
          subagentAgents: undefined,
        },
      );
      assert.equal(
        testApi.resolveEffectiveInteractive({ name: "visual-tester", task: "" }, visual),
        false,
        "auto-exit profile must resolve as autonomous/non-interactive",
      );

      const allowlist = new Set(
        testApi.buildSubagentToolAllowlist(visual.tools, { grantSpawning: false }).split(","),
      );
      for (const tool of [...LIFECYCLE_TOOLS, "edit"]) {
        assert.equal(allowlist.has(tool), false, `visual-tester must not receive ${tool}`);
      }
      assert.deepEqual(
        [...allowlist].sort(),
        ["ask_question", "bash", "read", "write"],
        "effective tools should contain only the exact profile tools plus child question control",
      );

      const body = visual.body ?? "";
      assert.match(body, /Use the `agent-browser` CLI exclusively/);
      assert.match(body, /first run `command -v agent-browser`/);
      assert.match(body, /printf '\{\}\\n' > "\$config_path"/);
      assert.match(body, /--session "\$session_name" --config "\$config_path"/);
      assert.match(body, /\[\[ "\$name" == AGENT_BROWSER_\* \]\]/);
      assert.match(body, /unset_args\+=\(-u "\$name"\)/);
      assert.match(body, /if \(\( \$\{#unset_args\[@\]\} > 0 \)\); then[\s\S]*else[\s\S]*fi/);
      assert.match(body, /sanitized, unique session name/);
      assert.match(body, /Do not rely on exports or shell variables persisting across `bash` tool calls/);
      assert.doesNotMatch(body, /export AGENT_BROWSER_/);

      for (const command of [
        "open",
        "wait",
        "get url",
        "get title",
        "snapshot -i",
        "screenshot",
        "console",
        "errors",
        "network requests",
        "set viewport",
        "set media",
        "close",
      ]) {
        assert.match(
          body,
          new RegExp(`<agent-browser-wrapper>\\" ${command.replace(" ", "\\\\s+")}`),
          `expected ${command} workflow to use the isolation wrapper`,
        );
      }
      assert.doesNotMatch(
        body,
        /`agent-browser (?:open|wait|get|snapshot|screenshot|click|fill|type|press|console|errors|network|set|close)\b/,
        "browser workflow and cleanup must never invoke raw agent-browser",
      );
      assert.match(body, /shared CDP, profile, state, auth, provider, or config mode/);
      assert.match(body, /only when the task explicitly requests it/);
      assert.match(body, /document the resulting reduced isolation/);
      assert.match(body, /never import ambient configuration or credentials/);
      assert.match(
        body,
        /Do not use `browser-use`[\s\S]*HazAT's `scripts\/cdp\.mjs` helper/,
        "body must reject both browser-use and the HazAT CDP helper",
      );
      assert.match(body, /There is no fallback browser mechanism/);
      assert.match(body, /Do not spawn other agents/);
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes the wrapper with empty and hostile ambient agent-browser environments", () => {
    const root = mkdtempSync(join(tmpdir(), "visual-tester-wrapper-"));
    const projectDir = join(root, "project");
    const agentDir = join(root, "agent-config");
    const fakeBinDir = join(root, "bin");
    const setupTmpDir = join(root, "tmp");
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(fakeBinDir, { recursive: true });
    mkdirSync(setupTmpDir, { recursive: true });

    try {
      process.chdir(projectDir);
      process.env.PI_CODING_AGENT_DIR = agentDir;

      const testApi = (subagentsModule as any).__test__;
      const visual = testApi.discoverAgentDefinitions().find(
        (agent: any) => agent.name === "visual-tester",
      );
      assert.ok(visual, "expected bundled visual-tester to be discoverable");

      const setupBlock = (visual.body ?? "").match(/```bash\n([\s\S]*?)\n```/)?.[1];
      assert.ok(setupBlock, "expected the profile's first bash block to be wrapper setup");

      const fakeBrowser = join(fakeBinDir, "agent-browser");
      writeFileSync(
        fakeBrowser,
        `#!/bin/bash
set -eu
for arg in "$@"; do
  printf 'ARG=%s\\n' "$arg"
done
while IFS= read -r line; do
  case "$line" in
    AGENT_BROWSER_*) printf 'ENV=%s\\n' "$line" ;;
  esac
done < <(/usr/bin/env)
`,
        { mode: 0o755 },
      );

      const cleanEnv: NodeJS.ProcessEnv = {};
      for (const [name, value] of Object.entries(process.env)) {
        if (!name.startsWith("AGENT_BROWSER_") && value !== undefined) cleanEnv[name] = value;
      }
      cleanEnv.PATH = `${fakeBinDir}:${cleanEnv.PATH ?? "/usr/bin:/bin"}`;
      cleanEnv.TMPDIR = setupTmpDir;
      cleanEnv.PI_SUBAGENT_NAME = "wrapper-test";
      cleanEnv.PI_SUBAGENT_ID = "empty-env";

      const setup = spawnSync("/bin/bash", ["-c", setupBlock], {
        cwd: projectDir,
        env: cleanEnv,
        encoding: "utf8",
      });
      assert.equal(setup.status, 0, `wrapper setup failed:\n${setup.stderr}`);
      const emitted = setup.stdout.match(
        /agent-browser wrapper: (.+)\nisolation directory: (.+)\nsession: (.+)\n/,
      );
      assert.ok(emitted, `setup did not emit wrapper metadata:\n${setup.stdout}`);
      const [, wrapperPath, isolationDir, sessionName] = emitted;
      const configPath = join(isolationDir, "empty-config.json");
      assert.equal(readFileSync(configPath, "utf8"), "{}\n");

      const invoke = (env: NodeJS.ProcessEnv) => {
        const result = spawnSync(wrapperPath, ["open", "https://example.invalid"], {
          cwd: projectDir,
          env,
          encoding: "utf8",
        });
        assert.equal(result.status, 0, `isolated wrapper failed:\n${result.stderr}`);
        return result.stdout.split("\n").filter(Boolean);
      };
      const expectedArgs = [
        "ARG=--session",
        `ARG=${sessionName}`,
        "ARG=--config",
        `ARG=${configPath}`,
        "ARG=open",
        "ARG=https://example.invalid",
      ];

      const emptyAmbientOutput = invoke(cleanEnv);
      assert.deepEqual(emptyAmbientOutput, expectedArgs);

      const hostileEnv = {
        ...cleanEnv,
        AGENT_BROWSER_PROVIDER: "browseruse",
        AGENT_BROWSER_AUTO_CONNECT: "1",
        AGENT_BROWSER_PROFILE: join(root, "ambient-profile"),
      };
      const hostileAmbientOutput = invoke(hostileEnv);
      assert.deepEqual(hostileAmbientOutput, expectedArgs);
      assert.equal(
        hostileAmbientOutput.some((line) => line.startsWith("ENV=AGENT_BROWSER_")),
        false,
      );

      rmSync(isolationDir, { recursive: true, force: true });
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
