# pi-advisor

Compact the current conversation into a focused summary, then let any configured expert model investigate and provide strategic guidance.

```text
╭─ advisor ─ anthropic/claude-fable-5-2 ───────────────────╮
│ How should I fix this lock ordering?                     │
╰──────────────────────────────────────────────────────────╯
Advisor is calling read…
✓ Advice from anthropic/claude-fable-5-2
  Before editing the lock order, rule out the registry → …
```

The calling model selects an advisor using your descriptions and supplies a focused `question`. The pipeline then:

1. Uses the **active executor model** to compact the current conversation into a summary focused on that question.
2. Sends only the question and compacted summary to the selected **advisor model**.
3. Lets the advisor call explicitly permitted tools, such as `read`, when the summary is insufficient.
4. Returns the advisor's final text so the executor can continue.

The advisor never receives the full context window. Compaction preserves relevant goals, constraints, evidence, file paths, errors, and unresolved decisions while omitting unrelated history and routine tool output. It does **not** compact or otherwise modify the live session.

This is a provider-neutral implementation inspired by Anthropic's advisor pattern, not Anthropic's server-side beta tool. It supports any chat model registered in pi and has no executor/advisor model-pair restrictions.

## Install

```sh
pi install git:github.com/kovaxs/pi-advisor
```

To try the package locally without installing it:

```sh
pi -e .
```

## Settings

Create `~/.pi/agent/advisor/settings.json` (or the equivalent directory when `PI_CODING_AGENT_DIR` is set):

```json
{
  "requireApproval": true,
  "tools": ["read", "grep", "find", "ls"],
  "models": {
    "anthropic/claude-fable-5-2": {
      "description": "Ask this model for very difficult questions",
      "thinking": "max"
    },
    "openai/gpt-5.2": {
      "description": "Use for architecture review and subtle concurrency bugs",
      "thinking": "high"
    },
    "openrouter/anthropic/claude-opus": {
      "description": "Alternative OpenRouter advisor",
      "thinking": "medium"
    }
  }
}
```

Each model key is `provider/model`, matching pi's provider and model IDs. Split on the first slash when a model ID itself contains slashes. Configure authentication normally with pi's `/login`, provider environment variables, or `models.json`.

Each value has a `description` that tells the calling model when to choose that advisor and a `thinking` level passed to that advisor's `streamSimple()` call. Supported levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; pi clamps levels unsupported by the selected model. The concise string form remains valid and defaults to high reasoning:

```json
"anthropic/claude-fable-5-2": "Ask this model for very difficult questions"
```

### Approval

- `requireApproval: true` (default) explains both model calls and lists the advisor's tool permissions before asking. Declining returns the refusal to the calling model without spending tokens. Print and JSON modes cannot prompt, so they reject approval-required calls instead of falling through to automatic approval.
- `requireApproval: false` enables yolo mode: every model-invoked advisor call immediately runs compaction and the advisor loop, including any allowed tool calls, and may incur charges from both models.

### Tool permissions

`tools` is an explicit allowlist shared by all configured advisors. The default is `[]`, meaning no tool access. Names can refer to built-in, extension, or MCP tools that are callable in the current session. Unavailable names fail before compaction without spending tokens; duplicate names are ignored, and `advisor` itself is forbidden to prevent recursion.

Each advisor tool call goes through `ctx.executeTool()`, including argument validation and pi's `tool_call` / `tool_result` hooks. Other permission extensions can therefore still block a call. The single advisor approval does not bypass those hooks. Tool results feed back into the advisor conversation for at most **eight model turns** per consultation.

**Allowing `bash`, `write`, `edit`, or other state-changing tools gives the advisor those capabilities.** Use a read-only set such as `["read", "grep", "find", "ls"]` unless mutation is intentional, especially in yolo mode.

`models` must contain at least one valid entry for the `advisor` tool to be registered. Reload pi or run `/reload` after changing the file. Run `/advisor` to see the loaded advisors, tool permissions, approval mode, and configuration path. Invalid settings disable the tool and surface an error instead of silently selecting a different model.

## How it works

- The extension loads and validates settings at startup, including each advisor's independent thinking level, then registers an `advisor` tool whose arguments are the configured `provider/model` and a focused `question`. `reachesTools` declares the configured allowlist.
- At execution time, `ctx.sessionManager.buildSessionProjection()` supplies the active, compaction-aware branch. Pi's standalone `generateSummaryWithUsage()` summarizes those messages with the active model and custom instructions focused on the question. Unlike `ctx.compact()`, this helper returns text without appending a compaction entry or changing the session.
- The summarization stream goes through `ctx.modelRegistry.streamSimple()` at the executor's current thinking level, so custom provider registrations and configured authentication work. Advisor requests use the same provider-neutral API with their configured reasoning level, the allowed tool declarations, and the tool's abort signal.
- The advisor initially receives only `<question>` and `<compacted_context>` sections. If it returns tool calls, the extension executes permitted calls through `ctx.executeTool()` and appends their results to the private advisor conversation. Nested calls appear in pi's tool-call tracking but do not enter the main session transcript.
- Streaming text appears in tool updates; only final text—not advisor reasoning—is returned to the calling model. Empty responses, provider errors, truncation, cancellation, declined approval, missing tools, and the eight-turn cap are reported explicitly.
- Token usage from compaction and every advisor inference is combined and attached to the tool result. Pi separately aggregates nested tool usage, avoiding double counting.
- Tool guidelines encourage consultation after read-only orientation, before committing to a difficult approach, when stuck, and before declaring a long task complete. They do not force calls on simple tasks.
- `/advisor` reports the effective configuration. No background resources are started, and non-interactive modes never attempt to open a dialog.

Run the pure-logic tests with:

```sh
node --test "test/*.test.ts"
```
