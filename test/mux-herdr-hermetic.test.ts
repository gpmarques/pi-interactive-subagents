import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const muxUrl = pathToFileURL(join(process.cwd(), "pi-extension/subagents/mux.ts")).href;
const tmuxUrl = pathToFileURL(join(process.cwd(), "pi-extension/subagents/tmux.ts")).href;

const fakeCli = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const binary = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_MUX_LOG, JSON.stringify({ binary, args }) + "\\n");

const statePath = process.env.FAKE_MUX_STATE;
let state = {};
try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
function saveState() { fs.writeFileSync(statePath, JSON.stringify(state)); }
function output(value) { process.stdout.write(value); }
function fail(stderr, status = 1) { process.stderr.write(stderr); process.exit(status); }

if (binary === "tmux") {
  if (args[0] === "split-window") output(process.env.FAKE_TMUX_SPLIT || "%fake-tmux\\n");
  else if (args[0] === "capture-pane") output(process.env.FAKE_TMUX_SCREEN || "");
  process.exit(0);
}

const command = args.slice(0, 2).join(" ");
if (command === "pane current") {
  output(process.env.FAKE_HERDR_CURRENT || JSON.stringify({
    result: { pane: { pane_id: "wf:p1", workspace_id: "wf", tab_id: "wf:t1" } }
  }));
} else if (command === "tab create") {
  output(process.env.FAKE_HERDR_TAB || JSON.stringify({
    result: { root_pane: { pane_id: "wf:p2" }, tab: { tab_id: "wf:t2" } }
  }));
} else if (command === "pane split") {
  const sequence = JSON.parse(process.env.FAKE_HERDR_SPLIT_SEQUENCE || "[]");
  const index = state.split || 0;
  state.split = index + 1;
  saveState();
  output(sequence[index] || process.env.FAKE_HERDR_SPLIT || JSON.stringify({
    result: { pane: { pane_id: "wf:p3" } }
  }));
} else if (command === "pane close" && process.env.FAKE_HERDR_CLOSE_ERROR) {
  fail(process.env.FAKE_HERDR_CLOSE_ERROR);
} else if (command === "pane read") {
  const sequence = JSON.parse(process.env.FAKE_HERDR_READ_SEQUENCE || "[]");
  const index = state.read || 0;
  state.read = index + 1;
  saveState();
  const entry = sequence[index];
  if (entry) {
    if (entry.status) fail(entry.stderr || "", entry.status);
    output(entry.stdout || "");
  } else {
    const sourceIndex = args.indexOf("--source");
    const source = sourceIndex >= 0 ? args[sourceIndex + 1] : "recent";
    output(source === "recent"
      ? (process.env.FAKE_HERDR_RECENT ?? "recent")
      : (process.env.FAKE_HERDR_VISIBLE ?? "visible"));
  }
}
process.exit(0);
`;

type Call = { binary: string; args: string[] };

type ScenarioOptions = {
  binaries: Array<"herdr" | "tmux">;
  env?: Record<string, string | undefined>;
  code: string;
};

function runScenario<T>(options: ScenarioOptions): { value: T; calls: Call[]; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "mux-herdr-hermetic-"));
  const logPath = join(root, "mux.log");
  const statePath = join(root, "state.json");
  const templatePath = join(root, ".fake-mux-cli");
  writeFileSync(statePath, "{}", "utf8");
  writeFileSync(templatePath, fakeCli, "utf8");

  try {
    for (const binary of options.binaries) {
      const path = join(root, binary);
      writeFileSync(path, fakeCli, "utf8");
      chmodSync(path, 0o755);
    }

    const env: NodeJS.ProcessEnv = {
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      PATH: `${root}:/usr/bin:/bin`,
      NODE_NO_WARNINGS: "1",
      FAKE_MUX_LOG: logPath,
      FAKE_MUX_STATE: statePath,
      FAKE_MUX_TEMPLATE: templatePath,
      FAKE_MUX_BIN_DIR: root,
    };
    for (const [name, value] of Object.entries(options.env ?? {})) {
      if (value !== undefined) env[name] = value;
    }

    const source = `
      import * as mux from ${JSON.stringify(muxUrl)};
      async function scenario() { ${options.code} }
      try {
        const value = await scenario();
        process.stdout.write("__MUX_RESULT__" + JSON.stringify({ ok: true, value }));
      } catch (error) {
        const stderr = typeof error?.stderr === "string"
          ? error.stderr
          : Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : null;
        process.stdout.write("__MUX_RESULT__" + JSON.stringify({
          ok: false,
          message: error?.message ?? String(error),
          stderr,
        }));
      }
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(child.status, 0, `isolated scenario failed:\n${child.stderr}\n${child.stdout}`);
    const marker = "__MUX_RESULT__";
    const markerIndex = child.stdout.lastIndexOf(marker);
    assert.notEqual(markerIndex, -1, `scenario returned no result:\n${child.stdout}\n${child.stderr}`);
    const result = JSON.parse(child.stdout.slice(markerIndex + marker.length));
    assert.equal(result.ok, true, result.message ?? "isolated scenario threw");

    const calls = existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    return { value: result.value as T, calls, cwd: realpathSync(root) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const herdrIdentity = {
  HERDR_ENV: "1",
  HERDR_WORKSPACE_ID: "w7",
  HERDR_PANE_ID: "w7:p3",
};

describe("mux Herdr adapter (hermetic public interface)", () => {
  it("selects Herdr before tmux when both environments coexist", () => {
    const result = runScenario<{ backend: string | null; herdr: boolean; tmux: boolean }>({
      binaries: ["herdr", "tmux"],
      env: { ...herdrIdentity, TMUX: "/tmp/tmux,1,0", TMUX_PANE: "%1" },
      code: `return {
        backend: mux.getMuxBackend(),
        herdr: mux.isHerdrAvailable(),
        tmux: mux.isTmuxAvailable(),
      };`,
    });

    assert.deepEqual(result.value, { backend: "herdr", herdr: true, tmux: true });
    assert.deepEqual(result.calls, []);
  });

  it("honors forced tmux and never falls back from unavailable or invalid preferences", () => {
    const forced = runScenario<string | null>({
      binaries: ["herdr", "tmux"],
      env: {
        ...herdrIdentity,
        TMUX: "/tmp/tmux,1,0",
        PI_SUBAGENT_MUX: "tmux",
      },
      code: "return mux.getMuxBackend();",
    });
    assert.equal(forced.value, "tmux");

    const unavailable = runScenario<{ backend: string | null; error: string }>({
      binaries: ["tmux"],
      env: {
        ...herdrIdentity,
        TMUX: "/tmp/tmux,1,0",
        PI_SUBAGENT_MUX: "herdr",
      },
      code: `
        let error = "";
        try { mux.createSurface("must-not-fallback"); } catch (caught) { error = caught.message; }
        return { backend: mux.getMuxBackend(), error };
      `,
    });
    assert.equal(unavailable.value.backend, null);
    assert.match(unavailable.value.error, /No supported terminal multiplexer|Herdr/);
    assert.deepEqual(unavailable.calls, [], "forced-unavailable Herdr must not call tmux");

    const invalid = runScenario<{ backend: string | null; hint: string; error: string }>({
      binaries: ["herdr", "tmux"],
      env: {
        ...herdrIdentity,
        TMUX: "/tmp/tmux,1,0",
        PI_SUBAGENT_MUX: "TMUX",
      },
      code: `
        let error = "";
        try { mux.createSurface("invalid"); } catch (caught) { error = caught.message; }
        return { backend: mux.getMuxBackend(), hint: mux.muxSetupHint(), error };
      `,
    });
    assert.equal(invalid.value.backend, null);
    assert.match(invalid.value.hint, /"tmux".*"herdr"/);
    assert.match(invalid.value.error, /Invalid PI_SUBAGENT_MUX.*"tmux".*"herdr"/);
    assert.deepEqual(invalid.calls, []);
  });

  it("treats an explicitly empty PI_SUBAGENT_MUX as invalid", () => {
    const result = runScenario<{ backend: string | null; hint: string; error: string }>({
      binaries: ["herdr", "tmux"],
      env: {
        ...herdrIdentity,
        TMUX: "/tmp/tmux,1,0",
        PI_SUBAGENT_MUX: "",
      },
      code: `
        let error = "";
        try { mux.createSurface("invalid-empty"); } catch (caught) { error = caught.message; }
        return { backend: mux.getMuxBackend(), hint: mux.muxSetupHint(), error };
      `,
    });

    assert.equal(result.value.backend, null);
    assert.match(result.value.hint, /"tmux".*"herdr"/);
    assert.match(result.value.error, /Invalid PI_SUBAGENT_MUX.*"tmux".*"herdr"/);
    assert.deepEqual(result.calls, []);
  });

  it("observes backend binary appearance and removal without reloading the module", () => {
    const result = runScenario<Array<string | null>>({
      binaries: [],
      env: { ...herdrIdentity, PI_SUBAGENT_MUX: "herdr" },
      code: `
        const { chmodSync, copyFileSync, rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        const binary = join(process.env.FAKE_MUX_BIN_DIR, "herdr");
        const states = [mux.getMuxBackend()];
        copyFileSync(process.env.FAKE_MUX_TEMPLATE, binary);
        chmodSync(binary, 0o755);
        states.push(mux.getMuxBackend());
        rmSync(binary);
        states.push(mux.getMuxBackend());
        return states;
      `,
    });

    assert.deepEqual(result.value, [null, "herdr", null]);
    assert.deepEqual(result.calls, []);
  });

  it("uses the safe current-pane fallback when Herdr identity env vars are absent", () => {
    const result = runScenario<string | null>({
      binaries: ["herdr"],
      env: {
        HERDR_ENV: "1",
        FAKE_HERDR_CURRENT: JSON.stringify({
          result: { pane: { pane_id: "wf:p9", workspace_id: "wf" } },
        }),
      },
      code: "return mux.getMuxBackend();",
    });

    assert.equal(result.value, "herdr");
    assert.deepEqual(result.calls, [
      { binary: "herdr", args: ["pane", "current", "--current"] },
    ]);
  });

  it("creates a no-focus tab in the explicit caller workspace and strictly parses its root pane", () => {
    const result = runScenario<string>({
      binaries: ["herdr"],
      env: {
        ...herdrIdentity,
        FAKE_HERDR_TAB: JSON.stringify({
          result: { root_pane: { pane_id: "w7:p8" }, tab: { tab_id: "w7:t8" } },
        }),
      },
      code: `return mux.createSurface("Review agent");`,
    });

    assert.equal(result.value, "w7:p8");
    assert.deepEqual(result.calls, [
      {
        binary: "herdr",
        args: [
          "tab", "create", "--workspace", "w7", "--cwd", result.cwd,
          "--label", "Review agent", "--no-focus",
        ],
      },
      { binary: "herdr", args: ["pane", "rename", "w7:p8", "Review agent"] },
    ]);
  });

  it("targets right/down Herdr splits explicitly without changing focus", () => {
    const result = runScenario<string[]>({
      binaries: ["herdr"],
      env: { ...herdrIdentity },
      code: `return [
        mux.createSurfaceSplit("from", "right", "w7:p99"),
        mux.createSurfaceSplit("below", "down"),
      ];`,
    });
    assert.deepEqual(result.value, ["wf:p3", "wf:p3"]);
    assert.deepEqual(result.calls, [
      { binary: "herdr", args: ["pane", "split", "w7:p99", "--direction", "right", "--cwd", result.cwd, "--no-focus"] },
      { binary: "herdr", args: ["pane", "rename", "wf:p3", "from"] },
      { binary: "herdr", args: ["pane", "split", "w7:p3", "--direction", "down", "--cwd", result.cwd, "--no-focus"] },
      { binary: "herdr", args: ["pane", "rename", "wf:p3", "below"] },
    ]);
  });

  it("rejects left/up Herdr splits before making any CLI call", () => {
    const result = runScenario<string[]>({
      binaries: ["herdr"],
      env: { ...herdrIdentity },
      code: `
        const errors = [];
        for (const direction of ["left", "up"]) {
          try { mux.createSurfaceSplit(direction, direction); }
          catch (error) { errors.push(error.message); }
        }
        return errors;
      `,
    });

    assert.equal(result.value.length, 2);
    assert.match(result.value[0], /Herdr supports only right\/down.*left.*unavailable/);
    assert.match(result.value[1], /Herdr supports only right\/down.*up.*unavailable/);
    assert.deepEqual(result.calls, []);
  });

  it("runs atomic commands, routes long commands, retries empty reads, and closes panes", () => {
    const result = runScenario<{
      sent: string;
      longPath: string;
      script: string;
      sync: string;
      async: string;
    }>({
      binaries: ["herdr"],
      env: {
        ...herdrIdentity,
        FAKE_HERDR_RECENT: "",
        FAKE_HERDR_VISIBLE: "visible output",
      },
      code: `
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const sent = "printf '%s\\n' hello world";
        mux.sendCommand("w7:p8", sent);
        const longPath = join(process.cwd(), "long command.sh");
        mux.sendLongCommand("w7:p8", "echo long", {
          scriptPath: longPath,
          scriptPreamble: "set -eu",
        });
        const sync = mux.readScreen("w7:p8", 0);
        const async = await mux.readScreenAsync("w7:p8", -9);
        mux.killSurface("w7:p8");
        return { sent, longPath, script: readFileSync(longPath, "utf8"), sync, async };
      `,
    });

    assert.equal(result.value.script, "#!/bin/bash\nset -eu\necho long\n");
    assert.equal(result.value.sync, "visible output");
    assert.equal(result.value.async, "visible output");
    assert.deepEqual(result.calls, [
      { binary: "herdr", args: ["pane", "run", "w7:p8", result.value.sent] },
      { binary: "herdr", args: ["pane", "run", "w7:p8", `bash '${result.value.longPath}'`] },
      { binary: "herdr", args: ["pane", "read", "w7:p8", "--source", "recent", "--lines", "1"] },
      { binary: "herdr", args: ["pane", "read", "w7:p8", "--source", "visible", "--lines", "1"] },
      { binary: "herdr", args: ["pane", "read", "w7:p8", "--source", "recent", "--lines", "1"] },
      { binary: "herdr", args: ["pane", "read", "w7:p8", "--source", "visible", "--lines", "1"] },
      { binary: "herdr", args: ["pane", "close", "w7:p8"] },
    ]);
  });

  it("keeps surface ownership stable across selection and availability changes", () => {
    const missing = JSON.stringify({ error: { code: "pane_not_found" } });
    const unrelated = JSON.stringify({ error: { code: "server_busy" } });
    const splitSequence = ["wf:p3", "wf:p4", "wf:p5"].map((pane_id) =>
      JSON.stringify({ result: { pane: { pane_id } } })
    );
    const readSequence = [
      { stdout: "owned sync" },
      { stdout: "owned async" },
      { status: 1, stderr: missing },
      { status: 1, stderr: missing },
    ];
    const result = runScenario<{
      sync: string;
      async: string;
      poll: { reason: string; exitCode: number };
      missingClassified: boolean;
      unrelatedClassified: boolean;
    }>({
      binaries: ["herdr", "tmux"],
      env: {
        ...herdrIdentity,
        FAKE_HERDR_SPLIT_SEQUENCE: JSON.stringify(splitSequence),
        FAKE_HERDR_READ_SEQUENCE: JSON.stringify(readSequence),
      },
      code: `
        const root = mux.createSurface("owned-root");
        process.env.PI_SUBAGENT_MUX = "tmux";
        process.env.HERDR_ENV = "0";
        process.env.TMUX = "/tmp/tmux,1,0";

        const successful = mux.createSurfaceSplit("successful", "right", root);
        const missing = mux.createSurfaceSplit("missing", "down", root);
        const unrelated = mux.createSurfaceSplit("unrelated", "right", root);
        mux.sendCommand(root, "owned command");
        const sync = mux.readScreen(root, 5);
        const async = await mux.readScreenAsync(root, 5);
        const poll = await mux.pollForExit(root, new AbortController().signal, { interval: 1 });

        mux.killSurface(successful);
        mux.sendCommand(successful, "after successful kill");

        process.env.FAKE_HERDR_CLOSE_ERROR = ${JSON.stringify(missing)};
        let missingClassified = false;
        try { mux.killSurface(missing); }
        catch (error) { missingClassified = mux.isMissingSurfaceError(error); }
        delete process.env.FAKE_HERDR_CLOSE_ERROR;
        mux.sendCommand(missing, "after missing kill");

        process.env.FAKE_HERDR_CLOSE_ERROR = ${JSON.stringify(unrelated)};
        let unrelatedClassified = true;
        try { mux.killSurface(unrelated); }
        catch (error) { unrelatedClassified = mux.isMissingSurfaceError(error); }
        delete process.env.FAKE_HERDR_CLOSE_ERROR;
        mux.sendCommand(unrelated, "retained after unrelated failure");
        mux.closeSurface(unrelated);

        return { sync, async, poll, missingClassified, unrelatedClassified };
      `,
    });

    assert.deepEqual(result.value, {
      sync: "owned sync",
      async: "owned async",
      poll: { reason: "disappeared", exitCode: 1 },
      missingClassified: true,
      unrelatedClassified: false,
    });

    const herdrCalls = result.calls.filter((call) => call.binary === "herdr").map((call) => call.args);
    const tmuxCalls = result.calls.filter((call) => call.binary === "tmux").map((call) => call.args);
    assert.ok(herdrCalls.some((args) => args[0] === "pane" && args[1] === "split" && args[2] === "wf:p2"));
    assert.ok(herdrCalls.some((args) => args.join(" ") === "pane run wf:p2 owned command"));
    assert.equal(herdrCalls.filter((args) => args[0] === "pane" && args[1] === "read").length, 4);
    assert.ok(herdrCalls.some((args) => args.join(" ") === "pane run wf:p5 retained after unrelated failure"));
    assert.equal(herdrCalls.filter((args) => args.join(" ") === "pane close wf:p5").length, 2);
    assert.equal(tmuxCalls.filter((args) => args.includes("after successful kill")).length, 1);
    assert.equal(tmuxCalls.filter((args) => args.includes("after missing kill")).length, 1);
    assert.equal(tmuxCalls.some((args) => args.includes("retained after unrelated failure")), false);
  });

  it("rejects malformed create JSON without guessing a pane id", () => {
    const result = runScenario<string>({
      binaries: ["herdr"],
      env: { ...herdrIdentity, FAKE_HERDR_TAB: "not-json" },
      code: `
        try { mux.createSurface("malformed"); }
        catch (error) { return error.message; }
        return "did not fail";
      `,
    });

    assert.match(result.value, /Unexpected Herdr tab create output: not-json/);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].args[0], "tab");
  });

  it("classifies only structured Herdr pane_not_found stderr as missing", () => {
    const sequence = [
      { status: 1, stderr: JSON.stringify({ error: { code: "pane_not_found" } }) },
      { status: 1, stderr: JSON.stringify({ error: { code: "server_busy" } }) },
      { status: 1, stderr: "pane_not_found but not JSON" },
    ];
    const result = runScenario<boolean[]>({
      binaries: ["herdr"],
      env: {
        ...herdrIdentity,
        FAKE_HERDR_READ_SEQUENCE: JSON.stringify(sequence),
      },
      code: `
        const classified = [];
        for (let index = 0; index < 3; index++) {
          try { mux.readScreen("w7:missing", 5); }
          catch (error) { classified.push(mux.isMissingSurfaceError(error)); }
        }
        return classified;
      `,
    });

    assert.deepEqual(result.value, [true, false, false]);
  });

  it("confirms two structured Herdr missing reads before reporting disappearance", () => {
    const missing = { status: 1, stderr: JSON.stringify({ error: { code: "pane_not_found" } }) };
    const result = runScenario<{ reason: string; exitCode: number }>({
      binaries: ["herdr"],
      env: {
        ...herdrIdentity,
        FAKE_HERDR_READ_SEQUENCE: JSON.stringify([missing, missing]),
      },
      code: `return mux.pollForExit("w7:missing", new AbortController().signal, { interval: 1 });`,
    });

    assert.deepEqual(result.value, { reason: "disappeared", exitCode: 1 });
    assert.equal(
      result.calls.filter((call) => call.args[0] === "pane" && call.args[1] === "read").length,
      2,
    );
  });

  it("keeps tmux.ts as an identity-preserving compatibility re-export", () => {
    const result = runScenario<{ sameKeys: boolean; sameFunctions: boolean }>({
      binaries: [],
      code: `
        const compat = await import(${JSON.stringify(tmuxUrl)});
        const keys = Object.keys(mux).sort();
        const compatKeys = Object.keys(compat).sort();
        return {
          sameKeys: JSON.stringify(keys) === JSON.stringify(compatKeys),
          sameFunctions: keys
            .filter((key) => typeof mux[key] === "function")
            .every((key) => mux[key] === compat[key]),
        };
      `,
    });

    assert.deepEqual(result.value, { sameKeys: true, sameFunctions: true });
    assert.deepEqual(result.calls, []);
  });
});
