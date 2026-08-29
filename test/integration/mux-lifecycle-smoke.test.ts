/**
 * Bounded model-backed lifecycle smoke for the current public mux contract.
 *
 * This deliberately covers only completion/resume and destructive kill/forget.
 * It must be selected explicitly; the separate broad provider lifecycle suite
 * is not part of this profile.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import {
  PI_TIMEOUT,
  cleanupTestEnv,
  cleanupOwnedChildSessionFiles,
  collectOwnedChildSessionFiles,
  createTestEnv,
  createTrackedSurface,
  getAvailableBackends,
  getHerdrWorkspaceSnapshot,
  readScreen,
  shellEscape,
  sleep,
  startPi,
  trackOwnedOuterSessionFile,
  trackTempFile,
  uniqueId,
  waitForFile,
  waitForHerdrWorkspaceRestored,
  waitForScreen,
  type HerdrWorkspaceSnapshot,
  type TestEnv,
} from "./harness.ts";

const FIXTURE_AGENT = "mux-lifecycle-smoke";
const SMOKE_MODEL = "openai-codex/gpt-5.6-sol";
const WORKSPACE_RESTORE_TIMEOUT = 20_000;
const POST_KILL_VERIFICATION_MS = 5_000;
const SUITE_FIXED_OVERHEAD_MS = 10_000;
const DIAGNOSTIC_TAIL_BYTES = 256 * 1024;
const DIAGNOSTIC_EVENT_LIMIT = 24;
const selectedBackends = getAvailableBackends();
const workspaceId = process.env.HERDR_WORKSPACE_ID;
const skipReason =
  process.env.PI_SUBAGENT_MUX !== "herdr"
    ? 'requires PI_SUBAGENT_MUX="herdr"'
    : selectedBackends.length !== 1 || selectedBackends[0] !== "herdr"
      ? "selected mux backend is not available Herdr"
      : !workspaceId
        ? "requires HERDR_WORKSPACE_ID"
        : false;

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type SessionMessage = {
  role?: string;
  provider?: string;
  model?: string;
  errorMessage?: string;
  toolName?: string;
  content?: unknown;
  details?: { sessionFile?: string };
};

function readSessionMessages(sessionFile: string): SessionMessage[] {
  return readFileSync(sessionFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { message?: SessionMessage })
    .flatMap((entry) => entry.message ? [entry.message] : []);
}

function toolResults(sessionFile: string, toolName: string): SessionMessage[] {
  return readSessionMessages(sessionFile).filter(
    (message) => message.role === "toolResult" && message.toolName === toolName,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function toolResultText(message: SessionMessage): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) => {
      if (!isRecord(part) || part.type !== "text") return [];
      return [typeof part.text === "string" ? part.text : ""];
    })
    .join("\n");
}

function diagnosticExcerpt(value: unknown): string {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function readDiagnosticTail(sessionFile: string): { lines: string[]; truncated: boolean } {
  const fd = openSync(sessionFile, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, DIAGNOSTIC_TAIL_BYTES);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = readSync(fd, buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }

    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    return { lines: text.split("\n"), truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

function persistedOuterOrdering(sessionFile: string): string {
  if (!existsSync(sessionFile)) return "outer session file is missing";

  let tail: { lines: string[]; truncated: boolean };
  try {
    tail = readDiagnosticTail(sessionFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unable to read outer session tail: ${diagnosticExcerpt(message)}`;
  }

  const events: string[] = [];
  const pushEvent = (event: string): void => {
    if (events.length === DIAGNOSTIC_EVENT_LIMIT) events.shift();
    events.push(event);
  };

  for (const [index, line] of tail.lines.entries()) {
    if (!line) continue;
    const position = tail.truncated ? `tail+${index + 1}` : String(index + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      pushEvent(`${position}:unparseable-entry`);
      continue;
    }
    if (!isRecord(parsed)) continue;

    if (parsed.type === "custom_message") {
      const details = isRecord(parsed.details) ? parsed.details : undefined;
      const customType = diagnosticExcerpt(parsed.customType) || "unknown";
      const name = diagnosticExcerpt(details?.name);
      pushEvent(
        `${position}:custom:${customType}${name ? `:${name}` : ""}:${diagnosticExcerpt(parsed.content)}`,
      );
      continue;
    }

    const message = parsed.type === "message" && isRecord(parsed.message)
      ? parsed.message as SessionMessage
      : undefined;
    if (message?.role === "assistant") {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!isRecord(block)) continue;
        if (block.type === "toolCall") {
          const blockName = diagnosticExcerpt(block.name) || "unknown";
          pushEvent(`${position}:tool-call:${blockName}`);
        } else if (block.type === "text") {
          const text = diagnosticExcerpt(block.text);
          if (text) pushEvent(`${position}:assistant:${text}`);
        }
      }
    } else if (message?.role === "toolResult") {
      const toolName = diagnosticExcerpt(message.toolName) || "unknown";
      pushEvent(
        `${position}:tool-result:${toolName}:${diagnosticExcerpt(toolResultText(message))}`,
      );
    }
  }

  const prefix = tail.truncated ? "earlier entries omitted; " : "";
  return events.length > 0
    ? `${prefix}${events.join(" -> ")}`
    : `${prefix}no persisted non-user outer-session events`;
}

function remainingCaseTime(
  caseDeadline: number,
  label: string,
  outerSessionFile: string,
): number {
  const remaining = caseDeadline - Date.now();
  if (remaining > 0) return remaining;
  throw new Error(
    `Stage5 ${label} exhausted its ${PI_TIMEOUT}ms absolute case deadline.\n` +
      `Persisted outer-session ordering: ${persistedOuterOrdering(outerSessionFile)}`,
  );
}

function stage5WaitError(
  label: string,
  caseDeadline: number,
  outerSessionFile: string,
  error: unknown,
): Error {
  const status = Date.now() >= caseDeadline
    ? `exhausted its ${PI_TIMEOUT}ms absolute case deadline`
    : `failed before its ${PI_TIMEOUT}ms absolute case deadline`;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `Stage5 ${label} ${status}.\n${message}\n` +
      `Persisted outer-session ordering: ${persistedOuterOrdering(outerSessionFile)}`,
  );
}

async function waitForStage5File(
  path: string,
  outerSessionFile: string,
  contentPattern: RegExp,
  caseDeadline: number,
  label: string,
): Promise<string> {
  const remaining = remainingCaseTime(caseDeadline, label, outerSessionFile);
  try {
    return await waitForFile(path, remaining, contentPattern);
  } catch (error) {
    throw stage5WaitError(label, caseDeadline, outerSessionFile, error);
  }
}

async function waitForStage5Completion(
  surface: string,
  outerSessionFile: string,
  pattern: RegExp,
  caseDeadline: number,
  lines: number,
  label: string,
): Promise<string> {
  const remaining = remainingCaseTime(caseDeadline, label, outerSessionFile);
  try {
    return await waitForScreen(surface, pattern, remaining, lines);
  } catch (error) {
    throw stage5WaitError(label, caseDeadline, outerSessionFile, error);
  }
}

function spawnedChildSessionFile(outerSessionFile: string): string {
  const result = toolResults(outerSessionFile, "subagent")[0];
  const sessionFile = result?.details?.sessionFile;
  assert.ok(sessionFile, "subagent tool result must identify the child session file");
  return sessionFile;
}

function assertSmokeProviderEvidence(label: string, sessionFiles: string[]): void {
  const assistants = sessionFiles.flatMap((sessionFile) =>
    readSessionMessages(sessionFile).filter((message) => message.role === "assistant")
  );
  assert.ok(assistants.length > 0, `${label} must persist model responses`);
  for (const message of assistants) {
    assert.equal(message.provider, "openai-codex");
    assert.equal(message.model, "gpt-5.6-sol");
    assert.equal(message.errorMessage, undefined);
  }
  console.log(`# ${label}: ${assistants.length} persisted Sol responses, 0 provider errors`);
}

describe(
  "mux lifecycle smoke [herdr]",
  {
    timeout:
      PI_TIMEOUT * 2 +
      WORKSPACE_RESTORE_TIMEOUT * 2 +
      POST_KILL_VERIFICATION_MS +
      SUITE_FIXED_OVERHEAD_MS,
    skip: skipReason,
  },
  () => {
    let env: TestEnv | undefined;
    let workspaceBefore: HerdrWorkspaceSnapshot | undefined;

    beforeEach(() => {
      // Capture exact focus and pane identity before the test owns any surface.
      workspaceBefore = getHerdrWorkspaceSnapshot(workspaceId!);
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
          // Only TestEnv-owned outer surfaces and files are closed/removed.
          cleanupTestEnv(env);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (workspaceBefore) {
        try {
          await waitForHerdrWorkspaceRestored(workspaceBefore, WORKSPACE_RESTORE_TIMEOUT);
        } catch (error) {
          // The helper reports leaked IDs but intentionally never closes them.
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
        throw new AggregateError(cleanupErrors, "Lifecycle smoke cleanup/restoration failed");
      }
    });

    it("completes and explicitly resumes the same named child", async () => {
      const caseDeadline = Date.now() + PI_TIMEOUT;
      assert.ok(env);
      const id = uniqueId();
      const childName = `Lifecycle-${id}`;
      const initialFile = join(env.dir, `initial-${id}.txt`);
      const resumeFile = join(env.dir, `resume-${id}.txt`);
      const initialFileMarker = `INITIAL_FILE_${id}`;
      const resumeFileMarker = `RESUME_FILE_${id}`;
      const initialResultMarker = `INITIAL_OK_${id}`;
      const resumeResultMarker = `RESUME_OK_${id}`;
      const outerCompletionMarker = `LIFECYCLE_FINAL_${id}`;
      const outerSessionFile = join(env.dir, `outer-resume-${id}.jsonl`);
      trackTempFile(env, initialFile);
      trackTempFile(env, resumeFile);
      trackTempFile(env, outerSessionFile);
      trackOwnedOuterSessionFile(env, outerSessionFile);

      const outer = createTrackedSurface(env, `lifecycle-resume-${id}`);
      await sleep(1_000);

      const task = [
        "Execute this lifecycle protocol exactly. Do not use subagent_message or poll session files.",
        "",
        "PHASE 1: In your first tool batch call public subagent exactly once with:",
        `  agent: "${FIXTURE_AGENT}"`,
        `  name: "${childName}"`,
        "  task: use bash exactly once to run the command below, then return a final response",
        `        formed by concatenating "INITIAL_", "OK_", and "${id}" with no other text:`,
        `        printf '%s\\n' '${initialFileMarker}' > '${initialFile}'`,
        "After the started acknowledgement, end the turn. Do not claim completion.",
        "",
        "PHASE 2: Wait for the automatic subagent result follow-up. Only after the actual child result",
        `contains the concatenation of "INITIAL_", "OK_", and "${id}", call public`,
        "subagent_resume exactly once, in a new tool batch, with:",
        `  name: "${childName}"`,
        "  message: use bash exactly once to run the command below, then return a final response",
        `           formed by concatenating "RESUME_", "OK_", and "${id}" with no other text:`,
        `           printf '%s\\n' '${resumeFileMarker}' > '${resumeFile}'`,
        "After the resumed-safely acknowledgement, end the turn. Do not claim resumed completion.",
        "",
        "PHASE 3: Wait for the automatic resumed result follow-up. Only after that actual result contains",
        `the concatenation of "RESUME_", "OK_", and "${id}", print one final line formed by`,
        `concatenating "LIFECYCLE_", "FINAL_", and "${id}". Print nothing after it.`,
      ].join("\n");

      startPi(outer, env.dir, task, {
        model: SMOKE_MODEL,
        extraArgs: `--session ${shellEscape(outerSessionFile)}`,
      });

      const initialContent = await waitForStage5File(
        initialFile,
        outerSessionFile,
        new RegExp(`^${escaped(initialFileMarker)}\\s*$`),
        caseDeadline,
        "completion/resume initial child output",
      );
      assert.equal(initialContent.trim(), initialFileMarker);

      const resumeContent = await waitForStage5File(
        resumeFile,
        outerSessionFile,
        new RegExp(`^${escaped(resumeFileMarker)}\\s*$`),
        caseDeadline,
        "completion/resume resumed child output",
      );
      assert.equal(resumeContent.trim(), resumeFileMarker);

      const screen = await waitForStage5Completion(
        outer,
        outerSessionFile,
        new RegExp(escaped(outerCompletionMarker)),
        caseDeadline,
        1_000,
        "completion/resume outer completion",
      );
      assert.ok(screen.includes(initialResultMarker), "outer screen must show the initial child result");
      assert.ok(screen.includes(resumeResultMarker), "outer screen must show the resumed child result");
      assert.ok(screen.includes(outerCompletionMarker), "outer screen must show final completion");
      assert.ok(
        screen.lastIndexOf(resumeResultMarker) < screen.lastIndexOf(outerCompletionMarker),
        "outer completion must follow the resumed result",
      );
      assertSmokeProviderEvidence(
        "completion/resume",
        [outerSessionFile, spawnedChildSessionFile(outerSessionFile)],
      );
    });

    it("kills, forgets, and refuses resume of the killed name", async () => {
      const caseDeadline = Date.now() + PI_TIMEOUT;
      assert.ok(env);
      const id = uniqueId();
      const childName = `Kill-${id}`;
      const startFile = join(env.dir, `kill-start-${id}.txt`);
      const finishFile = join(env.dir, `kill-finish-${id}.txt`);
      const startMarker = `START_${id}`;
      const forbiddenMarker = `FINISH_${id}`;
      const verifiedMarker = `KILL_FORGET_VERIFIED_${id}`;
      const exactKillResult = `Killed subagent "${childName}" and forgot its name.`;
      const exactResumeRefusal =
        `No completed subagent named "${childName}" in this parent session. ` +
        "No subagents have been spawned in this session yet.";
      const outerSessionFile = join(env.dir, `outer-kill-${id}.jsonl`);
      trackTempFile(env, startFile);
      trackTempFile(env, finishFile);
      trackTempFile(env, outerSessionFile);
      trackOwnedOuterSessionFile(env, outerSessionFile);

      const outer = createTrackedSurface(env, `lifecycle-kill-${id}`);
      await sleep(1_000);

      const task = [
        "Execute this destructive lifecycle protocol exactly and sequentially.",
        "",
        "PHASE 1: Call public subagent exactly once with:",
        `  agent: "${FIXTURE_AGENT}"`,
        `  name: "${childName}"`,
        "  task: immediately use bash exactly once to run this command, then return any short response:",
        `        printf '%s\\n' '${startMarker}' > '${startFile}'; sleep 120; ` +
          `printf '%s\\n' '${forbiddenMarker}' > '${finishFile}'`,
        "",
        "PHASE 2: After the started acknowledgement, use your own bash tool exactly once with this",
        "bounded command to wait for START. This explicit wait is required:",
        `  for i in $(seq 1 90); do test -f '${startFile}' && exit 0; sleep 1; done; exit 1`,
        `Only after that bash succeeds, call public subagent_kill with exact name "${childName}".`,
        "Do not call another lifecycle tool in the same tool batch as subagent_kill.",
        "",
        "PHASE 3: Inspect the kill result. Only if it says the child was killed and its name forgotten,",
        `call public subagent_resume in a later tool batch with name "${childName}" and message`,
        '"THIS MUST BE REFUSED". Inspect that result; it must refuse because no completed subagent',
        "with that name exists in this parent session.",
        "",
        "Only after observing both the kill/forget result and expected resume refusal, print one line",
        `formed by concatenating "KILL_", "FORGET_VERIFIED_", and "${id}". Print nothing after it.`,
      ].join("\n");

      assert.equal(task.includes(exactKillResult), false, "prompt must not contain the kill result");
      assert.equal(
        task.includes(exactResumeRefusal),
        false,
        "prompt must not contain the resume refusal",
      );
      startPi(outer, env.dir, task, {
        model: SMOKE_MODEL,
        extraArgs: `--session ${shellEscape(outerSessionFile)}`,
      });

      const startContent = await waitForStage5File(
        startFile,
        outerSessionFile,
        new RegExp(`^${escaped(startMarker)}\\s*$`),
        caseDeadline,
        "kill/forget child startup",
      );
      assert.equal(startContent.trim(), startMarker);

      await waitForStage5Completion(
        outer,
        outerSessionFile,
        new RegExp(escaped(verifiedMarker)),
        caseDeadline,
        1_000,
        "kill/forget outer verification",
      );
      await sleep(POST_KILL_VERIFICATION_MS);
      assert.equal(
        existsSync(finishFile),
        false,
        `killed child must not write forbidden marker ${forbiddenMarker}`,
      );

      const screen = readScreen(outer, 1_000);
      assert.ok(screen.includes(verifiedMarker), "outer screen must show kill/forget verification");

      const killResults = toolResults(outerSessionFile, "subagent_kill");
      assert.equal(killResults.length, 1, "outer must call public subagent_kill exactly once");
      assert.equal(toolResultText(killResults[0]), exactKillResult);

      const resumeResults = toolResults(outerSessionFile, "subagent_resume");
      assert.equal(resumeResults.length, 1, "outer must call public subagent_resume exactly once");
      assert.equal(toolResultText(resumeResults[0]), exactResumeRefusal);

      assertSmokeProviderEvidence(
        "kill/forget",
        [outerSessionFile, spawnedChildSessionFile(outerSessionFile)],
      );
    });
  },
);
