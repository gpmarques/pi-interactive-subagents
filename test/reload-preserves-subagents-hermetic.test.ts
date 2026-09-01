import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const PI = "/opt/homebrew/bin/pi";
const SUBAGENTS_ENTRYPOINT = fileURLToPath(
  new URL("../pi-extension/subagents/index.ts", import.meta.url),
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(10);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for reload repro state`);
}

function readJsonLines(path: string): Array<Record<string, any>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, any>];
      } catch {
        return [];
      }
    });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 1_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function writeFakeTmux(path: string): void {
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
state="$PI_RELOAD_REPRO_FAKE_STATE"
mkdir -p "$state"
printf '%s\\n' "$*" >> "$state/calls.log"
surface=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "-t" ]; then surface="$argument"; fi
  previous="$argument"
done
case "$1" in
  split-window)
    count=0
    if [ -f "$state/count" ]; then count=$(cat "$state/count"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$state/count"
    /bin/sleep 30 >/dev/null 2>&1 &
    printf '%s' "$!" > "$state/pid-$count"
    : > "$state/alive-$count"
    printf '%%reload-child-%s\\n' "$count"
    ;;
  capture-pane)
    number=\${surface##*-}
    if [ -f "$state/block-$number" ]; then
      : > "$state/entered-$number"
      while [ ! -f "$state/release-$number" ]; do /bin/sleep 0.01; done
    fi
    if [ ! -f "$state/alive-$number" ]; then
      printf "can't find pane: %s\\n" "$surface" >&2
      exit 1
    fi
    pid=$(cat "$state/pid-$number")
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$state/alive-$number"
      printf "can't find pane: %s\\n" "$surface" >&2
      exit 1
    fi
    if [ -f "$state/done-$number" ]; then
      printf '__SUBAGENT_DONE_0__\\n'
    else
      printf 'running %s\\n' "$surface"
    fi
    ;;
  send-keys)
    number=\${surface##*-}
    if [ ! -f "$state/alive-$number" ]; then
      printf "can't find pane: %s\\n" "$surface" >&2
      exit 1
    fi
    ;;
  kill-pane)
    number=\${surface##*-}
    if [ ! -f "$state/alive-$number" ]; then
      printf "can't find pane: %s\\n" "$surface" >&2
      exit 1
    fi
    pid=$(cat "$state/pid-$number")
    kill "$pid" 2>/dev/null || true
    rm -f "$state/alive-$number"
    printf '%s\\n' "$surface" >> "$state/killed.log"
    ;;
  select-layout) ;;
  *) ;;
esac
`,
  );
  chmodSync(path, 0o755);
}

function writeReloadHarness(path: string): void {
  writeFileSync(
    path,
    `import { appendFileSync } from "node:fs";
import subagentsExtension, { __test__ } from ${JSON.stringify(SUBAGENTS_ENTRYPOINT)};

const logPath = process.env.PI_RELOAD_REPRO_LOG!;
const generationsKey = Symbol.for("pi-subagents/reload-repro-generations");
const rejectionKey = Symbol.for("pi-subagents/reload-repro-rejection-listener");
const record = (value: Record<string, unknown>) => {
  appendFileSync(logPath, JSON.stringify({ at: Date.now(), ...value }) + "\\n");
};

if (!(globalThis as any)[rejectionKey]) {
  const listener = (reason: unknown) => {
    record({
      type: "unhandled-rejection",
      error: reason instanceof Error ? reason.message : String(reason),
    });
  };
  process.on("unhandledRejection", listener);
  (globalThis as any)[rejectionKey] = listener;
}

export default function reloadRepro(pi: any) {
  const generation = ((globalThis as any)[generationsKey] ?? 0) + 1;
  (globalThis as any)[generationsKey] = generation;
  const tools = new Map<string, any>();
  const bridge = new Proxy(pi, {
    get(target, property) {
      if (property === "registerTool") {
        return (tool: any) => {
          tools.set(tool.name, tool);
          return target.registerTool(tool);
        };
      }
      if (property === "sendMessage") {
        return (message: any, options: any) => {
          record({
            type: "send-attempt",
            generation,
            customType: message?.customType,
            name: message?.details?.name,
            error: message?.details?.error,
          });
          target.sendMessage(message, options);
          record({
            type: "send-success",
            generation,
            customType: message?.customType,
            name: message?.details?.name,
            error: message?.details?.error,
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  subagentsExtension(bridge);

  pi.on("session_start", (event: any) => {
    record({
      type: "session-start",
      generation,
      reason: event.reason,
      runningNames: Array.from(__test__.runningSubagents.values(), (running: any) => running.name),
    });
  });

  pi.on("session_shutdown", (event: any) => {
    record({
      type: "session-shutdown-after-subagents",
      generation,
      reason: event.reason,
      runningNames: Array.from(__test__.runningSubagents.values(), (running: any) => running.name),
    });
  });

  pi.registerCommand("reload-repro-start", {
    description: "Start bounded fake subagents for the reload regression test",
    handler: async (_args: string, ctx: any) => {
      const spawnTool = tools.get("subagent");
      const starts = [];
      for (const name of [
        "reload-result",
        "reload-kill",
        "reload-race-kill",
        "reload-race-result",
      ]) {
        starts.push(await spawnTool.execute(
          "reload-repro-" + name,
          { agent: "reload-fixture", name, task: "Stay alive across reload: " + name },
          undefined,
          undefined,
          ctx,
        ));
      }
      for (const running of __test__.runningSubagents.values() as Iterable<any>) {
        if (!running.name.startsWith("reload-race-")) continue;
        const originalAbort = running.abortController.abort.bind(running.abortController);
        let raced = false;
        running.abortController.abort = () => {
          originalAbort();
          record({ type: "watcher-abort", generation, name: running.name });
          if (running.name === "reload-race-kill" && !raced) {
            raced = true;
            const killed = __test__.handleSubagentKill({ name: running.name });
            record({
              type: "reload-race-kill",
              generation,
              details: killed.details,
              runningNames: Array.from(
                __test__.runningSubagents.values(),
                (candidate: any) => candidate.name,
              ),
            });
          }
        };
      }
      record({
        type: "started",
        generation,
        starts: starts.map((result: any) => result.details),
        running: Array.from(__test__.runningSubagents.values(), (running: any) => ({
          id: running.id,
          name: running.name,
          surface: running.surface,
          sessionFile: running.sessionFile,
          registryArtifactDir: running.registryArtifactDir,
        })),
      });
    },
  });

  pi.registerCommand("reload-repro-now", {
    description: "Invoke the real Pi extension reload flow",
    handler: async (_args: string, ctx: any) => {
      record({ type: "reload-requested", generation });
      await ctx.reload();
      record({ type: "old-reload-handler-returned", generation });
      return;
    },
  });

  pi.registerCommand("reload-repro-probe", {
    description: "Probe ownership and controls from the post-reload extension instance",
    handler: async (_args: string, ctx: any) => {
      const steer = __test__.handleSubagentSteer({
        name: "reload-result",
        message: "finish now",
      });
      const kill = await tools.get("subagent_kill").execute(
        "reload-repro-kill",
        { name: "reload-kill" },
        undefined,
        undefined,
        ctx,
      );
      record({
        type: "probe",
        generation,
        runningNames: Array.from(__test__.runningSubagents.values(), (running: any) => running.name),
        steerDetails: steer.details,
        killDetails: kill.details,
      });
    },
  });
}
`,
  );
}

function sendRpc(
  child: ChildProcessWithoutNullStreams,
  pending: Map<string, (event: Record<string, any>) => void>,
  id: string,
  message: string,
): Promise<Record<string, any>> {
  const response = new Promise<Record<string, any>>((resolve) => pending.set(id, resolve));
  child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
  return response;
}

test("reload preserves running subagents and rebinds their controls and delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-reload-hermetic-"));
  const binDir = join(root, "bin");
  const fakeState = join(root, "fake-tmux");
  const agentDir = join(root, "agent");
  const sessionsDir = join(root, "sessions");
  const logPath = join(root, "repro.jsonl");
  const harnessPath = join(root, "reload-harness.ts");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(fakeState, { recursive: true });
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  writeFakeTmux(join(binDir, "tmux"));
  writeReloadHarness(harnessPath);
  writeFileSync(
    join(agentDir, "agents", "reload-fixture.md"),
    [
      "---",
      "name: reload-fixture",
      "description: Hermetic reload fixture",
      "tools: read",
      "auto-exit: true",
      "session-mode: standalone",
      "---",
      "Do not perform provider work. The fake surface owns this bounded fixture.",
      "",
    ].join("\n"),
  );

  const child = spawn(
    PI,
    [
      "--mode", "rpc",
      "--no-extensions",
      "--no-builtin-tools",
      "--session-dir", sessionsDir,
      "--session-id", "reload-parent",
      "-e", harnessPath,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: join(root, "home"),
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        TMUX: `${join(root, "tmux.sock")},1,0`,
        PI_SUBAGENT_MUX: "tmux",
        PI_SUBAGENT_SHELL_READY_DELAY_MS: "0",
        PI_CODING_AGENT_DIR: agentDir,
        PI_RELOAD_REPRO_FAKE_STATE: fakeState,
        PI_RELOAD_REPRO_LOG: logPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdoutBuffer = "";
  const pending = new Map<string, (event: Record<string, any>) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line) as Record<string, any>;
      if (event.type === "response" && typeof event.id === "string") {
        pending.get(event.id)?.(event);
        pending.delete(event.id);
      }
    }
  });
  child.stderr.resume();

  try {
    await waitFor(() => readJsonLines(logPath).find(
      (event) => event.type === "session-start" && event.generation === 1,
    ));

    // Keep two watcher reads pending so shutdown must await their continuations.
    writeFileSync(join(fakeState, "block-3"), "block\n");
    writeFileSync(join(fakeState, "block-4"), "block\n");
    const startResponse = await sendRpc(child, pending, "start", "/reload-repro-start");
    assert.equal(startResponse.success, true, startResponse.error);
    const started = await waitFor(() => readJsonLines(logPath).find(
      (event) => event.type === "started",
    ));
    assert.equal(started.running.length, 4, "the precondition must contain four running children");
    await waitFor(() => existsSync(join(fakeState, "entered-3")) || undefined);
    await waitFor(() => existsSync(join(fakeState, "entered-4")) || undefined);

    const pids = [1, 2, 3, 4].map(
      (number) => Number(readFileSync(join(fakeState, `pid-${number}`), "utf8")),
    );
    assert.deepEqual(
      pids.map(processAlive),
      [true, true, true, true],
      "bounded fake child processes must start",
    );

    const reloadPromise = sendRpc(child, pending, "reload", "/reload-repro-now");
    await waitFor(() => {
      const aborted = readJsonLines(logPath).filter(
        (event) => event.type === "watcher-abort" && event.generation === 1,
      );
      return new Set(aborted.map((event) => event.name)).size === 2 ? aborted : undefined;
    }, 5_000);
    // Completion becomes visible only after reload quiescence has begun. The old
    // blocked watcher must not deliver it through stale context; the fresh one must.
    writeFileSync(join(fakeState, "done-4"), "done\n");
    writeFileSync(join(fakeState, "release-3"), "release\n");
    writeFileSync(join(fakeState, "release-4"), "release\n");

    const reloadResponse = await reloadPromise;
    assert.equal(reloadResponse.success, true, reloadResponse.error);
    const reloaded = await waitFor(() => readJsonLines(logPath).find(
      (event) => event.type === "session-start" && event.generation === 2,
    ));

    // Give abort handlers and watcher continuations a deterministic window to run,
    // then capture the user-visible survival state before exercising controls.
    await sleep(300);
    const survivedReload = pids.map(processAlive);

    const probeResponse = await sendRpc(child, pending, "probe", "/reload-repro-probe");
    assert.equal(probeResponse.success, true, probeResponse.error);
    const probe = await waitFor(() => readJsonLines(logPath).find(
      (event) => event.type === "probe" && event.generation === 2,
    ));

    // The result child should finish through the preserved watcher; the other child
    // should already have been killed through the post-reload tool instance.
    writeFileSync(join(fakeState, "done-1"), "done\n");
    await sleep(1_600);

    const events = readJsonLines(logPath);
    const registry = JSON.parse(
      readFileSync(join(started.running[0].registryArtifactDir, "subagent-registry.json"), "utf8"),
    ) as Record<string, { runState?: string }>;
    const sendsFor = (type: string, name: string) => events.filter(
      (event) => event.type === type && event.customType === "subagent_result" && event.name === name,
    ).length;
    const staleErrors = events.filter(
      (event) => event.type === "unhandled-rejection" && /extension ctx is stale/i.test(event.error),
    );

    const observed = {
      survivedReload,
      postReloadRunningNames: [...reloaded.runningNames].sort(),
      probeRunningNames: [...probe.runningNames].sort(),
      steerSucceeded: probe.steerDetails?.status === "steered",
      killSucceeded: probe.killDetails?.status === "killed",
      resultAttempts: sendsFor("send-attempt", "reload-result"),
      resultDeliveries: sendsFor("send-success", "reload-result"),
      resultDeliveryErrors: events.filter(
        (event) => event.type === "send-success" &&
          event.customType === "subagent_result" &&
          event.name === "reload-result" &&
          event.error,
      ).map((event) => event.error),
      killedChildDeliveryAttempts: sendsFor("send-attempt", "reload-kill"),
      racedKillSucceeded: events.some(
        (event) => event.type === "reload-race-kill" && event.details?.status === "killed",
      ),
      racedKillDeliveryAttempts: sendsFor("send-attempt", "reload-race-kill"),
      racedResultAttempts: sendsFor("send-attempt", "reload-race-result"),
      racedResultDeliveries: sendsFor("send-success", "reload-race-result"),
      racedResultGenerations: events.filter(
        (event) => event.type === "send-success" &&
          event.customType === "subagent_result" &&
          event.name === "reload-race-result",
      ).map((event) => event.generation),
      staleContextErrors: staleErrors.length,
      resultRegistryState: registry["reload-result"]?.runState ?? null,
      racedResultRegistryState: registry["reload-race-result"]?.runState ?? null,
      killedRegistryPresent: Object.hasOwn(registry, "reload-kill"),
      racedKillRegistryPresent: Object.hasOwn(registry, "reload-race-kill"),
    };

    assert.deepEqual(observed, {
      survivedReload: [true, true, false, false],
      postReloadRunningNames: ["reload-kill", "reload-race-result", "reload-result"],
      probeRunningNames: ["reload-result"],
      steerSucceeded: true,
      killSucceeded: true,
      resultAttempts: 1,
      resultDeliveries: 1,
      resultDeliveryErrors: [],
      killedChildDeliveryAttempts: 0,
      racedKillSucceeded: true,
      racedKillDeliveryAttempts: 0,
      racedResultAttempts: 1,
      racedResultDeliveries: 1,
      racedResultGenerations: [2],
      staleContextErrors: 0,
      resultRegistryState: "completed",
      racedResultRegistryState: "completed",
      killedRegistryPresent: false,
      racedKillRegistryPresent: false,
    });
  } finally {
    // Unblock any in-flight fake capture processes before stopping Pi so a
    // failed assertion cannot orphan their bounded shell loops.
    for (const name of existsSync(fakeState) ? readdirSync(fakeState) : []) {
      if (name.startsWith("block-")) {
        writeFileSync(join(fakeState, name.replace("block-", "release-")), "release\n");
      }
    }
    await stopProcess(child);
    for (const name of existsSync(fakeState) ? readdirSync(fakeState) : []) {
      if (!name.startsWith("pid-")) continue;
      const pid = Number(readFileSync(join(fakeState, name), "utf8"));
      if (Number.isFinite(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 15_000 });
