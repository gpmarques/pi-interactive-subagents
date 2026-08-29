# System Map: HazAT original vs Amos/gpmarques fork

**Path:** [Interactive subagents overview](interactive-subagents-overview.md) › HazAT comparison
**Question:** What materially differs between `HazAT/pi-interactive-subagents` and the Amos/gpmarques line at the compared revisions?
**Boundary:** HazAT `main` at `c100577` (`v3.7.2`) versus the current gpmarques working tree based on `f9f91ef` (package version remains `3.7.2`), covering public tools, terminal backends, lifecycle behavior, sandboxing, bundled roles, workflows, repository lineage, and verification. Linked Pi, provider, and terminal internals are outside the boundary.
**Horizon:** Current behavior at these two revisions, not a forecast of either project's roadmap.
**Evidence basis:** Static source/README comparison for HazAT; HazAT runtime suites were not executed. Fork verification at this revision: unit 187/187; focused visual profile 2/2; lifecycle hermetics 17/17 (kill 2/2, registry 2/2, resume 13/13); mux fake-CLI 14/14; system-prompt 1 Node test with 21/21 internal assertions; forced live no-model surfaces 8/8 Herdr and 7/7 tmux; a post-correction forced-Herdr Stage 5 working-tree lifecycle smoke, 2/2 in 64.444s with 15 persisted `openai-codex/gpt-5.6-sol` responses and 0 provider errors; a post-correction forced-Herdr Stage 6 broad lifecycle run, 6/6 in 199.084s with 40 persisted Sol responses and 0 errors/timeouts; and a live visual browser check.

## At a glance

These are related but behaviorally distinct systems:

- **HazAT at `c100577`:** supports cmux, tmux, zellij, and WezTerm; exposes ad hoc spawn controls, `subagent_interrupt`, path-based resume, and `/plan`/`/iterate` workflows.
- **This fork:** supports exactly tmux and Herdr through `mux.ts` plus private `mux-adapters.ts`; exposes five by-name lifecycle tools, fixed-profile nesting, parked questions, destructive kill, validated sandbox replay, and a narrower workflow layer.

The fork did not simply select one HazAT backend and did not merge HazAT wholesale. It first ported the source into a separate-root history, then redesigned lifecycle and capability boundaries. The current working tree restores a backend-neutral seam for tmux/Herdr and selectively adds Herdr; it does **not** claim HazAT's cmux, zellij, or WezTerm support.

## Decisive differences

| Dimension | HazAT original (`c100577`) | This fork |
|---|---|---|
| Supported terminal backends | cmux, tmux, zellij, WezTerm | Exactly tmux and Herdr |
| Mux organization | One public `cmux.ts` module implements policy and mechanics for four backends | `mux.ts` owns shared selection/lifecycle policy; private `mux-adapters.ts` owns tmux/Herdr mechanics; `tmux.ts` is a compatibility re-export |
| Backend selection | Optional `PI_SUBAGENT_MUX=cmux\|tmux\|zellij\|wezterm`; otherwise cmux → tmux → zellij → WezTerm | Exact `tmux`/`herdr` forces only if available; unset chooses Herdr before tmux; empty/unknown fails closed; availability is not cached indefinitely |
| Public main-session tools | Four: `subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume` | Five: `subagent`, `subagent_message`, `subagent_resume`, `subagent_kill`, `subagents_list` |
| Parent → running child | Turn-level interrupt by name or ID; no arbitrary by-name message tool | Message steering or destructive kill by exact persistent name; no interrupt tool |
| Child → parent question | `caller_ping` exits the child and asks the parent to resume it | `ask_question` parks the same Pi process until a by-name message arrives |
| Completed-session follow-up | `subagent_resume` accepts an arbitrary session path; message/name/auto-exit are optional | `subagent_resume` requires exactly current-parent `name` + non-empty `message`; completed-only, Pi-only after completion, autonomous, no launch overrides |
| Spawn schema | Required name/task; optional profile and per-call fork, interactive, model, system prompt, skills, tools, cwd | Required fixed agent/task; optional name, model, cwd |
| Nested delegation | Allowed unless spawning is disabled or lifecycle tools are denied | Denied unless `subagent_agents` exists; then restricted to those exact profile names and all five lifecycle tools |
| Pi extension/tool containment | Tool list can narrow calls, while ambient extension discovery remains active | `--no-extensions`, explicit tools and backing-extension paths, plus nested-role allowlist |
| Resume containment | Reopens a caller-supplied session path under current environment/config | Resolves only the current parent's registry and validates/replays the saved model, identity, cwd, agent dir, tools, extensions, and nested-role boundary |
| Claude policy | Bundled Claude-oriented role and Claude path under HazAT's configuration | Separately translated built-ins, `dontAsk`, no ambient settings, empty MCP config; unsupported profiles refuse; completed Claude sessions do not resume |
| Built-in commands | `/plan`, `/iterate`, `/subagent` | `/subagent` only |
| Bundled roles | planner, scout, worker, reviewer, visual-tester, claude-code | planner, researcher, reviewer, scout, visual-tester, worker |
| Visual QA | Sonnet with Chrome CDP via `scripts/cdp.mjs`/`chrome-cdp` skill | GPT-5.6 Sol through an ambient-sanitizing temporary `agent-browser` wrapper; reports evidence without editing implementation |
| Pi package namespace | Legacy `@mariozechner/*` and `@sinclair/typebox` | `@earendil-works/*` and `typebox` |
| Missing-surface polling | A screen-read failure causes a sidecar recheck and then another loop; no distinct confirmed-disappearance result | Backend-specific recognized misses are sidecar-rechecked, delayed briefly, confirmed once, then return `disappeared`; close is idempotent for an already absent surface |
| Runtime evidence here | Not executed | Exact verification record in [Established](#established) |

## Explicit resume is already implemented

The fork's `subagent_resume` is not a future ergonomic proposal. Its public schema has exactly two required fields:

```ts
subagent_resume({
  name: "worker",
  message: "Continue with the authorization tests"
})
```

The operation is completed-only and current-parent scoped. It rejects live/already-resuming aliases, missing completion proof, absent sessions, and invalid or unreplayable loadouts before process dispatch. It accepts no session path/id and no cwd, model, tools, auto-exit, interactive, or other override. A successful follow-up is always autonomous and delivers its result asynchronously. `subagent_message` retains a compatibility path for completed Pi names, but both entrypoints share the same safe implementation.

This differs from HazAT's availability-oriented resume: HazAT accepts a session path and optional message/name/auto-exit. The fork trades arbitrary historical recovery and interactive resume controls for parent ownership, duplicate-writer exclusion, and sandbox fidelity.

## Causal paths

### HazAT control path

```text
subagent(name, task, optional profile/per-call overrides)
  → select one of cmux/tmux/zellij/WezTerm
  → create and explicitly target a backend surface
  → launch Pi with the derived profile/overrides and child helper
  → child auto-exits, calls subagent_done, or caller_ping exits for help
  → parent receives completion/ping and a session path
  → parent may interrupt a live Pi turn or resume a supplied session path
```

Ad hoc per-call controls and workflow commands generate flexible one-off delegation. They also make the caller and current environment part of the capability definition on resume.

### Fork control path

```text
subagent(required agent, task, optional name/model/cwd)
  → validate exact profile, nesting permission, and reserved name
  → select tmux or Herdr under strict PI_SUBAGENT_MUX rules
  → create a focus-preserving surface and pin its explicit ID to that adapter
  → Pi: snapshot and apply resolved sandbox
    Claude: validate and apply translated no-ambient policy
  → child completes, or a Pi child parks through ask_question
  → exact persistent name chooses the next operation
      ├─ subagent_message → steer live work (completed-name compatibility may safely resume)
      ├─ subagent_resume  → claim and relaunch completed Pi work with required message
      └─ subagent_kill    → terminate, abort/suppress tracking, then forget the mapping
```

Required profiles remove HazAT's agentless/per-call capability design. Parent-scoped names and saved loadouts move durable identity away from caller-supplied paths.

## Terminal and lifecycle consequences

### Creation and focus

HazAT has broader backend coverage and substantial per-backend behavior. This comparison did not run those four environments, so source support is established but cross-backend runtime parity is not.

The fork has a smaller matrix with explicit current behavior:

- tmux public spawn creates a detached right split from the caller and debounces `even-horizontal` rebalance after creation/close.
- Herdr public spawn runs `tab create --workspace <caller workspace> ... --no-focus`, producing a background tab while preserving parent focus.
- Herdr's lower-level split seam explicitly targets the source pane and supports right/down only. Left/up reject before mutation because swap emulation would steal focus.
- Every operation stays pinned to the creating backend despite later environment drift.
- Herdr reads `recent`, falling back to `visible` only when the recent output is empty.

Forced live no-model tests passed 8/8 on Herdr and 7/7 on tmux. The cases exercised focus-preserving creation and cleanup of tracked resources, but did not assert equality of complete pre/post workspace surface sets. These observations establish the tested host paths, not every terminal version or shell. They are distinct from the model-backed tiers: the bounded Stage 5 smoke covers completion/resume and kill/forget, while the Stage 6 broad provider-backed suite covers six broader current-contract lifecycle cases. Both model-backed tiers were forced-Herdr runs; neither supplies model-backed tmux or HazAT runtime evidence.

### Destroyed surfaces and kill

The two revisions do not have equivalent destroyed-surface behavior:

- HazAT's `pollForExit` catches a screen-read failure, rechecks the exit sidecar, and otherwise continues polling. At `c100577` there is no corresponding bounded confirmation that returns a terminal `disappeared` result. Adapter/runtime behavior was not executed here.
- The fork recognizes missing surfaces through the creating adapter. Herdr accepts only structured stderr with `error.code === "pane_not_found"`. It rechecks sidecars around a bounded grace period, confirms the surface is still absent once, and returns `disappeared` rather than polling forever. A final activity/transcript proof can still recover a valid Pi completion; otherwise the watcher reports failure.
- The fork's `closeSurface` treats a recognized already-absent surface as closed. Unrelated errors remain errors rather than being guessed away.

`subagent_kill` is the fork's supported destructive path: exact name → terminate surface/process → abort and suppress watcher output → remove live tracking → conditionally forget that session mapping. It preserves the transcript. The fork has no `subagent_interrupt`; kill is not a turn-level cancellation.

An out-of-band close in either terminal can bypass extension-owned cleanup. In the fork, bounded disappearance prevents an immortal poll, but it cannot make an external close equivalent to `subagent_kill`'s full registry and suppression contract.

## Capability-boundary consequences

HazAT's declared child tools are still a whitelist for callable tools, but it does not disable ambient extension discovery. Its path-based resume launches under current configuration rather than a saved complete loadout. That favors recovery and experimentation.

The fork centralizes initial Pi launch and both completed-name entrypoints around one sandbox representation:

- omitted Pi profile tools yield only `ask_question`, not ambient Pi defaults;
- restricted children receive `--no-extensions`, an explicit tool list, and exact backing-extension paths;
- the saved loadout includes model, thinking, system-prompt identity, cwd, agent directory, tools/extensions, and nested roles;
- missing/malformed/incomplete/empty restricted state or unavailable saved extensions fails before surface creation;
- without a valid non-empty nested-role whitelist, all five lifecycle tools are suppressed on replay;
- in-process reservations and persisted run claims prevent simultaneous JSONL writers across names/aliases and parent restarts.

A complete legacy `toolAllowlist: null` snapshot remains intentionally unrestricted, so "fail closed" applies to malformed or incomplete replay state rather than rewriting that explicit historical policy. Local files are not a defense against another local process that can maliciously modify them; the boundary prevents accidental drift and caller-driven expansion.

Claude uses a separate policy because Pi extension paths cannot be replayed into Claude Code. The fork verifies required CLI flags, maps only supported built-ins, applies matching tool allowlists with `dontAsk`, disables ambient setting sources, and supplies empty MCP configuration. Profiles with unsupported tools or nested Pi spawning refuse before launch. This assembly is unit-tested but not yet verified against a live Claude runtime.

## Agent and workflow consequences

HazAT embeds a software-delivery workflow:

```text
/plan → investigate → interactive planning → implementation workers → review
/iterate → quick forked fix
```

The fork instead exposes fixed reusable roles without those orchestration commands:

```text
planner ─┬→ scout for local facts       → caller-specified plan artifact
         └→ researcher for external facts
worker  ─┬→ scout for local facts       → implementation
         └→ researcher for external evidence
reviewer                                 → read-only verdict
visual-tester → isolated agent-browser   → evidence-backed visual verdict
```

Planner and worker may spawn only scout/researcher; reviewer, scout, researcher, and visual-tester cannot spawn. The fork's planner is interactive on initial spawn but has no `/plan` workflow or todo pipeline. Any completed-session resume is autonomous/non-interactive by design, so it does not recreate the planner's initial collaboration mode.

The visual roles also differ materially. HazAT pins Sonnet and Chrome CDP tooling. The fork pins GPT-5.6 Sol and requires wrapper-only `agent-browser` calls with inherited `AGENT_BROWSER_*` variables removed, an explicit empty config, and a sanitized unique session. It may write requested evidence/reports but must not edit implementation. A live Google check reached `READY`, produced a valid 1280×800 screenshot, and reported no console or page errors.

## Ergonomic tradeoffs by actor

| Actor/task | More direct revision | Why |
|---|---|---|
| Model invoking established roles | Fork | Small fixed `agent + task` launch and persistent by-name message/resume/kill operations. |
| One-off experimental delegation | HazAT | Per-call prompt, tools, skills, fork, model, and interactive controls. |
| Human using built-in delivery workflows | HazAT | `/plan`, `/iterate`, interrupt, and interactive resume controls are integrated. |
| Capability audit or reproducible follow-up | Fork | Saved loadout, exact extension paths, current-parent registry, and completed-run proof constrain drift. |
| Recovery of arbitrary historical sessions | HazAT | Caller-supplied session paths prioritize availability. |
| Herdr user | Fork | Explicit workspace/background-tab support is implemented and live-tested. |
| cmux, zellij, or WezTerm user | HazAT | Those backends exist only in the HazAT revision compared here. |

## Repository lineage

The compared histories have separate roots and no Git merge base. The fork history records a source port (`c47a653`) followed by redesign, including a stage that supported only tmux; the current working tree adds Herdr behind a new backend-neutral seam.

Consequences:

- `git merge upstream/main` is not a normal integration path between these histories.
- Features and fixes must be selected and reconciled against the fork's changed lifecycle, sandbox, and mux contracts.
- Matching `3.7.2` package labels do not imply release ancestry or feature parity.
- The fork remains a selective port/reimplementation, not a wholesale merge of HazAT's four backend adapters or workflow layer.

## Causal regimes

- **Which revision supports more terminal environments at the compared horizon? — Clear, high confidence:** source and README expose four HazAT backends versus two fork backends. **Classification challenge:** Complicated if "supports" requires runtime verification on current backend versions. **Discriminator:** execute each revision's surface suite in every claimed environment.
- **Does the fork preserve focus and target the intended backend on its tested hosts? — Clear, high confidence for the exercised cases:** strict ownership tests plus forced live Herdr 8/8 and tmux 7/7 exercised focus-preserving creation and tracked-resource cleanup. They did not compare complete pre/post workspace surface sets. **Classification challenge:** Complicated across untested terminal/shell versions. **Discriminator:** repeat with both marker sets present, explicit whole-workspace snapshots, and after backend upgrades.
- **Do the fork's dedicated model-backed Herdr completion/resume and kill/forget paths reach persisted public outcomes and restore the workspace? — Complicated, high confidence within the two tested scenarios:** the post-correction working-tree smoke passed 2/2 in 64.444s with actual result follow-ups/tool results, 15 persisted Sol responses, and no provider errors. During the run, the harness compared exact focus and pane sets and restored `w7` to `focus=null` with panes `[w7:p1, w7:p33]`; separate post-run inspection confirmed the sole tab `[w7:t1]` and found no owned recent files or processes. Exact tab comparison was added afterward without rerunning the provider suite. **Classification challenge:** Clear if repeated runs across relevant timing/version changes remain stable. **Discriminator:** repeat the dedicated smoke after Pi/provider/Herdr changes; the broad suite tests different paths and cannot substitute for it.
- **Do the fork's broad current-contract lifecycle paths complete cleanly on provider-backed Herdr? — Complicated, high confidence within the six tested cases:** the post-correction forced-Herdr/Sol Stage 6 run passed 6/6 in 199.084s and persisted 40 Sol assistant responses with no errors/timeouts. During the run, the harness compared exact focus and pane sets and restored `w7` to `focus=null` with panes `[w7:p1, w7:p33]` after every case; separate post-run inspection confirmed the sole tab `[w7:t1]` and found no owned recent files or processes. Exact tab comparison was added afterward without rerunning the provider suite. This says nothing about HazAT runtime behavior. **Classification challenge:** Clear only with repeat evidence across relevant provider, Pi, and Herdr changes. **Discriminator:** rerun the fork suite and create equivalent bounded HazAT scenarios where the contracts align.
- **Which revision better preserves a restricted Pi capability set across completed-session follow-up? — Complicated, high confidence:** the fork validates a saved loadout and parent-owned completion claim; HazAT resumes a supplied path under current config. **Classification challenge:** Clear if repeated mutation tests expose the effective tool surface deterministically. **Discriminator:** mutate global extensions and profile tools between completion and resume in both revisions.
- **Does out-of-band surface destruction terminate fork supervision instead of polling forever? — Clear, high confidence for recognized fake-CLI errors:** two classified misses return `disappeared`. **Classification challenge:** Complicated for real terminal timing and unclassified errors. **Discriminator:** externally close real tmux and Herdr children around sidecar/sentinel publication and observe bounded watcher resolution.

## Established

- **HazAT backend and workflow surface:** the HazAT `README.md`, `cmux.ts`, and extension entry point at `c100577` establish cmux/tmux/zellij/WezTerm, four main-session tools, path-based resume, and `/plan`/`/iterate`.
- **Fork mux surface:** `pi-extension/subagents/mux.ts`, `mux-adapters.ts`, and `tmux.ts` establish exactly tmux/Herdr, shared policy, private mechanics, compatibility re-export, explicit ownership, and bounded disappearance.
- **Fork public lifecycle:** `index.ts`, `session.ts`, and this repository's `README.md` establish the five tools and exact completed-only `subagent_resume(name, message)` contract.
- **Repository divergence:** the inspected Git histories have separate roots/no merge base; the fork log records a source port followed by independent redesign rather than merged HazAT ancestry.
- **Fork automated verification:** unit 187/187; focused visual profile 2/2; kill 2/2 + registry 2/2 + resume 13/13 = lifecycle hermetics 17/17; mux fake-CLI 14/14; system-prompt 1 Node test with 21/21 internal assertions.
- **Fork live no-model verification:** forced Herdr surfaces passed 8/8 and forced tmux surfaces passed 7/7. The cases exercised focus-preserving creation and cleanup of tracked surfaces, but did not assert equality of complete pre/post workspace surface sets.
- **Fork bounded Stage 5 model-backed Herdr verification:** `env -u PI_SUBAGENT_LIFECYCLE_DISABLED PI_SUBAGENT_MUX=herdr PI_TEST_MODEL=openai-codex/gpt-5.6-sol PI_TEST_TIMEOUT=180000 npm run test:integration:lifecycle-smoke` ran `test/integration/mux-lifecycle-smoke.test.ts` and passed 2/2 in 64.444s. One scenario observed completion → actual result follow-up → public exact-name explicit resume → actual resumed result follow-up. The other observed running-child start → public exact-name kill/forget → persisted exact public result → public resume refusal. Persisted outer and child sessions contained 15 assistant responses total—9 for completion/resume and 6 for kill/forget—all Sol, with zero provider errors. During the run, the harness compared exact focus and pane sets and restored `w7` to `focus=null` with panes `[w7:p1, w7:p33]`. Separate post-run inspection confirmed the sole tab `[w7:t1]` and found no owned recent files or processes. The shared snapshot was subsequently hardened to enforce exact tab equality; the provider suite was not rerun after this harness-only change. Independent review approved both the production follow-up fix and corrected bounded harness.
- **Fork broad Stage 6 provider-backed Herdr verification:** `env -u PI_SUBAGENT_LIFECYCLE_DISABLED PI_SUBAGENT_MUX=herdr PI_TEST_MODEL=openai-codex/gpt-5.6-sol PI_TEST_TIMEOUT=120000 npm run test:integration:lifecycle` ran `test/integration/subagent-lifecycle.test.ts` and passed 6/6 in 199.084s. Its cases covered completion, a 90-second active call beyond the watchdog threshold, one-batch parallel fixed-profile children, fixed-profile fork linkage/copied context, `ask_question` followed by exact-name `subagent_message`, and visible project-local profile discovery/spawn. Outer and child sessions persisted 40 assistant responses, all `openai-codex/gpt-5.6-sol`, with 0 provider errors and 0 test timeouts. During the run, the harness compared exact focus and pane sets and restored `w7` to `focus=null` with panes `[w7:p1, w7:p33]` after every case. Separate post-run inspection confirmed the sole tab `[w7:t1]` and found no owned recent files or processes. The shared snapshot was subsequently hardened to enforce exact tab equality; the provider suite was not rerun after this harness-only change. This establishes only those fork paths on Herdr, not model-backed tmux, HazAT provider behavior, or generic production guarantees.
- **Fork live visual verification:** the Google check reached `READY` with a valid 1280×800 screenshot and no console/page errors.

## Hypotheses

- **The fork's selective-port strategy is intentional boundary preservation:** reimplementing features against fixed profiles, parent-scoped names, and saved loadouts is preferred to importing HazAT's ad hoc controls. **Falsifier:** a roadmap or subsequent changes restore arbitrary paths/per-call capability controls and wholesale workflow/backends.
- **HazAT's broader controls optimize human-led experimentation while the fork optimizes repeatable model delegation:** the schema/workflow differences align with those uses. **Falsifier:** usage evidence shows the opposite actor patterns or no meaningful ergonomic difference.

## Fog

- **HazAT runtime parity:** four adapters exist statically, but none was run for this comparison. **Needed:** current surface/focus/disappearance runs on cmux, tmux, zellij, and WezTerm.
- **Provider lifecycle comparison:** Stage 6 now covers six broad current-contract fork paths, including questions and parallel work, while Stage 5 separately covers explicit resume and kill/forget. HazAT still has no runtime evidence here, and neither fork suite covers deep nesting, every race, or every provider path. **Needed:** create equivalent bounded HazAT scenarios where the contracts align and add fork cases only for material gaps.
- **Backend/provider matrix:** both fork model-backed tiers covered forced Herdr only; model-backed tmux and live Claude lifecycle behavior remain untested. **Needed:** bounded probes for those paths.
- **High-concurrency behavior:** neither revision has evidence here for practical surface counts or deep nesting; neither Stage 5 nor Stage 6 was a stress test. **Needed:** comparable terminal/filesystem/provider contention measurements.

## Implication for parent

**Result:** Refines
**Parent item:** Two-backend architecture, lineage, and future portability.
**Parent update:** This fork supports tmux/Herdr through a backend-neutral seam, while HazAT supports cmux/tmux/zellij/WezTerm. The fork still diverges selectively rather than merging HazAT wholesale. Corrected Stage 5 evidence establishes public completion/resume and kill/forget on model-backed Herdr for two bounded scenarios; Stage 6 separately establishes six broad fixed-profile lifecycle cases on provider-backed Herdr, alongside fail-closed sandbox replay and bounded disappearance.
**Remaining fog:** Test model-backed tmux and live Claude paths, create comparable HazAT runtime probes, and measure practical scale; neither fork model-backed tier covers deep nesting, stress, or every provider path, and HazAT runtime behavior remains static-only in this comparison.
