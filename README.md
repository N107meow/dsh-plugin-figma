# Figma × DeepSeek Harness 插件

把 Figma 的设计能力做成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里**可插拔的一等公民**：模型用原生工具读懂 Figma 文件（结构 / 样式 / 变量 / 组件 / 截图），而不是靠人肉截图粘贴。

> **当前状态：只有设计稿，还没有代码。** 本仓库现在是一份技术方案 + 一个空的 git 仓库。

## 读什么

| 文件 | 内容 |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | **主文档**。技术选型、模块设计、上下文管道、分期验收、风险、事实出处 |

## 方案要点（三句话）

1. **不需要从零实现 MCP 协议。** DSH 自带 `dsh-mcp-client`，MCP 的「标准描述层 + 自动发现 + 调度协议」三层已经具备；要补的是 Figma 的**能力底座**（声明式 capability registry）和**上下文管道**（把几十 MB 的节点树压成模型读得起的形状）。
2. **对模型只暴露 3 个工具**，而不是把 Figma 的 130+ REST 端点各做一个工具。实测外推：后者会在**每一次请求**上多加约 3.3 万 tokens，前者约 750。
3. **核心协议无关，双适配器。** 默认走 DSH 原生 Cordis 插件；同一套核心再导出一个 MCP server，就能喂给别的宿主。核心不含任何 `@deepseek-ai/*` 依赖。

## 两个已经踩出来的坑（实现前务必读）

- **MCP 协议已分裂成两代。** 最新 `2026-07-28` 是破坏性变更（移除了 `initialize` 握手与会话）。但本机 `dsh-mcp-client` 依赖的 `@modelcontextprotocol/sdk@1.30.0` **只支持到 `2025-11-25`**。所以 P2 适配器必须按 `2025-11-25` 写，否则 DSH 连不上。细节见 `docs/PLAN.md` §6 的提示框。
- **Figma Tier 1 限流极紧**：`GET file` / `nodes` / `images` 在 Full/Dev 席位下只有 **10–20 次/分钟**，View/Collab 席位 **20 次/月**。所以缓存、请求合并、默认 `depth` 限制是**可用性前提**，不是性能优化。

## 目标结构

```
packages/
├── core/            # 协议无关核心：能力注册表 / 调度 / 缓存 / 上下文投影（零 DSH 依赖）
├── adapter-dsh/     # Cordis 插件，把核心接进 DeepSeek Harness
├── adapter-mcp/     # (P2) 独立 MCP server
└── figma-plugin/    # (P3) 伴生 Figma 插件 + 画布桥
```

## 分期

| 阶段 | 内容 | 估算 |
|---|---|---|
| **P0** | core + 3 个工具 + 接线，端到端可用 | 2–3 天 |
| P1 | 设计系统语义（组件 / 变量 / 样式） | 1–2 天 |
| P2 | MCP 适配器，可移植到其他宿主 | 0.5–1 天 |
| P3 | 伴生 Figma 插件 + 画布桥 + 可视化面板 | 3–4 天 |

## 决策状态

| 决策 | 状态 |
|---|---|
| Figma 席位 | ✅ **Full/Dev** —— Tier 1 为 10–20 次/分，方案按"预算制调度"实现（令牌桶 + 合并 + 缓存，默认保守取 10/min） |
| 写操作 | ✅ **不做，本插件只读** —— 所有会改 Figma 真实数据的端点**不进 capability registry**，并在派发前断言 `method === 'GET'`。这不是可打开的开关，是架构约束。详见 `docs/PLAN.md` §9.2 |

**"只读"是一条硬约束，不是默认值。** 意味着：能力表里没有写端点、运行期有 `GET` 断言、CI 有门禁、文档只引导只读 scope，且代码里不预埋任何 dry-run / 审批钩子。

### 令牌会过期 —— 但不用每 90 天手动重录

Figma 的两种令牌差别很大，选对了就省事：

| | 个人访问令牌（PAT） | 计划访问令牌（Plan token） |
|---|---|---|
| 最长有效期 | **90 天**，且**不可刷新** | **1 年**，**可刷新**（旧密钥续用 24 小时） |
| 创建门槛 | 自助，Settings → Security | 组织管理员 + MFA |
| 只读适配 | 可以（勾只读 scope） | **天然不支持任何写 scope**，与只读定位完全吻合 |

**如果你们是 Organization / Enterprise 套餐，用计划访问令牌** —— 一年一续、可平滑轮换、不可能有写权限。个人 PAT 就接受每 90 天换一次。

无论哪种，**换令牌都不需要重启 DSH**：凭据是每次操作重新解析的，且凭据文件带 `watch`，保存即生效。设计上我们**不存过期日期**（会漂移），而是捕获 403 时直接给出重录步骤。详见 `docs/PLAN.md` §4.4.1。

## 参考文献

- Shi, Y., Zhang, W., Cui, T. — *A Programming Paradigm for Spatiotemporal Composability*, [arXiv:2608.25512](https://arxiv.org/abs/2608.25512)（北京大学 / DeepSeek-AI）。Cordis 的形式化基础，本方案的生命周期设计依据其 revertible effects / reactive coeffects 概念。
- [Figma REST API 文档](https://developers.figma.com/docs/rest-api/) · [Figma Plugin API 文档](https://developers.figma.com/docs/plugins/api/api-reference/)
