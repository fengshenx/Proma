/**
 * Agent Adapter 工厂
 *
 * 根据渠道配置的 Agent 适配器类型选择对应的实现：
 * - claude-sdk → ClaudeAgentAdapter（基于 claude-agent-sdk，子进程模式）
 * - open-agent-sdk → OpenAgentAdapter（基于 open-agent-sdk，in-process 模式）
 */

import type { AgentAdapterType } from '@proma/shared'
import type { AgentProviderAdapter } from '@proma/shared'
import { ClaudeAgentAdapter } from './claude-agent-adapter'
import { OpenAgentAdapter } from './open-agent-adapter'

/** 单例 adapter 实例 */
const claudeAdapter = new ClaudeAgentAdapter()
const openAgentAdapter = new OpenAgentAdapter()

/**
 * 根据 adapter 类型获取 Agent 适配器
 */
export function getAgentAdapter(adapterType: AgentAdapterType): AgentProviderAdapter {
  if (adapterType === 'claude-sdk') return claudeAdapter
  return openAgentAdapter
}

/** 导出单例供直接引用 */
export { claudeAdapter, openAgentAdapter }
