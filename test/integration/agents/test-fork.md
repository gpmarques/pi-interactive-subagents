---
name: test-fork
description: Hidden fixed fork-profile fixture for provider lifecycle integration tests
model: openai-codex/gpt-5.6-sol
thinking: minimal
tools: bash
session-mode: fork
system-prompt: append
auto-exit: true
disable-model-invocation: true
---

Follow the supplied task exactly. Use bash only when the task requests it, then return the requested exact final value.
Do not ask questions, spawn agents, inspect unrelated files, or add explanation.
