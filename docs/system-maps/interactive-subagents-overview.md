# System Map: interactive subagents overview

**Question:** How does `pi-interactive-subagents` turn a parent Pi session into an asynchronous, safely name-resumable hierarchy of restricted child processes across its supported terminal backends?
**Revision boundary:** The current working tree based on `a3f1b22` (package version remains `3.7.2`), including the extension entry point, mux surface layer, child lifecycle helper, session/artifact state, bundled agents, docs, and tests. Pi internals, provider behavior, and external terminal implementations are outside the boundary.
**Horizon:** One parent session selecting a backend, spawning, supervising, messaging, killing, completing, and later resuming children.
**Evidence basis:** Static inspection plus fresh verification for this revision: unit 204/204; top-level hermetic/offline tests 38/38 (lifecycle 20/20, mux 14/14, visual profile 2/2, system-prompt 1/1 with 21 internal assertions, production web-preflight boundary 1/1); one six-runtime bundled-profile capability test, 1/1; and live no-model Herdr surface integration, 8/8. The capability checks launched fresh offline Pi RPC processes, invoked no model or web tool, and proved only `researcher` receives all four canonical web tools. Provider-backed Herdr, forced tmux surface, and visual-browser evidence recorded below predates this researcher-capability change and was not rerun.

## At a glance

The extension is a **process orchestrator**, not an in-process agent pool. Each child is a separate restricted Pi or Claude Code process on a terminal surface. This fork supports exactly tmux and Herdr through the backend-neutral `mux.ts` policy/lifecycle module and private mechanics in `mux-adapters.ts`; `tmux.ts` only preserves the old import path by re-exporting `mux.ts`.

The parent returns immediately after launch. It tracks explicit surface IDs, child-owned files, and session state. `researcher` is the only bundled profile granted `web_search`, `fetch_content`, `get_search_content`, and `source_check`; it also receives `safe_bash` and the ordinary child `ask_question` tool. Those web capabilities are available only when the effective Pi agent directory has exactly one unfiltered `npm:pi-web-access` registration, a canonical compatible `pi-web-access@0.27.0` package/configuration, and a bounded fresh offline Pi runtime that reports exactly the four canonical tools active. Every fully settled Pi child then has a binary externally visible outcome: exited children deliver their result, while children that remain alive publish one immutable current-state record for that settled cycle. Publication uses Pi's `agent_settled` event so retries, compaction/retry, and queued continuations are exhausted first; the latest assistant text is included when available without classifying its intent. The surface remains pinned to the backend that created it, while persistent parent-scoped names make completed Pi sessions resumable without exposing session paths or accepting new launch controls. Stage 5 establishes public completion/resume and kill/forget on model-backed Herdr within two dedicated smoke scenarios. The separate Stage 6 broad provider-backed Herdr suite establishes six current-contract cases—completion, active status beyond the watchdog, parallel spawn, fixed-profile fork, parked question/exact-name message, and project-local discovery—not model-backed tmux or generic production behavior.

## Causal path

```text
Parent calls subagent(agent, task, optional name/model/cwd)
  → profile and nested-role policy validate the requested child
  → requested extension-backed tools resolve only from the effective child agent directory
      pi-web-access → exact registration + version + canonical manifest/entrypoint + canonical tool configuration
  → researcher-only bounded offline Pi RPC preflight observes exactly the four active web tools
  → canonical entrypoint/package/version/manifest + full config identity are recorded
  → PI_SUBAGENT_MUX selects one available backend, or fails closed
  → the selected adapter creates a focus-preserving surface and returns its explicit ID
      tmux  → detached right split from the caller pane
      Herdr → background tab in the caller workspace with --no-focus
  → extension writes task/launch artifacts and a Pi sandbox validation record
  → a restricted Pi or Claude Code process starts on that surface
  → watcher combines activity/session sidecars with explicit-ID screen reads
  → agent_settled while alive atomically publishes a state record; watcher batches finalized records into one current-state parent wakeup
  → exit/completion or boundedly confirmed disappearance terminates the watch
  → cleanup uses the surface's creating adapter, then completion schedules a parent follow-up turn
```

After completion, `subagent_resume(name, message)` resolves only a current-parent registry entry with durable completion proof, validates the saved Pi loadout—including canonical extension paths and SHA-256 digests plus any saved `pi-web-access` package/version/manifest and full-config identity—runs the same fresh capability probe, revalidates those recorded fields afterward, atomically claims the run, and starts an autonomous follow-up. Recorded identity drift or a legacy identity gap rejects before terminal-surface creation. The loadout stores validation identity only; old executable files are not copied. While a child is live, `subagent_message` steers its surface instead. `subagent_kill(name)` takes the destructive branch: terminate the exact surface/process first, abort/suppress the watcher, remove live tracking, and conditionally forget the name while preserving transcript history.

The selection edge is deliberately strict. Exact `tmux` or `herdr` forces that backend only when available; unset auto-detects Herdr before tmux because nested or stale tmux markers can coexist with Herdr. Empty and unknown values fail closed. Executable availability is checked on each selection rather than cached indefinitely.

## Parts

| Part | Responsibility |
|---|---|
| `pi-extension/subagents/index.ts` | Agent discovery, spawn validation, strict effective-agent-dir extension/package/config resolution, capability-preflight orchestration, sandbox assembly, running-child registry, watcher, parent tools/UI, steering, kill, and resume. |
| `pi-web-access-runtime.ts` + `pi-web-access-preflight.ts` | Bounded offline Pi RPC capability process, active-tool inspection, timeout kill, and temporary cleanup. |
| `pi-extension/subagents/mux.ts` | Shared backend selection, backend-neutral surface API, per-surface adapter ownership, long-command routing, close semantics, and bounded exit/disappearance policy. |
| `pi-extension/subagents/mux-adapters.ts` | Private tmux/Herdr availability checks and CLI mechanics: create, split, send, read, kill, output parsing, focus-preserving flags, layout, and missing-surface classification. |
| `pi-extension/subagents/tmux.ts` | Compatibility re-export of `mux.ts`; it owns no backend behavior. |
| `pi-extension/subagents/subagent-done.ts` | Runs inside child Pi processes; records lifecycle, supplies `ask_question`, suppresses premature auto-exit, emits errors, and publishes immutable state records from `agent_settled`. |
| `activity.ts` + `status.ts` | Atomic activity protocol and mapping into starting/active/waiting/stalled/running UI states. |
| `session.ts` | Seeds lineage/fork sessions, validates loadout records and backing-extension/package/config identities, stores parent-scoped name/run registries, extracts current-run summaries, and calculates usage. |
| `agents/*.md` | Declarative profiles for model, tools, identity, session mode, auto-exit, and permitted nested agents. |
| `tools/safe-bash.ts` | Optional child-only shell wrapper with a small catastrophic-command denylist. |

### Public surface

The parent has exactly five lifecycle tools:

- `subagent`
- `subagent_message`
- `subagent_resume`
- `subagent_kill`
- `subagents_list`

It also has `/subagent <agent> <task>`. Pi children may receive `ask_question`.

`subagent_resume` requires exactly `name` and `message`. It is completed-only, current-parent scoped, and Pi-only after completion; it accepts no session path/id or cwd, model, tools, auto-exit, interactive, or other launch override. It replays the validated saved sandbox, always autonomously. `subagent_message` retains a compatibility path that invokes the same safe resume implementation for a completed Pi name, but explicit relaunch intent belongs to `subagent_resume`.

Six profiles are bundled: interactive `planner`; autonomous `researcher`, `reviewer`, `scout`, `visual-tester`, and `worker`. Planner and worker may delegate only to scout/researcher. Project definitions override global definitions, which override package-bundled definitions.

## State and boundaries

- **In memory:** running child ID → explicit surface ID, name, timestamps, status, watcher controller, and kill/suppression state; the mux ownership map separately binds surface ID → creating adapter.
- **Parent artifacts:** task/system-prompt files, launch scripts, activity snapshots, and `subagent-registry.json` entries with parent-scoped name, session, and durable `running`/`completed` ownership.
- **Beside a Pi session:** `<session>.loadout.json` preserves model, thinking, tools, canonical backing-extension paths and SHA-256 digests, identity, cwd, agent directory, and nested-spawn allowlist. For `pi-web-access`, it also preserves the canonical package root/name/version, manifest digest, canonical config path, and complete/config-relevant digests. It does not preserve executable code or the full package/dependency tree.
- **Transient IPC:** `<session>.idle/` holds atomically renamed immutable settled-state records. Filenames begin with a zero-padded process-global sequence, shared across child sessions and preserved through extension reloads, so lexical drain order stays monotonic across wall-clock rollback and module re-evaluation; `settledAt` retains wall-clock metadata separately, and launch/resume cleanup prevents process epochs from sharing a queue. Incomplete temporary files are invisible to delivery. `<session>.exit` reports an error; a shell/plugin sentinel catches normal process exit or crashes. `.ask*` files are no longer produced and are removed only as legacy cleanup.
- **Surface ownership:** operations and errors stay routed to the creating adapter even if `PI_SUBAGENT_MUX` or availability changes later. New surface creation re-evaluates current selection.
- **Resume exclusion:** in-process name/session reservations plus an atomic persisted run claim prevent concurrent writers to one Pi JSONL across aliases, restarts, and parent processes.

## Generated behavior

- **Parallel fan-out/fan-in:** independent background surfaces let the parent launch several children without blocking; completion follow-ups arrive independently.
- **Focus-preserving launch:** tmux's detached split and Herdr's explicit-workspace `--no-focus` tab preserve the caller's active surface. tmux then debounces `even-horizontal` rebalance after create/close; Herdr public launches stay as background tabs.
- **Stable targeting under environment drift:** explicit surface IDs plus adapter ownership prevent a Herdr-created child from switching to tmux operations, or vice versa, after launch.
- **Bounded disappearance:** a recognized missing-surface read triggers sidecar rechecks, a short grace period, and one confirmation. Two confirmed misses produce `disappeared` instead of an indefinite poll; idempotent close treats an already absent surface as closed.
- **Repeatable completed work:** normal completion retains the current parent's Pi name mapping; safe resume can claim and replay it repeatedly, while kill/forget removes that capability.
- **Capability containment:** Pi children use `--no-extensions`, explicit tools/extensions, and a nested-role allowlist. Extension-backed tools fail before surface creation when their canonical backing identity cannot be proved. The four web tools resolve as one explicit `pi-web-access` entrypoint only for `researcher`; a fresh offline Pi runtime must activate exactly those four under the exact preflight allowlist, while every other bundled profile remains web-free. Claude children use separately translated built-ins, `dontAsk`, no ambient settings, and empty MCP configuration; unsupported profiles refuse before launch.
- **Visible supervision:** valid child activity snapshots update the widget; absent or invalid snapshots become stalled only after the watchdog delay. Apart from the explicit `ask_question` waiting state, nonterminal `waiting` begins at `agent_settled`, never an intermediate `agent_end`.
- **No silent parking:** every non-shutdown `agent_settled` publishes exactly one immutable snapshot (`idle`, `awaiting_answer`, or `waiting_on_children`). The parent batches accumulated snapshots oldest-to-newest and emphasizes the newest state, so intermediate history cannot cause a misleading standalone turn. External input changes only future snapshots; retry/compaction/continuation `agent_start` events preserve a pending question. Rejected parent sends retain the entire batch; exit, kill, and resume discard it.

### Backend limitations

- tmux public creation is a detached right split and supports all four directions through the generic split seam.
- Herdr public creation is a background tab. Its lower-level split seam supports only right/down with explicit target IDs. Left/up reject before any mutation because swap-based emulation would steal focus.
- Herdr screen reads use `recent`; they fall back to `visible` only when `recent` returns the empty string.
- Herdr missing-surface classification accepts only structured JSON stderr with `error.code === "pane_not_found"`; matching prose or unrelated structured errors do not prove disappearance.

## Causal regimes

- **Does selection choose the intended backend for each new surface during this revision? — Clear, high confidence:** strict preference parsing, uncached availability checks, 14/14 fake-CLI tests, and forced live tests expose a stable sequence. **Classification challenge:** Complicated if real terminal identity APIs vary across versions. **Discriminator:** rerun both forced live suites after backend upgrades and with both marker sets present.
- **Does surface creation preserve parent focus and clean up its tracked surfaces over one no-model run? — Clear, high confidence for the tested cases:** forced Herdr passed 8/8 and tmux passed 7/7. The cases exercised focus-preserving creation and tracked-resource cleanup; they did not compare the complete pre/post workspace surface set. **Classification challenge:** Complicated across other shells/terminal versions. **Discriminator:** repeat on those environments with explicit whole-workspace focus, pane, and tab snapshots.
- **Do the dedicated public completion/resume and kill/forget paths reach their persisted outcomes and restore the Herdr workspace during one model-backed working-tree run? — Complicated, high confidence within the two tested scenarios:** the post-correction smoke passed 2/2 in 64.444s, observed actual result follow-ups and public tool results, and persisted 15 Sol responses with no provider errors. During the run, the harness compared exact focus and pane sets and restored `w7` to `focus=null` with panes `[w7:p1, w7:p33]`; separate post-run inspection confirmed the sole tab `[w7:t1]` and found no owned recent files or processes. Exact tab comparison was added afterward without rerunning the provider suite. **Classification challenge:** Clear if repeated runs across relevant timing and version changes continue to produce the same sequence. **Discriminator:** rerun the dedicated smoke after Pi/provider/Herdr changes; the broad suite tests different paths and cannot substitute for it.
- **Do the broad current-contract lifecycle paths complete cleanly on provider-backed Herdr? — Complicated, high confidence within the six tested cases:** the post-correction forced-Herdr/Sol Stage 6 run passed 6/6 in 199.084s and persisted 40 Sol assistant responses with no errors/timeouts. During the run, the harness compared exact focus and pane sets and restored `w7` to `focus=null` with panes `[w7:p1, w7:p33]` after every case; separate post-run inspection confirmed the sole tab `[w7:t1]` and found no owned recent files or processes. Exact tab comparison was added afterward without rerunning the provider suite. **Classification challenge:** Clear only with repeat evidence across relevant provider, Pi, and Herdr changes. **Discriminator:** rerun the broad suite and add separately bounded model-backed tmux coverage.
- **Does Pi resume reject drift in its recorded backing-extension/package/config fields before creating a new surface? — Clear, high confidence for the offline boundary:** one validated loadout feeds both resume entrypoints. Hermetic tests mutate extension bytes, replace an entrypoint with a symlink, and drift the `pi-web-access` manifest/full config; all reject before a tmux split, while an unchanged researcher identity resumes only after the fresh probe. **Classification challenge:** same-version helper/dependency mutation and filesystem races after final verification are outside this focused guarantee. **Discriminator:** add content-addressed package/dependency closure binding in a separately scoped hardening change.
- **Does metadata-compatible `pi-web-access` actually expose the required tools before researcher surface creation? — Clear, high confidence for the offline boundary:** production-launch tests use exact-name/version packages whose entrypoints register zero, partial, renamed, and all four tools; only all four reaches `split-window`. Focused probes also reject extension errors, malformed/uninspectable RPC output, nonzero exit, and timeout while proving the timed-out parent/descendant process group is gone and temporary state is removed. **Classification challenge:** a same-user malicious extension can observe process environment and race/forge local evidence. **Discriminator:** load from an immutable verified snapshot in a stronger isolation boundary.

## Established

- **Two-backend architecture and ownership:** `mux.ts`, `mux-adapters.ts`, and the `tmux.ts` compatibility re-export establish exactly tmux/Herdr support, strict selection, explicit IDs, and creating-adapter routing.
- **Backend placement/focus mechanics:** `mux-adapters.ts` establishes detached tmux right splits with debounced layout and Herdr explicit-workspace background tabs plus right/down-only no-focus splits.
- **Bounded missing-surface handling:** `mux.ts` rechecks terminal sidecars around a bounded delay, confirms recognized disappearance once, and returns `disappeared`; `mux-adapters.ts` provides backend-specific classifiers and idempotent close support.
- **Persistent parent-scoped identity:** `session.ts` and `index.ts` map exact names to Pi sessions, prove completion/ownership, reserve aliases, and conditionally forget killed mappings.
- **Settled lifecycle contract:** `subagent-done.ts` atomically publishes per-record files only from `agent_settled`; the watcher removes each accepted record, ignores incomplete temporary files, and cannot let one corrupt record block later cycles. Terminal completion keeps its existing result path, and kill suppresses both paths.
- **Fail-closed Pi resume:** `index.ts` and `session.ts` require a structurally complete replayable loadout. Missing, malformed, incomplete, legacy identity-free, empty restricted fields, unavailable saved extensions, non-canonical/symlink replacements, entrypoint digest drift, or recorded `pi-web-access` package/version/manifest/full-config drift prevent surface creation. A valid non-empty nested whitelist is required to expose any of the five lifecycle tools.
- **Researcher-only web capability:** `agents/researcher.md` requests exactly the four canonical web tools plus `safe_bash`; `worker` delegates current/external research; the other bundled profiles request no web tool. Resolution accepts only the exact unfiltered `npm:pi-web-access` registration in the effective child agent directory and verified `pi-web-access@0.27.0`, with all four tools enabled and unrenamed. Metadata is followed by a 5-second-bounded offline/no-session Pi RPC probe using the exact child cwd/agent directory, canonical entrypoint, `--no-extensions`, and exact four-tool allowlist; all failure modes reject before a surface or loadout.
- **Focused recorded identity:** the saved web identity covers canonical entrypoint bytes/path, package root/name/version and manifest, and complete/relevant config state. It deliberately does not hash npm locks, helpers, or dependency trees; same-version unrecorded mutation is outside this guarantee. The isolated capability subprocess measured about 0.25–0.30 seconds.
- **Fresh automated evidence for this revision:** `test/test.ts` passed 204/204 in 3.213s. The top-level hermetic/offline files passed 38/38 in 12.025s: lifecycle 20/20 (`kill` 2/2, `registry` 2/2, `resume` 16/16), mux fake-CLI 14/14, visual profile 2/2, system-prompt 1/1 with 21/21 internal assertions, and the production-boundary web preflight 1/1. `test/integration/web-tools-offline.test.ts` passed 1/1 in 1.889s while checking six fresh offline Pi RPC runtimes. The resume identity cases prove no tmux split for legacy identity gaps, recorded entrypoint/manifest/config drift, or symlink replacement and prove an unchanged researcher identity resumes after preflight. The preflight cases prove zero/partial/renamed tool registration cannot create a surface and timeout cleanup removes both parent/descendant processes and temporary state.
- **Fresh live no-model evidence:** the Herdr surface integration passed 8/8 in 16.468s, exercising focus-preserving creation, commands, reads, concurrent surfaces, targeted splits, and tracked cleanup. No model/provider call was made. The prior forced tmux surface result remains 7/7 but was not rerun for this revision.
- **Earlier broader evidence (not rerun for this revision):** the provider-backed Herdr suites, forced tmux no-model surfaces, and the visual browser observation below.
- **Verified bounded Stage 5 model-backed Herdr evidence:** `env -u PI_SUBAGENT_LIFECYCLE_DISABLED PI_SUBAGENT_MUX=herdr PI_TEST_MODEL=openai-codex/gpt-5.6-sol PI_TEST_TIMEOUT=180000 npm run test:integration:lifecycle-smoke` ran `test/integration/mux-lifecycle-smoke.test.ts` and passed 2/2 in 64.444s. One scenario observed completion → actual result follow-up → public exact-name `subagent_resume` → actual resumed result follow-up. The other observed running-child start → public exact-name kill/forget → persisted exact public result → public resume refusal. Persisted outer and child sessions contained 15 assistant responses total—9 for completion/resume and 6 for kill/forget—all Sol, with zero provider errors. During the run, the harness compared exact focus and pane sets and restored `w7` to `focus=null` with panes `[w7:p1, w7:p33]`. Separate post-run inspection confirmed the sole tab `[w7:t1]` and found no owned recent files or processes. The shared snapshot was subsequently hardened to enforce exact tab equality; the provider suite was not rerun after this harness-only change. Independent review approved both the production follow-up fix and the corrected bounded harness.
- **Verified broad Stage 6 provider-backed Herdr evidence:** `env -u PI_SUBAGENT_LIFECYCLE_DISABLED PI_SUBAGENT_MUX=herdr PI_TEST_MODEL=openai-codex/gpt-5.6-sol PI_TEST_TIMEOUT=120000 npm run test:integration:lifecycle` ran `test/integration/subagent-lifecycle.test.ts` and passed 6/6 in 199.084s. The cases covered completion, a 90-second active call beyond the watchdog threshold, one-batch parallel fixed-profile children, fixed-profile fork linkage/copied context, `ask_question` followed by exact-name `subagent_message`, and visible project-local profile discovery/spawn. Outer and child sessions persisted 40 assistant responses, all `openai-codex/gpt-5.6-sol`, with 0 provider errors and 0 test timeouts. During the run, the harness compared exact focus and pane sets and restored `w7` to `focus=null` with panes `[w7:p1, w7:p33]` after every case. Separate post-run inspection confirmed the sole tab `[w7:t1]` and found no owned recent files or processes. The shared snapshot was subsequently hardened to enforce exact tab equality; the provider suite was not rerun after this harness-only change. This evidence is Herdr-only and case-bounded.
- **Verified live visual observation:** the Google check reached `READY`, captured a valid 1280×800 screenshot, and reported no console or page errors.

## Hypotheses

- **Human-visible surfaces are valuable beyond process isolation:** users sometimes inspect or take over child work, making tmux splits and Herdr tabs part of the product rather than an incidental launcher. **Falsifier:** usage evidence shows surfaces are never observed and a headless process offers equal utility.
- **Filesystem sidecars deliberately minimize coupling to Pi internals:** activity, question, error, loadout, and registry state cross process boundaries without a dedicated server. **Falsifier:** project history or a planned migration shows these files are temporary workarounds for an existing complete Pi IPC contract.
- **Persistent parent-scoped names are the primary usability abstraction:** IDs and paths remain internal while public message/resume tools accept exact names. **Falsifier:** future public workflows expose session or surface IDs as caller-controlled durable handles.

## Fog

- **Provider lifecycle breadth:** Stage 6 now covers six broad current-contract paths, including questions and parallel work, while the Stage 5 smoke separately covers explicit resume and kill/forget. Neither suite covers deep nesting, every race, or every provider lifecycle path. **Needed:** add bounded cases only for material uncovered paths rather than treating either suite as exhaustive.
- **Backend/provider matrix:** both model-backed tiers exercised forced Herdr only. Model-backed tmux and live Claude lifecycle behavior remain untested. **Needed:** bounded backend/provider probes, including a Claude effective-tool/settings/MCP inspection.
- **Practical scale:** there is no measured safe pane/tab count, nesting depth, or cumulative-spawn rate, and neither Stage 5 nor Stage 6 was a stress test. **Needed:** stress measurements for terminal surfaces, polling/filesystem work, provider concurrency, and nested delegation.

## Zooms

- **[HazAT original vs this fork](hazat-comparison.md) — Refines repository lineage and capability tradeoffs:** HazAT supports cmux/tmux/zellij/WezTerm; this selectively diverged fork supports tmux/Herdr and adds by-name lifecycle/sandbox behavior rather than merging HazAT wholesale.

## Frontier

- **Lifecycle zoom:** map spawn → active → waiting → completion/disappearance/kill → resume races across both backends.
- **Sandbox zoom:** trace every route by which Pi or Claude children can gain tools, extensions, credentials, or nested roles.
- **Scale zoom:** identify stable concurrency and nesting regimes for tmux panes, Herdr tabs, watchers, and providers.
