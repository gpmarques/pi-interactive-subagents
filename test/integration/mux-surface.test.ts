/**
 * Integration tests for the backend-neutral mux surface layer.
 *
 * These tests exercise real mux operations: creating surfaces,
 * sending commands, reading screen output, and closing surfaces.
 * No LLM calls — fast and free.
 *
 * Run inside the selected multiplexer:
 *   PI_SUBAGENT_MUX=herdr npm run test:integration:surface
 *   PI_SUBAGENT_MUX=tmux npm run test:integration:surface
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  createTrackedSurfaceSplit,
  focusSurface,
  getFocusedSurface,
  waitForFocusedSurface,
  untrackSurface,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  shellEscape,
  sleep,
  uniqueId,
  trackTempFile,
  waitForFile,
  waitForScreen,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();
const FOCUS_TEST_SHELL_READY_DELAY_MS = Number(process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS ?? "2500");

if (backends.length === 0) {
  console.log("⚠️  No selected mux backend is available — skipping mux-surface integration tests");
  console.log('   Run inside Herdr or tmux and set PI_SUBAGENT_MUX to "herdr" or "tmux".');
}

for (const backend of backends) {
  describe(`mux-surface [${backend}]`, { timeout: 60_000 }, () => {
    let env: TestEnv;

    beforeEach(() => {
      env = createTestEnv();
    });

    afterEach(() => {
      cleanupTestEnv(env);
    });

    it("keeps focus on the active surface while creating and targeting child surfaces", async () => {
      const originalFocus = getFocusedSurface(backend);
      assert.ok(originalFocus, `Expected one focused ${backend} surface before the test`);

      let expectedFocus = originalFocus;
      try {
        if (backend === "tmux") {
          expectedFocus = createTrackedSurfaceSplit(env, "focus-anchor", "right");
          await sleep(1000);
          focusSurface(backend, expectedFocus);
          await waitForFocusedSurface(backend, expectedFocus, 10_000);
        }

        const childA = createTrackedSurface(env, "focus-child-a");
        await sleep(FOCUS_TEST_SHELL_READY_DELAY_MS);
        assert.equal(getFocusedSurface(backend), expectedFocus);

        const childB = createTrackedSurface(env, "focus-child-b");
        await sleep(FOCUS_TEST_SHELL_READY_DELAY_MS);
        assert.equal(getFocusedSurface(backend), expectedFocus);

        const markerA = uniqueId();
        const markerB = uniqueId();
        sendCommand(childA, `echo "FOCUS_A_${markerA}"`);
        sendCommand(childB, `echo "FOCUS_B_${markerB}"`);

        await Promise.all([
          waitForScreen(childA, new RegExp(`FOCUS_A_${markerA}`), 20_000, 50),
          waitForScreen(childB, new RegExp(`FOCUS_B_${markerB}`), 20_000, 50),
        ]);
        assert.equal(getFocusedSurface(backend), expectedFocus);
      } finally {
        if (backend === "tmux") {
          focusSurface(backend, originalFocus);
          await waitForFocusedSurface(backend, originalFocus, 10_000);
        }
      }
    });

    it("creates a surface, sends a command, reads output, and closes it", async () => {
      const surface = createTrackedSurface(env, "echo-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "MARKER_${marker}"`);
      await waitForScreen(surface, new RegExp(`MARKER_${marker}`), 20_000, 50);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`MARKER_${marker}`),
        `Expected screen to contain MARKER_${marker}. Got:\n${screen}`,
      );

      closeSurface(surface);
      closeSurface(surface);
      untrackSurface(env, surface);
    });

    it("preserves shell special characters in command output", async () => {
      const surface = createTrackedSurface(env, "escape-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo 'SPEC_${marker}_$HOME_"quotes"_done'`);
      await waitForScreen(surface, new RegExp(`SPEC_${marker}`), 20_000, 50);

      const screen = readScreen(surface, 50);
      assert.ok(screen.includes(`SPEC_${marker}`), `Expected special-char output. Got:\n${screen}`);
      assert.ok(screen.includes("$HOME"), `Expected literal $HOME in output. Got:\n${screen}`);
    });

    it("sends a long command via script file without truncation", async () => {
      const surface = createTrackedSurface(env, "long-cmd-test");
      await sleep(1000);

      const marker = uniqueId();
      const longValue = "X".repeat(500);
      const command = `echo "LONG_${marker}_${longValue}_END"`;
      const scriptPath = `${env.dir}/mux-surface-long-command.sh`;

      sendLongCommand(surface, command, { scriptPath });
      await waitForScreen(surface, new RegExp(`LONG_${marker}`), 20_000, 100);

      const screen = readScreen(surface, 100);
      assert.ok(
        screen.includes(`LONG_${marker}`),
        `Expected long command output. Got:\n${screen.slice(0, 300)}...`,
      );
      assert.ok(
        screen.includes("_END"),
        `Expected full output (not truncated). Got:\n${screen.slice(-300)}`,
      );
    });

    it("reads screen asynchronously", async () => {
      const surface = createTrackedSurface(env, "async-read-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "ASYNC_${marker}"`);
      await waitForScreen(surface, new RegExp(`ASYNC_${marker}`), 20_000, 50);

      const screen = await readScreenAsync(surface, 50);
      assert.ok(
        screen.includes(`ASYNC_${marker}`),
        `Async read should find marker. Got:\n${screen}`,
      );
    });

    it("manages multiple surfaces concurrently", async () => {
      const s1 = createTrackedSurface(env, "multi-1");
      const s2 = createTrackedSurface(env, "multi-2");
      await sleep(1500);

      const m1 = uniqueId();
      const m2 = uniqueId();
      sendCommand(s1, `echo "S1_${m1}"`);
      sendCommand(s2, `echo "S2_${m2}"`);

      await Promise.all([
        waitForScreen(s1, new RegExp(`S1_${m1}`), 20_000, 50),
        waitForScreen(s2, new RegExp(`S2_${m2}`), 20_000, 50),
      ]);
      const screen1 = readScreen(s1, 50);
      const screen2 = readScreen(s2, 50);

      assert.ok(screen1.includes(`S1_${m1}`), `Surface 1 missing marker. Got:\n${screen1}`);
      assert.ok(screen2.includes(`S2_${m2}`), `Surface 2 missing marker. Got:\n${screen2}`);
    });

    it("writes output to a file and verifies it via the surface", async () => {
      const surface = createTrackedSurface(env, "file-test");
      await sleep(1000);

      const marker = uniqueId();
      const filePath = `/tmp/pi-mux-surface-${marker}.txt`;
      trackTempFile(env, filePath);

      sendCommand(
        surface,
        `echo "FILE_${marker}" > ${shellEscape(filePath)} && echo "WRITTEN_${marker}"`,
      );

      await waitForScreen(surface, new RegExp(`WRITTEN_${marker}`), 20_000, 50);
      const content = await waitForFile(filePath, 10_000, new RegExp(`FILE_${marker}`));
      assert.ok(content.includes(`FILE_${marker}`), `File content wrong. Got: ${content}`);
    });

    if (backend === "herdr") {
      it("creates a targeted right split without stealing focus and cleans it up", async () => {
        const originalFocus = getFocusedSurface(backend);
        assert.ok(originalFocus, "Expected one focused Herdr pane before the split test");

        const target = createTrackedSurface(env, "split-target");
        await sleep(1000);
        assert.equal(getFocusedSurface(backend), originalFocus);

        const split = createTrackedSurfaceSplit(env, "split-right", "right", target);
        await sleep(1000);
        assert.equal(getFocusedSurface(backend), originalFocus);

        const marker = uniqueId();
        sendCommand(split, `echo "SPLIT_${marker}"`);
        await waitForScreen(split, new RegExp(`SPLIT_${marker}`), 20_000, 50);
        const screen = readScreen(split, 50);
        assert.ok(screen.includes(`SPLIT_${marker}`), `Split missing marker. Got:\n${screen}`);
        assert.equal(getFocusedSurface(backend), originalFocus);

        closeSurface(split);
        untrackSurface(env, split);
        closeSurface(target);
        untrackSurface(env, target);
        assert.equal(getFocusedSurface(backend), originalFocus);
      });
    }
  });
}
