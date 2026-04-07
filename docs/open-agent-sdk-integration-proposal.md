# Open Agent SDK 适配方案

> 将 `@codeany/open-agent-sdk` 作为第二个 Agent Provider 接入 Proma，实现多 Provider Agent 模式。

## 1. 背景与动机

当前 Proma 的 Agent 模式仅支持 `@anthropic-ai/claude-agent-sdk`，只能使用 Anthropic Claude 系列模型。而 Chat 模式已通过 Provider 适配器支持 10+ 家 Provider。

`@codeany/open-agent-sdk`（以下简称 OAS）是一个开源 Agent SDK，核心特点：

- **纯 in-process 执行**：无需 CLI 子进程，直接在 Node.js/Bun 进程内运行完整 Agent 循环
- **多 Provider 支持**：Anthropic + OpenAI 兼容协议（GPT、DeepSeek、Qwen、Mistral 等）
- **API 兼容性高**：`SDKMessage` 流式事件结构与 claude-agent-sdk 高度相似
- **MIT 开源**：可自由修改和分发

接入后，Agent 模式将获得与 Chat 模式对等的多 Provider 能力。

## 2. 架构现状

### 2.1 现有抽象层

Proma 已在 `@proma/shared` 中定义了 Provider 无关的 `AgentProviderAdapter` 接口：

```typescript
// packages/shared/src/types/agent-provider.ts
interface AgentProviderAdapter {
  query(input: AgentQueryInput): AsyncIterable<SDKMessage>
  abort(sessionId: string): void
  dispose(): void
  sendQueuedMessage?(sessionId: string, message: SDKUserMessageInput): Promise<void>
  cancelQueuedMessage?(sessionId: string, messageUuid: string): Promise<void>
  setPermissionMode?(sessionId: string, mode: string): Promise<void>
}
```

当前唯一实现：`ClaudeAgentAdapter`（`apps/electron/src/main/lib/adapters/claude-agent-adapter.ts`）。

### 2.2 数据流

```
用户输入 → agent-orchestrator.ts
  → AgentProviderAdapter.query() → SDKMessage 流
  → eventBus.emit() → IPC 推送
  → useGlobalAgentListeners → Jotai atoms → React UI
```

orchestrator 层只依赖 `AgentProviderAdapter` 接口和 `SDKMessage` 类型，不直接依赖任何 SDK。

## 3. 两个 SDK 的 API 对比

### 3.1 查询入口

| 维度 | claude-agent-sdk | open-agent-sdk |
|------|-----------------|----------------|
| 调用方式 | `sdk.query({ prompt, options })` | `agent.query(prompt, overrides?)` |
| 返回类型 | `AsyncGenerator<SDKMessage>` | `AsyncGenerator<SDKMessage>` |
| 初始化 | 每次 query 传入全部 options | `createAgent(options)` 创建实例，query 时可覆盖 |
| 进程模型 | 子进程（需要 CLI 路径） | in-process（直接调用） |

### 3.2 SDKMessage 事件类型

| 事件类型 | claude-agent-sdk | open-agent-sdk | 兼容性 |
|---------|-----------------|----------------|--------|
| `assistant` | `{ type, uuid, session_id, message }` | `{ type, uuid?, session_id?, message }` | 结构一致 |
| `tool_result` | `{ type, result: { tool_use_id, tool_name, output } }` | 同左 | 完全一致 |
| `result` | `{ type, subtype, num_turns, usage, ... }` | `{ type, subtype, num_turns, usage, total_cost_usd, ... }` | 基本一致，OAS 多了 `total_cost_usd` |
| `system` | `{ type, subtype: 'init', session_id, model }` | `{ type, subtype: 'init', session_id, model }` | 结构一致 |
| `partial_message` | 有 | 有 | 结构一致 |
| `compact_boundary` | 有 | 有 | 结构一致 |
| `status` | 有 | 有 | 结构一致 |

**结论**：两个 SDK 的 `SDKMessage` 联合类型高度兼容，orchestrator 层无需修改事件处理逻辑。

### 3.3 权限系统

| 维度 | claude-agent-sdk | open-agent-sdk |
|------|-----------------|----------------|
| 回调签名 | `canUseTool(toolName, input, options) → PermissionResult` | `canUseTool(tool, input) → { behavior, updatedInput?, message? }` |
| 权限模式 | `acceptEdits / bypassPermissions / plan` | `default / acceptEdits / bypassPermissions / plan / dontAsk / auto` |
| 动态切换 | `query.setPermissionMode()` | `agent.setPermissionMode()` |

差异较小，需要在 adapter 内做签名适配。

### 3.4 MCP 集成

| 维度 | claude-agent-sdk | open-agent-sdk |
|------|-----------------|----------------|
| 配置格式 | `mcpServers: Record<string, McpServerConfig>` | `mcpServers: Record<string, McpServerConfig>` |
| 传输协议 | stdio / SSE / HTTP | stdio / SSE / HTTP |
| In-process | 不支持 | `createSdkMcpServer()` |

配置格式一致，可直接透传。

### 3.5 会话管理

| 维度 | claude-agent-sdk | open-agent-sdk |
|------|-----------------|----------------|
| 恢复方式 | `resume: sdkSessionId` | `resume: sessionId` 或 `continue: true` |
| 存储位置 | SDK 内部管理 | `~/.open-agent-sdk/sessions/` |
| Fork | `forkSession + resumeSessionAt` | `forkSession()` 函数 |

Proma 自身已有 JSONL 持久化方案，OAS 的内置会话管理可以禁用（`persistSession: false`），由 Proma 统一管理。

## 4. 适配方案

### 4.1 总体策略

**新增 `OpenAgentAdapter`**，与 `ClaudeAgentAdapter` 并列，由 orchestrator 根据渠道 Provider 类型选择使用哪个 adapter。

```
apps/electron/src/main/lib/adapters/
├── claude-agent-adapter.ts    # 现有，不改动
├── open-agent-adapter.ts      # 新增
└── index.ts                   # 新增，adapter 工厂
```

### 4.2 Adapter 选择逻辑

```typescript
// adapters/index.ts
import { ClaudeAgentAdapter } from './claude-agent-adapter'
import { OpenAgentAdapter } from './open-agent-adapter'
import type { AgentProviderAdapter } from '@proma/shared'

type AdapterType = 'claude-sdk' | 'open-agent-sdk'

const adapters: Record<AdapterType, AgentProviderAdapter> = {
  'claude-sdk': new ClaudeAgentAdapter(),
  'open-agent-sdk': new OpenAgentAdapter(),
}

/**
 * 根据 Provider 类型选择 Agent 适配器
 *
 * - Anthropic 渠道 → claude-sdk（保持现有行为）
 * - 其他渠道 → open-agent-sdk（in-process 执行）
 */
export function getAgentAdapter(providerId: string): AgentProviderAdapter {
  if (providerId === 'anthropic') return adapters['claude-sdk']
  return adapters['open-agent-sdk']
}
```

### 4.3 OpenAgentAdapter 实现

```typescript
// adapters/open-agent-adapter.ts（核心结构）
import { createAgent, type Agent } from '@codeany/open-agent-sdk'
import type { AgentProviderAdapter, AgentQueryInput, SDKMessage } from '@proma/shared'

export interface OpenAgentQueryOptions extends AgentQueryInput {
  apiKey: string
  baseURL?: string
  apiType?: 'anthropic-messages' | 'openai-completions'
  systemPrompt?: string
  mcpServers?: Record<string, unknown>
  canUseTool?: CanUseToolFn
  thinking?: ThinkingConfig
  maxTurns?: number
  // ... 其他 OAS 支持的选项
}

export class OpenAgentAdapter implements AgentProviderAdapter {
  private activeAgents = new Map<string, Agent>()

  async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const options = input as OpenAgentQueryOptions

    const agent = createAgent({
      model: options.model,
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      apiType: options.apiType,
      cwd: options.cwd,
      systemPrompt: options.systemPrompt,
      mcpServers: options.mcpServers,
      canUseTool: options.canUseTool,
      thinking: options.thinking,
      maxTurns: options.maxTurns,
      persistSession: false,  // Proma 自行管理持久化
      includePartialMessages: false,
    })

    this.activeAgents.set(options.sessionId, agent)

    try {
      for await (const event of agent.query(options.prompt)) {
        yield event as SDKMessage  // SDKMessage 结构兼容，直接透传
      }
    } finally {
      this.activeAgents.delete(options.sessionId)
      await agent.close()
    }
  }

  abort(sessionId: string): void {
    const agent = this.activeAgents.get(sessionId)
    agent?.interrupt()
  }

  dispose(): void {
    for (const [, agent] of this.activeAgents) {
      agent.interrupt()
    }
    this.activeAgents.clear()
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const agent = this.activeAgents.get(sessionId)
    await agent?.setPermissionMode(mode as any)
  }
}
```

### 4.4 Orchestrator 改动

`agent-orchestrator.ts` 需要的改动很小：

1. **adapter 选择**：在 `startQuery()` 中根据渠道的 `providerId` 调用 `getAgentAdapter()` 获取对应 adapter
2. **选项构建**：根据 adapter 类型构建不同的 options（Claude 需要 CLI 路径等，OAS 需要 apiKey + apiType）
3. **环境变量**：OAS 不需要 `ANTHROPIC_API_KEY` 等环境变量，改为直接传入 `apiKey` 参数

事件处理、消息持久化、权限流程等均不需要改动。

```typescript
// agent-orchestrator.ts 改动示意
async startQuery(sessionId: string, ...) {
  const channel = await this.findChannel(channelId)
  const adapter = getAgentAdapter(channel.providerId)  // 新增

  // 根据 adapter 类型构建不同的 options
  const queryOptions = channel.providerId === 'anthropic'
    ? this.buildClaudeOptions(channel, ...)    // 现有逻辑
    : this.buildOpenAgentOptions(channel, ...) // 新增

  for await (const msg of adapter.query(queryOptions)) {
    // 现有事件处理逻辑，无需改动
    this.processSDKMessage(sessionId, msg)
  }
}
```

### 4.5 依赖管理

```jsonc
// apps/electron/package.json
{
  "dependencies": {
    "@codeany/open-agent-sdk": "workspace:*"  // 本地 workspace 引用
    // 或发布后使用 npm 版本
  }
}
```

OAS 的依赖很轻量：`@anthropic-ai/sdk`、`@modelcontextprotocol/sdk`、`zod`。其中前两个 Proma 已有。

**打包优势**：OAS 是纯 in-process 库，可以直接被 esbuild 打包进 `main.cjs`，无需像 claude-agent-sdk 那样 external + files 配置。

### 4.6 Provider → apiType 映射

在 orchestrator 中根据渠道的 `providerId` 自动推断 OAS 的 `apiType`：

```typescript
function resolveApiType(providerId: string): 'anthropic-messages' | 'openai-completions' {
  if (providerId === 'anthropic') return 'anthropic-messages'
  return 'openai-completions'  // OpenAI、DeepSeek、Moonshot、智谱等均兼容
}
```

## 5. 需要注意的差异

### 5.1 队列消息注入

`ClaudeAgentAdapter` 通过 `query.streamInput()` 实现队列消息注入。OAS 的 `Agent` 类目前没有等价的 `streamInput` 方法。

**方案**：`OpenAgentAdapter` 暂不实现 `sendQueuedMessage`（接口中为可选方法）。如果后续需要，可以向 OAS 提交 PR 或在 adapter 层用 abort + 重新 query 模拟。

### 5.2 SDK Session Resume

claude-agent-sdk 通过 `resume: sdkSessionId` 恢复 SDK 内部会话状态（包括工具执行上下文）。OAS 的 session resume 基于文件系统持久化。

**方案**：
- 短期：每次 query 创建新的 Agent 实例，通过 Proma 自身的 JSONL 消息历史提供上下文（context backfill 模式）
- 长期：利用 OAS 的 `loadSession()` + `resume` 选项实现原生 resume

### 5.3 系统提示词

claude-agent-sdk 支持 `{ type: 'preset', preset: 'claude_code', append }` 预设提示词。OAS 使用字符串系统提示词 + 自动注入（git status、项目上下文等）。

**方案**：使用 Proma 现有的 `agent-prompt-builder.ts` 构建完整系统提示词字符串，直接传给 OAS 的 `systemPrompt` 参数。

### 5.4 工具集差异

两个 SDK 的内置工具集高度重叠（Read、Write、Edit、Bash、Glob、Grep、Agent、Task 等），但工具名称和参数 schema 可能有细微差异。

**方案**：使用 OAS 自带的工具集，不做映射。orchestrator 层的工具匹配逻辑（`tool-matching.ts`）基于工具名称字符串，两边一致则无需改动。如有差异，在 `@proma/shared` 的 `ToolIndex` 中补充别名。

## 6. 实施步骤

### Phase 1：基础适配（核心可用）

1. 将 `open-agent-sdk-typescript/` 加入 monorepo workspace 或作为本地依赖引用
2. 新建 `apps/electron/src/main/lib/adapters/open-agent-adapter.ts`
3. 新建 `apps/electron/src/main/lib/adapters/index.ts`（adapter 工厂）
4. 修改 `agent-orchestrator.ts`：增加 adapter 选择 + OAS options 构建
5. 验证：使用 OpenAI 兼容渠道（如 DeepSeek）发起 Agent 会话

### Phase 2：功能对齐

6. 权限系统适配：确保 `canUseTool` 回调在 OAS 中正确工作
7. MCP Server 配置透传验证
8. 错误映射：将 OAS 的错误格式映射到 Proma 的 `TypedError`
9. 自动标题生成：确保 OAS 会话也能触发标题生成

### Phase 3：体验优化

10. 会话恢复：实现 OAS 的 session resume 对接
11. 工具活动展示：确认 OAS 的 `tool_result` 事件能正确驱动 `ToolActivityItem` UI
12. 打包验证：确认 OAS 可被 esbuild 正确打包，移除不必要的 external 配置

## 7. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| OAS 的 SDKMessage 与 Proma 类型不完全兼容 | 事件处理异常 | 在 adapter 层做类型断言 + 运行时校验，不改 orchestrator |
| OAS 工具执行行为与 claude-agent-sdk 不一致 | Agent 行为差异 | 使用 OAS 原生工具集，接受行为差异作为 Provider 特性 |
| OAS 版本迭代导致 API 变更 | 适配器需要跟进 | 锁定版本 + 适配器层隔离变更 |
| in-process 工具执行的安全性 | Bash 等工具直接在主进程执行 | 依赖 Proma 现有权限系统 + OAS 的 canUseTool 回调 |

## 8. 预期收益

- **多 Provider Agent 模式**：GPT-4o、DeepSeek、Qwen 等均可运行 Agent
- **打包简化**：OAS 可直接 bundle，消除 CLI 路径解析、ripgrep symlink 等复杂逻辑
- **启动加速**：in-process 执行，省去子进程启动开销
- **开源可控**：MIT 协议，可根据 Proma 需求自由修改
- **渐进式迁移**：Anthropic 渠道继续使用 claude-agent-sdk，其他渠道使用 OAS，零风险切换
