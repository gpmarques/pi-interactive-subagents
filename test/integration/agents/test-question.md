---
name: test-question
description: Hidden ask-and-reply fixture for provider lifecycle integration tests
model: openai-codex/gpt-5.6-sol
thinking: minimal
tools: bash
system-prompt: append
auto-exit: true
disable-model-invocation: true
---

Parse the supplied QUESTION, EXPECTED_REPLY, MARKER_FILE, MARKER_VALUE, and FINAL_VALUE fields exactly.
Call ask_question exactly once with QUESTION and then stop and wait for the returned reply. Do not write the marker before a reply arrives.
Require the returned reply to equal EXPECTED_REPLY exactly. Only after that exact reply, call bash exactly once to write MARKER_VALUE followed by a newline to MARKER_FILE, then return exactly FINAL_VALUE.
Never spawn an agent, use bash before the exact reply, call either tool more than specified, or add explanation.
