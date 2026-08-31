# pi-interactive-subagents

Async subagents for [pi](https://github.com/earendil-works/pi-mono), running on tmux or Herdr terminal surfaces. Spawn a sub-agent, keep working in the main session, and automatically receive either its result after exit or an idle report when it settles but remains alive. Fully non-blocking.

This fork supports exactly two terminal backends: [tmux](https://github.com/tmux/tmux) and Herdr. See [Acknowledgements](#acknowledgements) for its relationship to the HazAT original.

For a component and lifecycle overview, see the [coarse system map](docs/system-maps/interactive-subagents-overview.md).

## How it works

`subagent()` returns immediately. The sub-agent runs in its own terminal surface while a live widget above the input tracks every running sub-agent. Pi-backed children follow one lifecycle invariant: every fully settled child either exits for normal result delivery, or remains alive and atomically publishes one immutable state record for that settled cycle. The parent drains accumulated records in creation order as one notification per batch: `subagent_question` when the newest state awaits an answer, otherwise `subagent_idle`. Notifications include the latest assistant response when available and never infer finality from its wording.

Surface placement is backend-specific and focus-preserving. tmux creates a detached right split from the caller pane. Herdr creates a background tab in the caller's explicit workspace with `--no-focus`, so the parent remains focused. Launches and later reads/messages/closes target explicit surface IDs; each surface stays pinned to the backend that created it even if environment variables change.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and deliver results back independently as each finishes.

When tmux is selected, panes are kept evenly sized: the extension re-applies an `even-horizontal` layout after every spawn and exit (debounced). The layout is a single constant, `SUBAGENT_TMUX_LAYOUT` in `pi-extension/subagents/mux-adapters.ts`—change it to any named tmux layout (`main-vertical`, `tiled`, …). This paragraph does not apply to Herdr tabs.

The backend-neutral split seam supports all four directions in tmux. Herdr supports only explicit right/down splits; left/up reject before mutation because emulating them with a swap would steal focus. Public `subagent` creation uses a background Herdr tab rather than this split seam.

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## Tools

The parent registers exactly five lifecycle tools:

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated terminal surface (async) |
| `subagent_message` | Message by exact name — steers a running child; safely resumes a completed Pi child for compatibility |
| `subagent_resume` | Explicitly and safely resume a completed Pi child by exact parent-scoped name |
| `subagent_kill` | Terminate a running child by exact name and forget its resumable mapping |
| `subagents_list` | List available agent definitions |

Pi-backed sub-agent sessions may additionally receive the child-only `ask_question` tool to ask the orchestrator one question and wait for the reply. Spawning also requires the parent to have a persistent session file: use Pi's normal session mode, not `--no-session`. A sessionless parent receives `Error: no session file. Start pi with a persistent session to use subagents.`

`/subagent <agent> <task>` is a convenience command, not a direct spawn primitive. It validates the agent name and queues a user instruction telling the current parent model to call `subagent`; the child is created only if that model turn invokes the tool.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Requested display name for the terminal surface and widget. Explicit and defaulted duplicates are auto-suffixed (`scout`, `scout-2`, …); the launch acknowledgement returns the actual reserved name |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by exact name only**:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is sent to the live terminal surface (newlines flattened) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a follow-up notification.
- **Completed Pi session (compatibility)** — existing callers still resume through the same safe implementation as `subagent_resume`. New callers should use the explicit completed-only tool below when relaunch is their intent.

### subagent_resume

```typescript
subagent_resume({ name: "scout", message: "Now inspect the authorization tests" });
```

The public interface has exactly two required fields: exact `name` and follow-up `message`. There is no session-path/session-id argument and no cwd, model, tools, auto-exit, interactive, or other launch override. The name is resolved only in the **current parent/spawner session's** artifact registry. A sibling parent's name is invisible.

`subagent_resume` is completed-only. It refuses a name—or an alias mapped to the same session—that is running or already resuming and directs live follow-ups to `subagent_message`; it never silently steers. A successful resume is fire-and-forget, always autonomous (`autoExit: true`, non-interactive tracking), and delivers the current run's result asynchronously through the normal watcher.

Every spawn records name → session file plus durable run ownership in `artifacts/<sessionId>/subagent-registry.json`, so Pi-backed names completed before a parent restart stay addressable afterward. A nested Pi sub-agent gets its own registry keyed by its own session id. Launch marks the mapped session `running` before dispatching the child command; only the terminal watcher marks that exact run `completed`. Registry mutation retries brief lock contention but never guesses that an ownerless lock is abandoned: uncertain ownership times out closed and requires manual lock cleanup only after confirming no parent process is active. A restarted or second parent therefore refuses an entry that is still running or lacks completion proof instead of risking two writers against one JSONL. Normal completion preserves the mapping for repeated resumes; `subagent_kill` forgets it. Resume is refused before terminal-surface creation if the current parent's name is unknown, the session is gone, durable completion is unproven, or the saved sandbox is missing, malformed, incomplete, or no longer replayable. In-process reservations and the atomic persisted run claim cover both name and mapped-session aliases, so concurrent resume/message attempts across parent processes cannot launch two writers. Claude-backed children can be messaged and killed while running, but completed Claude sessions are not resumed.

### subagent_kill

`subagent_kill({ name })` is a destructive lifecycle operation for a currently running child. It targets only the exact persistent display name, kills the child’s terminal surface/process (Pi or Claude CLI), aborts its watcher, removes it from the running widget, and forgets the name mapping so it cannot be resumed or reused until a fresh spawn. Existing session/transcript history is preserved; kill does not delete it. If surface termination fails, the operation reports an error and leaves tracking intact rather than claiming success. Completion/error follow-ups and pending-question steer messages are suppressed.

**Pi resume revalidates the original sandbox identity.** At spawn time the fully resolved loadout—tool allowlist, canonical backing-extension paths and SHA-256 digests, model, thinking level, system-prompt identity, nested-spawn whitelist, cwd, and agent dir—is recorded in `<session>.loadout.json`. For `pi-web-access`, the record additionally binds the canonical package root/name/version, manifest digest, and complete `web-search.json` bytes (or absence) plus the relevant tool config. Both resume entrypoints validate and rebuild from that record rather than rediscovering a profile or accepting caller launch controls. Missing, malformed, incomplete, empty-string, unavailable, symlink-replaced, or drifted recorded identities are refused before terminal-surface creation. Legacy sidecars without the required extension/package/config identity are also refused, including formerly unrestricted snapshots.

A saved loadout is a validation record, **not a copy of old executable code**. Resume rechecks the recorded entrypoint, manifest/package version, and config identity, then runs the same fresh capability probe before creating a surface. Treat every `pi-web-access` package or config update as requiring a **fresh child**; resumes are refused when a recorded field changes. This focused guarantee does not hash the complete package/dependency tree or npm lock, so same-version helper or dependency-tree mutation that leaves those recorded fields unchanged is outside the resume-identity guarantee.

### ask_question

A Pi-backed sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** instead of exiting. `ask_question` stores the pending question in child memory; every non-shutdown `agent_settled` atomically publishes one immutable record describing the current state (`awaiting_answer`, `waiting_on_children`, or `idle`), latest response, and question when applicable. The parent drains accumulated records in one ordered notification whose newest state is explicit, then replies through `subagent_message({ name, message })`. Actual external `input` clears the pending question for later records; retry, compaction recovery, and continuation `agent_start` events do not. Historical records are never cancelled or rewritten. Failed parent sends retain the whole batch for retry, while exit, kill, and resume discard pending records.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the terminal surface stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **planner** | `openai-codex/gpt-5.6-sol` | `read`, `write`, `bash` + spawning | Interactive planning specialist; writes one plan artifact and may spawn `scout` and `researcher` for factual gaps |
| **researcher** | `openai-codex/gpt-5.6-sol` | `web_search`, `fetch_content`, `get_search_content`, `source_check`, `safe_bash` | Web research, synthesized into a sourced brief |
| **reviewer** | `openai-codex/gpt-5.6-sol` | `read`, `bash` | Read-only review of introduced changes against task intent and a fixed point |
| **scout** | `openai-codex/gpt-5.6-sol` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **visual-tester** | `openai-codex/gpt-5.6-sol` | `read`, `write`, `bash` | Autonomous visual QA through an ambient-sanitizing temporary `agent-browser` wrapper; reports evidence without editing implementation |
| **worker** | `openai-codex/gpt-5.6-sol` | `read`, `write`, `edit`, `bash` + spawning | General implementer; delegates external research to `researcher` and may also spawn `scout` |

Six agents are bundled. Scout, researcher, reviewer, visual-tester, and worker are autonomous (`auto-exit: true`). Planner is explicitly interactive (`interactive: true`, `auto-exit: false`) and remains open for user-led planning. All six carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openai-codex/gpt-5.6-sol
thinking: medium
tools: read, edit, write, safe_bash
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | Pi 0.84.4 levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Pi clamps the request to levels supported by the selected model/provider, so the effective level can differ |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed for Pi: `web_search`, `fetch_content`, `get_search_content`, `source_check`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing listed tools are loaded explicitly |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the lifecycle/spawning toolset** (`subagent`, `subagent_message`, `subagent_resume`, `subagent_kill`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn or use lifecycle tools |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs via Claude Code under the separate fail-closed policy below. Unsupported tool mappings and `subagent_agents` make launch refuse |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session requests shutdown after a normally completed agent run — the agent just writes its final message and stops (there is no "done" tool). The shutdown path delivers the last assistant message as the result and suppresses a duplicate idle report. Recommended for all autonomous agents.

Idle publication uses Pi's `agent_settled` event, not `agent_end`: retries, automatic compaction/retry, and queued continuations must finish first. A Pi process that remains alive then atomically publishes one durable record file for the parent watcher; interrupted temporary files are ignored and rapid repeated turns cannot overwrite or block one another. No language-based completion heuristic is used.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the terminal surface, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that terminal surface — the widget still updates). Set explicitly to override.

## Tool access control

**Pi-backed profiles are whitelist-only.** They launch with `--no-extensions` (ambient extension discovery disabled) and `--tools <allowlist>`; only the exact extensions backing listed custom tools are re-enabled with explicit `-e` paths. Omitted `tools` yields only `ask_question`, not Pi's ambient defaults. A child's cwd or effective agent directory can affect explicit backing-extension resolution, but it never grants ambient extensions. This restriction survives resume through the validated loadout record.

`safe_bash` is one such explicitly loaded custom tool. It checks a fixed denylist of dangerous command patterns and then delegates to Pi's ordinary bash implementation; it is not an OS sandbox and does not protect the separate built-in `bash` tool. Ambient/global extensions such as a `bash-guard` are disabled by `--no-extensions` and are **not inherited** by restricted children. A profile that declares `bash` therefore receives ordinary Pi bash unless another explicitly backed custom tool is declared instead.

Among the bundled profiles, only `researcher` declares the four canonical web tools—`web_search`, `fetch_content`, `get_search_content`, and `source_check`—and it uses `safe_bash` rather than built-in `bash`. The web tools all resolve to one canonical extension entrypoint from the effective child agent directory's `<agent-dir>/npm/node_modules/pi-web-access/package.json` (`pi.extensions`). Resolution requires exactly one unfiltered string `"npm:pi-web-access"` in that agent directory's `settings.json`, verifies exactly `pi-web-access@0.27.0`, and requires all four canonical tools to remain enabled and unrenamed in `web-search.json`. Package roots, manifests, entrypoints, settings, and config must remain canonical and inside their allowed roots; symlinks at those checked paths are rejected. A stale package beside Pi's installation is not a fallback, and unrelated global packages are never scanned.

Metadata validation alone does not authorize a researcher launch. Before any researcher surface is created, the extension starts the canonical Pi executable in the exact child cwd and effective agent directory with `--mode rpc --offline --no-session --no-extensions`, the exact four-tool `--tools` allowlist, the validated package entrypoint, and a private no-tool inspector. It issues only RPC `get_state`, then requires Pi's fresh active-tool set to equal the four canonical names. The process is capped at 5 seconds in a detached process group; the group is killed with `SIGKILL` during cleanup and its nonce-bound temporary snapshot is removed in `finally`. No persistent session or prompt is created, and no model/provider or web call is made. Missing/partial/renamed registration, extension errors, malformed or uninspectable RPC state, timeout, or nonzero exit fails closed with repair guidance before surface or loadout creation.

Ambient loading remains disabled for the real child: the validated entrypoint is passed once with `-e` while the complete child `--tools` allowlist selects the web tools plus `safe_bash` and ordinary `ask_question`. After a successful initial preflight, the launch records the canonical entrypoint digest, package root/name/version and manifest digest, and full/relevant config identity. Resume verifies those fields before the probe and again afterward. Recorded drift rejects before a surface; same-version unrecorded helper/dependency drift is not claimed to be detected.

**Claude-backed profiles use a separate verified policy.** Before launch, the extension checks installed `claude --help` for the policy flags it relies on, then uses `--tools`, matching `--allowedTools`, `--permission-mode dontAsk`, no ambient setting sources, and strict empty MCP configuration. It never uses `--dangerously-skip-permissions`. Supported profile mappings are `read→Read`, `write→Write`, `edit→Edit`, `bash→Bash`, `grep→Grep`, `find→Glob`, `web_search→WebSearch`, and `web_fetch→WebFetch`; omitted `tools` disables all Claude tools. Because Pi extensions and nested Pi spawning cannot be represented faithfully in Claude Code, a Claude profile requesting any other tool or declaring `subagent_agents` is refused before terminal-surface creation. Parent-side `subagent_kill` remains available for a running Claude child.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a Pi sub-agent may only spawn agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so omitting an agent cannot escalate to an ambient profile.

Extensions can register additional Pi-backed tools at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a role directory. If `<cwd>/.pi/agent` exists, it becomes that child's effective Pi agent directory for explicit configuration and backing-tool resolution. Restricted Pi children still use `--no-extensions`, so merely changing cwd never ambient-loads extensions from that directory:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (an explicit question, or fully settled and open for input/another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Outside the explicit `ask_question` path, `waiting` is recorded at `agent_settled`, so an intermediate `agent_end` during retry or continuation is not exposed as idle. Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Requirements and setup

- [Earendil Pi 0.84.4](https://github.com/earendil-works/pi-mono). This audit checked 0.84.4's package, persistent-session, and thinking interfaces and exercised offline child tool surfaces with that CLI. The repository's locked development libraries remain 0.84.3, and no provider-backed lifecycle run was repeated for this documentation update. Compatibility with other Pi versions is not asserted here.
- Either Herdr or [tmux](https://github.com/tmux/tmux)
- `agent-browser` on `PATH` when using the bundled `visual-tester`. The agent reports a blocked run if it is missing; it never installs a browser tool or uses a fallback.
- [`pi-web-access`](https://github.com/nicobailon/pi-web-access) when using the bundled `researcher`. Install it separately with `pi install npm:pi-web-access`; this project does not vendor it.

### Install this fork

Pi packages execute code with full user privileges. Review the source, then install the maintained fork at the reviewed commit used by this documentation. This fork is not published in the npm registry, so do **not** use `pi install npm:pi-interactive-subagents`.

```bash
# User scope (~/.pi/agent/settings.json)
pi install git:github.com/gpmarques/pi-interactive-subagents@b403b02484aa545b72a0a852aee9ecce524fa6f8

# Or project scope (.pi/settings.json); run from the project root
pi install git:github.com/gpmarques/pi-interactive-subagents@b403b02484aa545b72a0a852aee9ecce524fa6f8 -l
```

A reviewed local checkout is also supported. Local paths are referenced in place rather than copied:

```bash
git clone https://github.com/gpmarques/pi-interactive-subagents.git
cd pi-interactive-subagents
git checkout b403b02484aa545b72a0a852aee9ecce524fa6f8
FORK_CHECKOUT=$PWD
pi install "$FORK_CHECKOUT"                  # user scope
# cd /path/to/project
# pi install "$FORK_CHECKOUT" -l             # project scope
```

`pi update --extensions` reconciles installed packages, but a commit-pinned git source stays on its configured commit. The targeted form below does the same for this package. Update has no `-l` mode: it considers configured user packages and trusted project packages. To advance this package, review a new commit and replace the pin explicitly; use `-l` when replacing a project-local source:

```bash
pi update --extension git:github.com/gpmarques/pi-interactive-subagents

NEW_COMMIT=replace-with-a-reviewed-full-commit
pi install "git:github.com/gpmarques/pi-interactive-subagents@$NEW_COMMIT"
# pi install "git:github.com/gpmarques/pi-interactive-subagents@$NEW_COMMIT" -l
```

Remove the package from the same scope in which it was installed:

```bash
pi remove git:github.com/gpmarques/pi-interactive-subagents       # user scope
pi remove git:github.com/gpmarques/pi-interactive-subagents -l    # project scope
```

Start Pi with its normal persistent session inside either supported backend. Do not pass `--no-session` when the parent must spawn children:

```bash
# Herdr: start Herdr, then run `pi` in its terminal
herdr

# Or start Pi directly inside tmux
tmux new -A -s pi 'pi'
```

With `PI_SUBAGENT_MUX` unset, the extension auto-detects Herdr before tmux because nested or stale tmux markers can coexist with a live Herdr environment. Set the variable to exactly `herdr` or `tmux` to force that backend when it is available:

```bash
PI_SUBAGENT_MUX=herdr pi
# or
PI_SUBAGENT_MUX=tmux pi
```

An explicitly empty value or any other value fails closed; a forced unavailable backend does not fall back. Binary availability is checked when selection occurs rather than cached indefinitely.

## Validation and testing

Run these commands from the repository root inside the matching terminal backend. These surface suites make no model calls and establish backend mechanics, not provider lifecycle behavior:

```bash
PI_SUBAGENT_MUX=herdr npm run test:integration:surface
PI_SUBAGENT_MUX=tmux npm run test:integration:surface
```

The web-tool capability checks make no model or web calls. The production-boundary hermetic test proves that exact-name/version packages registering zero, partial, renamed, or all four tools cannot create a researcher surface unless the fresh capability probe succeeds; it also covers malformed output, extension errors, nonzero exit, timeout bounds, and temporary cleanup:

```bash
env -u PI_SUBAGENT_LIFECYCLE_DISABLED npm run test:web-preflight-hermetic
```

The broader profile check starts a fresh offline Pi RPC runtime for every bundled profile—never a saved loadout—and records Pi's active tools to prove that only `researcher` receives all four `pi-web-access` tools:

```bash
npm run test:integration:web-tools
```

The dedicated Herdr lifecycle smoke uses real `openai-codex/gpt-5.6-sol` calls. It intentionally covers only the public completion/result-follow-up/explicit-resume and kill/forget/resume-refusal paths. Cleanup checks exact focus, pane IDs, and tab IDs without closing unknown resources. This is an opt-in provider/live-surface command and was **not** run in the current documentation audit:

```bash
env -u PI_SUBAGENT_LIFECYCLE_DISABLED PI_SUBAGENT_MUX=herdr PI_TEST_MODEL=openai-codex/gpt-5.6-sol PI_TEST_TIMEOUT=180000 npm run test:integration:lifecycle-smoke
```

To launch Pi manually against the working-tree extension rather than an installed package, run this as one command from anywhere inside the repository:

```bash
cd "$(git rev-parse --show-toplevel)" && PI_SUBAGENT_MUX=herdr pi -ne -e "$PWD/pi-extension/subagents/index.ts"
```

`$PWD` must be the repository root when Pi starts; the leading `cd` is therefore part of the command. The historical post-correction Stage 5 run passed 2/2 in 64.444s, persisted 15 Sol assistant responses (9 completion/resume and 6 kill/forget), and reported 0 provider errors. During that run, the harness compared exact focus and pane sets and restored `w7` to `focus=null` with panes `[w7:p1, w7:p33]`. Separate post-run inspection confirmed the sole tab `[w7:t1]` and found no owned recent files or processes. The shared snapshot was subsequently hardened to enforce exact tab equality; the provider suite was not rerun after this harness-only change. The production fix and corrected smoke harness were independently approved.

The Stage 6 broad provider-backed lifecycle suite is separate from both the no-model surface suites and the bounded Stage 5 smoke. It is also opt-in and was not run in the current documentation audit. It covers six current-contract cases: completion, a 90-second active call beyond the watchdog threshold, parallel fixed-profile children, fixed-profile fork context, `ask_question` plus exact-name `subagent_message`, and project-local profile discovery. Reproduce the post-correction forced-Herdr/Sol run from anywhere inside the repository with:

```bash
cd "$(git rev-parse --show-toplevel)" && env -u PI_SUBAGENT_LIFECYCLE_DISABLED PI_SUBAGENT_MUX=herdr PI_TEST_MODEL=openai-codex/gpt-5.6-sol PI_TEST_TIMEOUT=120000 npm run test:integration:lifecycle
```

The historical post-correction run passed 6/6 in 199.084s and persisted 40 assistant responses, all `openai-codex/gpt-5.6-sol`, with 0 provider errors and 0 test timeouts. During that run, the harness compared exact focus and pane sets and restored `w7` to `focus=null` with panes `[w7:p1, w7:p33]` after every case. Separate post-run inspection confirmed the sole tab `[w7:t1]` and found no owned recent files or processes. The shared snapshot was subsequently hardened to enforce exact tab equality; the provider suite was not rerun after this harness-only change. This is provider-backed Herdr evidence for those six cases, not model-backed tmux evidence or a generic production guarantee.

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, its multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/). At the compared revision, the HazAT original supports cmux, tmux, zellij, and WezTerm. This fork does not carry all four backends: it retains tmux and selectively adds Herdr.

## License

MIT
