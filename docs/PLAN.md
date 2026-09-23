# Figma × DeepSeek Harness 插件技术实现方案

> 目标：把 Figma 的设计能力做成 DSH 里**可插拔的一等公民**——模型能用原生工具读懂一个 Figma 文件（结构 / 样式 / 变量 / 组件 / 截图），而不需要人肉截图粘贴。
>
> 状态：设计稿 v1（待评审）。文中所有关于 DSH 内部接口的结论，均已在本机部署上实测核对，出处标注在 §10。

---

## 0. 结论先行（TL;DR）

这套东西**不需要从零实现 MCP 协议**。本机部署里已经有 `@deepseek-ai/dsh-mcp-client`，MCP 的「标准描述层 + 自动发现 + 调度协议」这三层 DSH 已经提供了，而且它读取的是 `tools/list` 返回的 JSON Schema——**任何东西只要能产出工具描述，就已经是一个 MCP server 的等价物**。

所以真正要做的只有两件事：

1. **能力底座**：把 Figma 的 REST API 包装成一张**声明式的 capability registry**（数据，不是代码）；
2. **上下文管道**：把 Figma 那种动辄几十 MB 的节点树，压成模型能读、且读得起的形状。

至于对外协议，做成**双适配器**：默认走 DSH 原生插件（进程内、零序列化、可直接复用 `ctx.credentials`），同时**顺手导出 MCP server**（~150 行），这样同一套能力以后能直接喂给 Claude Code / Codex / Cursor。核心不绑定协议。

预期最终形态：模型调用 `figma_capabilities` 发现能力 → `figma_call` 执行 → 返回**裁剪过的节点树 + 一个可复用的图片引用**。整条链路对模型而言就是 3 个工具，而不是 130 个。

---

## 0.1 理论地基：Cordis 的时空可组合性

本方案的所有生命周期设计都不是工程直觉，而是 Cordis 形式化基础的直接推论。参考：**Shi, Zhang, Cui, _A Programming Paradigm for Spatiotemporal Composability_, arXiv:2608.25512（北京大学 / DeepSeek-AI，2026-08-26）** —— 即 Cordis 框架的论文。

论文把"动态组合"拆成两个正交维度，并各自给出运行时机制：

| 论文概念 | 论文定义（意译） | 本方案里它落在哪 |
|---|---|---|
| **Revertible effects**（可逆效应） | 每一次上下文变换都携带一个由运行时保管的逆变换 → 时间可组合性 | 每个 `ctx.effect()` / `ctx.on()` / `ctx.tools.register()` 都自带 disposer：**桥断开时必须收回的子资源清单**（WebSocket、令牌桶计时器、缓存驱逐定时器、`figma/*` 监听器） |
| **Reactive coeffects**（反应式余效应） | 每一次上下文变化都与组件的 coeffect 规格比对，据此驱动组件的激活/失活 → 空间可组合性 | `inject: ['figmaBridge']`：桥出现则工具激活，桥消失则工具自动失活，**不需要手写探测** |
| **Context paradigm**（上下文范式） | 把 effect context 与 coeffect context 统一为单一 context 类型，所有 effect/coeffect 都经由它中介 | 就是 `ctx`：`ctx.tools.register()`（效应）与 `inject`（余效应）走同一根代理 |
| **Observational equivalence**（观测等价） | 中介诱导出一个等价关系，**不同组件的效应在此等价下交错而不互相干扰** | 这是"装/卸 Figma 插件不会扰动其他插件"的形式化保证；也是 DSH 敢做 `patchReload: live` 的理论依据 |

**三个具体的设计后果**（不是修辞，是改了设计）：

1. **§4.3 的 `figma_canvas` 从"手动降级"改成"依赖声明"**。我原稿写的是"桥离线时返回未就绪"——那是**命令式探测**，要在 `apply` 里轮询或缓存桥状态，而桥状态本身就成了一个会漂移的副本。改成让桥作为服务、`figma_canvas` 作为 `inject: ['figmaBridge']` 的子插件后，Cordis 的 coeffect 解析接管了激活/失活：**离线状态不再是一种运行期错误，而是一个可推理的静态状态**，工具表在离线时也不被无用定义占用上下文。
2. **分层纪律有了理论依据**。论文要求"组件"是自足单元（效应与余效应都在组件边界内可逆/可解析）。`core` 零 DSH 依赖因此不只是"方便测试"，而是让 `core` 成为一个真正的组件；协议适配器只是把它绑定到某个 context 上。这解释了为什么双适配器（原生 + MCP）是零成本抽象而不是额外负担。
3. **限流桶的单例归属得到确认**。令牌桶是进程级共享状态，跨 session 复用；它既不是某个组件的私有效应，也不能被某个 session 的卸载带走——所以它必须挂在一个**所有 session 都够得着的 context** 上，即 host 面（§2.1 的结论由此从"经验"变成"推论"）。

> 论文另有 92 页正文与 service broker（§5.7）等内容，对"多 Figma 账号并存、灰度切换提供方"这类未来需求有直接价值；本方案 P0–P1 不依赖它们。

---

## 1. 现状核查：地基比预想的厚

### 1.1 DSH 已经有的东西（实测）

| 能力 | 包 | 对本方案的意义 |
|---|---|---|
| MCP 客户端桥 | `dsh-mcp-client` | 消费任意 MCP server；工具名 `mcp__<server>__<tool>`；支持 stdio 与 streamable-http |
| 凭据服务 | `dsh-credentials` + `dsh-credentials-local` | 密钥不进配置文件；`ctx.credentials.resolve(ref)` **每次操作重新解析**（轮换后无需重启） |
| 工具注册表 | `dsh-tools` | `ctx.tools.register()` 是 Effect，插件卸载自动反注册；支持 `output` 规范化契约、`finalizeContent` |
| 出站代理 | `dsh-http-proxy` | 裸 `fetch()` 自动走 `HTTPS_PROXY`，**不需要**为代理写额外代码 |
| 图片管道 | `dsh-attachment` / `dsh-llm` | 工具结果里可以带**持久化 image block**；有精确的路由能力闸门与文本降级 |
| 热重载 | `cordis-plugin-loader` (`patchReload: live`) | 改 `cordis.patch.yml` 即时生效，开发循环极短 |
| 本地插件先例 | `~/.dsh/profiles/web/plugins/pale-green-tint` | 本机已有手写插件被正确挂载，照抄它的接线即可 |

### 1.2 四条硬约束（它们决定了整个设计）

**约束一：工具描述是永久上下文税。**
`dsh-mcp-client` 的文档写得很直白：*"Tool definitions add tokens to every model request"*。

本机实测（`Tool.listTools` 实测 + JSON 尺寸估算，见 §10）当前这个 session 有 **34 个工具**，光定义就约 **30.9k 字符 ≈ 8.6k tokens，每一次请求都要付**，平均每个工具约 250 tokens。据此外推：

| 暴露方式 | 每请求额外成本 |
|---|---|
| 把 20 个常用 Figma 端点各做一个工具 | +5.0k tokens |
| 把 50 个端点各做一个工具 | +12.6k tokens |
| 把 REST API 的 130+ 端点各做一个工具 | **+32.8k tokens（≈ 现有全部工具的 4 倍）** |
| **本方案：3 个固定工具** | **≈ +0.75k tokens** |

而且代价不只是钱：工具表一变动，KV cache 前缀从第一个变更的 schema token 起全部失效。130 个工具的表天然是"经常变动"的表。

> **推论：绝不"一个端点 = 一个工具"。能力层的粒度是「声明式 registry」，模型只看到固定 3 个工具，能力目录按需检索、按需展开。**

**约束二：Figma 限流比想象中狠得多。**
按官方最新（2025-11-17 生效）限流表，**Tier 1**（`GET file` / `GET file nodes` / `GET image`）的额度是：

| 席位 | Starter | Professional | Organization | Enterprise |
|---|---|---|---|---|
| View / Collab | 20 / **月** | 20 / **月** | 20 / **月** | 20 / **月** |
| Dev / Full | 10 / 分 | 10 / 分 | 15 / 分 | 20 / 分 |

Tier 2（组件、变量、版本、项目、评论）Dev/Full 席位为 25–100/分；Tier 3 为 50–150/分。429 会带 `Retry-After`（秒）、`X-Figma-Plan-Tier`、`X-Figma-Rate-Limit-Type`（`low`=Collab/Viewer，`high`=Full/Dev）、`X-Figma-Upgrade-Link`。

> **推论：缓存、请求合并、`depth` 优先，不是性能优化，是可用性前提。** 一个"帮我看看这个文件"的对话，如果模型连续三次拉全量文件，Full 席位一分钟额度就没了。

**约束三：`GET /v1/files/:key` 会返回整棵文档树。**
一个中等规模的社区文件、或任何有历史的设计系统文件，全量 JSON 几十 MB 是常态，`geometry=paths` 会让它更大。直接塞进 tool result 等于当场烧掉上下文。

> **推论：默认必须 `depth=1` 或按 `ids` 定点取；全量取只在显式要求时发生，且要落盘 spool。**

**约束四（隐性但关键）：插件权限模型不允许"随便发请求"。**
Figma 插件 manifest 的 `networkAccess.allowedDomains` 是**域名白名单**，不在名单里的域会被 Figma 直接拦掉（`["none"]` 表示禁止一切外部网络）。要连本地桥就必须显式声明，且**名单里出现 localhost / 开发服务器时 `reasoning` 字段是必填的**：

```json
"networkAccess": {
  "allowedDomains": ["ws://127.0.0.1:8790", "https://api.figma.com"],
  "reasoning": "读取当前画布选区并回传给本地开发工具链",
  "devAllowedDomains": ["ws://127.0.0.1:8790"]
}
```

同时，插件的 `main` 代码运行在 Figma 的受限沙箱中（无 socket / 无任意 fetch），只有 `ui` 声明的 iframe 具备网络能力，两者通过 `postMessage` 通信。这条决定了「Plugin API 桥」的拓扑（见 §5.3）。

---

## 2. MCP 五层 → DSH 运行时：映射与归属

用户给的 MCP 拆解（能力底座 / 标准描述层 / 自动发现 / 调度协议 / 上下文管道）在 DSH 里有非常干净的对应关系。**先看清哪几层要自己写，方案就不会跑偏**：

| MCP 层 | 在 DSH 里的对应物 | 谁提供 | 本方案要写的部分 |
|---|---|---|---|
| ① 能力底座 | Figma REST API + Plugin API | Figma | **capability spec 声明表**（把 API 变成数据） |
| ② 标准描述层 | `ToolDefinition`（name/description/parameters/output） | `dsh-tools` | **Figma 语义层的描述**：每个能力的中文/英文 description、参数文档、何时该用 |
| ③ 自动发现 | registry → 工具表 → prompt 组装自动同步 | `dsh-tools` | 目录检索接口：`figma_capabilities(query)` 按需展开 |
| ④ 调度协议 | JSON-RPC 派发 / 超时 / 中间件管线 | `dsh-tools` | **Figma 侧的调度**：限流桶、合并、重试、缓存、能力白名单校验 |
| ⑤ 上下文管道 | 工具结果规范化 + image block + 压缩 | `dsh-tools` + `dsh-llm` | **压缩投影器**：节点树 → 模型友好结构；图片 → 路径 + 持久 image block |

也就是说：**②③④ 的骨架 DSH 已经给了**，我们只需要在 Figma 语义上把 ①②④⑤ 补齐。这正是"不写协议也能拿到 MCP 全部好处"的原因。

### 2.1 归属：host 面还是 preset 面？

按本仓库 plane 规则判断：

- **Figma token 是进程级凭据**（一个 token 服务所有 session），不是某个 agent 的私有物；
- **限流桶必须是进程级单例**——如果每个 session 各持一个桶，10 req/min 的额度会被并发 session 直接击穿；
- **HTTP 连接池、LRU 缓存、插件桥 WebSocket 服务端**都只能有一份。

> **结论：capability registry / 限流器 / 缓存 / 插件桥 = HOST 面（`cordis.patch.yml`）；工具行也可以放 host 面**（与 `tool-bash`、`tool-fs` 同级）。将来若要让不同 agent 用不同 Figma 账号，再拆成 isolate realm + preset，但**默认不要**——那会让同一个进程出现多个限流桶。

---

## 3. 交付形态：三个方案与取舍

| | A. 直接用 Figma 官方 MCP | B. 自建 MCP server（走 stdio/HTTP） | C. 自建 DSH 原生插件（本方案） |
|---|---|---|---|
| 接入方式 | `dsh-mcp-client` 加一行 config | `dsh-mcp-client` 指向自建 server | `cordis.patch.yml` 挂插件 |
| 覆盖度 | 官方固定工具集 | 自定义 | 自定义 |
| 鉴权 | OAuth 登录 / Dev Mode 本地 | PAT | PAT |
| 能否 headless / CI | ❌ 依赖登录或 Figma 桌面端 | ✅ | ✅ |
| 上下文开销 | 固定工具集，不可裁剪 | 多一层 `mcp__` 前缀 + schema 双份 | **最小** |
| 可调试性 | 黑盒 | 进程边界清晰，可单独调试 | 同进程，能直接读 `ctx`、打点、热重载 |
| 图片落地 | 由官方决定 | 需自己过协议 | 直接产出持久 image block |
| 可移植到别的宿主 | 天然 | 天然 | 需再写 MCP 适配器 |

**方案 A 的真实限制**（值得知道，但不足以否掉它作为"先跑起来"的选项）：官方远程 MCP（`https://mcp.figma.com/mcp`）是 Figma 托管的、需要 OAuth 登录；本地 Dev Mode MCP 需要 **Figma 桌面客户端开着、且当前文件已打开**，端口是 `127.0.0.1:3845` 且只有 Dev/Full 席位可用。对我们「用户只给了一个 PAT，要在 headless 环境里读任意文件」的场景，A 覆盖不了。

**采用 C，并保留 B 的语言**：内部核心写成协议无关的 `ToolProvider` 接口，配两个适配器：

```
                    ┌──────────────────────────────┐
                    │  @figma-mcp-dsh/core (纯逻辑)  │
                    │  capability registry          │
                    │  scheduler / cache / ratelimit│
                    │  context projector            │
                    │  ToolProvider 接口             │
                    └───────────┬──────────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
   ┌──────────────────────┐            ┌──────────────────────┐
   │ adapters/dsh          │            │ adapters/mcp          │
   │ Cordis 插件，原生工具   │            │ 独立 MCP server(P2)   │
   │ ← 本方案主线           │            │ → 喂给别的宿主         │
   └──────────────────────┘            └──────────────────────┘
```

**顺带说明：为什么"原生"和"仍是 MCP"不矛盾。** MCP 的价值在五层结构，不在那根网线。DSH 原生插件保有了全部五层语义，还额外拿到：省掉 `mcp__` 前缀与重复 schema、进程内直接读凭据服务、能参与 DSH 的审批/审计管线。同时因为核心是协议无关的，P2 加上 MCP 适配器就两栖，一份能力定义两处卖。

---

## 4. 模块设计

### 4.1 目录结构

```
Figma-MCP-dsh/
├── package.json                  # workspace 根
├── pnpm-workspace.yaml
├── docs/
│   ├── PLAN.md                   # 本文
│   ├── CAPABILITIES.md           # 能力清单（自动生成）
│   └── WIRING.md                 # 接线步骤
└── packages/
    ├── core/                     # 协议无关核心，零 DSH 依赖，可独立测试
    │   └── src/
    │       ├── capability.ts     # CapabilitySpec 类型 + 运行时校验
    │       ├── specs/            # ★ 能力声明表（数据）
    │       │   ├── files.ts      # file / file_nodes / file_meta
    │       │   ├── images.ts     # image_render / image_fills
    │       │   ├── comments.ts
    │       │   ├── components.ts
    │       │   ├── variables.ts
    │       │   ├── projects.ts
    │       │   └── plugin.ts     # 走插件桥的能力
    │       ├── auth.ts           # PAT 注入，Bearer / X-Figma-Token 双写
    │       ├── http.ts           # fetch 薄封装：超时、AbortSignal、错误归一
    │       ├── retry.ts          # 429 感知退避（读 Retry-After）
    │       ├── scheduler.ts      # ★ 令牌桶 + 单飞 + 队列
    │       ├── cache.ts          # LRU + TTL + ETag/SWR
    │       ├── projection.ts     # ★ 节点树 → 模型友好结构
    │       ├── budget.ts         # ★ 结果大小预算 + 溢出落盘
    │       ├── url.ts            # Figma URL → fileKey/nodeId 解析
    │       └── provider.ts       # ToolProvider 接口 + 实现
    ├── adapter-dsh/              # Cordis 插件（host 面）
    │   └── src/
    │       ├── index.ts          # apply(ctx)：读凭据、建 provider、注册工具
    │       ├── config.ts         # Schemastery config schema
    │       ├── tools.ts          # 3 个工具的定义
    │       ├── bridge-server.ts  # 插件桥 WebSocket 服务端
    │       └── events.ts         # figma/* 事件（审计与可观测）
    ├── adapter-mcp/              # (P2) 独立 MCP server 入口
    │   └── src/server.ts         # initialize / tools/list / tools/call
    └── figma-plugin/             # (P3) 伴生 Figma 插件
        ├── manifest.json         # networkAccess 白名单
        ├── src/main.ts           # 沙箱侧：调 figma.* API
        └── src/ui.ts             # iframe 侧：WebSocket 到 localhost
```

**硬性分层纪律**：`core` 不得 import 任何 `@deepseek-ai/*`。这条纪律是可测试性与可移植性的全部来源——core 用 `node:test` + 本地 mock server 就能装满覆盖，不需要起 DSH。

### 4.2 核心数据结构：CapabilitySpec

这是整个方案的支点。**每一个 Figma 能力都是一条数据**：

```ts
export interface CapabilitySpec {
  /** 稳定标识，也是 figma_call 的 op 值 */
  name: string
  /** 给模型看的一句话：做什么、什么时候用 */
  description: string
  /** 归类，用于 figma_capabilities 的过滤 */
  group: 'file' | 'node' | 'image' | 'comment' | 'component' | 'variable' | 'project' | 'plugin'
  /** 需要的 Figma scope，用于启动时自检与错误提示 */
  scopes?: string[]
  /** 'rest' 直连 Figma；'plugin' 需伴生插件在线 */
  transport: 'rest' | 'plugin'
  /** 只读能力：当前仅有 'GET'。保留联合类型是为了让 run-time 断言
   *  (spec.method === 'GET') 有意义——见 §9.2 的只读约束 */
  method: 'GET' | 'POST' | 'DELETE'
  /** REST 路径模板，:key / :nodeId 由参数填充 */
  path: string
  /** 参数声明：JSON Schema 子集 + 是否必填 + 文档 */
  params: Record<string, ParamSpec>
  /** 固定注入的 query（如 depth / geometry） */
  query?: Record<string, string>
  /** 速率档位，决定用哪个令牌桶 */
  tier: 1 | 2 | 3
  /** 缓存策略 */
  cache?: { ttlMs: number; keyBy: string[]; swr?: boolean }
  /** 结果投影器名（见 §4.5） */
  project: ProjectorName
  /** 结果量级预判，用于提前拒绝或强制落盘 */
  weight: 'tiny' | 'small' | 'large' | 'huge'
  /** 破坏性操作，需要人工确认 */
  mutating?: boolean
}
```

再加一条 `files.ts` 里的真实例子（说明"能力即数据"到什么程度）：

```ts
export const fileNodes: CapabilitySpec = {
  name: 'file_nodes',
  description: '按 node id 精确获取一个或多个节点子树。比取整个文件便宜得多，是读取设计的首选入口。',
  group: 'node',
  scopes: ['file_content:read'],
  transport: 'rest',
  method: 'GET',
  path: '/v1/files/:fileKey/nodes',
  params: {
    fileKey:  { type: 'string', required: true, doc: 'Figma 文件 key，可由任意 figma.com 设计链接解析得到' },
    nodeIds:  { type: 'array', items: 'string', required: true, doc: '形如 "12:345" 的节点 id，逗号分隔' },
    depth:    { type: 'integer', min: 1, max: 8, default: 2, doc: '子树深度，越大越贵' },
    geometry: { type: 'string', enum: ['paths'], doc: '需要矢量路径时传入，会显著增大结果' },
  },
  tier: 1,
  cache: { ttlMs: 60_000, keyBy: ['fileKey', 'nodeIds', 'depth'] },
  project: 'nodeTree',
  weight: 'large',
}
```

**新增一个 Figma 能力 = 加一条数据 + 可能加一个投影器。** 这是这个架构最重要的性质：能力扩张不触碰调度、鉴权、上下文管道，也不会让模型看到的工具表变长。

### 4.3 对模型暴露的工具面（3 个，固定）

这是"上下文税"约束的直接产物。

```ts
// 1) 目录检索 —— 渐进式披露
figma_capabilities({
  query?: string,          // 关键词，如 "变体" / "export" / "comment"
  group?: string,          // 按组过滤
  detail?: 'names' | 'full'  // names 只回名字+一句话；full 回完整参数 schema
})
// → 200 token 级目录，命中时才展开 1~3 条完整 schema

// 2) 统一执行入口
figma_call({
  op: string,              // 能力名，如 "file_nodes"
  args?: Record<string, unknown>,
  target?: string,         // 便捷写法：直接粘 figma.com 链接，自动解析 fileKey/nodeId
  max_bytes?: number,      // 显式预算覆盖
  format?: 'summary' | 'full'  // 默认 summary（投影后），full 需显式要求
})

// 3) 画布桥状态与操作（P3，插件未装时可无副作用地返回未就绪）
figma_canvas({
  action: 'status' | 'selection' | 'screenshot' | 'run',
  code?: string            // action=run 时：在 Figma 沙箱里执行并回传 JSON 结果
})
```

为什么 `figma_call` 要支持 `target`：**模型拿到的是人给的链接，不是 fileKey。** 把 URL 解析放进插件而不是放进模型的工作记忆，能省掉一整类"我猜这个 key 是哪一段"的失败。URL 形态需要覆盖 `/file/`、`/design/`、`/board/`、`/proto/`、`/slides/`，以及带 `?node-id=12-345` 的情况（注意 URL 里是 `-`，API 里是 `:`，这个转换必须做）。

**关于 `figma_canvas` 的降级：不要手写探测，用 coeffect 声明式表达。**
插件桥不在线时它必须返回"未就绪 + 如何启用"的确定性结果，而不是报错——但**不要**在 `apply` 里手写轮询或 `if (bridge.isUp())`。正确做法是把桥写成一个**服务**，让 `figma_canvas` 作为一个 `inject: ['figmaBridge']` 的子插件存在：

```
桥服务未注册  → 子插件停在 PENDING，工具不在表里（零副作用、零成本）
桥服务注册后  → Cordis 自动把它拉起来，工具出现
桥断开/卸载   → 依赖失效，工具自动消失
```

这正是 Cordis 论文里的 **reactive coeffect**（见 §0.1）。好处不只是代码更短：**它把"画布离线"从一种运行期错误，变成了一个编译期式可推理的状态**，而且工具表在桥离线时不会被无用的 `figma_canvas` 定义占着上下文。`figma_capabilities` / `figma_call` 两个 REST 工具则无条件常驻。

### 4.4 鉴权与配置

**token 不进配置文件**，走 DSH 凭据服务：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: figma-mcp
      name: 'dsh-figma-mcp'
      config:
        credentialRef: FIGMA_TOKEN       # 由 ctx.credentials 解析
        cacheTtlMs: 60000
        maxResultBytes: 262144           # 单次结果软上限 256 KiB
        spoolDir: .figma                 # 溢出落盘目录（相对 session workspace）
        # ── 限流：按「端点档位 × 席位」声明，而不是一个全局数字 ──
        # 已确认席位为 Full/Dev。默认取最低档 10/min（Starter 套餐的 Full 席位
        # 就是这个值），并由启动自检 + 响应头动态上调，见下文。
        rateLimits:
          tier1: { perMinute: 10, burst: 2 }   # file / file nodes / image
          tier2: { perMinute: 25, burst: 4 }   # 组件 / 变量 / 版本 / 项目 / 评论
          tier3: { perMinute: 50, burst: 8 }   # me / file metadata / 组件与样式
        enablePluginBridge: false        # P3 打开
        bridgePort: 8790
        # 注：没有 allowWrites 之类的写开关——本插件只读，见 §9.2
```

**限流参数为什么要写成"档位 × 席位"而不是一个数字。** Figma 的限流是三个因子的乘积：**席位类型**、**端点档位**、**资源所在套餐**。已确认席位是 Full/Dev，但套餐维度仍会咬人——官方原话是：用 PAT 请求一个 Starter 套餐里的文件，即使你在别的套餐有 Full 席位，该文件也是 **6 次/月**级别。所以：

1. 默认按**最保守的 10/min** 起步（Starter 套餐下 Full 席位的 Tier 1 值），先安全再提速；
2. 自检探针用 **`GET /v1/files/:key/meta`（Tier 3）**，不用 `GET /v1/me`——原因见 §4.4.1；
3. 每次响应读 **`X-Figma-Rate-Limit-Type`**（`high`=Full/Dev，`low`=View/Collab），据此把桶的上限**动态上调或下调**——这比在配置里猜数字可靠，也能在用户换 token、跨套餐取文件时自动适应；
4. `429` 一律以 `Retry-After` 为准覆盖本地估算。

`burst` 给得很小（2）是刻意的：Tier 1 只有 10/min，一次突发失败会让后续调用排队更久，不如串行化。

读凭据的代码（注意 `resolve` 是 per-call 的，**不要缓存**）：

```ts
const ref = credentialRef(config.credentialRef)          // 'FIGMA_TOKEN'
const hit = await ctx.credentials.resolve(ref)
if (hit === undefined) {
  // 不抛硬错误：返回可操作指引，让模型/用户知道下一步做什么
  return { kind: 'unconfigured', remedy: `在 ~/.dsh/.credentials.yaml 的 refs 下加 ${config.credentialRef}` }
}
```

解析顺序天然覆盖环境变量 → 托管存储 → `.env`，所以**用户"只给一个 API token"这件事，三种投递方式都成立**，插件不需要关心他用哪种。

请求头：**PAT 与计划访问令牌用 `X-Figma-Token`**（官方两种令牌的用法页都明确写这个头；REST API 限流页的示例用 `Authorization: Bearer`，两者都有效）。实现为：默认发 `X-Figma-Token`，并允许 config 覆盖成 `Authorization: Bearer` 以兼容。

### 4.4.1 令牌生命周期：会过期，而且两种令牌差别很大

**令牌会过期，这是设计约束而不是运维意外。** 官方事实：

| | 个人访问令牌（PAT） | 计划访问令牌（Plan token） |
|---|---|---|
| 最长有效期 | **90 天**（官方对比表原文 "Max expiration of 90 days"） | **1 年**（365 天） |
| 归属 | 绑定个人账号 | 绑定组织/企业套餐，不绑定个人 |
| 能否刷新 | ❌ **不能刷新**，只能删掉重建 | ✅ 可刷新，**旧密钥还会继续有效 24 小时**（优雅切换窗口） |
| 创建门槛 | 个人 Figma 设置 → Security 里自助生成 | 组织管理员 + 强制 MFA，在 `figma.com/developers/tokens` 生成 |
| 只读适配度 | 可以（勾只读 scope） | **极佳**——官方明确说明计划令牌**不支持** `file_variables:write`、`file_code_connect:write`、`file_comments:write` 这些写 scope；但**也不支持 `/v1/me` 与 `/v1/oembed`** |
| 可用范围 | 该用户能访问的一切 | 限制在套餐内，还可用资源白名单进一步收窄 |

**如果你们是 Organization / Enterprise 套餐，计划访问令牌明显更优**：1 年有效期 + 可刷新 + 24 小时重叠期 + 天然不支持写 scope（与本插件只读定位完全吻合），且不必担心"某人离职后 token 失效"。唯一代价是它不支持 `GET /v1/me`——所以 §4.4 第 2 条的自检探针改用 `GET /v1/files/:key/meta`（Tier 3，很轻，且两种令牌都支持）。

**令牌过期时 API 返回什么**：官方在 file 端点页把 `403` 定义为 *"The developer / OAuth token is invalid or expired"*。**注意是 403 而不是 401** —— 实现时两个都要按"凭据失效"处理，别只判断 401。

**轮换的体验设计**（这是本条信息真正影响的部分）：

1. **不做"自动刷新"**。只有计划令牌能刷新，且刷新动作在 Figma 的管理界面或 API 上，不是 agent 该碰的东西。也不要为了省事去存 OAuth 授权记录（本项目只读且用户只给 token）。
2. **不在我们这边存"过期日期"**。存了就会漂移，还会给用户一种"系统知道什么时候过期"的错觉。**让 403 自己说话**：捕获到凭据失效时，错误结果直接给出可执行的补救步骤（`kind: 'token_expired'`）：
   > Figma 令牌已失效或过期（403）。请到 Figma → Settings → Security → Personal access tokens 生成新令牌（只读 scope 即可），保存到 `~/.dsh/.credentials.yaml` 的 `refs.FIGMA_TOKEN`。凭据文件带 `watch`，**保存即生效，不需要重启**。
3. **轮换无需重启，这件事由 DSH 已经保证**：`ctx.credentials.resolve()` 是**每次操作重新解析**的（官方文档明确要求不得跨操作缓存），加上凭据文件 `watch: true`，所以用户改完文件后，**下一个请求就用新令牌**——刚好覆盖"90 天到了、换一个"这个场景。
4. **降级而不是崩**：令牌失效时，插件要给出确定性的可操作错误，且**其他插件不受影响**（§0.1 的 observational equivalence）。不要把令牌失效做成插件卸载或启动失败。

> **给用户的一句话建议**：如果你们有 Org/Enterprise 套餐，用**计划访问令牌**（1 年 + 可刷新 + 无写权限）；否则用**只读 PAT**，并接受每 90 天换一次——换的时候直接改 `~/.dsh/.credentials.yaml`，保存即生效。

### 4.5 上下文管道（本方案的真正难点）

#### (a) 投影：把节点树变成"设计工程师看得懂的东西"

Figma 节点对象有近百个字段，其中大部分对模型毫无价值。投影器按白名单保留：

```
保留：id / name / type / layoutMode / itemSpacing / padding / primaryAxisSizingMode
     / absoluteBoundingBox(x,y,w,h) / cornerRadius / fills(→ 归一成 hex + opacity)
     / strokes / effects / styleId / characters / style(文本样式)
     / componentId / componentProperties / children

丢弃：id 内部的临时字段 / 各类 *InternalOnly / 冗余的 constraints / relativeTransform
     / 完整 paint 对象里的冷字段 / boundingBox(相对坐标，除非显式需要)
```

- **文本节点特殊处理**：`characters` 保留，但超过阈值截断，并记录被截断的长度——设计师的文案经常很长，全量塞进去性价比极低。
- **颜色归一**：Figma 用 0–1 浮点 RGBA。投影时转成 `#RRGGBB` + `opacity`，因为模型在 hex 上的推理和生成质量明显更好，也更省 token。
- **几何信息按需**：`absoluteBoundingBox` 是回答"这两个元素对不对齐"的关键，默认给；`geometry=paths` 只在明确要矢量路径时给。
- **深度控制默认开**：`depth` 默认 2。这是防"一次调用烧掉整个上下文"的第一道闸。

#### (b) 预算与溢出（budget + spool）

```ts
if (bytes(result) > maxResultBytes) {
  const path = await spool(result)                 // 写 .figma/<hash>.json
  return {
    summary: project(result, { budget: maxResultBytes }),   // 结构 + 统计 + 节点计数
    full: { path, bytes, hint: '需要细节时用 read/grep 读取该文件' },
  }
}
```

关键点：**溢出不是失败**。模型仍然拿到可用的结构摘要和一句诚实的"完整数据在哪个路径"，需要用细节时它有自己的文件工具。这样超长响应永远不会炸掉会话。

#### (c) 缓存与请求合并

三级：

1. **请求合并（单飞）**：同一个 `(fileKey, nodeIds, depth)` 在飞行中只发一次 HTTP，多个并发调用共享结果。这对限流是直接收益。
2. **LRU + TTL**：默认 60s。同一轮对话里模型反复查同一节点是常态，命中率会很高。
3. **ETag / `If-None-Match`**（若 Figma 响应带 ETag，实测确认）：`304` 不消耗额度吗——**这一点必须实测验证**，不能假设。

缓存 key 必须包含**影响响应内容的全部参数**（含 `depth`、`geometry`、`version`）。漏参就是给模型喂错数据，比不缓存更糟。

#### (d) 图片：产出可复用的持久引用

`GET /v1/images/:key?ids=...&format=png&scale=2` 返回的是**短期 S3 链接**（URL 会过期）。设计上：

1. 立刻下载到 `.figma/images/<nodeId>@<scale>x.png`（内容寻址命名，避免"路径还在但内容已变"）；
2. 工具结果里同时给出：相对路径、绝对路径、尺寸、字节数、`nodeId→path` 映射表；
3. **同时把图片作为持久 image block 挂到结果上**（`dsh-llm` 的 typed content 支持嵌套 image block，MCP 桥也是这么做的）。这样模型当轮就能"看见"设计，不需要额外一次 `read_image` 往返；而路径又保证了它想复看时不必重新导出（导出要花 Tier 1 额度）。

注意闸门：只有路由模型声明了 image 输入能力时图片才会真的送达，否则 DSH 会自动降级为文本占位符——这是产品既有行为，插件不需要自己判断，但**要在工具返回值里保留文本描述**，这样降级路径下模型仍能工作。

#### (e) 限流：令牌桶 + 精确退避

因为额度太低（10–20/min），调度必须是"预算制"而不是"尽力而为"：

- 按 `tier` 维护令牌桶（Tier 1 / 2 / 3 三档，各自独立）；
- 桶空时**排队而不是丢弃**，并在工具结果里诚实说明排了多久；
- `429` 一律读 `Retry-After` 退避，绝不自研固定间隔重试；
- `X-Figma-Rate-Limit-Type: low` 时直接返回升级提示（把 `X-Figma-Upgrade-Link` 透给用户）——这是 Figma 官方建议的 UX；
- 长任务（比如"导出全部图标"）走 `ctx.jobs` 后台化，避免占用工具调用超时。

---

## 5. 关键实现细节

### 5.1 工具注册与生命周期

`ctx.tools.register()` 本身就是 Effect，插件卸载自动反注册，**不需要手写清理**。但下面这些必须显式包 `ctx.effect()`：

```ts
export function apply(ctx: Context, config: Config) {
  const provider = createFigmaProvider({ /* ... */ })

  // 工具：自带 Effect，撤回自动
  ctx.tools.register(defineTool(capabilitiesTool))
  ctx.tools.register(defineTool(callTool))
  ctx.tools.register(defineTool(canvasTool))

  // 外部资源：必须自己管
  ctx.effect(() => stopBridgeServer(bridge))       // WebSocket 服务端
}
```

### 5.2 `figma_call` 的执行骨架

```
figma_call({ op, args, target })
  ├─ 1. op 必须在 registry 中（白名单，防模型幻觉出不存在的端点）
  ├─ 2. 只读断言：spec.method === 'GET'，否则拒绝（§9.2 硬约束一）
  ├─ 3. target 存在则解析 URL → fileKey/nodeId（与 args 冲突时 args 优先并提示）
  ├─ 4. 参数按 ParamSpec 校验：类型、必填、范围、枚举
  ├─ 5. 查缓存 → 命中即返回（附 cache: 'hit'）
  ├─ 6. 取令牌（桶空则排队）
  ├─ 7. fetch（带 AbortSignal，接工具超时）
  ├─ 8. 429/5xx → 按 Retry-After 退避重试（上限 N 次）
  ├─ 9. 4xx → 归一为结构化错误（见 5.4），不重试
  ├─ 10. project() 投影
  ├─ 11. budget 检查 → 超限则 spool + 摘要
  └─ 12. 返回 { structuredContent, content[] }，附 meta{bytes,cached,ms,rate}
```

### 5.3 Plugin API 桥（P3，可选但值钱）

REST 拿不到的、只有 Plugin API 能给的：**当前选区、视口、当前页面、`pluginData`、按 Figma 语义遍历**。（Plugin API 也能写节点，但本插件只读，见 §9.2——桥只暴露读取语义。）

架构（受 §1.2 约束四约束）：

```
Figma 插件 (用户手动在 Figma 里运行一次)
├── main (QuickJS 沙箱, 无网络)  ──postMessage──▶  ui iframe (有网络)
└── ui iframe ──WebSocket(ws://127.0.0.1:8790)──▶  DSH host 进程内的 bridge server
                                                          │
                                        figma_canvas 工具 ←──┘
```

- 走 **`ws://127.0.0.1:8790`**（不是 `wss`）→ 必须在 `manifest.json` 的 `networkAccess.allowedDomains` 里声明，且因涉及本地服务器需要写 `reasoning`；
- `manifest.json` 还要设 `documentAccess: 'dynamic-page'`（Figma 对新插件已强制），否则每次运行都会触发整文件加载，在大文件上体验很糟；
- 协议用最朴素的 JSON 请求/响应 + `id` 关联，别引入 RPC 框架；
- **必须实现请求超时**：Figma 关了、插件被卸载，都要在秒级给出确定性错误，而不是让工具调用挂到超时；
- `action: 'run'`（在 Figma 沙箱里执行代码并回传 JSON）是这套桥的杀手锏——**用一次插件往返，换来"任意只读查询"能力**，比在 registry 里穷举几十个 plugin 能力划算得多。**沙箱侧只提供 `figma.*` 的读取 API，不注入任何写方法**（§9.2）。

### 5.4 错误归一

模型对错误信息的质量极其敏感。统一形状：

```ts
type FigmaError =
  | { kind: 'unconfigured'; remedy: string }              // 凭据未配置
  | { kind: 'token_expired'; remedy: string }             // 403：令牌无效或已过期（Figma 用 403，不是 401）
  | { kind: 'forbidden_scope'; scope: string; remedy }    // 403：令牌有效但缺 scope（变量 API 常见）
  | { kind: 'not_found'; remedy: string }                 // 404：key 或 nodeId 错
  | { kind: 'rate_limited'; retryAfterSec: number; upgradeUrl?: string; tier: string }
  | { kind: 'too_large'; bytes: number; spoolPath: string; suggestion: string }
  | { kind: 'bad_args'; field: string; reason: string }   // 参数校验失败
  | { kind: 'bridge_offline'; remedy: string }            // 插件桥不可用
  | { kind: 'upstream'; status: number; body: string }    // 其他
```

**403 的两种含义必须区分开**，否则用户会被指向错误的补救动作：

- `token_expired` —— 令牌本身失效/过期（§4.4.1）。remedy 指向"去 Figma → Settings → Security 重新生成，写回 `~/.dsh/.credentials.yaml`，保存即生效"。
- `forbidden_scope` —— 令牌有效但 scope 不够。remedy 指向"给这个令牌补上 `file_variables:read`"。

区分方式：读响应体里的 Figma 错误信息；无法区分时**默认报 `token_expired`**（因为过期是高频原因，且它给出的补救步骤是无害的）。**不自动重试 403** —— 重试不会让权限变多。

每条 `remedy` 都要是**可执行的下一步**（"给这个 PAT 加上 `file_variables:read` scope"），而不是复述错误。

### 5.5 安全

- token 只出现在请求头，**永不进入日志、错误体、工具结果**；插件侧做一次集中脱敏；
- `302`/`301` 重定向**不自动跟随**——避免 token 被带到非 Figma 域（这是最容易被忽略的凭据泄漏路径）；
- 能力白名单：只允许 registry 里声明的端点，模型无法构造任意 URL；
- `spool` 写盘路径固定在 session workspace 下，禁止路径穿越；
- **只读**：registry 里不存在任何写能力，运行期断言 `method === 'GET'`（§9.2）；
- 若需要 OAuth 而非 PAT，凭据服务的 `CredentialKey`/`modifyRecord` 已经支持「授权记录 + 串行化刷新」，不用自建 token 存储。

### 5.6 可观测

- 每次调用 `ctx.emit('figma/call', {...})`（只发叶子字段，**不要序列化 live 对象**）；
- 结果 meta 里回传 `bytes / cached / ms / ratelimitRemaining`，模型自己会据此调整策略（"刚才那次很贵，我换个方式"）；
- 自检：解析凭据 → 用 `GET /v1/files/:key/meta`（Tier 3）探一次 → 校验返回。失败只在日志告警，**不阻断加载**（避免一个坏 token 让整个 harness 起不来）。**不用 `GET /v1/me`** —— 计划访问令牌不支持该端点（§4.4.1）。

---

## 6. 分期与验收

### P0 — 打通链路（可独立验收，最有价值的一期）

- `core`：capability 类型 + `files/nodes/images` 三个 spec + URL 解析 + http/retry/scheduler/cache/projection/budget
- `adapter-dsh`：3 个工具 + 凭据接入 + config schema
- 接线到 `~/.dsh/profiles/web/`，热重载生效

**验收（端到端，不靠单元测试自我感动）**：
1. 给一个真实 Figma 设计链接，模型能说出：文件里有哪些页面、顶层 Frame 的结构、主色调 hex、主要字体与字号；
2. 追问"某个 Frame 里的按钮长什么样"，模型用 `file_nodes` 定点取，**不重取整个文件**；
3. 导出该 Frame 的 PNG，模型当轮直接看到图；
4. 断网/改坏 token，错误信息能让用户知道具体该做什么；
5. 故意连续调用 12 次 Tier 1 能力，观察排队与 429 退避是否按预期工作。

### P1 — 设计系统语义

- 补 `components` / `variables` / `styles` / `versions` spec（企业版能力要优雅降级）
- `figma://` 作为 session reference 时自动注入文件摘要
- 把能力清单生成到 `docs/CAPABILITIES.md`（从 spec 表自动导出，永不与代码脱节）

**验收**：能回答"这个设计系统里 Button 有几个变体、各自的圆角和配色是什么"；能列出变量集合与模式（需企业版，非企业版给出明确说明而非报错）。

### P2 — MCP 适配器（可移植性）

- `adapter-mcp`：`initialize` / `notifications/initialized` / `tools/list` / `tools/call`，stdio 优先
- 验证：把同一个包挂进别的 MCP 宿主，工具行为一致

**验收**：`dsh-mcp-client` 配置一行指向它，桥接出的 `mcp__figma__*` 与本机工具行为等价。

> ### ⚠️ P2 的协议版本陷阱（已实测，务必先读）
>
> **MCP 协议正在分裂成两代，而本机部署的 SDK 只支持旧的那一代。**
>
> 实测本机 `@modelcontextprotocol/sdk@1.30.0`（`dsh-mcp-client` 的依赖）：
> ```
> LATEST_PROTOCOL_VERSION   = '2025-11-25'
> SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']
> ```
> 而 MCP 已有 **2026-07-28** 修订版，是一次**破坏性**变更（官方 changelog 原文）：
>
> | 2026-07-28 的变化 | 对本项目的影响 |
> |---|---|
> | **移除 `initialize` / `notifications/initialized` 握手**，版本与客户端能力改由每个请求的 `_meta` 携带（`io.modelcontextprotocol/protocolVersion`、`clientCapabilities`） | 我原稿 P2 的"实现 initialize"在新协议下**根本不存在** |
> | 移除协议级 session 与 `Mcp-Session-Id` 头 | 服务端不再需要会话状态管理 |
> | 新增 `server/discover`（**MUST** 实现），用于广告支持的协议版本与能力 | 新协议下这是必需的入口方法 |
> | `tools/list` 等列表结果**必须**带 `ttlMs` / `cacheScope`；工具顺序**应当**确定 | 与我们在 §4.5 的缓存思路同向，但字段是强制的 |
> | 移除 `ping`、`logging/setLevel`；任务改为扩展 `io.modelcontextprotocol/tasks` | — |
>
> **结论与对策**：
> 1. **P2 只实现 `2025-11-25`**（即 `initialize` 握手那一代）。这是当前 `dsh-mcp-client` 唯一能协商成功的版本——写新协议等于自己造一个 DSH 连不上的 server。
> 2. **不要手写协议**：直接用 `@modelcontextprotocol/sdk`（本机已有 1.30.0）。理由是它同时封装了版本协商与 transport，手写只会在这个正在快速变动的规范上持续还债。
> 3. **把版本差异关在适配器里**。这正是 §0.1 组件自足性的价值：`core` 完全不知道 MCP 有几个版本，`adapter-mcp` 换成 stateless 实现时，`core` 一行不用改。等 SDK 升到支持 `2026-07-28`、且 `dsh-mcp-client` 跟进后，再新增一个 stateless 适配器（估 0.5 天）。
> 4. **顺带的好处**：`2026-07-28` 的 `ttlMs`/`cacheScope` 与"服务器应返回确定性顺序的工具列表以提升 LLM prompt cache 命中"这两条，和我方 §1.2/§4.5 的结论完全同向——说明"少而稳定的工具表 + 明确缓存语义"是行业共识，不是我们的偏好。

### P3 — 画布桥 + 可视化

- 伴生 Figma 插件（manifest / main / ui）+ bridge server
- `figma_canvas` 工具 + Client 侧 Slot 面板（桥状态、选区、截图预览）

**验收**：在 Figma 里选中一个图层，问"这个图层的问题在哪"，模型无需人给链接即可读到该图层；面板能实时显示连接状态。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Tier 1 额度只有 10–20/min | 连续操作直接不可用 | 令牌桶 + 单飞 + 缓存；默认 `depth` 限制；大任务后台化 |
| View/Collab 席位 20 次/月 | 几乎不可用 | 启动自检 `X-Figma-Rate-Limit-Type`，UI/错误明确提示升级 |
| 全量文件 JSON 撑爆上下文 | 会话报废 | 默认禁全量；超限 spool + 摘要，永不失败 |
| 模型幻觉出不存在的 op | 无意义失败 | registry 白名单校验，错误里回带可用 op 列表 |
| 节点 id 的 `-`/`:` 混淆 | 高频低级失败 | 由 `target` URL 解析统一承担，并在错误里给出正确写法 |
| 企业版 API（变量）权限 | 421/403 难懂 | 单独 spec + 明确 remedy 文案，不与其他错误混同 |
| 插件桥依赖用户手动运行插件 | 体验断点 | 桥用 coeffect 声明，离线时工具根本不出现在表里（见 §4.3）；文档给出一次性接入步骤 |
| 图片 URL 短期有效 | 复看时 403 | 官方说明图片资源 **30 天后过期**（image fills 的 URL ≤14 天）；故立刻下载落盘 + 内容寻址命名，工具结果只给本地路径 |
| **令牌过期**（PAT 最长 90 天，且不可刷新） | 某天起全部调用 403 | 不存过期日期；捕获 403 报 `token_expired` 并给出重录步骤；`resolve` per-call + 凭据文件 watch 保证**改完即生效免重启**（§4.4.1） |
| 重定向泄漏 token | 凭据泄漏 | 禁用自动重定向 |
| Figma 改版限流策略 | 硬编码失效 | 限额做成 config（`tier` 档位），并读响应头自适应 |
| **MCP 协议版本分裂**（见 §6 P2） | P2 适配器可能白写 | 只实现部署现有 SDK 支持的 `2025-11-25`；stateless 版留到 SDK 升级后，且只改动适配器一个文件 |
| **误加写能力**（只读约束被破坏） | 模型可能改坏真实设计资产 | registry 里没有写 spec + 运行期 `method === 'GET'` 断言 + CI 门禁（§11 第 9 条） |

---

## 8. 工作量估算

| 阶段 | 内容 | 估时 | 状态 |
|---|---|---|---|
| P0 | core 骨架 + 3 spec + 3 工具 + 接线 + 测试（**只读**） | 2–3 天 | 待开工 |
| P1 | 设计系统 spec + 能力文档生成 | 1–2 天 | — |
| P2 | MCP 适配器（按协议 `2025-11-25`） | 0.5–1 天 | — |
| P3 | Figma 伴生插件 + 桥 + Client 面板 | 3–4 天 | — |
| P4 | ~~写操作~~ | — | **不做**（§9.2） |

P0 结束就已经是一个**能天天用的东西**；P3 是锦上添花。P4 已确认不做，故不在估算内——将来若要做，按 §9.2 末尾的方式作为独立一期重新设计（估 +1.5 天）。

---

## 9. 已确认的两个决策

### 9.1 Figma 席位：Full/Dev ✅ 已确认

带来两个直接后果，已落到配置里（见 §4.4）：

- Tier 1（file / nodes / images）额度 **10–20/min**，Tier 2 为 25–100/min，Tier 3 为 50–150/min —— 方案可用，**但必须按"预算制"调度**：令牌桶（默认保守取 10/min）+ 请求合并 + 缓存，`burst` 给小。
- 仍然存在的坑：**限流是「席位 × 端点档位 × 资源所在套餐」三者乘积**。PAT 指向 Starter 套餐里的文件时，即使是 Full 席位也只有 6 次/月级别。所以桶上限不能写死，要读 `X-Figma-Rate-Limit-Type` 动态调整（§4.4）。

### 9.2 写操作：**不做**（已确认，只读）✅

**决策：本插件只读。** 不实现任何会改变 Figma 云端真实数据的调用。这不是"默认关闭、可以打开的开关"，而是架构级约束——`allowWrites` 不作为可配置项暴露，因为**当前不存在任何合法取值**。

定义（我按此实现，也请按此验收）：所有会改变 Figma 数据的端点，**不在 capability registry 里出现**。它们不是"被禁用的能力"，而是**根本不存在的能力**：

| 类别 | 读（实现） | 写（不实现，registry 里没有） |
|---|---|---|
| 评论 | 列出评论 | 发表评论、删除评论 |
| 变量 | 读取本地/已发布变量 | 创建 / 修改 / 删除变量与变量集合 |
| Dev Resources | 列出 dev resources | 新增 / 更新 / 删除 dev resource |
| Webhook | 列出 | 创建 / 更新 / 删除 webhook |
| 文件 | 读节点、导出图 | 改文件名等 |

**实现层面的三条硬约束**（P0 起生效，已并入 §11 纪律清单）：

1. **能力白名单 + 方法白名单双重校验**：派发前断言 `spec.method === 'GET'`。即使有人误加了一条 `POST` spec，运行期也会拒绝——不依赖"我们不会写错"。
2. **只引导只读 scope**：文档与错误提示都指向 `file_content:read`、`file_comments:read`、`file_variables:read`、`file_dev_resources:read` 这类只读 scope。插件不请求、不使用任何写 scope。
3. **不留"预留接口"**：不写 dry-run 骨架、不写审批流钩子、不留 `TODO: writes`。未实现的东西留接口，只会让代码形状按错误的假设生长。

**这条决策的三个理由**（记录在案，便于将来重新评估时对照）：

1. **读错了只浪费一次额度，写错了是在改真实的设计资产**——评论会通知全团队，改变量会影响所有引用该变量的设计稿，且无撤销按钮。
2. **PAT 的能力边界由 scope 决定**，只读 token 是唯一能保证"模型再怎么幻觉也删不掉东西"的方式。
3. **写操作的额度消耗是隐性的**：一轮"批量改 40 个变量"在 Tier 2 的 25/min 下会排队很久，模型未必意识到自己触发了限流。

> 将来若确实需要（例如"让 agent 自动整理变量命名"），按独立一期重新设计：`mutating: true` 标记 + 逐次审批 + 强制 dry-run + 只读/写入双 token 物理隔离（§8 的 P4）。**不要在只读版代码里提前埋这些钩子。**

---

## 10. 事实出处（本机实测 + 官方文档）

**本机实测**（`/Users/n109meow/.npm/_npx/1e7f6d9597241db0/`、`~/.dsh/`）：
- `dsh-mcp-client@0.1.5-rc.2` 存在，README 说明工具命名 `mcp__<serverName>__<tool>`、*"Tool definitions add tokens to every model request"*、stdio/streamable-http 两种 transport、`notifications/tools/list_changed` 重同步、重连退避策略
- `dsh-credentials`：`resolve/describe/set/unset` + `readRecord/listRecords/modifyRecord`；文档明确要求 **per-operation 重新 resolve、不得缓存**，这正是 token 轮换免重启的机制
- `dsh-tools` README：`ctx.tools.register()` 为 Effect；管线 `tools/pre-execute` → `tools/execute` → `tools/post-execute` → `finalizeContent` → `tools/result`；PTC 模式下含图片的成功结果会在运行后附加为 context
- `dsh-llm/lib/types/content.d.ts`：模型内容支持 `image` 块（含嵌套 tool-result 内容），且有路由能力闸门与文本降级路径
- **§1.2 工具开销数字的来源**：用 `Tool.listTools` Inspect 拿到本 session 全部 34 个工具的真实定义（名称/description/parameters 全文），按其 JSON 结构逐项累加字符数得 ~30.9k 字符；token 数按 3.6 字符/token 换算为 ~8.6k。**这是一个工程近似值，不是 tokenizer 精确计数**——本机没有可离线调用的 DeepSeek tokenizer，所以按比例外推（"130 个工具 ≈ +32.8k tokens"）时请当作量级判断而非精确账单。
- `~/.dsh/profiles/web/package.json` + `cordis.patch.yml`：本地插件接线方式（`link:` 依赖 + `insert` 行）；`plugins/pale-green-tint` 是一个已在本机正常工作的手写插件先例
- `dsh plugin --profile web --help` 实际转发给 pnpm，即 `dsh plugin --profile web add <pkg>` = 在 profile 目录里 `pnpm add`

**官方文档**：
- [Figma REST API 认证](https://developers.figma.com/docs/rest-api/authentication/)：OAuth / plan token / PAT 三种；scope 概念（如 `file_content:read`）
- [Figma 个人访问令牌](https://developers.figma.com/docs/rest-api/personal-access-tokens/)：最长 90 天；生成路径 Settings → Security；**用法页明确写 `X-Figma-Token` 头**；token 明文只显示一次
- [Figma 计划访问令牌](https://developers.figma.com/docs/rest-api/plan-access-tokens/)：最长 1 年；可刷新且**旧密钥续用 24 小时**；不支持 `file_variables:write` / `file_code_connect:write` / `file_comments:write` / `/v1/me` / `/v1/oembed`；需组织管理员 + MFA
- [Figma REST API 限流](https://developers.figma.com/docs/rest-api/rate-limits/)：2025-11-17 新表；Tier 1/2/3 × 席位 × 套餐；leaky bucket；429 头 `Retry-After`、`X-Figma-Plan-Tier`、`X-Figma-Rate-Limit-Type`、`X-Figma-Upgrade-Link`；示例用 `Authorization: Bearer`
- [Figma 文件端点](https://developers.figma.com/docs/rest-api/file-endpoints/)：`GET /v1/files/:key` 的 `ids`/`depth`/`geometry`/`version`/`plugin_data`/`branch_data` 参数；`GET /v1/files/:key/nodes`、`GET /v1/images/:key`（`scale` 0.01–4、`format` png/jpg/svg/pdf）、`GET /v1/files/:key/images`、`GET /v1/files/:key/meta`（Tier 3，只用 `file_metadata:read`）；**403 定义为「token invalid or expired」**；图片资源 30 天过期、image fill URL ≤14 天
- [Figma 插件 manifest](https://developers.figma.com/docs/plugins/manifest/)：`networkAccess.allowedDomains` 白名单机制、`ws`/`wss`/`http://localhost:<port>` 是合法 pattern、含本地服务器时 `reasoning` 必填、`documentAccess: 'dynamic-page'`
- [Figma Plugin API 参考](https://developers.figma.com/docs/plugins/api/api-reference/) / [REST API](https://developers.figma.com/docs/rest-api/)

**学术文献**：
- Shi, Y., Zhang, W., Cui, T. — *A Programming Paradigm for Spatiotemporal Composability*, arXiv:2608.25512 [cs.PL], 2026-08-26，92 页。北京大学 / DeepSeek-AI。即 Cordis 的形式化基础论文。原文：<https://arxiv.org/abs/2608.25512>；代码：<https://github.com/cordiverse/cordis>。§0.1 的四个概念（revertible effects / reactive coeffects / context paradigm / observational equivalence）均引自其摘要原文，未做引申。

**MCP 协议（已实测版本支持面）**：
- 本机 `@modelcontextprotocol/sdk@1.30.0`（`dsh-mcp-client` 的依赖）的 `LATEST_PROTOCOL_VERSION = '2025-11-25'`，`SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']`（读 `dist/esm/types.js` 得到）
- [MCP 规范 2026-07-28 变更日志](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md)：移除 `initialize` 握手与会话、新增 `server/discover`、列表结果强制 `ttlMs`/`cacheScope`、建议确定性工具顺序等（详见 §6 P2 的提示框）
- [Claude 官方对 MCP 2026-07-28 的说明](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude)；[Google 关于 MCP stateless 的工程文章](https://developers.googleblog.com/en/scaling-ai-agent-infrastructure-with-the-mcp-stateless-updates/)

**本方案中我没有逐条核实的部分**（诚实标注，避免误导）：
- Figma 各端点具体返回字段与是否支持 `ETag`/`304`。P0 第一件事就是实测这两项（见文末），它们直接决定缓存策略的收益上限。
- Figma 官方 MCP server（远程 `mcp.figma.com/mcp` 与本地 Dev Mode 端口）的当前工具清单与端口细节；§3 中对它的定位（需要 OAuth 登录 / 需要桌面端打开文件）足以支撑选型结论，但不作为实现依据。
- MCP `2026-07-28` 的字段级细节（`server/discover` 的精确 schema、MRTR 的 `inputRequests` 结构等）。P2 只实现 `2025-11-25`，届时若要做 stateless 适配器再逐条对照规范。
- 论文中 service broker 等章节的具体机制（§0.1 末尾提到但未展开），我只依据摘要层面的结论，没有逐节校对 92 页正文。

---

## 11. 设计纪律清单（源自 §0.1，逐条可验证）

这张表是给评审和 code review 用的：每条纪律都配一个**可执行/可观察**的检查方式，避免"听起来很对"的设计悄悄退化。实现时建议直接把这表变成 PR checklist。

| # | 纪律 | 理论出处 | 怎么验证（不靠自觉） |
|---|---|---|---|
| 1 | 每一份子资源都在 `apply()` 里注册 disposer（WebSocket、定时器、缓存驱逐、事件监听、工具） | revertible effects | 反复 `stop` / `update` 插件 20 次，观察句柄数与定时器数回到基线（`process._getActiveHandles()` 或计数器断言） |
| 2 | 不使用不受管的全局副作用（模块级单例、`setInterval`、`process.on`） | revertible effects | CI 里 grep 禁止模式：`^const .* = new .*\(\)$`（模块级）、裸 `setInterval`、`process.on(` |
| 3 | 依赖一律用 coeffect 声明，不手写探测 | reactive coeffects | code review 拒绝 `apply` 内的 `if (bridge.isUp())` / 轮询逻辑；离线行为由 PENDING 表达 |
| 4 | 可选依赖用 `ctx.get(name)` + undefined 检查，硬依赖用 `inject` | context paradigm | 缺服务时插件应停 PENDING 而非抛异常；用"临时摘掉 credentials 行"实测 |
| 5 | `core` 不 import 任何 `@deepseek-ai/*` | 组件自足性 | `dependency-cruiser` 或简单 grep 作为 CI 门禁；`packages/core/package.json` 里没有 DSH 依赖 |
| 6 | 共享可变状态（限流桶、缓存）挂在 host 面 context，不放进 per-session 域 | observational equivalence | 开第二个 session，断言两 session 共用同一个桶实例（否则额度会被翻倍消耗） |
| 7 | 跨组件通信只走 `ctx`（服务/事件），不 import 彼此实现 | observational equivalence | 适配器之间零 import；`core` 只暴露接口 |
| 8 | 卸载后不得残留对模型的可见影响 | observational equivalence | 卸载插件后 `Tool.listTools` 必须回到装载前的工具集（做一次快照 diff） |
| 9 | **只读**：registry 中不存在写能力，派发前断言 `method === 'GET'` | 项目决策（§9.2） | CI 断言：所有 spec 的 `method` 均为 `GET`；故意注入一条 `POST` spec，运行期必须拒绝 |

> 这张表的实际价值在第 6 条和第 8 条上：它们是最容易被"先跑通再说"牺牲掉的两条，而恰恰是它们决定了插件能不能在长跑的 harness 里共处。

---

> 待实测确认的两项（P0 第一件事就做）：**① 304 是否消耗限流额度；② `GET /v1/files/:key` 与 `nodes` 端点是否返回 `ETag`。** 这两条结论会直接影响缓存策略的收益上限。
