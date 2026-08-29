/**
 * Broad provider-backed integration coverage for the current public lifecycle contract.
 *
 * These tests run real outer Pi sessions and fixed-profile subagents (Sol by default).
 * Each test owns an isolated environment and verifies durable files/session evidence;
 * screen output is used only for the live status widget assertion.
 *
 * Run inside Herdr or tmux with PI_SUBAGENT_MUX selecting that backend:
 *   npm run test:integration:lifecycle
 *
 * Configuration:
 *   PI_TEST_MODEL     — outer-session model (default: openai-codex/gpt-5.6-sol)
 *   PI_TEST_TIMEOUT   — bounded provider wait in ms (default: 120000)
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { SNAPSHOT_STALLED_AFTER_MS } from "../../pi-extension/subagents/status.ts";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  cleanupOwnedChildSessionFiles,
  collectOwnedChildSessionFiles,
  createTrackedSurface,
  getHerdrWorkspaceSnapshot,
  shellEscape,
  sleep,
  startPi,
  trackOwnedOuterSessionFile,
  uniqueId,
  waitForFile,
  waitForHerdrWorkspaceRestored,
  waitForScreen,
  readScreen,
  PI_TIMEOUT,
  type HerdrWorkspaceSnapshot,
  type TestEnv,
} from "./harness.ts";

const FIXED_AGENT = "test-echo";
const FORK_AGENT = "test-fork";
const QUESTION_AGENT = "test-question";
const SOL_PROVIDER = "openai-codex";
const SOL_MODEL = "gpt-5.6-sol";
const WORKSPACE_RESTORE_TIMEOUT = 20_000;
const WATCHDOG_ASSERTION_DELAY = SNAPSHOT_STALLED_AFTER_MS + 5_000;
const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  No selected mux backend is available — skipping subagent lifecycle integration tests");
  console.log('   Run inside Herdr or tmux and set PI_SUBAGENT_MUX to "herdr" or "tmux".');
}

type MessageContent = {
  type?: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

type SessionMessage = {
  role?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  toolName?: string;
  content?: MessageContent[];
  details?: Record<string, unknown>;
};

type SessionEntry = {
  type?: string;
  customType?: string;
  content?: string;
  details?: Record<string, unknown>;
  message?: SessionMessage;
  parentSession?: string;
};

function readSessionEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as SessionEntry);
}

function sessionMessages(entries: SessionEntry[]): SessionMessage[] {
  return entries.flatMap((entry) => entry.message ? [entry.message] : []);
}

function assistantMessages(entries: SessionEntry[]): SessionMessage[] {
  return sessionMessages(entries).filter((message) => message.role === "assistant");
}

function assistantText(message: SessionMessage): string {
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function toolResults(entries: SessionEntry[], toolName: string): SessionMessage[] {
  return sessionMessages(entries).filter(
    (message) => message.role === "toolResult" && message.toolName === toolName,
  );
}

function toolCalls(
  entries: SessionEntry[],
  toolName: string,
): Array<MessageContent & { name: string; arguments: Record<string, unknown> }> {
  return assistantMessages(entries).flatMap((message) =>
    (message.content ?? []).flatMap((part) =>
      part.type === "toolCall" && part.name === toolName
        ? [{ ...part, name: toolName, arguments: part.arguments ?? {} }]
        : []
    )
  );
}

function customEntries(entries: SessionEntry[], customType: string): SessionEntry[] {
  return entries.filter((entry) => entry.type === "custom_message" && entry.customType === customType);
}

async function waitForSession(
  sessionFile: string,
  predicate: (entries: SessionEntry[]) => boolean,
  label: string,
  timeout: number = PI_TIMEOUT,
): Promise<SessionEntry[]> {
  const start = Date.now();
  let latest: SessionEntry[] = [];
  let latestError: unknown;

  while (Date.now() - start < timeout) {
    if (existsSync(sessionFile)) {
      try {
        latest = readSessionEntries(sessionFile);
        latestError = undefined;
        if (predicate(latest)) return latest;
      } catch (error) {
        latestError = error;
      }
    }
    await sleep(500);
  }

  const errorText = latestError instanceof Error ? ` Last read error: ${latestError.message}` : "";
  throw new Error(
    `Timeout (${timeout}ms) waiting for ${label} in ${sessionFile}. ` +
      `Latest entry types: ${latest.map((entry) => entry.customType ?? entry.type ?? "unknown").join(", ")}.${errorText}`,
  );
}

function startedSubagentResults(entries: SessionEntry[]): SessionMessage[] {
  return toolResults(entries, "subagent").filter(
    (message) => message.details?.status === "started",
  );
}

function childSessionFile(result: SessionMessage): string {
  const sessionFile = result.details?.sessionFile;
  assert.equal(typeof sessionFile, "string", "public subagent result details must include sessionFile");
  assert.ok(sessionFile.length > 0, "public child sessionFile must not be empty");
  return sessionFile;
}

function successfulChildResults(
  entries: SessionEntry[],
  name: string,
  childMarker: string,
): SessionEntry[] {
  return customEntries(entries, "subagent_result").filter(
    (entry) =>
      entry.details?.name === name &&
      entry.details?.exitCode === 0 &&
      typeof entry.content === "string" &&
      entry.content.includes(childMarker),
  );
}

function assertOuterCompletedAfterResult(
  entries: SessionEntry[],
  childName: string,
  childMarker: string,
  outerMarker: string,
): void {
  const resultIndex = entries.findIndex(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "subagent_result" &&
      entry.details?.name === childName &&
      entry.details?.exitCode === 0 &&
      typeof entry.content === "string" &&
      entry.content.includes(childMarker),
  );
  const finalIndex = entries.findIndex(
    (entry, index) =>
      index > resultIndex &&
      entry.message?.role === "assistant" &&
      assistantText(entry.message).trim() === outerMarker,
  );
  assert.ok(resultIndex >= 0, `outer session must persist the successful ${childName} result`);
  assert.ok(finalIndex > resultIndex, `outer ${outerMarker} response must follow the actual child result`);
}

function assertProviderEvidence(label: string, sessionFiles: string[]): void {
  const assistants = sessionFiles.flatMap((sessionFile) =>
    assistantMessages(readSessionEntries(sessionFile))
  );
  assert.ok(assistants.length > 0, `${label} must persist model responses`);

  const providerErrors = assistants.filter(
    (message) => message.stopReason === "error" || typeof message.errorMessage === "string",
  );
  assert.equal(providerErrors.length, 0, `${label} must have no persisted provider errors`);

  const counts = new Map<string, number>();
  for (const message of assistants) {
    assert.ok(message.provider, `${label} assistant response must identify its provider`);
    assert.ok(message.model, `${label} assistant response must identify its model`);
    const key = `${message.provider}/${message.model}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([model, count]) => `${model}=${count}`).join(", ");
  console.log(`# provider ${label}: ${assistants.length} persisted responses (${summary}), 0 errors`);
}

function assertFixedChildUsesSol(sessionFile: string, childMarker: string): void {
  const assistants = assistantMessages(readSessionEntries(sessionFile));
  assert.ok(
    assistants.some(
      (message) => message.provider === SOL_PROVIDER && message.model === SOL_MODEL,
    ),
    `fixed-profile child ${sessionFile} must persist a ${SOL_PROVIDER}/${SOL_MODEL} response`,
  );
  assert.equal(
    assistantText(assistants.at(-1) ?? {}).trim(),
    childMarker,
    `fixed-profile child ${sessionFile} must end with the requested exact value`,
  );
}

for (const backend of backends) {
  describe(
    `subagent-lifecycle [${backend}]`,
    { timeout: PI_TIMEOUT * 6 + WORKSPACE_RESTORE_TIMEOUT + 10_000 },
    () => {
      let env: TestEnv | undefined;
      let workspaceBefore: HerdrWorkspaceSnapshot | undefined;

      beforeEach(() => {
        if (backend === "herdr" && process.env.PI_SUBAGENT_MUX === "herdr") {
          const workspaceId = process.env.HERDR_WORKSPACE_ID;
          assert.ok(workspaceId, "forced Herdr lifecycle tests require HERDR_WORKSPACE_ID");
          // Capture exact focus and pane identity before this test owns any surface.
          workspaceBefore = getHerdrWorkspaceSnapshot(workspaceId);
        }
        env = createTestEnv();
      });

      afterEach(async () => {
        const cleanupErrors: unknown[] = [];
        let ownedChildSessions: string[] = [];
        if (env) {
          try {
            const collection = collectOwnedChildSessionFiles(env.ownedOuterSessionFiles);
            ownedChildSessions = collection.sessionFiles;
            cleanupErrors.push(...collection.errors);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }

        if (env) {
          try {
            // Close only TestEnv-owned outer surfaces. Workspace restoration below
            // reports any live child surfaces without touching unknown panes.
            cleanupTestEnv(env);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }

        if (workspaceBefore) {
          try {
            await waitForHerdrWorkspaceRestored(
              workspaceBefore,
              WORKSPACE_RESTORE_TIMEOUT,
            );
            console.log(
              `# restored Herdr workspace ${workspaceBefore.workspaceId}: ` +
                `focus=${workspaceBefore.focusedPaneId}, ` +
                `panes=[${workspaceBefore.paneIds.join(", ")}], ` +
                `tabs=[${workspaceBefore.tabIds.join(", ")}]`,
            );
          } catch (error) {
            // The helper reports leaked IDs and intentionally never closes unknown panes.
            cleanupErrors.push(error);
          }
        }

        try {
          cleanupOwnedChildSessionFiles(ownedChildSessions);
        } catch (error) {
          cleanupErrors.push(error);
        }

        env = undefined;
        workspaceBefore = undefined;
        if (cleanupErrors.length > 0) {
          throw new AggregateError(cleanupErrors, "Lifecycle cleanup/restoration failed");
        }
      });

      it("spawns a fixed profile, completes, and delivers the public result", async () => {
        assert.ok(env);
        const id = uniqueId();
        const childName = `Echo-${id}`;
        const fileMarker = `PASS_${id}`;
        const childMarker = `ECHO_CHILD_${id}`;
        const outerMarker = `ECHO_OUTER_${id}`;
        const markerFile = join(env.dir, `echo-${id}.txt`);
        const outerSessionFile = join(env.dir, `outer-echo-${id}.jsonl`);
        trackOwnedOuterSessionFile(env, outerSessionFile);

        const surface = createTrackedSurface(env, `echo-${id}`);
        await sleep(1_000);
        const task = [
          "Execute this protocol sequentially.",
          "Call public subagent exactly once with:",
          `  name: "${childName}"`,
          `  agent: "${FIXED_AGENT}"`,
          `  task: "Use bash to run: printf '%s\\n' '${fileMarker}' > '${markerFile}'. Then return exactly ${childMarker}."`,
          "After the started acknowledgement, end the turn and wait for the automatic result.",
          `Only after the actual successful child result contains ${childMarker}, return exactly ${outerMarker}.`,
        ].join("\n");

        startPi(surface, env.dir, task, {
          extraArgs: `--session ${shellEscape(outerSessionFile)}`,
        });

        const content = await waitForFile(markerFile, PI_TIMEOUT, new RegExp(`^${fileMarker}\\s*$`));
        assert.equal(content.trim(), fileMarker);
        const entries = await waitForSession(
          outerSessionFile,
          (current) =>
            successfulChildResults(current, childName, childMarker).length === 1 &&
            assistantMessages(current).some((message) => assistantText(message).includes(outerMarker)),
          "basic child result and outer completion",
        );

        const started = startedSubagentResults(entries);
        assert.equal(started.length, 1, "outer must call public subagent exactly once");
        assert.equal(started[0].details?.agent, FIXED_AGENT);
        const childSession = childSessionFile(started[0]);
        assert.ok(existsSync(childSession), `child session must exist: ${childSession}`);
        assertOuterCompletedAfterResult(entries, childName, childMarker, outerMarker);
        assertFixedChildUsesSol(childSession, childMarker);
        assertProviderEvidence("basic completion", [outerSessionFile, childSession]);
      });

      it("keeps a 90s active bash call healthy beyond the real watchdog threshold", async () => {
        assert.ok(env);
        const id = uniqueId();
        const childName = `Status-${id}`;
        const startMarker = `START_${id}`;
        const fileMarker = `STATUS_${id}`;
        const childMarker = `STATUS_CHILD_${id}`;
        const outerMarker = `STATUS_OUTER_${id}`;
        const startFile = join(env.dir, `status-start-${id}.txt`);
        const markerFile = join(env.dir, `status-${id}.txt`);
        const outerSessionFile = join(env.dir, `outer-status-${id}.jsonl`);
        trackOwnedOuterSessionFile(env, outerSessionFile);

        const surface = createTrackedSurface(env, `status-${id}`);
        await sleep(1_000);
        const task = [
          "Call public subagent exactly once with:",
          `  name: "${childName}"`,
          `  agent: "${FIXED_AGENT}"`,
          `  task: "Use bash exactly once to run: printf '%s\\n' '${startMarker}' > '${startFile}'; sleep 90; printf '%s\\n' '${fileMarker}' > '${markerFile}'. Then return exactly ${childMarker}."`,
          "After the started acknowledgement, end the turn and wait for the automatic result.",
          `Only after the actual successful child result contains ${childMarker}, return exactly ${outerMarker}.`,
        ].join("\n");

        startPi(surface, env.dir, task, {
          extraArgs: `--session ${shellEscape(outerSessionFile)}`,
        });

        await waitForFile(startFile, PI_TIMEOUT, new RegExp(`^${startMarker}\\s*$`));
        const thresholdStart = Date.now();
        const activeLine = new RegExp(`${childName}[^\\n]*active[^\\n]*bash`, "i");
        const activeScreen = await waitForScreen(surface, activeLine, PI_TIMEOUT, 300);
        assert.match(activeScreen, activeLine);
        assert.equal(existsSync(markerFile), false, "completion marker must not exist during the long call");

        await sleep(WATCHDOG_ASSERTION_DELAY);
        assert.ok(
          Date.now() - thresholdStart >= SNAPSHOT_STALLED_AFTER_MS,
          "watchdog assertion must occur after the real stalled threshold",
        );
        assert.equal(existsSync(markerFile), false, "90s call must still be running at the watchdog assertion");
        const watchdogScreen = readScreen(surface, 300);
        assert.match(watchdogScreen, activeLine, "active bash must remain observable beyond the watchdog threshold");
        assert.doesNotMatch(
          watchdogScreen,
          new RegExp(`${childName}[^\\n]*stalled`, "i"),
          "a live bash tool call must not be reported stalled",
        );

        const content = await waitForFile(markerFile, PI_TIMEOUT, new RegExp(`^${fileMarker}\\s*$`));
        assert.equal(content.trim(), fileMarker);
        const entries = await waitForSession(
          outerSessionFile,
          (current) =>
            successfulChildResults(current, childName, childMarker).length === 1 &&
            assistantMessages(current).some((message) => assistantText(message).includes(outerMarker)),
          "status child result and outer completion",
        );
        const started = startedSubagentResults(entries);
        assert.equal(started.length, 1);
        const childSession = childSessionFile(started[0]);
        assertOuterCompletedAfterResult(entries, childName, childMarker, outerMarker);
        assertFixedChildUsesSol(childSession, childMarker);
        assertProviderEvidence("active status", [outerSessionFile, childSession]);
      });

      it("spawns two fixed-profile children in one parallel tool batch", async () => {
        assert.ok(env);
        const id = uniqueId();
        const childA = `ParaA-${id}`;
        const childB = `ParaB-${id}`;
        const fileMarkerA = `DONE_A_${id}`;
        const fileMarkerB = `DONE_B_${id}`;
        const childMarkerA = `PARA_CHILD_A_${id}`;
        const childMarkerB = `PARA_CHILD_B_${id}`;
        const outerMarker = `PARALLEL_OUTER_${id}`;
        const fileA = join(env.dir, `parallel-${id}-a.txt`);
        const fileB = join(env.dir, `parallel-${id}-b.txt`);
        const outerSessionFile = join(env.dir, `outer-parallel-${id}.jsonl`);
        trackOwnedOuterSessionFile(env, outerSessionFile);

        const surface = createTrackedSurface(env, `parallel-${id}`);
        await sleep(1_000);
        const task = [
          "In your first tool batch call public subagent exactly twice, with both calls in the same assistant response.",
          "First call:",
          `  name: "${childA}"`,
          `  agent: "${FIXED_AGENT}"`,
          `  task: "Use bash to run: printf '%s\\n' '${fileMarkerA}' > '${fileA}'. Then return exactly ${childMarkerA}."`,
          "Second call:",
          `  name: "${childB}"`,
          `  agent: "${FIXED_AGENT}"`,
          `  task: "Use bash to run: printf '%s\\n' '${fileMarkerB}' > '${fileB}'. Then return exactly ${childMarkerB}."`,
          "After both started acknowledgements, end the turn and wait for both automatic results.",
          `Only after both actual successful results arrive, return exactly ${outerMarker}.`,
        ].join("\n");

        startPi(surface, env.dir, task, {
          extraArgs: `--session ${shellEscape(outerSessionFile)}`,
        });

        const [contentA, contentB] = await Promise.all([
          waitForFile(fileA, PI_TIMEOUT, new RegExp(`^${fileMarkerA}\\s*$`)),
          waitForFile(fileB, PI_TIMEOUT, new RegExp(`^${fileMarkerB}\\s*$`)),
        ]);
        assert.equal(contentA.trim(), fileMarkerA);
        assert.equal(contentB.trim(), fileMarkerB);

        const entries = await waitForSession(
          outerSessionFile,
          (current) =>
            successfulChildResults(current, childA, childMarkerA).length === 1 &&
            successfulChildResults(current, childB, childMarkerB).length === 1 &&
            assistantMessages(current).some((message) => assistantText(message).includes(outerMarker)),
          "both parallel child results and outer completion",
        );
        const started = startedSubagentResults(entries);
        assert.equal(started.length, 2, "outer must start exactly two children");

        const parallelBatch = assistantMessages(entries).find((message) => {
          const names = (message.content ?? [])
            .filter((part) => part.type === "toolCall" && part.name === "subagent")
            .map((part) => part.arguments?.name);
          return names.includes(childA) && names.includes(childB);
        });
        assert.ok(parallelBatch, "both fixed-profile spawns must be emitted in one parallel tool batch");

        const childSessions = started.map((result) => {
          const sessionFile = childSessionFile(result);
          const marker = result.details?.name === childA ? childMarkerA : childMarkerB;
          assertFixedChildUsesSol(sessionFile, marker);
          return sessionFile;
        });
        const lastResultIndex = Math.max(
          entries.findIndex(
            (entry) =>
              entry.details?.name === childA &&
              entry.customType === "subagent_result" &&
              typeof entry.content === "string" &&
              entry.content.includes(childMarkerA),
          ),
          entries.findIndex(
            (entry) =>
              entry.details?.name === childB &&
              entry.customType === "subagent_result" &&
              typeof entry.content === "string" &&
              entry.content.includes(childMarkerB),
          ),
        );
        const finalIndex = entries.findIndex(
          (entry, index) =>
            index > lastResultIndex &&
            entry.message?.role === "assistant" &&
            assistantText(entry.message).includes(outerMarker),
        );
        assert.ok(finalIndex > lastResultIndex, "outer completion must follow both actual child results");
        assertProviderEvidence("parallel completion", [outerSessionFile, ...childSessions]);
      });

      it("uses a hidden fixed fork profile with parent linkage and copied context", async () => {
        assert.ok(env);
        const id = uniqueId();
        const childName = `Fork-${id}`;
        const parentContextMarker = `PARENT_CONTEXT_${id}`;
        const outerTriggerMarker = `OUTER_TRIGGER_${id}`;
        const fileMarker = `FORK_FILE_${id}`;
        const childMarker = `FORK_CHILD_${id}`;
        const outerMarker = `FORK_OUTER_${id}`;
        const markerFile = join(env.dir, `fork-${id}.txt`);
        const outerSessionFile = join(env.dir, `outer-fork-${id}.jsonl`);
        trackOwnedOuterSessionFile(env, outerSessionFile);
        const seedPrompt = `Reply with exactly ${parentContextMarker}. Do not use tools.`;

        const surface = createTrackedSurface(env, `fork-${id}`);
        await sleep(1_000);
        const task = [
          `This triggering turn is identified by ${outerTriggerMarker}.`,
          "Call public subagent exactly once with the current schema:",
          `  name: "${childName}"`,
          `  agent: "${FORK_AGENT}"`,
          `  task: "Use bash to run: printf '%s\\n' '${fileMarker}' > '${markerFile}'. Then return exactly ${childMarker}."`,
          "Do not pass a fork flag or any caller-side launch override.",
          "After the started acknowledgement, end the turn and wait for the automatic result.",
          `Only after the actual successful child result contains ${childMarker}, return exactly ${outerMarker}.`,
        ].join("\n");

        startPi(surface, env.dir, task, {
          extraArgs:
            `--session ${shellEscape(outerSessionFile)} ${shellEscape(seedPrompt)}`,
        });

        const content = await waitForFile(markerFile, PI_TIMEOUT, new RegExp(`^${fileMarker}\\s*$`));
        assert.equal(content.trim(), fileMarker);
        const outerEntries = await waitForSession(
          outerSessionFile,
          (current) =>
            successfulChildResults(current, childName, childMarker).length === 1 &&
            assistantMessages(current).some((message) => assistantText(message).includes(outerMarker)),
          "fork child result and outer completion",
        );

        const started = startedSubagentResults(outerEntries);
        assert.equal(started.length, 1);
        assert.equal(started[0].details?.agent, FORK_AGENT, "fork spawn must name the fixed profile");
        const childSession = childSessionFile(started[0]);
        const childEntries = readSessionEntries(childSession);
        const headers = childEntries.filter((entry) => entry.type === "session");
        assert.equal(headers.length, 1, "fork child must have exactly one session header");
        assert.equal(headers[0].parentSession, outerSessionFile, "fork header must link to the persisted parent");

        assert.ok(
          assistantMessages(outerEntries).some(
            (message) => assistantText(message).trim() === parentContextMarker,
          ),
          "parent must persist the completed seed response",
        );
        const serializedChild = JSON.stringify(childEntries);
        assert.equal(
          serializedChild.includes(outerTriggerMarker),
          false,
          "fork context must exclude the triggering outer user turn",
        );
        const parentContextIndex = childEntries.findIndex(
          (entry) =>
            entry.message?.role === "assistant" &&
            assistantText(entry.message).trim() === parentContextMarker,
        );
        const childTaskIndex = childEntries.findIndex(
          (entry) =>
            entry.message?.role === "user" &&
            assistantText(entry.message).includes(fileMarker),
        );
        assert.ok(
          parentContextIndex > 0 && childTaskIndex > parentContextIndex,
          "copied parent assistant context must precede the child's direct task",
        );
        assertOuterCompletedAfterResult(outerEntries, childName, childMarker, outerMarker);
        assertFixedChildUsesSol(childSession, childMarker);
        assertProviderEvidence("fixed fork", [outerSessionFile, childSession]);
      });

      it("parks on ask_question and replies by exact name with subagent_message", async () => {
        assert.ok(env);
        const id = uniqueId();
        const childName = `Question-${id}`;
        const question = `Which unique reply unlocks question ${id}?`;
        const reply = `REPLY_${id}`;
        const fileMarker = `QUESTION_REPLIED_${id}`;
        const childMarker = `QUESTION_CHILD_${id}`;
        const outerMarker = `QUESTION_OUTER_${id}`;
        const markerFile = join(env.dir, `question-${id}.txt`);
        const outerSessionFile = join(env.dir, `outer-question-${id}.jsonl`);
        trackOwnedOuterSessionFile(env, outerSessionFile);

        const surface = createTrackedSurface(env, `question-${id}`);
        await sleep(1_000);
        const childTask = [
          `QUESTION: ${question}`,
          `EXPECTED_REPLY: ${reply}`,
          `MARKER_FILE: ${markerFile}`,
          `MARKER_VALUE: ${fileMarker}`,
          `FINAL_VALUE: ${childMarker}`,
        ].join("\n");
        const task = [
          "Execute this three-phase protocol sequentially in one parent session.",
          "PHASE 1: Call public subagent exactly once with:",
          `  name: "${childName}"`,
          `  agent: "${QUESTION_AGENT}"`,
          `  task: ${JSON.stringify(childTask)}`,
          "After the started acknowledgement, end the turn. Do not call subagent again.",
          "PHASE 2: Wait for the actual subagent_question notification. Verify its exact question, then call",
          `public subagent_message exactly once with name "${childName}" and message "${reply}".`,
          "After the delivered acknowledgement, end the turn and wait for the automatic completion result.",
          `PHASE 3: Only after the actual successful result contains ${childMarker}, return exactly ${outerMarker}.`,
        ].join("\n");

        startPi(surface, env.dir, task, {
          extraArgs: `--session ${shellEscape(outerSessionFile)}`,
        });

        const questionEntries = await waitForSession(
          outerSessionFile,
          (current) =>
            customEntries(current, "subagent_question").some(
              (entry) => entry.details?.name === childName && entry.details?.question === question,
            ),
          "persisted subagent question notification",
        );
        const questions = customEntries(questionEntries, "subagent_question").filter(
          (entry) => entry.details?.name === childName,
        );
        assert.equal(questions.length, 1, "child must ask its supplied unique question exactly once");
        assert.equal(questions[0].details?.question, question);

        const content = await waitForFile(markerFile, PI_TIMEOUT, new RegExp(`^${fileMarker}\\s*$`));
        assert.equal(content.trim(), fileMarker, "child must write the marker only after the reply");
        const entries = await waitForSession(
          outerSessionFile,
          (current) =>
            successfulChildResults(current, childName, childMarker).length === 1 &&
            assistantMessages(current).some((message) => assistantText(message).includes(outerMarker)),
          "question child result and outer completion",
        );

        const spawnCalls = toolCalls(entries, "subagent");
        assert.equal(spawnCalls.length, 1, "the waiting child must never be relaunched");
        assert.equal(spawnCalls[0].arguments.agent, QUESTION_AGENT);
        assert.equal(spawnCalls[0].arguments.name, childName);

        const messageCalls = toolCalls(entries, "subagent_message");
        assert.equal(messageCalls.length, 1, "outer must reply with public subagent_message exactly once");
        assert.deepEqual(
          messageCalls[0].arguments,
          { name: childName, message: reply },
          "outer reply must use the exact running name and supplied unique answer",
        );
        const messageResults = toolResults(entries, "subagent_message");
        assert.equal(messageResults.length, 1);
        assert.equal(
          messageResults[0].details?.status,
          "steered",
          "reply must steer the parked live child, not resume/relaunch it",
        );

        const started = startedSubagentResults(entries);
        assert.equal(started.length, 1);
        const childSession = childSessionFile(started[0]);
        const childEntries = readSessionEntries(childSession);
        const askCalls = toolCalls(childEntries, "ask_question");
        const bashCalls = toolCalls(childEntries, "bash");
        assert.equal(askCalls.length, 1);
        assert.deepEqual(askCalls[0].arguments, { question });
        assert.equal(bashCalls.length, 1);
        assert.ok(
          JSON.stringify(bashCalls[0].arguments).includes(markerFile) &&
            JSON.stringify(bashCalls[0].arguments).includes(fileMarker),
          "the child's sole bash call must write the supplied marker",
        );
        const askIndex = childEntries.findIndex(
          (entry) =>
            entry.message?.role === "assistant" &&
            (entry.message.content ?? []).some(
              (part) =>
                part.type === "toolCall" &&
                part.name === "ask_question" &&
                part.arguments?.question === question,
            ),
        );
        const replyIndex = childEntries.findIndex(
          (entry, index) =>
            index > askIndex &&
            entry.message?.role === "user" &&
            assistantText(entry.message).trim() === reply,
        );
        const bashIndex = childEntries.findIndex(
          (entry, index) =>
            index > replyIndex &&
            entry.message?.role === "assistant" &&
            (entry.message.content ?? []).some(
              (part) => part.type === "toolCall" && part.name === "bash",
            ),
        );
        const finalIndex = childEntries.findIndex(
          (entry, index) =>
            index > bashIndex &&
            entry.message?.role === "assistant" &&
            assistantText(entry.message).trim() === childMarker,
        );
        assert.ok(
          askIndex >= 0 && replyIndex > askIndex && bashIndex > replyIndex && finalIndex > bashIndex,
          "child must ask, receive the exact reply, write once, and only then return its final value",
        );
        assert.equal(childEntries.filter((entry) => entry.type === "session").length, 1);
        assert.equal(successfulChildResults(entries, childName, childMarker).length, 1);
        assertOuterCompletedAfterResult(entries, childName, childMarker, outerMarker);
        assertFixedChildUsesSol(childSession, childMarker);
        assertProviderEvidence("ask/reply/message", [outerSessionFile, childSession]);
      });

      it("lists and spawns the visible project-local fixed profile", async () => {
        assert.ok(env);
        const id = uniqueId();
        const childName = `Discovery-${id}`;
        const fileMarker = `DISCOVERY_FILE_${id}`;
        const childMarker = `DISCOVERY_CHILD_${id}`;
        const outerMarker = `DISCOVERY_OUTER_${id}`;
        const markerFile = join(env.dir, `discovery-${id}.txt`);
        const outerSessionFile = join(env.dir, `outer-discovery-${id}.jsonl`);
        trackOwnedOuterSessionFile(env, outerSessionFile);

        const surface = createTrackedSurface(env, `discovery-${id}`);
        await sleep(1_000);
        const task = [
          "First call public subagents_list exactly once.",
          `Inspect the actual result. Only if it lists ${FIXED_AGENT} as a project profile, call public subagent once with:`,
          `  name: "${childName}"`,
          `  agent: "${FIXED_AGENT}"`,
          `  task: "Use bash to run: printf '%s\\n' '${fileMarker}' > '${markerFile}'. Then return exactly ${childMarker}."`,
          "After the started acknowledgement, end the turn and wait for the automatic result.",
          `Only after the actual successful child result contains ${childMarker}, return exactly ${outerMarker}.`,
        ].join("\n");

        startPi(surface, env.dir, task, {
          extraArgs: `--session ${shellEscape(outerSessionFile)}`,
        });

        const content = await waitForFile(markerFile, PI_TIMEOUT, new RegExp(`^${fileMarker}\\s*$`));
        assert.equal(content.trim(), fileMarker);
        const entries = await waitForSession(
          outerSessionFile,
          (current) =>
            successfulChildResults(current, childName, childMarker).length === 1 &&
            assistantMessages(current).some((message) => assistantText(message).includes(outerMarker)),
          "discovery child result and outer completion",
        );

        const listCalls = toolCalls(entries, "subagents_list");
        assert.equal(listCalls.length, 1, "outer must use the public discovery tool once");
        const listResults = toolResults(entries, "subagents_list");
        assert.equal(listResults.length, 1);
        const listedAgents = listResults[0].details?.agents;
        assert.ok(Array.isArray(listedAgents), "subagents_list details must include agents");
        const listedFixed = listedAgents.find(
          (agent) =>
            typeof agent === "object" &&
            agent !== null &&
            (agent as Record<string, unknown>).name === FIXED_AGENT,
        ) as Record<string, unknown> | undefined;
        assert.ok(listedFixed, `${FIXED_AGENT} must be visible in project-local discovery`);
        assert.equal(listedFixed.source, "project");
        assert.equal(listedFixed.model, `${SOL_PROVIDER}/${SOL_MODEL}`);
        assert.equal(
          listedAgents.some(
            (agent) =>
              typeof agent === "object" &&
              agent !== null &&
              [(agent as Record<string, unknown>).name].some(
                (name) => name === FORK_AGENT || name === QUESTION_AGENT,
              ),
          ),
          false,
          "hidden lifecycle fixtures must not appear in public discovery",
        );

        const spawnCalls = toolCalls(entries, "subagent");
        assert.equal(spawnCalls.length, 1);
        assert.equal(spawnCalls[0].arguments.agent, FIXED_AGENT);
        const childSession = childSessionFile(startedSubagentResults(entries)[0]);
        assertOuterCompletedAfterResult(entries, childName, childMarker, outerMarker);
        assertFixedChildUsesSol(childSession, childMarker);
        assertProviderEvidence("project discovery", [outerSessionFile, childSession]);
      });
    },
  );
}
