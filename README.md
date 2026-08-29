# pi-interactive-subagents

Async subagents for [pi](https://github.com/earendil-works/pi-mono), running on tmux or Herdr terminal surfaces. Spawn a sub-agent, keep working in the main session, and receive its result in a follow-up turn when it finishes. Fully non-blocking.

This fork supports exactly two terminal backends: [tmux](https://github.com/tmux/tmux) and Herdr. See [Acknowledgements](#acknowledgements) for its relationship to the HazAT original.

For a component and lifecycle overview, see the [coarse system map](docs/system-maps/interactive-subagents-overview.md).

## How it works

`subagent()` returns immediately. The sub-agent runs in its own terminal surface while a live widget above the input tracks every running sub-agent. When one finishes, its result is delivered to the main session as a follow-up notification that triggers a new turn, even when completion races with the end of the current parent turn.

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

Pi-backed sub-agent sessions may additionally receive the child-only `ask_question` tool to ask the orchestrator one question and wait for the reply. There is also a `/subagent <agent> <task>` command for spawning directly.

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

**Pi resume replays the original sandbox.** At spawn time the fully resolved loadout—tool allowlist, exact backing-extension paths, model, thinking level, system-prompt identity, nested-spawn whitelist, cwd, and agent dir—is snapshotted to `<session>.loadout.json`. Both resume entrypoints validate and rebuild from that snapshot rather than rediscovering a profile or accepting caller launch controls. Missing, malformed, incomplete, empty-string, or unavailable restricted snapshots are refused before terminal-surface creation. Complete legacy `toolAllowlist: null` snapshots remain intentionally unrestricted, but any resume without a valid non-empty spawn whitelist suppresses all subagent lifecycle tools, including `subagent_resume`.

### ask_question

A Pi-backed sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the terminal surface stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **planner** | `openai-codex/gpt-5.6-sol` | `read`, `write`, `bash` + spawning | Interactive planning specialist; writes one plan artifact and may spawn `scout` and `researcher` for factual gaps |
| **researcher** | `openai-codex/gpt-5.6-sol` | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **reviewer** | `openai-codex/gpt-5.6-sol` | `read`, `bash` | Read-only review of introduced changes against task intent and a fixed point |
| **scout** | `openai-codex/gpt-5.6-sol` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **visual-tester** | `openai-codex/gpt-5.6-sol` | `read`, `write`, `bash` | Autonomous visual QA through an ambient-sanitizing temporary `agent-browser` wrapper; reports evidence without editing implementation |
| **worker** | `openai-codex/gpt-5.6-sol` | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch` + spawning | General implementer; may spawn `scout` and `researcher` |

Six agents are bundled. Scout, researcher, reviewer, visual-tester, and worker are autonomous (`auto-exit: true`). Planner is explicitly interactive (`interactive: true`, `auto-exit: false`) and remains open for user-led planning. All six carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openai-codex/gpt-5.6-sol
thinking: medium
tools: read, edit, write, safe_bash, web_search
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
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child |
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

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the terminal surface, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that terminal surface — the widget still updates). Set explicitly to override.

## Tool access control

**Pi-backed profiles are whitelist-only.** They launch with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only extensions backing listed tools are loaded explicitly. Omitted `tools` yields only `ask_question`, not Pi's ambient defaults. This restriction survives resume through the validated loadout snapshot.

**Claude-backed profiles use a separate verified policy.** Before launch, the extension checks installed `claude --help` for the policy flags it relies on, then uses `--tools`, matching `--allowedTools`, `--permission-mode dontAsk`, no ambient setting sources, and strict empty MCP configuration. It never uses `--dangerously-skip-permissions`. Supported profile mappings are `read→Read`, `write→Write`, `edit→Edit`, `bash→Bash`, `grep→Grep`, `find→Glob`, `web_search→WebSearch`, and `web_fetch→WebFetch`; omitted `tools` disables all Claude tools. Because Pi extensions and nested Pi spawning cannot be represented faithfully in Claude Code, a Claude profile requesting any other tool or declaring `subagent_agents` is refused before terminal-surface creation. Parent-side `subagent_kill` remains available for a running Claude child.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a Pi sub-agent may only spawn agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so omitting an agent cannot escalate to an ambient profile.

Extensions can register additional Pi-backed tools at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

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

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Requirements and setup

- [pi](https://github.com/earendil-works/pi-mono)
- Either Herdr or [tmux](https://github.com/tmux/tmux)
- `agent-browser` on `PATH` when using the bundled `visual-tester`. The agent reports a blocked run if it is missing; it never installs a browser tool or uses a fallback.

Start Pi inside either supported backend:

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

The dedicated Herdr lifecycle smoke uses real `openai-codex/gpt-5.6-sol` calls. It intentionally covers only the public completion/result-follow-up/explicit-resume and kill/forget/resume-refusal paths. Cleanup checks exact focus, pane IDs, and tab IDs without closing unknown resources:

```bash
env -u PI_SUBAGENT_LIFECYCLE_DISABLED PI_SUBAGENT_MUX=herdr PI_TEST_MODEL=openai-codex/gpt-5.6-sol PI_TEST_TIMEOUT=180000 npm run test:integration:lifecycle-smoke
```

To launch Pi manually against the working-tree extension rather than an installed package, run this as one command from anywhere inside the repository:

```bash
cd "$(git rev-parse --show-toplevel)" && PI_SUBAGENT_MUX=herdr pi -ne -e "$PWD/pi-extension/subagents/index.ts"
```

`$PWD` must be the repository root when Pi starts; the leading `cd` is therefore part of the command. The post-correction Stage 5 run passed 2/2 in 64.444s, persisted 15 Sol assistant responses (9 completion/resume and 6 kill/forget), and reported 0 provider errors. During that run, the harness compared exact focus and pane sets and restored `w7` to `focus=null` with panes `[w7:p1, w7:p33]`. Separate post-run inspection confirmed the sole tab `[w7:t1]` and found no owned recent files or processes. The shared snapshot was subsequently hardened to enforce exact tab equality; the provider suite was not rerun after this harness-only change. The production fix and corrected smoke harness were independently approved.

The Stage 6 broad provider-backed lifecycle suite is separate from both the no-model surface suites and the bounded Stage 5 smoke. It covers six current-contract cases: completion, a 90-second active call beyond the watchdog threshold, parallel fixed-profile children, fixed-profile fork context, `ask_question` plus exact-name `subagent_message`, and project-local profile discovery. Reproduce the post-correction forced-Herdr/Sol run from anywhere inside the repository with:

```bash
cd "$(git rev-parse --show-toplevel)" && env -u PI_SUBAGENT_LIFECYCLE_DISABLED PI_SUBAGENT_MUX=herdr PI_TEST_MODEL=openai-codex/gpt-5.6-sol PI_TEST_TIMEOUT=120000 npm run test:integration:lifecycle
```

The post-correction run passed 6/6 in 199.084s and persisted 40 assistant responses, all `openai-codex/gpt-5.6-sol`, with 0 provider errors and 0 test timeouts. During that run, the harness compared exact focus and pane sets and restored `w7` to `focus=null` with panes `[w7:p1, w7:p33]` after every case. Separate post-run inspection confirmed the sole tab `[w7:t1]` and found no owned recent files or processes. The shared snapshot was subsequently hardened to enforce exact tab equality; the provider suite was not rerun after this harness-only change. This is provider-backed Herdr evidence for those six cases, not model-backed tmux evidence or a generic production guarantee.

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, its multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/). At the compared revision, the HazAT original supports cmux, tmux, zellij, and WezTerm. This fork does not carry all four backends: it retains tmux and selectively adds Herdr.

## License

MIT
