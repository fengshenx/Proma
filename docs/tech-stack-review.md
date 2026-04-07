# Proma 技术栈与代码质量评估

## 技术栈

选型扎实，没有明显的"为用而用"。几个亮点：

- Bun + esbuild + Vite 这套工具链搭配合理，开发体验和构建速度都有保障
- Jotai 做状态管理是个好选择，比 Redux 轻量，atom 粒度的更新对 Electron 渲染进程友好
- Monorepo 拆包思路清晰：shared 放类型和常量、core 放 Provider 适配器、ui 放共享组件，职责边界明确
- Provider 适配器模式设计得不错，OpenAI 兼容协议的复用很务实，新增 Provider 成本低
- Radix UI + Tailwind + CSS 变量的主题系统，为多主题留了空间

依赖版本整体偏新（Electron 39、React 18.3、Vite 6），没有明显的过时依赖拖后腿。

## 代码质量

架构层面 7-8 分，工程纪律 5-6 分，拉开说：

### 做得好的

- IPC 四层通信模式（类型 → 主进程 → Preload → 渲染进程）虽然繁琐但类型安全，是 Electron 项目的正确做法
- 全局 Agent 监听器提升到 `main.tsx` 顶层、永不销毁的设计，解决了页面切换丢事件的经典问题
- 服务层拆分合理：orchestrator、session-manager、permission-service、prompt-builder 各司其职
- Jotai atoms 按功能域组织，派生 atom 用得恰当

### 需要关注的

- **零测试覆盖** — 这是最大的短板。agent-orchestrator（1863 行）、feishu-bridge（1997 行）这种核心逻辑没有测试保护，重构风险很高。CLAUDE.md 里写了 BDD 但实际没落地
- **几个文件偏大** — `ipc.ts`（2307 行）本质是个巨型路由注册表，可以按 domain 拆分成多个 handler 文件再统一注册；`LeftSidebar.tsx`（1412 行）和 `AgentView.tsx`（1321 行）可以进一步组件化
- **agent-orchestrator.ts**（1863 行）承担了太多职责：并发控制、渠道查找、环境构建、消息持久化、事件流、错误处理、标题生成全在一个文件里。虽然内部有函数拆分，但模块边界可以更清晰
- `noUnusedLocals` 和 `noUnusedParameters` 关了，意味着死代码不会被编译器捕获

## 总结

技术选型成熟务实，架构设计有经验，功能覆盖面广（多 Provider、多 Bridge、Agent Teams、MCP、权限系统）。主要的技术债是测试缺失和少数大文件的模块化不足。如果要往生产级走，测试基础设施是第一优先级。
