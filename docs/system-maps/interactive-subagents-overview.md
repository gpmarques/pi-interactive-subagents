# System Map: interactive subagents overview

**Question:** How does `pi-interactive-subagents` turn a parent Pi session into an asynchronous, resumable hierarchy of restricted child sessions?
**Boundary:** The extension entry point, tmux transport, child lifecycle helper, session/artifact state, bundled agents, and tests in this repository. Pi internals, model-provider behavior, and linked upstream repositories are outside the boundary.
**Horizon:** One parent session spawning, supervising, messaging, completing, and later resuming children with version `3.7.2` of this repository.
**Evidence basis:** Static inspection plus the unit suite, a current-Pi extension startup smoke test, and the tmux surface integration suite; no model-backed child lifecycle was run.

## At a glance

The extension is a **process orchestrator**, not an in-process agent pool. Every child is a separate Pi process in a detached tmux pane with its own session JSONL file, model, identity, working directory, and tool loadout. The parent returns immediately after launch, watches child-owned files and the pane for lifecycle signals, then injects the final result back into the parent as a steer message that starts another turn.

The key invariant is that a child is addressed by a persistent name while execution is transient. That name routes to a live pane when the child is running and to a saved session plus sandbox snapshot after it exits.

## Causal path

```text
Parent calls subagent(agent, task, optional name/model/cwd)
  → extension resolves the named profile and checks tmux, session, and spawn allowlists
  → it creates a child session, task artifacts, sandbox snapshot, and detached tmux pane
  → launch script starts a separate Pi process with explicit model/tools/extensions/env
  → child lifecycle hooks write activity and question/error sidecars
  → parent watcher classifies status while polling sidecars and the pane sentinel
  → child exits; watcher extracts the final assistant message and usage from its session
  → parent closes the pane and sends a subagent_result steer message
  → a later subagent_message(name, message) either steers the live pane or resumes the saved session
```

The non-obvious edge is resume: it does not rediscover the current agent profile. It replays the `<session>.loadout.json` snapshot and refuses to resume when that snapshot is missing, preventing an old restricted child from silently returning with the parent's full toolset.

## Parts

| Part | Responsibility |
|---|---|
| `pi-extension/subagents/index.ts` | Agent discovery, spawn validation, command construction, running-child registry, watcher, parent tools/UI, steering, and resume. |
| `tmux.ts` | Creates detached panes, sends launch scripts/messages, captures screen output, balances layout, closes panes, and detects terminal exit sentinels. |
| `subagent-done.ts` | Runs inside child Pi processes; records lifecycle, supplies `ask_question`, suppresses premature auto-exit, and emits error sidecars. |
| `activity.ts` + `status.ts` | Defines the atomic activity-file protocol and maps snapshots into starting/active/waiting/stalled/running UI states. |
| `session.ts` | Seeds lineage/fork sessions, stores loadout snapshots and name registries, resolves sessions, extracts summaries, and calculates usage. |
| `agents/*.md` | Declarative profiles for model, tools, identity, session mode, auto-exit, and permitted nested agents. |
| `tools/safe-bash.ts` | Optional child-only shell wrapper with a small catastrophic-command denylist. |

### Public surface

- Parent tools: `subagent`, `subagent_message`, `subagents_list`.
- Parent command: `/subagent <agent> <task>`.
- Child-only control tool: `ask_question`.
- Bundled profiles:
  - `scout`: read-only code reconnaissance.
  - `researcher`: web search/fetch plus `safe_bash`.
  - `worker`: implementation tools and permission to spawn only `scout` and `researcher`.

Agent discovery precedence is package → global → project during insertion, so later project definitions replace names from earlier scopes.

## State and boundaries

- **In memory:** running child id → pane, name, timestamps, status, watcher controller.
- **Parent artifacts:** task/system-prompt files, launch scripts, activity snapshots, and `subagent-registry.json` mapping persistent names to child sessions.
- **Beside the child session:** `<session>.loadout.json` preserves model, tools, extensions, identity, cwd, config root, and nested-spawn allowlist.
- **Transient IPC:** `<session>.ask` signals a question; `<session>.exit` reports an agent/provider error; a terminal sentinel catches normal process exit or crashes.
- **Child session:** the durable conversation and final assistant response used for completion and future resume.

## Generated behavior

- **Parallel fan-out/fan-in:** detached panes let the parent launch several independent children without waiting; each completion independently steers a new parent turn.
- **Context protection through delegation:** the bundled worker can offload reconnaissance or research to disposable child contexts and receive only their summaries.
- **Question parking:** `ask_question` changes an auto-exit child from active to waiting; a reply by name resumes its work rather than terminating and respawning it.
- **Capability containment:** explicit `--no-extensions`, `--tools`, selected `-e` paths, and `PI_SUBAGENT_ALLOWED` constrain tools and nested roles. Resumes replay that containment rather than recomputing it.
- **Visible supervision:** child event snapshots update a widget; missing or invalid snapshots become stalled only after a fixed delay, reducing false alarms during long valid tool calls.

## Causal regimes

- **Does a valid top-level spawn return immediately and later deliver the child's final answer during one healthy tmux session? — Complicated, high confidence:** launch and watcher responsibilities are explicit and both unit and integration tests target the lifecycle. **Classification challenge:** Clear, if repeated current-version end-to-end runs establish a stable path. **Discriminator:** run the tmux integration suite against the installed Pi and configured model.
- **Does resume preserve the original child's capability boundary after profile/config changes? — Complicated, high confidence:** one loadout snapshot feeds both initial sandbox assembly and resume, and missing snapshots fail closed. **Classification challenge:** Clear, if runtime tests mutate the profile between spawn and resume and observe an unchanged child surface. **Discriminator:** compare `pi.getAllTools()` and nested-spawn access before and after such a resume.
- **Does the status widget always distinguish legitimate waiting from a stalled child under provider/tool delays? — Complex, medium confidence:** event snapshots, filesystem timing, process stalls, and asynchronous parent polling interact; the code can classify known paths but unusual timing combinations emerge operationally. **Classification challenge:** Complicated, if fault-injection tests cover all relevant timing states. **Discriminator:** inject delayed, corrupt, missing, and reordered snapshots while observing parent transitions.

## Established

- **Separate-process architecture:** `launchSubagent()` builds a `pi` command and sends it to a new tmux pane (`index.ts`, `tmux.ts`).
- **Fire-and-forget completion:** `subagent.execute()` starts `watchSubagent()` without awaiting it; the watcher later calls `pi.sendMessage(..., { deliverAs: "steer" })` (`index.ts`).
- **Default-deny restricted profiles:** `applySandboxToParts()` combines `--no-extensions`, `--tools`, and explicit extension paths; nested roles are checked against `PI_SUBAGENT_ALLOWED` (`index.ts`).
- **Persistent by-name identity:** the parent artifact registry maps each name to a session, while `subagent_message` prefers a live child and otherwise resumes the registered session (`session.ts`, `index.ts`).
- **Fail-closed resume:** no loadout sidecar means no resume (`index.ts`, `session.ts`).
- **Auto-exit waits for dependencies:** `subagent-done.ts` parks while a question or nested child is outstanding and exits after a normal final turn.
- **Broad unit coverage:** `test/test.ts` exercises session, status, activity, sandbox, agent discovery, UI, and steering logic; tmux and LLM-backed integration suites are separate package scripts.

## Hypotheses

- **tmux is chosen for observability as much as concurrency:** a human can inspect and take over a child pane while the parent retains focus. **Falsifier:** project history or usage data showing panes are never inspected and only serve as a process launcher.
- **Filesystem sidecars intentionally minimize coupling to Pi internals:** activity, question, error, loadout, and registry state cross process boundaries without a dedicated server. **Falsifier:** an intended migration to an existing Pi IPC/session API that already carries all these signals.
- **Persistent names are the primary usability abstraction:** ids remain internal while the public message tool only accepts `name`. **Falsifier:** future public workflows that expose ids as the stable user handle.

## Fog

- **Compatibility with the installed Pi distribution:** package metadata and imports target `@earendil-works/*`; unit tests, extension startup, and tmux transport pass, but no live child lifecycle has run against the installed Pi runtime. **Needed:** perform a model-backed spawn and resume smoke test.
- **Integration-suite freshness:** lifecycle tests still mention removed request fields and the former `caller_ping` name even though unit tests assert the reduced schema and `ask_question`. **Needed:** execute and reconcile `test/integration/subagent-lifecycle.test.ts` with the current public surface.
- **Practical scale limit:** there is no explicit pane, nesting-depth, or cumulative-spawn cap in the extension. **Needed:** stress measurements for pane count, polling/filesystem overhead, provider concurrency, and runaway nested delegation.
- **Claude CLI containment:** profiles may choose `cli: claude`, which launches with `--dangerously-skip-permissions` and follows a different completion path. **Needed:** a dedicated capability-boundary review and tests for that mode.

## Frontier

- **Sandbox zoom:** trace every route by which a child can gain tools, extensions, credentials, or nested agents.
- **Lifecycle zoom:** model all spawn → active → waiting → stalled → completion/recovery transitions and their race conditions.
- **Compatibility zoom:** migrate package imports/metadata and refresh integration tests for the installed Pi version.
