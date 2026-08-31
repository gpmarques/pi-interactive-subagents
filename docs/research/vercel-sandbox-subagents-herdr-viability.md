# Vercel Sandbox subagents with Herdr: viability report

## Executive decision

**Verdict: CONDITIONAL GO** for a bounded proof of concept and, only if its gates pass, an opt-in execution target for selected Pi-backed children. **It is not a drop-in backend today.** Vercel provides the necessary primitives—persistent named microVMs, command/file APIs, and a supported interactive CLI path—and Vercel publishes an official integration that puts a Sandbox agent terminal in a local Herdr pane with `vercel sandbox exec --interactive`. [Vercel Sandbox](https://vercel.com/docs/sandbox) · [Herdr integration](https://vercel.com/docs/sandbox/ecosystem/herdr) · [pinned CLI implementation evidence](https://github.com/vercel/sandbox/blob/be86cc619390868ae08435fde227c6896b8acad9/packages/sandbox/src/interactive-shell/interactive-shell.ts#L40-L217)

The blocker is preserving this repository's lifecycle protocol, not drawing the terminal. Production needs a dedicated **local controller + Herdr PTY bridge + remote Pi runner** with durable, generation-scoped events. Reusing the official plugin with a custom `pi` launch command is adequate for a terminal demo, but does not preserve result, question, resume, nesting, or fail-closed ownership semantics.

| Scope | Decision |
|---|---|
| Native Pi TUI in a Herdr pane backed by Vercel | **GO for PoC** |
| Selected, non-nesting Pi children with result/question/resume | **CONDITIONAL GO** after protocol and recovery gates |
| Every current profile and feature without semantic changes | **NO-GO as a drop-in** |
| Production before the PoC gates below pass | **NO-GO** |

## Scope and evidence

Research/design only: no dependencies installed, account authentication, Vercel API call, paid workload, or cloud resource creation occurred.

- **Verified — repository:** observed at commit `b403b02484aa545b72a0a852aee9ecce524fa6f8`, with local path/lines cited.
- **Verified — upstream:** official Vercel or Herdr docs/source at the linked URL.
- **Proposal:** recommended but not implemented or proven.
- **Unknown/gate:** must be measured in the PoC.

A Vercel **Sandbox** is a long-lived named entity; a **session** is one VM boot. Stop can preserve a persistent Sandbox's filesystem, but resume starts a new VM and new processes. [Persistence model](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes#sandboxes-and-sessions)

## 1. Current contract and incompatibilities

The extension is more than a terminal launcher:

1. It selects exactly `tmux` or `herdr`; `PI_SUBAGENT_MUX` accepts only those values and surfaces remain pinned to their creating adapter. **Repository:** `pi-extension/subagents/mux.ts:20-55,123-150`.
2. The Herdr adapter creates a **local** tab/split, runs a local shell command, reads local pane history, and closes that pane. **Repository:** `pi-extension/subagents/mux-adapters.ts:237-318`.
3. Launch preflights locally installed extensions, creates a local deterministic JSONL path, writes local loadout/task artifacts, exports local absolute paths, and invokes local `pi`. **Repository:** `pi-extension/subagents/index.ts:2546-2641,2735-2827,2834-2866`.
4. The watcher polls local `.exit`/sentinel files and pane output and reads local activity/settled records. Pane disappearance is not success unless durable activity plus current-run transcript proves completion. **Repository:** `pi-extension/subagents/mux.ts:240-303,327-422`; `pi-extension/subagents/index.ts:3015-3089`.
5. Results come from entries appended to local JSONL and include local session path/id/stats. **Repository:** `pi-extension/subagents/index.ts:3143-3189,3426-3462`.
6. `ask_question`, `agent_settled`, nested-child waiting and auto-exit are semantic child-extension state, not screen heuristics. **Repository:** `pi-extension/subagents/subagent-done.ts:234-355,438-465`.
7. Resume uses a parent-scoped registry and fail-closed loadout binding tools, extension paths/digests, model, identity, cwd, agent directory and nested-spawn boundary. **Repository:** `pi-extension/subagents/session.ts:84-159,183-225,319-413`.
8. Kill terminates the owning surface first; uncertain termination leaves tracking intact. **Repository:** `pi-extension/subagents/index.ts:1793-1884`.

A generic remote Pi terminal breaks items 3–8 because no shared filesystem exists, host absolute paths are invalid remotely, and a process inside Vercel cannot call the host's local Herdr socket.

## 2. What upstream already proves

- Each Sandbox is a Firecracker microVM with dedicated kernel, private filesystem, process isolation, network namespace, resource limits and timeout. Vercel contrasts this with Docker's shared host kernel. **Upstream.** [Concepts](https://vercel.com/docs/sandbox/concepts#sandboxes-vs-containers) · [isolation](https://vercel.com/docs/sandbox/concepts#isolation-architecture)
- The interactive CLI calls `openInteractive()`, opens a tokenized WebSocket, sends command/env/cwd/rows/columns, forwards raw stdin/stdout, receives an exit frame, and forwards resize events. **Upstream.** [PTY source](https://github.com/vercel/sandbox/blob/be86cc619390868ae08435fde227c6896b8acad9/packages/sandbox/src/interactive-shell/interactive-shell.ts#L40-L217)
- SDK/CLI capabilities include streamed commands, file read/write/download, non-interactive command signals, names, stop/resume and snapshots. **Upstream.** [SDK reference](https://vercel.com/docs/sandbox/sdk-reference) · [command signals](https://github.com/vercel/sandbox/blob/be86cc619390868ae08435fde227c6896b8acad9/packages/vercel-sandbox/src/command.ts#L325-L359)
- Vercel's official Herdr plugin maps one local pane to one persistent named Sandbox, connects with `vercel sandbox exec --interactive`, uses local Vercel CLI auth, reviewed uploads, in-Sandbox agent auth, explicit reconnect/stop/delete and conflict-checked Git patches. **Upstream.** [Herdr workflow](https://vercel.com/docs/sandbox/ecosystem/herdr#how-it-works) · [plugin control flow](https://github.com/vercel-labs/herdr-vercel-sandbox-plugin/blob/be8393aac17eae4b67ca58fdcc5ad8233f91b6c5/docs/design.md#control-flow)
- Built-in adapters cover Claude Code, Codex and OpenCode. Custom terminal agents are declarative and explicitly unverified; Pi is not built in. **Upstream.** [Custom agents](https://vercel.com/docs/sandbox/ecosystem/herdr#custom-agents)
- Herdr `--remote` is SSH, not a general Vercel transport. Automation otherwise uses a local Unix socket/named pipe. **Upstream.** [Remote access](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/docs/next/website/src/content/docs/persistence-remote.mdx) · [socket API](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/docs/next/website/src/content/docs/socket-api.mdx)

**Conclusion:** terminal transport and product precedent are verified; a Pi-specific lifecycle/control plane is not.

## 3. Platform viability

### Lifecycle and persistence

Persistence is default. Stop snapshots the filesystem; resume creates a new VM session. Processes do **not** survive, so `onResume` exists to restart services. Snapshot expiry defaults to 30 days after last use; `0` means no expiry; `keepLastSnapshots: { count: 1 }` bounds retained history. A Sandbox unable to resume is removed after 14 inactive days. Deleting a Sandbox does not delete its snapshots, which remain billable until deleted/expired. **Upstream.** [Persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes)

Thus “ephemeral VM” and “persistent Sandbox” are compatible descriptions: process/VM state is ephemeral; the named entity, configuration and snapshotted filesystem persist. A Vercel timeout/stop is an **interruption**, never proof of Pi completion.

### PTY, streaming, files and signals

For the initial PoC, the supported transport is a pinned local Vercel CLI subprocess—`vercel sandbox exec --interactive`—running in the Herdr pane exactly as the official plugin does. The plugin's concrete form is `exec --interactive --workdir <remoteCwd> <sandboxName> -- sh -lc <launch>`, with local terminal restoration in `finally`. **Upstream.** [Herdr integration](https://vercel.com/docs/sandbox/ecosystem/herdr#how-it-works) · [plugin bridge source](https://github.com/vercel-labs/herdr-vercel-sandbox-plugin/blob/be8393aac17eae4b67ca58fdcc5ad8233f91b6c5/src/bridge.mjs#L207-L234)

The pinned CLI source shows that its current implementation uses `openInteractive()`, a tokenized WebSocket, raw input/output, resize messages, exit frames and periodic timeout extension. That source is **implementation evidence, not a public guarantee of the underlying WebSocket framing protocol**. [Interactive source](https://github.com/vercel/sandbox/blob/be86cc619390868ae08435fde227c6896b8acad9/packages/sandbox/src/interactive-shell/interactive-shell.ts#L141-L217) · [timeout extension](https://github.com/vercel/sandbox/blob/be86cc619390868ae08435fde227c6896b8acad9/packages/sandbox/src/interactive-shell/extend-sandbox-timeout.ts#L10-L38)

**Blocked for the initial PoC:** reimplementing the CLI's WebSocket client directly. It requires Vercel confirmation or a stable documented public protocol and, regardless, must pass an explicit compatibility gate against the pinned CLI. Unknown CLI-level behaviors still include Ctrl-C/Ctrl-Z, abrupt transport loss, bridge crash, UTF-8 frame boundaries, alternate-screen redraw, bracketed paste, and whether disconnect kills the launched shell/process group. File APIs can transfer control records and transcript mirrors, but are not a shared mount. The official plugin likewise uses upload plus explicit Git patch, not continuous synchronization. [SDK files](https://vercel.com/docs/sandbox/sdk-reference) · [Herdr apply](https://vercel.com/docs/sandbox/ecosystem/herdr#apply-changes-locally)

### Network and ports

`networkPolicy` defaults to `allow-all`; `deny-all` blocks egress including DNS; custom policies deny by default and allow specified domains/CIDRs. Domain filtering has documented SNI/domain-fronting limits, and broad CIDRs or unrestricted DNS can defeat narrow intent. The firewall can broker HTTP credentials without exposing them in the VM and can proxy requests with Vercel OIDC identity. **Upstream.** [Firewall](https://vercel.com/docs/sandbox/concepts/firewall)

Exposed ports receive public URLs, and traffic both ways is billable. The proposed design needs **no exposed application port**: use authenticated Vercel control/interactive channels. [Network access](https://vercel.com/docs/sandbox/concepts#network-access) · [network pricing](https://vercel.com/docs/sandbox/pricing#network)

**Proposal:** allow dependency preparation under a reviewed policy, then tighten egress before Pi starts. Permit only provider/tool destinations; prefer credential brokering where compatible; do not grant GitHub/SSH credentials by default.

### Authentication and secrets

Vercel recommends OIDC. Local `vercel link && vercel env pull` yields a `VERCEL_OIDC_TOKEN` expiring after 12 hours; Vercel-hosted production renewal is automatic. External hosts can use access token plus team/project IDs. [Authentication](https://vercel.com/docs/sandbox/concepts/authentication)

The official plugin keeps Vercel credentials local; agent login occurs inside the persistent Sandbox. [Herdr credentials](https://vercel.com/docs/sandbox/ecosystem/herdr#how-it-works)

**Proposal:** keep Vercel control credentials local. Establish provider credentials interactively, broker them, or inject explicitly scoped short-lived credentials. Follow the plugin's reviewed manifest and exclude `.git`, `.vercel`, env files, SSH/cloud credential paths and token-like content. Treat snapshots as sensitive when they preserve agent login.

### Limits, regions and pricing

Regions are `iad1` (default), `sfo1`, `cle1`, and `cdg1`; snapshots are regional; failover is unavailable on Hobby/Pro trials and with drives. [Regions](https://vercel.com/docs/sandbox/concepts/regions)

| Plan | Max session | Concurrent | Max vCPU/RAM | Disk/ports |
|---|---:|---:|---:|---:|
| Hobby | 45 min | 10 | 4 / 8 GB | 32 GB / 15 |
| Pro | 24 h | 10,000 | 8 / 16 GB | 32 GB / 15 |
| Enterprise | 24 h | 10,000 | 32 / 64 GB | 32 GB / 15 |

Default timeout is 5 minutes; the maximum resets per resumed session. [Limits](https://vercel.com/docs/sandbox/pricing#quotas-and-limits)

At `iad1`, Pro lists `$0.128` per active vCPU-hour, `$0.0212` per provisioned GB-hour (one-minute minimum), `$0.15/GB` billable network, `$0.08/GB-month` snapshots, and `$0.60/million` creations. Downloads are free; egress and all exposed-port traffic are billable. Hobby includes 5 CPU-hours/month, 420 GB-hours memory, 5,000 creations, 20 GB transfer and 15 GB lifetime snapshots, then pauses creation rather than charging. [Pricing](https://vercel.com/docs/sandbox/pricing#pricing)

Calculated from those rates, a default 2-vCPU/4-GB child for one hour costs about `$0.0848` memory plus at most `$0.256` active CPU at full utilization: about `$0.3408` before network, snapshots and model tokens. Pro is the practical baseline for sessions over 45 minutes.

## 4. Architecture options

### A. Official plugin + custom Pi profile

Smallest terminal PoC; reuses upload, auth, pane mapping, patch and deletion UX. But its custom profile only describes install/version/launch/auth/detection/resume. It has no run ID, JSONL cursor, settled records, parent result messages, name registry, loadout verification, question or nested-child contract. Plugin start is an explicit action; natural-language typing into another agent does not invoke it. [Plugin README](https://github.com/vercel-labs/herdr-vercel-sandbox-plugin/blob/be8393aac17eae4b67ca58fdcc5ad8233f91b6c5/README.md#mental-model)

**Decision:** terminal/auth smoke only; not production.

### B. Dedicated controller + bridge + remote runner (**recommended**)

```text
local parent Pi extension
  ├─ durable registry and event delivery cursor
  ├─ VercelController (local credentials)
  └─ local Herdr pane
       └─ pinned `vercel sandbox exec --interactive` subprocess
            ├─ terminal presentation → remote tmux/PTY → native Pi TUI
            └─ controller watches events and writes durable command inbox

persistent Sandbox
  ├─ /vercel/sandbox/workspace            reviewed Git snapshot
  ├─ privileged runner/control code        immutable to Pi user
  └─ control/<runId>/                      runner-brokered narrow IPC
       ├─ manifest + generation/lease
       ├─ session.jsonl + loadout.json
       ├─ events/<sequence>.json
       ├─ inbox/<generation>/<commandId>.json
       ├─ acks/<generation>/<commandId>.json
       └─ artifacts/
```

The **surface remains Herdr**; Vercel is an **execution target**, not a third mux. A remote tmux/supervisor lets transient local bridge loss detach without necessarily killing Pi. A full Sandbox session stop still destroys processes and requires a new Pi generation from persisted JSONL.

Terminal bytes are presentation only. The supported CLI subprocess is the initial transport boundary; a direct WebSocket implementation is not part of the PoC. The local controller owns Vercel calls, mapping, inbox writes, event validation, acknowledgements and cleanup. The remote runner owns process creation, process-group termination, journal and remote loadout verification.

### C. Remote Pi RPC/headless + local UI proxy

Structured by nature, but requires a new local TUI or framed RPC-over-PTY and changes native interaction. **Decision:** defer; larger than native TUI plus narrow lifecycle journal.

## 5. Proposed lifecycle and state authority

### State machine

```text
reserved → provisional → creating → preparing → ready
  → running ↔ waiting(awaiting_answer | waiting_on_children | idle)
  → completing → completed → stopped

active states may become interrupted, missing, failed, kill-pending or deleted
```

Rules:

1. Persist provisional local mapping before creation. Once remote creation succeeds, retain the mapping through later setup failures, following the official plugin's orphan-avoidance pattern. [Plugin lifecycle](https://github.com/vercel-labs/herdr-vercel-sandbox-plugin/blob/be8393aac17eae4b67ca58fdcc5ad8233f91b6c5/README.md#lifecycle-actions)
2. Every run has immutable `runId` and increasing `generation`; every controller command is identified by `(runId, generation, commandId)`.
3. The durable inbox is the **sole authoritative controller-to-Pi path**. A Pi-side extension consumes and deduplicates commands by that tuple, persists a receipt before dispatch, and then persists an `applied` or `rejected` acknowledgement. The controller does not consider the command complete without that terminal acknowledgement. Event delivery remains at-least-once with idempotent event IDs and a durable parent cursor.
4. `completed` requires a runner terminal event plus valid current-generation transcript boundary. Pane/socket loss, stop and stale `agent_end` do not count.
5. Kill sends TERM to the known process group/remote tmux, escalates, verifies absence, then optionally stops the Sandbox. Pane close alone is not kill.
6. Stop, kill and delete are distinct. Destructive deletion remains human-confirmed.

### Session, loadout and workspace

**Proposal: remote canonical state.** Version the registry from a local-only `sessionFile` to a tagged locator:

```ts
type SessionLocator =
  | { kind: "local"; sessionFile: string }
  | {
      kind: "vercel";
      teamId: string;
      projectId: string;
      sandboxName: string;
      remoteSessionFile: string;
      sessionId: string | null;
      runId: string;
      generation: number;
      localMirror?: string;
    };
```

- Upload a reviewed Git snapshot; never pass host absolute paths to remote commands.
- Seed standalone/lineage/fork JSONL remotely; upload only bounded validated context.
- Resolve and hash Pi/tool extensions **inside** the remote image. Host digests cannot prove remote executables. Store the canonical remote loadout and a local digest/mirror.
- Put task/skill artifacts remotely and pass remote `@path` arguments.
- Extract current-run result/stats remotely at the saved line boundary. Download an immutable final JSONL mirror for inspection; resume from remote canonical JSONL.
- Keep source changes separate from control artifacts. Return source through baseline/tag/binary Git patch and local `git apply --check`. [Official patch flow](https://vercel.com/docs/sandbox/ecosystem/herdr#apply-changes-locally)
- Document that synchronization is not live; patch conflicts are explicit.

### Activity, questions and results

The child publishes immutable atomic event records matching today's semantic states. Parent validates protocol version, sandbox, `runId`, generation and sequence.

- Activity/heartbeat drives status.
- `agent_settled` emits one `settled` event: `awaiting_answer`, `waiting_on_children`, or `idle`, with latest response/question.
- `ask_question` parks Pi. Parent delivers `subagent_question`; the answer is one durable inbox command keyed by `(runId, generation, commandId)`. The Pi-side extension checks its persisted acknowledgement journal, applies an unseen command once at a supported turn boundary, and persists the outcome so reconnect/replay is deduplicated.
- Controller-initiated steering, answers and follow-up prompts use that same inbox only. The controller must **never also write the durable command into raw PTY bytes**.
- Direct human typing in the Herdr PTY remains available but is explicitly best-effort, non-durable and outside controller acknowledgements. It may be lost across disconnect/recovery and must not be replayed automatically.
- Infrastructure kill/stop remains a runner lifecycle operation; it is never simulated with terminal keystrokes.
- Terminal event is emitted after process exit and JSONL flush; only then does parent deliver result and mark completed.
- Replacement bridges drain events and inbox acknowledgements from the last persisted cursors. Herdr screen classification never establishes semantic state.

### Reattach, recover and completed resume

1. **Reattach:** Pi still runs in the same VM session; connect a new bridge to existing remote tmux.
2. **Recover:** VM session stopped, so old process is gone; restore filesystem, verify state/loadout, increment generation, relaunch from JSONL.
3. **Resume completed:** current `subagent_resume` behavior—new autonomous run after proven completion and exact loadout validation.

Automatic Sandbox resume must not imply automatic Pi recovery. `onResume` should reconcile only; controller authorizes a new writer.

### Nested spawning

**MVP:** reject remote-eligible profiles with `subagent_agents` before creating a Sandbox. A remote child cannot call the host's local Herdr socket, and Vercel credentials must not be copied into it.

**Future:** remote nested tools call a narrow authenticated local controller that creates the grandchild pane/Sandbox and routes results to the parent's inbox. This needs lineage, quota propagation, cancellation trees and two-journal recovery; it is a separate milestone.

## 6. Compatibility matrix

| Behavior | Custom terminal profile | Recommended runner | MVP |
|---|---:|---:|---|
| Native Pi TUI in Herdr | Yes | Yes | Required |
| Controller message steering | Fragile terminal injection | Durable inbox + Pi-side dedupe/ack; no PTY duplication | Required |
| Direct human typing | Yes, best-effort | PTY presentation only; non-durable | Required, explicitly separate |
| Ordered idle/question delivery | No | Event journal | Required |
| Current-run result | No | JSONL boundary + terminal event | Required |
| Activity/widget fidelity | Screen detection only | Semantic events | Required |
| Kill proves remote death | Unknown | PGID/tmux verification | Required |
| Completed resume | Generic adapter only | Remote loadout validation | Required |
| Parent/Herdr restart recovery | Mapping/reconnect only | Locator + journal + generations | Required |
| Fork/lineage | No | Remote seed | Required for selected profiles |
| Tool identity | No | Resolve/hash remotely | Required |
| Safe writeback | Git patch | Reuse patch flow | Required for writers |
| Nested children | No | Controller delegation | Deferred/rejected |

Herdr restores layout but not arbitrary pane processes after full server restart; unsupported panes return as shells. [Herdr session state](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/docs/next/website/src/content/docs/session-state.mdx) The Vercel plugin therefore uses explicit reconnect. [Reconnect](https://vercel.com/docs/sandbox/ecosystem/herdr#herdr-was-detached-or-restarted)

## 7. Module-level change plan

All changes are proposals.

| Path | Change |
|---|---|
| `mux.ts`, `mux-adapters.ts` | Keep local presentation; do not add `vercel` mux. Make local script-file behavior target-specific. |
| `execution-target.ts` (new) | `RunController`: prepare, launch, steer, subscribe/reconcile, kill, stop, resume, delete, export. |
| `vercel/controller.ts` (new) | Auth/project resolution, lifecycle, policies, mapping, budget and retries. |
| `vercel/bridge.ts` (new) | Spawn and supervise the pinned `vercel sandbox exec --interactive` CLI, restore local terminal state, classify disconnect/exit; no direct WebSocket implementation in the PoC. |
| `vercel/protocol.ts` (new) | Strict versioned event, `(runId, generation, commandId)` inbox command, locator, manifest and persisted-ack schemas. |
| `vercel/runner/` (new) | Separate privileged setup/supervisor identity, journal, PID/PGID/tmux ownership, loadout verification, result extraction and least-privilege IPC. |
| Pi-side remote extension (new) | Consume/dedupe the durable inbox, apply controller commands at Pi turn boundaries, and persist acknowledgements; never mirror commands into PTY input. |
| `index.ts` | Target selection; target-neutral launch/watch/result; startup reconciliation. Largest seam. |
| `session.ts` | Version registry for local path or remote locator; remote mirror and target-specific loadout validation. |
| `subagent-done.ts` | Remote event sink while retaining current local sink. |
| `activity.ts`, `status.ts` | Remote heartbeat/event input and disconnected/interrupted/recovering states. |
| profile/config parsing | Explicit target, region, resources, timeout, persistence, egress, retention, writeback; reject incompatible profiles pre-create. |
| tests | Protocol, migration, stale generation, kill, reconnect, stop/recovery, patch and security suites. |

Do not overload `PI_SUBAGENT_MUX=vercel`; it currently means presentation and accepts only `tmux|herdr` (`mux.ts:27-31`). Use separate `execution-target: vercel`.

## 8. Security controls

1. One selected child per Sandbox initially. Create a distinct Pi user with `Sandbox.createUser`; run Pi commands/files as that `SandboxUser`, with a private home. The Pi identity must have **no sudo or admin capability**. Privileged image setup and the trusted runner use a separate identity; the worktree user cannot modify runner/control code. Before every launch and again after each resume, fail closed unless checks confirm the expected UID, groups, empty effective capabilities, no sudoers/admin grant, directory ownership/modes, and the exact inbox/event/ack IPC permission matrix. [Multi-user Sandboxes](https://vercel.com/docs/sandbox/concepts/multi-agent) · [isolation](https://vercel.com/docs/sandbox/concepts#isolation-architecture)
2. Exact upload manifest/digest, second-action approval, credential filters and exact-file override, modeled on the plugin. [Reviewed uploads](https://vercel.com/docs/sandbox/ecosystem/herdr#how-it-works)
3. Deny-by-default egress with documented DNS/CIDR/SNI caveats; broker credentials where compatible. [Firewall](https://vercel.com/docs/sandbox/concepts/firewall)
4. No public control port.
5. Reject unknown protocol versions/fields, oversized payloads, traversal, wrong run/generation and non-monotonic sequence.
6. Pin CLI/SDK, image, Pi, runner and extension identities; validate remotely before launch/resume.
7. Bounded snapshot retention, explicit snapshot deletion, access audit and disclosure of persisted login. [Retention](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes#default-snapshot-expiration-and-retention)
8. No host Git credentials by default; patch-check before apply; no automatic commit/push.
9. Hard concurrency, timeout, inactivity, daily-spend and orphan controls. [Cost controls](https://vercel.com/docs/sandbox/pricing#managing-costs)
10. Stop is reversible; delete is separately confirmed and partial deletion checkpointed. [Plugin safety](https://github.com/vercel-labs/herdr-vercel-sandbox-plugin/blob/be8393aac17eae4b67ca58fdcc5ad8233f91b6c5/docs/design.md#safety-boundaries)

## 9. Failure behavior

| Failure | Required behavior |
|---|---|
| Pane create fails | Remove provisional state; no Sandbox should exist. |
| Remote create succeeds, setup fails | Retain failed mapping; retry/stop/delete; no implicit duplicate. |
| Upload differs after approval | Reject; require new manifest approval. |
| PTY open/drop | Retry boundedly; mark disconnected, never completed. |
| Herdr server restart | Replacement bridge; do not assume pane process survived. [Source](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/docs/next/website/src/content/docs/session-state.mdx) |
| Vercel timeout/stop | Mark interrupted; filesystem may survive, process does not. [Source](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes#lifecycle-hooks) |
| Snapshot/Sandbox missing | Explicit `missing`; never silently replace old identity. |
| Parent crash around delivery | Idempotent redelivery; cursor advances with durable delivery bookkeeping. |
| Duplicate controller | Lease fails closed; one JSONL writer only. |
| Stale question reply | Reject wrong message ID/generation. |
| Malformed remote journal | Quarantine, protocol error, no state advancement. |
| Kill uncertain | Keep `kill-pending/unknown`; do not forget name. |
| Stop reports ambiguous success | Query actual state; plugin documents exit-0-with-failure output. [Source](https://github.com/vercel-labs/herdr-vercel-sandbox-plugin/blob/be8393aac17eae4b67ca58fdcc5ad8233f91b6c5/src/bridge.mjs#L66-L83) |
| Patch conflict | Apply nothing; retain remote changes. |
| Auth/egress failure | Surface exact cause; never broaden policy automatically. |
| Partial cleanup | Checkpoint each deletion; retain unresolved resource IDs. |

## 10. PoC, tests and hard gates

### Stage 0 — contract seam, no cloud (1–2 engineer-days)

Define protocol and fake `RunController`; route existing local behavior through the seam; add registry migration tests.

**Gate:** current tmux/Herdr launch, question, result, resume and kill remain semantically identical; feature off by default.

### Stage 1 — interactive spike (2–3 days)

With later explicit approval, use a non-sensitive fixture and one non-nesting profile in one short-lived Sandbox. Launch through the pinned local `vercel sandbox exec --interactive --workdir <remoteCwd> <sandboxName> -- sh -lc <launch>` subprocess, matching the official plugin; do not implement the WebSocket protocol. Exercise direct human typing, multiline paste, Unicode, Ctrl-C, resize, alternate screen, idle/active timeout, CLI subprocess kill/restart and Herdr detach/restart. Verify no public port and exact cleanup.

**Gate:** no input corruption, duplicate Pi writer or false completion; remote state observable without screen inference; direct protocol reimplementation remains blocked unless Vercel documents/confirms it and it passes a pinned-CLI compatibility suite.

### Stage 2 — lifecycle protocol (3–5 days)

Implement journal/acks, activity, settlement, result/stats and process-group kill. Route every controller steer/question answer through the durable inbox; have the Pi-side extension dedupe `(runId, generation, commandId)` and persist acknowledgement. Crash controller/runner/Pi at every inbox consume/apply/ack and event write/ack boundary.

**Gate:** one parent-visible semantic notification per event ID under retries; one application per command tuple; no controller command is duplicated into PTY input; stale generations cannot steer/complete; kill cannot report success while Pi lives.

### Stage 3 — persistence/writeback (3–5 days)

Force stop mid-turn; recover from JSONL to new generation; prove completed resume and loadout-drift refusal; conflict/check/apply binary patch; delete/expire fixture snapshot.

**Gate:** no duplicate writer/stale result; loadout fails closed; source changes occur only after patch check.

### Stage 4 — security/cost (2–4 days)

Seed fake credentials; create the dedicated Pi user; verify UID/groups, sudo denial, empty capabilities, ownership and least-privilege inbox/event/ack IPC before launch and after resume; attempt control-area writes as that user; test egress policies and optional brokering; then verify timeout/concurrency/orphan/retention/deletion.

**Gate:** security/product acceptance and no unresolved high-severity issue.

### Hard stop conditions

Choose Docker/SSH if any cannot be deterministic without private APIs:

- The supported CLI subprocess cannot provide reliable interaction/recovery and success would require copying an undocumented WebSocket protocol without Vercel confirmation or a stable public contract.
- Disconnect leaves an unidentifiable Pi writer that cannot be reattached or killed safely.
- Runner cannot distinguish VM interruption from completion.
- Remote loadout/session identity cannot be proven before resume.
- Required auth needs broad long-lived host secrets and brokering is unworkable.
- Required profiles need host sockets/paths or nesting cannot be deferred.

### Required tests

- Protocol version/size/path validation; sequence gaps/duplicates/reordering; stale generation.
- Registry migration, claim collision and fail-closed abandoned ownership.
- Crash before/after event delivery/ack; late settled versus terminal event.
- Inbox replay around consume/apply/ack; tuple dedupe; persisted ack recovery; proof that controller steering never also enters PTY bytes; separate best-effort human typing.
- Kill TERM/KILL/uncertain/already-absent paths.
- Image/Pi/extension/loadout drift; manifest exclusion/digest invalidation.
- Binary patch, traversal, conflict and duplicate apply.
- Fake SDK with delayed/duplicated streams, stopped sessions and missing snapshots.
- Pinned CLI subprocess fixture for split UTF-8, resize, raw-mode restoration and abrupt close; any future direct protocol implementation must run the same compatibility corpus.
- Dedicated-user checks before launch/after resume: UID/groups, sudo denial, Linux capabilities, ownership and inbox/event/ack IPC permissions.
- Bounded live cases for completion, idle, question, steer, kill, bridge/Herdr restart, stop/recovery, completed resume, patch conflict and deletion.
- After each live case, list exact named Sandboxes/snapshots and fail on any owned leak; record all pinned versions and usage.

## 11. Rollout and rollback

1. Explicit experimental per-profile/spawn flag; local remains default.
2. Read-only/non-nesting profiles first; writers only after patch gates.
3. Preserve local registry compatibility; never interpret remote locator as local path.
4. Global kill switch disables **new** remote launches while leaving stop/export/delete/recovery available.
5. Low-concurrency canary with hard daily budget/retention; monitor failures, reconnects, interruptions, stale leases, uncertain kills, orphans, patch conflicts and cost/completion.
6. Rollback: disable creation; drain/kill; export wanted patches; stop; mirror transcripts; human-confirm deletion of Sandboxes and snapshots; preserve local audit records. Keep recovery code until no mappings remain.

## 12. Comparison: Vercel, local Docker, SSH

| Criterion | Vercel | Local Docker | SSH host + Herdr |
|---|---|---|---|
| Isolation | Dedicated Firecracker kernel; strongest default for untrusted code. [Source](https://vercel.com/docs/sandbox/concepts#sandboxes-vs-containers) | Shared host kernel; needs local hardening. | Depends on host/tenant setup. |
| Herdr | Official PTY bridge precedent; not native remote mode. [Source](https://vercel.com/docs/sandbox/ecosystem/herdr) | Native local pane; lowest latency. | Native `herdr --remote` over SSH. [Source](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/docs/next/website/src/content/docs/persistence-remote.mdx) |
| Files | Upload/copy/patch; no host mount. | Bind mount preserves current path assumptions. | Remote FS; Git/rsync policy owned by team. |
| Processes | Die at Vercel session stop; FS resumes. | Controlled by local host/container policy. | Can be long-lived; no Vercel session cap. |
| Integration effort | Highest: protocol/reconciliation. | Lowest: shared local controller/files. | Medium: remote deployment/runner. |
| Credentials/network | Managed microVM/firewall/brokering; snapshots need governance. | Docker socket/mounts sensitive; operator egress. | SSH keys, patching, isolation owned by operator. |
| Scale/cost | Managed burst/concurrency; metered. [Source](https://vercel.com/docs/sandbox/pricing) | Developer-machine limits; no cloud meter. | Team capacity and server cost. |

If the goal is only “keep tools off the host,” local Docker should come first: it preserves shared files and the watcher. If hardened development VMs already exist and long-lived sessions matter, SSH is simpler. Choose Vercel when managed microVM isolation, burst concurrency, disposability and egress controls justify the new protocol and metering.

## 13. Prerequisites, effort, blockers and decisions

### Prerequisites

- Herdr `0.7.5+`, Node `20+`, Git, linked Vercel team/project and eligible account. Current plugin README requires Vercel CLI `58.7.1+`, stricter than the tutorial's `56.2.0+`; pin the stricter minimum and preflight it. [Plugin requirements](https://github.com/vercel-labs/herdr-vercel-sandbox-plugin/blob/be8393aac17eae4b67ca58fdcc5ad8233f91b6c5/README.md#requirements) · [Tutorial](https://vercel.com/docs/sandbox/ecosystem/herdr#prerequisites)
- Pro/Enterprise for configured sessions over 45 minutes. [Limits](https://vercel.com/docs/sandbox/pricing#runtime-limits)
- Reproducible Linux image with pinned Pi, runner and extensions.
- At least one Linux-compatible, non-nesting profile without host-only paths/sockets.
- Security owner for upload/egress/secrets/snapshots and product owner for cost/retention/deletion.

### Effort bands

Assumes one experienced TypeScript/Node engineer plus security/product review; excludes procurement/compliance and upstream contribution.

| Scope | Estimate |
|---|---:|
| Terminal/auth spike and protocol | **3–5 engineer-days** |
| Selected non-nesting MVP with result/question/kill/recovery/patch | **3–6 engineer-weeks** |
| Production hardening, profiles, observability, migration, recovery UX | **8–12+ engineer-weeks total** |
| Later nested-spawn milestone | **+4–8+ engineer-weeks** |

Planning estimates, not commitments; PTY/process recovery has the largest variance.

### Blockers

1. No verified Pi adapter in the official plugin.
2. No target-neutral run-control abstraction locally.
3. Session/activity/sentinel/loadout authority is local-path based.
4. End-to-end interactive disconnect/signal/reattach semantics are unproven.
5. No durable remote journal/inbox, generation or controller lease.
6. No agreed provider-auth/egress/snapshot-secret policy.
7. No remote-safe nesting; MVP must reject it.
8. No selected-profile Linux compatibility/image receipt.
9. No cost, retention, deletion or orphan owner.

### User/product decisions

1. Which named profiles are remote-eligible; are nested, Claude, GUI/browser and host-integrated profiles excluded?
2. Explicit spawn target, per-profile default or automatic policy? Explicit opt-in is recommended.
3. Accept remote-canonical sessions with local mirror/`vercel://` locator, or demand continuous local transcript mirroring?
4. Reviewed upload + explicit Git patch (recommended), remote Git credentials, or another sync model?
5. Interactive provider login, short-lived key injection or credential brokering; may auth persist in snapshots?
6. Exact allowed domains/tools; default-deny; temporary preparation egress?
7. Stop on inactivity and explicit recover, or automatic recover? Timeout/max task length?
8. Snapshot count/TTL, transcript retention, deletion confirmation and orphan owner?
9. Plan, region/data residency, concurrency and daily spend cap?
10. If recovery is unreliable, choose Docker or SSH rather than weakening completion/kill guarantees?

## Final recommendation

Authorize only the staged PoC. Implement Vercel as an execution target behind Herdr, not a mux; use the pinned `vercel sandbox exec --interactive` subprocess exactly like the official plugin; keep direct WebSocket reimplementation blocked; borrow the plugin's upload/auth/mapping/patch/deletion safeguards; and make the runner journal plus Pi-side durable inbox/ack path authoritative. Start with one non-nesting read-mostly profile under a distinct no-sudo user, short sessions and no public ports.

Promote only after interruption-versus-completion, process kill proof, single-writer recovery, event replay, remote loadout identity, secret-safe auth and cleanup all pass. Until then, Docker is the lower-effort isolation path and SSH the lower-complexity persistent remote path.

## Sources

### Kept

- Repository modules/tests at commit `b403b02484aa545b72a0a852aee9ecce524fa6f8` — current contract.
- Installed Pi `docs/sdk.md`, `rpc.md`, `sessions.md`, `session-format.md`, `security.md`, `containerization.md` — RPC/SDK/session alternative assessment.
- [Vercel overview](https://vercel.com/docs/sandbox), [concepts](https://vercel.com/docs/sandbox/concepts), [persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes), [SDK](https://vercel.com/docs/sandbox/sdk-reference), [firewall](https://vercel.com/docs/sandbox/concepts/firewall), [auth](https://vercel.com/docs/sandbox/concepts/authentication), [pricing](https://vercel.com/docs/sandbox/pricing), [regions](https://vercel.com/docs/sandbox/concepts/regions), [Herdr integration](https://vercel.com/docs/sandbox/ecosystem/herdr) — canonical platform facts.
- [`vercel/sandbox` at `be86cc6`](https://github.com/vercel/sandbox/tree/be86cc619390868ae08435fde227c6896b8acad9) — pinned CLI/SDK implementation evidence, not a public WebSocket protocol guarantee.
- [`herdr-vercel-sandbox-plugin` at `be8393a`](https://github.com/vercel-labs/herdr-vercel-sandbox-plugin/tree/be8393aac17eae4b67ca58fdcc5ad8233f91b6c5) — production precedent and safeguards.
- [Herdr v0.8.2 docs](https://herdr.dev/llms.txt) — remote/socket/restore semantics.

### Dropped

- Search summaries and third-party posts — official docs/source were available.
- Guessed Vercel `/limits`, `/security`, `/networking`, `/network-policy`, `/snapshots`, `/runtime-and-images` URLs — 404; canonical pages above replaced them.
- Changelog as primary evidence — current docs/source preferred for mutable behavior and limits.
- Generic custom-agent support as proof of Pi compatibility — proves terminal extensibility only.

## Remaining gaps

- Exact pinned CLI subprocess signal/disconnect/process-group behavior, plus whether Vercel will confirm or document a stable direct interactive protocol.
- Remote tmux same-session reattachment reliability.
- Pi JSONL recovery at every provider/tool/compaction interruption point.
- Provider auth compatibility with deny-by-default egress/brokering.
- Organization-specific snapshot confidentiality/compliance requirements.
- Profile-by-profile compatibility and measured real costs.

The staged PoC and security review are the next steps to close these gaps.
