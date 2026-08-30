/**
 * Fresh-process capability check for bundled profiles.
 *
 * Every profile starts a new offline Pi RPC runtime with the same
 * --no-extensions / --tools / explicit -e policy used by subagent launches.
 * The inspector records Pi's active tool names at session_start; no model or
 * web tool is invoked, and no saved subagent loadout is resumed.
 *
 * Run with:
 *   npm run test:integration:web-tools
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { __test__ as testApi } from "../../pi-extension/subagents/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_TOOLS = [
  "web_search",
  "fetch_content",
  "get_search_content",
  "source_check",
] as const;
const BUNDLED_PROFILES = [
  "planner",
  "researcher",
  "reviewer",
  "scout",
  "visual-tester",
  "worker",
] as const;

function readFreshRuntimeTools(profileName: string, root: string, inspectorPath: string): string[] {
  const profile = testApi.loadAgentDefaults(profileName);
  assert.ok(profile, `expected bundled ${profileName} profile`);
  const grantSpawning = !!profile.subagentAgents?.length;
  const allowlist = testApi.buildSubagentToolAllowlist(profile.tools, { grantSpawning });
  assert.ok(allowlist, `expected restricted ${profileName} allowlist`);
  const backingExtensions = testApi.resolveToolBackingExtensions(allowlist);
  assert.ok(backingExtensions, `expected restricted ${profileName} extension list`);

  const snapshotPath = join(root, `${profileName}-tools.json`);
  const args = [
    "--mode",
    "rpc",
    "--offline",
    "--no-session",
    "--no-extensions",
    "--tools",
    allowlist,
    ...backingExtensions.flatMap((extensionPath: string) => ["-e", extensionPath]),
    "-e",
    inspectorPath,
  ];
  const result = spawnSync("pi", args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_OFFLINE: "1",
      PI_RUNTIME_TOOL_SNAPSHOT: snapshotPath,
      PI_SUBAGENT_AGENT: profileName,
      PI_SUBAGENT_NAME: `offline-${profileName}`,
    },
    encoding: "utf8",
    input: "",
    timeout: 30_000,
  });

  assert.equal(
    result.status,
    0,
    `fresh offline Pi runtime failed for ${profileName}: ${result.error?.message ?? result.stderr}`,
  );
  assert.equal(existsSync(snapshotPath), true, `missing runtime tool snapshot for ${profileName}`);
  return JSON.parse(readFileSync(snapshotPath, "utf8"));
}

describe("fresh offline bundled-profile tool surfaces", { timeout: 60_000 }, () => {
  it("gives all four pi-web-access tools only to researcher", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagent-web-tools-"));
    const inspectorPath = join(root, "inspect-active-tools.ts");
    writeFileSync(
      inspectorPath,
      [
        'import { writeFileSync } from "node:fs";',
        "export default function (pi) {",
        '  pi.on("session_start", () => {',
        "    writeFileSync(",
        "      process.env.PI_RUNTIME_TOOL_SNAPSHOT,",
        "      JSON.stringify(pi.getActiveTools().sort()),",
        '      "utf8",',
        "    );",
        "  });",
        "}",
        "",
      ].join("\n"),
    );

    try {
      for (const profileName of BUNDLED_PROFILES) {
        const activeTools = readFreshRuntimeTools(profileName, root, inspectorPath);
        const active = new Set(activeTools);
        if (profileName === "researcher") {
          assert.deepEqual(activeTools, [
            "ask_question",
            "fetch_content",
            "get_search_content",
            "safe_bash",
            "source_check",
            "web_search",
          ]);
          continue;
        }
        for (const tool of WEB_TOOLS) {
          assert.equal(active.has(tool), false, `${profileName} unexpectedly received ${tool}`);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
