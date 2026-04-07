/**
 * Open Agent SDK 适配器
 *
 * 基于 @codeany/open-agent-sdk 实现 AgentProviderAdapter 接口，
 * 支持非 Anthropic Provider（OpenAI、DeepSeek、MiniMax 等）运行 Agent 模式。
 * 纯 in-process 执行，无需 CLI 子进程。
 */

import type {
  AgentProviderAdapter,
  AgentQueryInput,
  SDKMessage,
} from '@proma/shared'
import type { ProviderType } from '@proma/shared'

// ===== 类型定义 =====

/** OAS canUseTool 回调签名 */
interface OASCanUseToolResult {
  behavior: 'allow' | 'deny'
  updatedInput?: unknown
  message?: string
}

interface OASToolDefinition {
  name: string
  [key: string]: unknown
}

type OASCanUseToolFn = (
  tool: OASToolDefinition,
  input: unknown,
) => Promise<OASCanUseToolResult>

/** OAS 的 API 类型 */
type OASApiType = 'anthropic-messages' | 'openai-completions'

/** OAS Agent 实例接口（避免直接依赖 OAS 类型） */
interface OASAgent {
  query(prompt: string, overrides?: Record<string, unknown>): AsyncGenerator<SDKMessage, void>
  interrupt(): Promise<void>
  close(): Promise<void>
  setPermissionMode(mode: string): Promise<void>
}

/** OAS createAgent 函数签名 */
type CreateAgentFn = (options: Record<string, unknown>) => OASAgent

/**
 * OpenAgentAdapter 查询选项
 *
 * 扩展 AgentQueryInput，添加 OAS 特有的配置字段。
 */
export interface OpenAgentQueryOptions extends AgentQueryInput {
  /** API Key（直接传入，不走环境变量） */
  apiKey: string
  /** API Base URL */
  baseURL?: string
  /** API 协议类型 */
  apiType?: OASApiType
  /** 系统提示词（完整字符串） */
  systemPrompt?: string
  /** MCP Server 配置 */
  mcpServers?: Record<string, unknown>
  /** 权限回调（已适配为 OAS 签名） */
  canUseTool?: OASCanUseToolFn
  /** 扩展思考配置 */
  thinking?: Record<string, unknown>
  /** 推理努力等级 */
  effort?: string
  /** 最大轮次 */
  maxTurns?: number
  /** 最大预算（美元） */
  maxBudgetUsd?: number
  /** 子 Agent 定义 */
  agents?: Record<string, unknown>
  /** 环境变量 */
  env?: Record<string, string | undefined>
  /** 附加工作目录 */
  additionalDirectories?: string[]
  /** 权限模式 */
  permissionMode?: string
  /** 预批准的工具列表 */
  allowedTools?: string[]

  // 回调
  onSessionId?: (sid: string) => void
  onModelResolved?: (model: string) => void
  onContextWindow?: (cw: number) => void
}

/**
 * 根据 Provider 类型和 Base URL 推断 OAS 的 apiType
 *
 * 优先检测 URL 特征（如 /anthropic 端点），再按 provider 推断。
 */
export function resolveApiType(provider: ProviderType, baseUrl?: string): OASApiType {
  if (provider === 'anthropic') return 'anthropic-messages'
  // 检测 Anthropic 兼容端点（如 https://api.minimaxi.com/anthropic）
  if (baseUrl && /\/anthropic\b/i.test(baseUrl)) return 'anthropic-messages'
  return 'openai-completions'
}

/**
 * OpenAgentAdapter — 基于 @codeany/open-agent-sdk 的 Agent 适配器
 */
export class OpenAgentAdapter implements AgentProviderAdapter {
  /** 活跃 Agent 实例（按 sessionId 隔离） */
  private activeAgents = new Map<string, OASAgent>()

  async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const options = input as OpenAgentQueryOptions

    // 动态导入 OAS（与 ClaudeAgentAdapter 保持一致的懒加载模式）
    const { createAgent } = await import('@codeany/open-agent-sdk') as { createAgent: CreateAgentFn }

    const abortController = new AbortController()
    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true })
    }

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
      effort: options.effort,
      maxTurns: options.maxTurns ?? 10,
      maxBudgetUsd: options.maxBudgetUsd,
      agents: options.agents,
      additionalDirectories: options.additionalDirectories,
      permissionMode: options.permissionMode ?? 'bypassPermissions',
      allowedTools: options.allowedTools,
      abortController,
      persistSession: false,  // Proma 自行管理持久化
      includePartialMessages: false,
      promptSuggestions: true,
      env: options.env,
    })

    this.activeAgents.set(options.sessionId, agent)

    try {
      for await (const event of agent.query(options.prompt)) {
        // 从 system init 事件提取 session_id 和 model，触发回调
        const msg = event as Record<string, unknown>
        if (msg.type === 'system' && msg.subtype === 'init') {
          if (msg.session_id && options.onSessionId) {
            options.onSessionId(msg.session_id as string)
          }
          if (msg.model && options.onModelResolved) {
            options.onModelResolved(msg.model as string)
          }
        }

        // 从 result 事件提取 context window 信息
        if (msg.type === 'result' && options.onContextWindow) {
          const usage = msg.usage as Record<string, unknown> | undefined
          if (usage?.context_window) {
            options.onContextWindow(usage.context_window as number)
          }
        }

        yield event as SDKMessage
      }
    } finally {
      this.activeAgents.delete(options.sessionId)
      await agent.close().catch(() => { /* 静默处理关闭错误 */ })
    }
  }

  abort(sessionId: string): void {
    const agent = this.activeAgents.get(sessionId)
    if (agent) {
      agent.interrupt().catch(() => { /* 静默处理中断错误 */ })
    }
  }

  dispose(): void {
    for (const [, agent] of this.activeAgents) {
      agent.interrupt().catch(() => {})
    }
    this.activeAgents.clear()
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const agent = this.activeAgents.get(sessionId)
    if (agent) {
      await agent.setPermissionMode(mode)
    }
  }
}
