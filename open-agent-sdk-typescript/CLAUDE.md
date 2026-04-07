# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```bash
npm run build       # Compile TypeScript to dist/
npm run dev         # Watch mode (tsc --watch)
npx tsx examples/01-simple-query.ts   # Run single example
npm run test:all    # Run all examples in sequence
npm run web        # Start web chat UI (localhost:8081)
```

## Architecture

```
Agent (agent.ts)         ← High-level API: createAgent(), query()
  └── QueryEngine (engine.ts)  ← Core agentic loop: API call → tools → repeat
        ├── Provider layer      ← AnthropicProvider / OpenAIProvider
        ├── Tool pool           ← 35+ built-in tools + MCP tools
        ├── HookRegistry        ← 20 lifecycle events
        ├── SkillRegistry       ← Bundled + custom skills
        └── Session persistence ← Save/resume/fork on disk
```

**Key files:**
- `src/agent.ts` — `createAgent()`, `query()` factory functions and `Agent` class
- `src/engine.ts` — `QueryEngine`: streaming loop with auto-compact, retry, concurrency control
- `src/providers/index.ts` — `createProvider()` factory; `AnthropicProvider`, `OpenAIProvider`
- `src/providers/anthropic.ts` / `src/providers/openai.ts` — API-specific implementations
- `src/tools/` — Individual tool implementations (Bash, Read, Edit, Glob, etc.)
- `src/skills/` — Skill system: registry, bundled skills (commit, review, debug, simplify, test)
- `src/hooks.ts` — `HookRegistry` with 20 lifecycle events (PreToolUse, PostToolUse, SessionStart, etc.)
- `src/session.ts` — Session persistence (save, load, list, fork, resume)
- `src/utils/compact.ts` — Auto-compact (summarize conversation) and micro-compact (truncate tool results)
- `src/utils/retry.ts` — Exponential backoff for rate limits and transient errors
- `src/utils/tokens.ts` — Token estimation, cost calculation, context window sizes

## API Design

**Provider abstraction** (`src/providers/`): Normalizes Anthropic Messages API vs OpenAI Completions API into a common interface with `createMessage()`.

**Tool execution order** (`engine.ts:executeTools`): Read-only tools run concurrently (up to `AGENT_SDK_MAX_TOOL_CONCURRENCY`, default 10); mutation tools run sequentially.

**Permission flow**: `Agent.canUseTool` → `HookRegistry` PreToolUse hooks → tool execution → PostToolUse hooks.

**Context injection**: `getSystemContext()` injects git status; `getUserContext()` injects AGENT.md and project settings into the system prompt automatically.
