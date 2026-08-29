# System Map: interactive subagents overview

**Question:** How does `pi-interactive-subagents` turn a parent Pi session into an asynchronous, safely name-resumable hierarchy of restricted child processes across its supported terminal backends?
**Revision boundary:** The current working tree based on `f9f91ef` (package version remains `3.7.2`), including the extension entry point, mux surface layer, child lifecycle helper, session/artifact state, bundled agents, docs, and tests. Pi internals, provider behavior, and external terminal implementations are outside the boundary.
**Horizon:** One parent session selecting a backend, spawning, supervising, messaging, killing, completing, and later resuming children.
**Evidence basis:** Static inspection plus the following verification at this revision: unit 187/187; focused visual profile 2/2; lifecycle hermetics 17/17 (kill 2/2, registry 2/2, resume 13/13); mux fake-CLI 14/14; system-prompt 1 Node test with 21/21 internal assertions; forced live no-model surfaces 8/8 on Herdr and 7/7 on tmux; a post-correction forced-Herdr Stage 5 working-tree lifecycle smoke, 2/2 in 64.444s with 15 persisted `openai-codex/gpt-5.6-sol` responses and 0 provider errors; a post-correction forced-Herdr Stage 6 broad lifecycle run, 6/6 in 199.084s with 40 persisted Sol responses and 0 errors/timeouts; and a live visual browser check.

## At a glance

The extension is a **process orchestrator**, not an in-process agent pool. Each child is a separate restricted Pi or Claude Code process on a terminal surface. This fork supports exactly tmux and Herdr through the backend-neutral `mux.ts` policy/lifecycle module and private mechanics in `mux-adapters.ts`; `tmux.ts` only preserves the old import path by re-exporting `mux.ts`.

The parent returns immediately after launch. It tracks explicit surface IDs, child-owned files, and session state, then delivers completion to the parent as a follow-up notification. The surface remains pinned to the backend that created it, while persistent parent-scoped names make completed Pi sessions resumable without exposing session paths or accepting new launch controls. Stage 5 establishes public completion/resume and kill/forget on model-backed Herdr within two dedicated smoke scenarios. The separate Stage 6 broad provider-backed Herdr suite establishes six current-contract cases—completion, active status beyond the watchdog, parallel spawn, fixed-profile fork, parked question/exact-name message, and project-local discovery—not model-backed tmux or generic production behavior.

## Causal path

```text
Parent calls subagent(agent, task, optional name/model/cwd)
  → profile and nested-role policy validate the requested child
  → PI_SUBAGENT_MUX selects one available backend, or fails closed
  → the selected adapter creates a focus-preserving surface and returns its explicit ID
      tmux  → detached right split from the caller pane
      Herdr → background tab in the caller workspace with --no-focus
  → extension writes task/launch artifacts and a Pi sandbox snapshot
  → a restricted Pi or Claude Code process starts on that surface
  → watcher combines activity/session sidecars with explicit-ID screen reads
  → completion or boundedly confirmed disappearance terminates the watch
  → cleanup uses the surface's creating adapter, then completion schedules a parent follow-up turn
```

After completion, `subagent_resume(name, message)` resolves only a current-parent registry entry with durable completion proof, validates the saved Pi loadout, atomically claims the run, and starts an autonomous follow-up. While a child is live, `subagent_message` steers its surface instead. `subagent_kill(name)` takes the destructive branch: terminate the exact surface/process first, abort/suppress the watcher, remove live tracking, and conditionally forget the name while preserving transcript history.

The selection edge is deliberately strict. Exact `tmux` or `herdr` forces that backend only when available; unset auto-detects Herdr before tmux because nested or stale tmux markers can coexist with Herdr. Empty and unknown values fail closed. Executable availability is checked on each selection rather than cached indefinitely.

## Parts

| Part | Responsibility |
|---|---|
| `pi-extension/subagents/index.ts` | Agent discovery, spawn validation, sandbox assembly, running-child registry, watcher, parent tools/UI, steering, kill, and resume. |
| `pi-extension/subagents/mux.ts` | Shared backend selection, backend-neutral surface API, per-surface adapter ownership, long-command routing, close semantics, and bounded exit/disappearance policy. |
| `pi-extension/subagents/mux-adapters.ts` | Private tmux/Herdr availability checks and CLI mechanics: create, split, send, read, kill, output parsing, focus-preserving flags, layout, and missing-surface classification. |
| `pi-extension/subagents/tmux.ts` | Compatibility re-export of `mux.ts`; it owns no backend behavior. |
| `pi-extension/subagents/subagent-done.ts` | Runs inside child Pi processes; records lifecycle, supplies `ask_question`, suppresses premature auto-exit, and emits error sidecars. |
| `activity.ts` + `status.ts` | Atomic activity protocol and mapping into starting/active/waiting/stalled/running UI states. |
| `session.ts` | Seeds lineage/fork sessions, validates loadout snapshots and exact backing extensions, stores parent-scoped name/run registries, extracts current-run summaries, and calculates usage. |
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
- **Beside a Pi session:** `<session>.loadout.json` preserves model, thinking, tools, exact backing extensions, identity, cwd, agent directory, and nested-spawn allowlist for replay validation.
- **Transient IPC:** `<session>.ask` signals a parked question; `<session>.exit` reports an error; a shell/plugin sentinel catches normal process exit or crashes.
- **Surface ownership:** operations and errors stay routed to the creating adapter even if `PI_SUBAGENT_MUX` or availability changes later. New surface creation re-evaluates current selection.
- **Resume exclusion:** in-process name/session reservations plus an atomic persisted run claim prevent concurrent writers to one Pi JSONL across aliases, restarts, and parent processes.

## Generated behavior

- **Parallel fan-out/fan-in:** independent background surfaces let the parent launch several children without blocking; completion follow-ups arrive independently.
- **Focus-preserving launch:** tmux's detached split and Herdr's explicit-workspace `--no-focus` tab preserve the caller's active surface. tmux then debounces `even-horizontal` rebalance after create/close; Herdr public launches stay as background tabs.
- **Stable targeting under environment drift:** explicit surface IDs plus adapter ownership prevent a Herdr-created child from switching to tmux operations, or vice versa, after launch.
- **Bounded disappearance:** a recognized missing-surface read triggers sidecar rechecks, a short grace period, and one confirmation. Two confirmed misses produce `disappeared` instead of an indefinite poll; idempotent close treats an already absent surface as closed.
- **Repeatable completed work:** normal completion retains the current parent's Pi name mapping; safe resume can claim and replay it repeatedly, while kill/forget removes that capability.
- **Capability containment:** Pi children use `--no-extensions`, explicit tools/extensions, and a nested-role allowlist. Claude children use separately translated built-ins, `dontAsk`, no ambient settings, and empty MCP configuration; unsupported profiles refuse before launch.
- **Visible supervision:** valid child activity snapshots update the widget; absent or invalid snapshots become stalled only after the watchdog delay.

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
- **Does Pi resume preserve a restricted child's capabilities after profile/config drift? — Complicated, high confidence:** one validated loadout feeds both resume entrypoints, and invalid state fails before surface creation. **Classification challenge:** Clear after repeated model-backed mutation tests. **Discriminator:** change profile/global extensions between completion and resume, then compare effective tools and nested-spawn access.

## Established

- **Two-backend architecture and ownership:** `mux.ts`, `mux-adapters.ts`, and the `tmux.ts` compatibility re-export establish exactly tmux/Herdr support, strict selection, explicit IDs, and creating-adapter routing.
- **Backend placement/focus mechanics:** `mux-adapters.ts` establishes detached tmux right splits with debounced layout and Herdr explicit-workspace background tabs plus right/down-only no-focus splits.
- **Bounded missing-surface handling:** `mux.ts` rechecks terminal sidecars around a bounded delay, confirms recognized disappearance once, and returns `disappeared`; `mux-adapters.ts` provides backend-specific classifiers and idempotent close support.
- **Persistent parent-scoped identity:** `session.ts` and `index.ts` map exact names to Pi sessions, prove completion/ownership, reserve aliases, and conditionally forget killed mappings.
- **Fail-closed Pi resume:** `index.ts` and `session.ts` require a structurally complete replayable loadout. Missing, malformed, incomplete, empty restricted fields, or unavailable saved extensions prevent surface creation. A valid non-empty nested whitelist is required to expose any of the five lifecycle tools.
- **Verified automated evidence:** `test/test.ts` passed 187/187; `test/visual-tester-agent.test.ts` passed 2/2; lifecycle hermetics passed 17/17 (`lifecycle-kill-hermetic` 2/2, `lifecycle-registry-hermetic` 2/2, `lifecycle-resume-hermetic` 13/13); `test/mux-herdr-hermetic.test.ts` passed 14/14; and `test/system-prompt-mode.test.ts` passed 1 Node test with 21/21 internal assertions.
- **Verified live no-model evidence:** forced Herdr surfaces passed 8/8 and forced tmux surfaces passed 7/7. The cases exercised focus-preserving creation and cleanup of their tracked surfaces, but did not assert equality of the complete pre/post workspace surface sets.
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
