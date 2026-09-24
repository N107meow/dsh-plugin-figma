# P0 施工图（Implementation Spec）

> **给执行者**：本文是**唯一按序执行的施工文档**。读完本文即可开工，**不需要通读 `PLAN.md`**。
>
> - `docs/PLAN.md` = **决策与证据**（人读，回答"为什么"）。它是本文的来源，但**不是**施工依据；两者冲突时**以本文为准**。
> - 本文 = **做什么、按什么顺序、怎么算做完**。
>
> 状态：P0 范围已冻结（`PLAN.md` §9.1.3）。包骨架、入口、装配验证脚本、命名已就位。
> 交付形态：**仅 DSH 原生 Cordis 插件（A）**。MCP 适配器**不做**。
>
> **脱敏说明**：本文中的 fileKey、节点 id 与文件名均写作**合成标识符**。实测结论来自真实的私有设计文件，其真实标识符不随本仓库发布；合成 fileKey 仍是 22 位 `[A-Za-z0-9]`，所有实测数字（体积、压缩率、配色、字体层级）未被改动。

---

## 0. 本阶段要交付什么（一句话）

**拿一个 Figma 设计链接，模型能读懂文件结构、配色、字体层级，并导出截图当轮可见。只读。**

完成后模型看到 **2 个工具**（`figma_canvas` 是 P3）：

| 工具 | 作用 |
|---|---|
| `figma_capabilities` | 渐进式披露：按关键词/分组检索能力目录，`detail=full` 才展开参数 schema |
| `figma_call` | 统一执行入口：`op` 指定能力，`target` 可直接粘 Figma 链接 |

**为什么只有 2 个工具而不是 130 个**：工具描述是**每次请求都付**的上下文税。实测本机 34 个工具的定义约 30.9k 字符（≈8.6k tokens）；把 Figma 的 130+ REST 端点各做一个工具会**再加约 3.3 万 tokens/请求**。详见 `PLAN.md` §1.2。

---

## 1. 开工前三件事（顺序不能反）

### 1.0 ⚠️ 先解决依赖解析 —— 否则第一步就崩

**实测发现的阻塞问题**：插件通过 `link:` 装进 profile 后，Node 会按**符号链接的真实路径**（本仓库）解析 import，**不会**去 profile 的 `node_modules` 找。所以直接 `import '@deepseek-ai/dsh-tools'` 会 `ERR_MODULE_NOT_FOUND`。

实测记录（全部失败 → 修复后全部成功）：

```
从 profile 目录:        ✅ 能解析 @deepseek-ai/dsh-tools / schemastery / cordis
从本仓库（插件真实路径）: ❌ ERR_MODULE_NOT_FOUND × 3     ← 插件实际就在这里
把包装进本仓库后:        ✅ 三个全部解析成功
```

**修复**（`package.json` 已加好 `peerDependencies`）：把 DSH 的包在**本仓库**里也装一份。

```bash
cd /Users/n109meow/Documents/DeepSeek/Figma-MCP-dsh

# ⚠️ 必须钉版本 —— npm 上 @deepseek-ai/dsh-tools 的 `latest` 标签指向
#    陈旧的 0.0.1-rc.1，而本机部署是 0.1.5-rc.2。不要裸装。
pnpm add -D @deepseek-ai/dsh-tools@0.1.5-rc.2 @deepseek-ai/schemastery@3.18.2 @deepseek-ai/cordis@4.0.2
```

装完立即自检（**必须三个都 ✅ 才能继续**）：

```bash
node --input-type=module -e "
for (const m of ['@deepseek-ai/dsh-tools','@deepseek-ai/schemastery','@deepseek-ai/cordis'])
  try { await import(m); console.log('  ✅', m) } catch(e) { console.log('  ❌', m, e.code) }"
```

**版本必须与运行中的 DSH 一致**。查本机实际版本：

```bash
P=$(dirname "$(readlink -f "$(command -v dsh)" 2>/dev/null || echo /Users/n109meow/.npm/_npx/1e7f6d9597241db0)")/node_modules/@deepseek-ai
node -p "require('$P/dsh-tools/package.json').version"   # 期望 0.1.5-rc.2
```

> **为什么版本必须对齐**：`defineTool`、`ToolDefinition`、`Config` 的 schema 契约由 DSH 提供。装错版本 = 运行期类型/行为不一致，而且**不会在加载时立刻报错**，只在工具调用时出问题。
>
> **为什么本仓库也要装**：`node_modules/` 在 `.gitignore` 里，所以**别人 clone 后也必须跑这一条**。这是本仓库唯一必需的安装步骤，已写进 README。

### 1.1 然后才是装配三件事

```bash
cd /Users/n109meow/Documents/DeepSeek/Figma-MCP-dsh

# 1) 先装依赖（会改 profile 的 package.json，需要重启 DSH 才生效）
cd ~/.dsh/profiles/web && pnpm add link:/Users/n109meow/Documents/DeepSeek/Figma-MCP-dsh

# 2) 再挂载（cordis.patch.yml 是 patchReload: live，热载生效）
#    在 ~/.dsh/profiles/web/cordis.patch.yml 追加：
#      - insert:
#          - id: figma
#            name: 'figma-mcp-dsh'

# 3) 每次改装配后跑这个，四项必须全绿
cd /Users/n109meow/Documents/DeepSeek/Figma-MCP-dsh && bash scripts/verify-wiring.sh
```

> ⚠️ **顺序反了会看到"装了但没生效"的假象**：`package.json` 的依赖变更需要重启 DSH，而 `cordis.patch.yml` 是热载。先装依赖再挂载。
>
> ⚠️ **`name:` 是包名，`id:` 是 Cordis 行 id** —— 两个不同的字段，别混（`PLAN.md` §9.1.2 有命名统一表）。

---

## 2. 🔴 五个"沉默陷阱"（Do NOT 清单）

这些坑**不报错，只是结果错**。这是本阶段最容易出的事故，**每条都要有对应测试**（§7）。

### ❌ 陷阱 1：把 `color.a` 当图层透明度

Figma 的 paint 是：

```json
{ "type": "SOLID", "color": { "r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0 } }
```

- **`color.a` 是颜色的 alpha 通道，不是透明度。**
- **图层透明度是另一个字段**：`fill.opacity`。

**正确做法**：hex **只取 `r/g/b`**（忽略 `a`）；透明度**只读 `fill.opacity`**，且仅在 `≠ 1` 时输出。

**为什么危险**：实测样本文件里 8 个 fill **全部 `a = 1.0`**，所以写错也测不出来。但任何半透明色都会算错 hex，例如 `{r:0.5,g:0.5,b:0.5,a:0.3}` 会被算成 `#4D4D4D` 而不是正确的 `#808080`。

### ❌ 陷阱 2：以为 `ids` 能限制取多少

- **`ids` 只决定"从哪开始"，`depth` 才决定"取多少"。**
- **不传 `depth` 会返回完整后代树。** 实测（`PLAN.md` §1.3）：

| 请求 | 响应体 |
|---|---|
| `/nodes?ids=13:14`（不传 depth） | **48,659 B** |
| `/nodes?ids=13:14&depth=1` | **2,491 B**（−95%） |
| `/nodes?ids=1:2`（根画布，不传 depth） | **1,193,266 B** ≈ 整个文件 |

**正确做法**：`figma_call` 在 `ids` 存在而 `depth` 缺失时**自动补默认值 `depth=2`**。不要把球踢给模型 —— 模型对"取一个节点"的直觉预期是"取这一层"。

### ❌ 陷阱 3：依赖 `ETag` / `If-None-Match` 做缓存

- `/files/:key/meta` **返回** `etag`，但带 `If-None-Match` 重请求得到 **`200` + 全量，不是 `304`**；响应头还明确 `cache-control: no-cache, no-store`。
- `/files/:key` 与 `/nodes` **根本没有** `etag`。

**正确做法**：缓存**只用 TTL**（默认 60s）。**不要实现 304 分支**，那是死代码。

### ❌ 陷阱 4：以为限流响应头每次都有

- `Retry-After` / `X-Figma-Plan-Tier` / `X-Figma-Rate-Limit-Type` / `X-Figma-Upgrade-Link` **只在 429 上出现**。
- 成功响应**不返回**这些头（它们出现在 `access-control-expose-headers` 里只是 CORS 暴露声明）。

**正确做法**：正常运行期按**本地令牌桶预算**跑，只在收到 429 时用响应头**事后校正**桶上限。

### ❌ 陷阱 5：把令牌失效和缺 scope 搞反

| 实测输入 | 状态 | 响应体 | 含义 |
|---|---|---|---|
| 无效/过期 token | **401** | `{"status":401,"err":"Invalid token"}` | 令牌问题 |
| 有效 token + 缺 scope | **403** | `{"status":403,"message":"Invalid scope…"}` | 权限问题 |

**正确做法**：**401 → `token_invalid`**；**403 + message 含 `Invalid scope` → `forbidden_scope`**。
- 匹配用 **`Invalid scope` 前缀**，别写死单复数 —— 实测两种措辞都出现过：`Invalid scope:` 与 `Invalid scope(s):`。
- 403 的 message 里**列出了该令牌实际持有的全部 scope**，解析出来当 `granted[]` 用。
- **两种都不自动重试**（重试不会让权限变多）。

---

## 3. 目录与模块职责

```
figma-mcp-dsh/                 # 仓库根 = 包根（npm + GitHub 双通道分发要求）
├── package.json                  # name: figma-mcp-dsh ✅ 已就位
├── src/
│   ├── core/                     # ⛔ 零 DSH 依赖、⛔ 不出现 ctx（CI 门禁，见 §8）
│   │   ├── types.ts              # 所有类型定义（本文件无运行时逻辑）
│   │   ├── tokens.ts             # estimateTokens()（§5.7）
│   │   ├── capability.ts         # CapabilitySpec 校验 + 只读断言
│   │   ├── specs/                # ★ 能力声明表（纯数据）
│   │   │   ├── files.ts          #   file, file_nodes, file_meta
│   │   │   ├── images.ts         #   image_render
│   │   │   └── index.ts          #   汇总为 ALL_SPECS
│   │   ├── url.ts                # Figma URL → { fileKey, nodeId }
│   │   ├── auth.ts               # TokenSource 接口 + 脱敏
│   │   ├── http.ts               # fetch 封装（禁重定向、超时、错误归一）
│   │   ├── retry.ts              # 429 感知退避
│   │   ├── scheduler.ts          # 令牌桶 + 同参单飞
│   │   ├── cache.ts              # LRU + 纯 TTL
│   │   ├── projection.ts         # ★ 节点树 → 模型友好结构（陷阱 1 在这里）
│   │   ├── budget.ts             # 动态 depth + spool 溢出
│   │   ├── provider.ts           # ToolProvider：把上面组装起来
│   │   └── spool-sink.ts         # 落盘接口（core 只定义接口，不碰 fs）
│   └── adapter/                  # DSH 接线（唯一允许 import DSH 之处）
│       ├── index.ts              # apply(ctx, config)
│       ├── config.ts             # Schemastery config
│       ├── tools.ts              # figma_capabilities / figma_call 定义
│       └── spool-fs.ts           # 用 ctx.fs 实现 core 的 SpoolSink
├── lib/index.js                  # ⚠️ 公开入口 —— P0 要替换它（§9）
├── test/
│   ├── core/                     # 不 import 任何 DSH，node --test 直接跑
│   ├── fixtures/                 # 见 §7.3
│   └── adapter/                  # 可选，验证 config schema
├── scripts/
│   ├── verify-wiring.sh          # ✅ 已就位
│   └── check-layering.mjs        # 待写（§8）
└── docs/ · README.md · LICENSE · .github/
```

**分层纪律（必须遵守）**：`src/core/**` 里**不得出现** `@deepseek-ai/` 的 import，**不得出现** `ctx`。
这不是洁癖 —— 它是 `PLAN.md` §12.3.1 里"将来补 MCP 适配器不用重构"的**唯一保证**，且由 CI 门禁守住。

---

## 4. 数据流（一次 `figma_call` 的完整路径）

```
模型调用 figma_call({ op, args, target })
  │
  1. op 在 ALL_SPECS 里？否 → bad_op 错误（回带可用 op 列表）
  2. target 存在 → url.ts 解析成 { fileKey, nodeId }（args 优先并提示冲突）
  3. spec.method === 'GET' 断言（只读硬约束）
  4. 参数按 ParamSpec 校验：类型/必填/范围/枚举 → bad_args
  5. 【陷阱 2】args.ids 存在而 args.depth 缺失 → 补 spec 的 depth 默认值
  6. 凭据：tokenSource.resolve() → 无 → unconfigured（给可执行指引）
     （凭据每次操作重新解析，不许缓存 —— 这是令牌轮换免重启的机制）
  7. 缓存查 (spec.name + 规范化参数) → 命中且未过期 → 返回，meta.cached = true
  8. 单飞：同 key 已在飞行中 → 复用同一个 Promise
  9. 令牌桶取令牌（桶空 → 排队，结果 meta 里回报 waitedMs）
 10. http.ts fetch：
       - 禁自动重定向
       - 接 exec.signal（工具超时）
       - 带 X-Figma-Token
 11. 401 / 403 / 404 / 429 / 5xx → 归一（§6）
 12. 429 → retry.ts 按 Retry-After 退避重试（上限 3 次）
 13. projection.ts 投影（陷阱 1 的颜色归一在这里）
 14. budget.ts：
       size > budget? → 收紧 depth 重取一次 → 仍超 → 只回骨架 + spool 落盘
 15. 返回 { structuredContent, content[] }，meta 回带
     { nodeCount, projectedChars, depthUsed, cached, waitedMs, spooled }
```

**第 15 步为什么重要**：把成本回报给模型，它下一轮会主动用 `ids` 收窄。这比插件单方面截断体验好得多。

---

## 5. 模块规格

### 5.1 `core/types.ts`

```ts
export interface ParamSpec {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array'
  items?: 'string'
  required?: boolean
  default?: unknown
  min?: number
  max?: number
  enum?: readonly string[]
  description: string
}

export interface CapabilitySpec {
  name: string
  description: string
  group: 'file' | 'node' | 'image' | 'comment' | 'component' | 'variable' | 'project'
  scopes?: readonly string[]
  transport: 'rest' | 'plugin'          // P0 只用 'rest'
  method: 'GET'                          // ⚠️ 只读：P0 里只有 GET。保留联合类型仅为让断言有意义
  path: string                           // 如 '/v1/files/:fileKey/nodes'
  params: Record<string, ParamSpec>
  query?: Record<string, string>         // 固定注入的 query
  tier: 1 | 2 | 3
  cache?: { ttlMs: number; keyBy: readonly string[] }
  project: ProjectorName
  weight: 'tiny' | 'small' | 'large' | 'huge'
}

export type ProjectorName = 'fileMeta' | 'nodeTree' | 'imageUrls' | 'raw'

export interface TokenSource { resolve(): Promise<string | undefined> }
export interface SpoolSink { write(name: string, content: string): Promise<string> }
```

`CapabilitySpec.method` 注释里要写上"P0 只有 GET"，避免后人误以为可以加 POST。

### 5.2 `core/url.ts`

```ts
export interface FigmaTarget { fileKey: string; nodeId?: string }

/** 返回 undefined 而不是抛错 —— 让调用方决定怎么报错。 */
export function parseFigmaUrl(input: string): FigmaTarget | undefined
```

必须覆盖的 URL 形态（`PLAN.md` §4.3）：

- 路径段：`/file/`、`/design/`、`/board/`、`/proto/`、`/slides/`
- fileKey = 第 2 个路径段
- **node-id 转换**：URL 里是 `?node-id=12-345`（连字符），API 里要 `12:345`（冒号）—— **这个转换必须做**
- 忽略 `?t=...` 之类的追踪参数
- 也要接受裸 fileKey（22 位字母数字）与裸 nodeId

**测试用例**（全部来自真实链接）：

| 输入 | 期望 |
|---|---|
| `https://www.figma.com/design/Aa1Bb2Cc3Dd4Ee5Ff6Gg7H/Design%20File%20A?node-id=1-2&t=xxx` | `{fileKey:'Aa1Bb2Cc3Dd4Ee5Ff6Gg7H', nodeId:'1:2'}` |
| `https://www.figma.com/design/Zz9Yy8Xx7Ww6Vv5Uu4Tt3S/Design%20File%20B?node-id=9-10&t=xxx` | `{fileKey:'Zz9Yy8Xx7Ww6Vv5Uu4Tt3S', nodeId:'9:10'}` |

### 5.3 `core/http.ts`

```ts
export interface HttpRequest {
  url: string
  token: string
  headers?: Record<string, string>
  signal?: AbortSignal
  redirect?: 'error'   // ⚠️ P0 固定 'error'，见下
}
export interface HttpResponse { status: number; headers: Headers; body: string }
export async function figmaFetch(req: HttpRequest): Promise<HttpResponse>
```

**硬性要求**：

1. **禁止自动重定向**。`fetch(..., { redirect: 'error' })`。理由：令牌在 `X-Figma-Token` 头里，自动跟随重定向会把令牌带到非 Figma 域（凭据泄漏）。**这是安全项，不是偏好。**
2. **认证头用 `X-Figma-Token`**（两种令牌的官方用法页都写这个头）。发出站请求时**不要**同时带 `Authorization`，避免日志里出现两份凭据。
3. **集中脱敏**：任何进入错误、日志、工具结果的字符串都过一遍 `redact(s)`，把令牌值替换成 `figma_***`。**在 `http.ts` 和 `provider.ts` 的出口各做一次。**
4. 不设 `Content-Type`（都是 GET，无 body）。
5. 返回 `body` 为**字符串**，由调用方决定是否 `JSON.parse`（错误体可能不是 JSON）。

### 5.4 `core/retry.ts`

```ts
export interface RetryPolicy { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }
export async function withRetry<T>(
  attempt: () => Promise<T>,
  classify: (r: unknown) => { retryable: boolean; retryAfterMs?: number },
  policy: RetryPolicy,
  signal?: AbortSignal,
): Promise<T>
```

- **只对 429 与 5xx 重试**；4xx（含 401/403/404）**不重试**。
- 429 时**以 `Retry-After` 为准**（秒，整数），无该头才退回指数退避。
- 退避加抖动，避免并发请求同时重试。
- `maxAttempts` 默认 3。
- 每次重试前检查 `signal.aborted`。

### 5.5 `core/scheduler.ts`

```ts
export interface RateLimitConfig { perMinute: number; burst: number }
export class TokenBucket {
  constructor(cfg: RateLimitConfig, now?: () => number)
  async acquire(signal?: AbortSignal): Promise<{ waitedMs: number }>
  /** 仅由 429 路径调用：用响应头校正上限。 */
  calibrate(limitType: 'high' | 'low' | undefined): void
  get limit(): number
}
export class SingleFlight {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>
}
```

- **默认值按"最弱席位"设**：Tier 1 `{ perMinute: 5, burst: 1 }`。理由：开源受众里 View/Collab 席位的 Tier 1 只有 **20 次/月**，且调用前无法得知对方是哪种（`PLAN.md` §12.2）。
- `now` 可注入 → **测试确定性**（不要用真实时钟写测试）。
- `calibrate()` 只在收到 429 时调用；`limitType === 'high'`（Full/Dev）时放宽到配置上限，`'low'` 时收紧。

### 5.6 `core/cache.ts`

```ts
export class TtlCache<V> {
  constructor(opts: { maxEntries: number; now?: () => number })
  get(key: string): V | undefined           // 过期即视为 miss 并删除
  set(key: string, value: V, ttlMs: number): void
  /** 显式失效：/meta 的 version 变化时调用。 */
  invalidatePrefix(prefix: string): void
}
```

- **纯 TTL，无 ETag/304 分支**（陷阱 3）。
- 缓存 key 必须包含**影响响应内容的全部参数**：`spec.name` + `fileKey` + `ids`（**排序后**）+ `depth` + `geometry`。**漏参就是喂错数据，比不缓存更糟。**
- 默认 `maxEntries: 64`，TTL 取 spec.cache.ttlMs（默认 60_000）。

### 5.7 `core/tokens.ts`

```ts
/** 粗略 token 估算：chars / 3.6。用于预算决策，不用于计费。 */
export function estimateTokens(s: string): number
export function estimateBytes(s: string): number   // Buffer.byteLength(s, 'utf8')
```

**必须在文件头写明这是近似值**：本机没有可离线调用的 DeepSeek tokenizer，`3.6 chars/token` 是工程近似（`PLAN.md` §10 已如实标注）。用它做**决策**（要不要 spool），不要用它做**断言**。

### 5.8 `core/projection.ts` ★

```ts
export interface ProjectOptions { budgetTokens?: number; includeGeometry?: boolean }
export interface ProjectedNode { /* 见下面白名单 */ }
export function projectNode(node: unknown, opts?: ProjectOptions): ProjectedNode
export function projectFileMeta(raw: unknown): Record<string, unknown>
export function collectPalette(node: ProjectedNode): Array<{ hex: string; count: number }>
export function collectFonts(node: ProjectedNode): string[]
```

**节点字段白名单**（`PLAN.md` §4.5a）：

```
保留：id, name, type, layoutMode, itemSpacing,
     paddingLeft/Right/Top/Bottom,
     primaryAxisSizingMode, counterAxisSizingMode,
     cornerRadius, fills, strokes, strokeWeight, effects,
     characters, style, componentId, componentProperties,
     opacity, visible, children
丢弃：constraints, relativeTransform, absoluteRenderBounds, blendMode,
     background, backgroundColor, clipsContent, complexStrokeProperties,
     exportSettings, interactions, layoutAlign, layoutGrow, scrollBehavior,
     strokeAlign, strokeJoin, strokesIncludedInLayout, layoutSizing*,
     layoutGrids, *, *InternalOnly
```

**几何**：`absoluteBoundingBox` → `box: { x, y, w, h }`（全部 `Math.round`），然后**删掉原字段**。

**颜色归一（陷阱 1 的实现）**：

```ts
const toHex = (c: { r: number; g: number; b: number }) =>
  '#' + (['r','g','b'] as const)
    .map(k => Math.min(255, Math.round(255 * (c[k] ?? 0))).toString(16).padStart(2, '0'))
    .join('').toUpperCase()

// fills：逐项 →
//   { type }
//   + (color ? { hex: toHex(color) } : {})       // ⛔ 绝不读 color.a
//   + (fill.opacity != null && fill.opacity !== 1 ? { opacity: fill.opacity } : {})
//   + (fill.visible === false ? { hidden: true } : {})
```

**文本样式**：只保留 `{ fontFamily, fontWeight, fontSize, textAlignHorizontal, lineHeightPx, letterSpacing }`，丢掉 `fontPostScriptName` / `textAutoResize` / `lineHeightPercent*` / `lineHeightUnit`。

**`characters`**：超过 `maxTextChars`（默认 500）截断，并在节点上加 `textTruncatedAt: <原长度>` —— **不要静默截断**。

**实测基准**（§7 的断言依据）：

| 文件 / 节点 | 原始 | 投影后 | 压缩 |
|---|---|---|---|
| `Design File A` `11:12`（`depth=4`，18 节点） | 20,859 chars | 5,879 chars | **−72%** |
| `Design File B` `3:4` LIGHT（154 节点） | 123,328 chars | 35,425 chars | **−71%** |
| 同上 `5:6` DARK（154 节点） | 122,961 chars | 35,105 chars | **−71%** |

### 5.9 `core/budget.ts` ★

```ts
export interface BudgetResult {
  value: unknown
  depthUsed: number
  spooled?: { path: string; bytes: number }
  tightened: boolean
  skeletonOnly: boolean
}
export async function applyBudget(
  fetchOnce: (depth: number) => Promise<unknown>,
  project: (raw: unknown) => unknown,
  opts: { depth: number; budgetTokens: number; minDepth: number; spool: SpoolSink },
): Promise<BudgetResult>
```

算法（`PLAN.md` §1.5）：

```
1. raw = await fetchOnce(depth); proj = project(raw)
2. estimateTokens(JSON.stringify(proj)) <= budget ? → 返回
3. depth > minDepth ? depth-- 重取一次（只重取一次）→ 再判
4. 仍超 → 只回骨架：页面/画板层级 + 每层节点计数 + 配色/字体摘要
   同时把完整投影 JSON 交给 spool.write()，结果里给路径
```

> ⚠️ **步骤 3 只重取一次**。无限收紧会让一次工具调用烧掉大量 Tier 1 额度（每档 5/min）。宁可给骨架 + 落盘路径，也不要反复重取。

默认 `budgetTokens: 8000`。

### 5.10 `core/provider.ts`

```ts
export interface ToolProvider {
  listCapabilities(filter?: { query?: string; group?: string; detail?: 'names' | 'full' }): unknown
  call(input: {
    op: string
    args?: Record<string, unknown>
    target?: string
    max_bytes?: number
    format?: 'summary' | 'full'
    /** 来自 exec.signal，接工具超时与取消 */
    signal?: AbortSignal
  }): Promise<unknown>
}
export function createProvider(deps: {
  tokenSource: TokenSource
  spool: SpoolSink
  config: { cacheTtlMs: number; maxResultBytes: number; rateLimits: Record<'tier1'|'tier2'|'tier3', RateLimitConfig>; budgetTokens: number }
  fetchImpl?: typeof fetch          // 测试注入
  now?: () => number                // 测试注入
}): ToolProvider
```

### 5.11 `adapter/config.ts`

```ts
import Schema from '@deepseek-ai/schemastery'
export const Config = Schema.object({
  credentialRef: Schema.string().default('FIGMA_TOKEN'),
  cacheTtlMs: Schema.number().default(60_000),
  maxResultBytes: Schema.number().default(262_144),
  budgetTokens: Schema.number().default(8_000),
  spoolDir: Schema.string(),                 // 见 §5.12
  rateLimits: Schema.object({
    tier1: Schema.object({ perMinute: Schema.number().default(5),  burst: Schema.number().default(1) }),
    tier2: Schema.object({ perMinute: Schema.number().default(10), burst: Schema.number().default(2) }),
    tier3: Schema.object({ perMinute: Schema.number().default(20), burst: Schema.number().default(3) }),
  }),
})
```

> ⚠️ **默认值一律取"最弱席位"**（陷阱之外的第 6 条纪律）：**不要把 Full/Dev 的参数写进默认值**，靠首次 429 的响应头放宽。

### 5.12 `adapter/index.ts`

```ts
export const name = 'figma'
export const inject = ['tools', 'credentials']   // 硬依赖
export function apply(ctx: Context, config): void
```

**必须**：

- `inject: ['tools', 'credentials']` —— 两者都是硬依赖，缺一就不该激活。
- **所有副作用走 `ctx.effect()` / `ctx.on()` / `ctx.tools.register()`**（后两者自带 Effect）。
- **凭据每次操作重新解析**：`await ctx.credentials.resolve(ref)` **不许缓存** —— 这是令牌轮换免重启的机制（`PLAN.md` §4.4.1）。
- **`spoolDir` 的解析**：`ctx.fs` 在 host 面存在与否要 **`ctx.get('fs')` + undefined 检查**（不要写进 `inject`，否则没有 `ctx.fs` 的 profile 会让整个插件 PENDING）。取不到 `ctx.fs` 时降级：spool 改为"不落盘，只回摘要"。
  - 路径：`ctx.fs.resolve(spoolDir, { cwd })` → `ctx.fs.writeText(target, content, undefined, signal)`。
  - `spoolDir` 建议默认 `'.figma'`，相对 session workspace；**做路径穿越防护**（拒绝 `..`）。
- **不要 `JSON.stringify` 任何 DSH live 对象**（`ctx`、Service 实例、Session）—— 只取叶子标量。

### 5.13 `adapter/tools.ts`

用 `defineTool`（**已核实的签名**，来自 `dsh-tools` README）：

```ts
ctx.tools.register(defineTool({
  name: 'figma_call',
  description: '…',
  parameters: {
    op:     { type: 'string', required: true, description: '能力名，如 file_nodes。先用 figma_capabilities 查看可用 op。' },
    args:   { type: 'object', description: '能力参数，见 figma_capabilities detail=full' },
    target: { type: 'string', description: '可直接粘 Figma 链接，自动解析 fileKey/nodeId' },
    max_bytes: { type: 'number' },
    format: { type: 'string', enum: ['summary', 'full'] },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    // ⚠️ 逐字段转发 —— 不要 `...args` 再塞 signal：args 是模型给的参数，
    //    signal 是执行上下文，混进同一个对象会让 provider 收到未声明的键。
    return provider.call({
      op: args.op,
      args: args.args,
      target: args.target,
      max_bytes: args.max_bytes,
      format: args.format,
      signal: exec.signal,          // provider.call 的 input 类型里要加 signal?: AbortSignal
    })
  },
}))
```

- `parameters` 的 `description` 要写清**什么时候用**，不只是"是什么"（模型据此选工具）。
- `figma_capabilities` 的 `detail` 默认 `'names'`（只回名字 + 一句话），`'full'` 才回完整参数 schema —— 这是渐进式披露的实现。
- **`execute` 里不要抛错**：`PLAN.md` §5.4.1 的通道 A —— 把错误变成**成功的、带可执行补救步骤的返回值**。抛错会让模型只看到 `Error: ...` 并倾向无意义重试。

---

## 6. 错误归一（`core/errors.ts`）

```ts
export type FigmaError =
  | { kind: 'unconfigured';       remedy: string }
  | { kind: 'token_invalid';      remedy: string }                    // 401
  | { kind: 'forbidden_scope';    granted: string[]; remedy: string } // 403 + Invalid scope
  | { kind: 'not_found';          remedy: string }                    // 404
  | { kind: 'rate_limited';       retryAfterSec: number; upgradeUrl?: string; limitType?: 'high'|'low' }
  | { kind: 'too_large';          bytes: number; spoolPath?: string; suggestion: string }
  | { kind: 'bad_args';           field: string; reason: string }
  | { kind: 'bad_op';             requested: string; available: string[] }
  | { kind: 'upstream';           status: number; body: string }
```

**判别规则**（陷阱 5）：先看 status，再看响应体文案。

**`remedy` 必须是可执行的下一步**，不是复述错误。两个关键 remedy 的文案：

`token_invalid`：

```
Figma 令牌已失效（401 Invalid token）。个人访问令牌最长 90 天且不可刷新。
请用户执行：
  1. 打开 https://www.figma.com/settings → Security → Personal access tokens → Generate new token
  2. 勾选只读 scope：file_content:read, file_metadata:read, file_comments:read, file_dev_resources:read
  3. 把新令牌写入 ~/.dsh/.credentials.yaml 的 refs.FIGMA_TOKEN（保存即生效，无需重启）
  4. 写完后告诉我，我重试刚才的操作
```

> 最后一句是关键：**模型被明确授权"要求用户重新申请 + 重试"**，闭环才完整。

**进程内记忆**：`token_invalid` 要记住"这个凭据值已失效"，使同会话后续调用**立刻失败并复用同一份指引**，而不是每次撞一次 401。**判据用凭据值的哈希**（不用时间）—— 这样用户放好新令牌后自动恢复。

---

## 7. 测试

### 7.1 分层

- `test/core/**` —— **不 import 任何 DSH**，`node --test test/core/` 直接跑。用注入的 `fetchImpl` / `now` 保证确定性。
- `test/adapter/**` —— 可选，验证 config schema 校验与参数映射。

### 7.2 必测用例（每条对应一个陷阱或硬约束）

| # | 用例 | 断言 |
|---|---|---|
| 1 | **半透明颜色**（陷阱 1） | `{r:0.5,g:0.5,b:0.5,a:0.3}` → hex `#808080`；`opacity` 来自 `fill.opacity` 而非 `color.a` |
| 2 | **不透明颜色** | `{r:1,g:1,b:1,a:1}` → `#FFFFFF`，且**不输出** `opacity` 字段 |
| 3 | **`fill.opacity = 0.5`** | 输出 `opacity: 0.5`，hex 仍为 rgb 算出 |
| 4 | **depth 守卫**（陷阱 2） | 传 `ids` 不传 `depth` → 断言实际请求 URL 含 `depth=2` |
| 5 | **URL 解析** | 两个真实链接（§5.2 表格），含 `node-id=9-10` → `9:10` |
| 6 | **URL 解析失败** | 非 Figma URL → `undefined`，不抛错 |
| 7 | **只读断言** | 注入一条 `method: 'POST'` 的 spec → 派发必须拒绝 |
| 8 | **401 → token_invalid**（陷阱 5） | 含可执行 remedy；**断言不重试**（调用计数 = 1） |
| 9 | **403 → forbidden_scope** | 解析出 `granted[]`；**断言不重试** |
| 10 | **429 退避**（陷阱 4） | 读 `Retry-After`；重试次数 ≤ maxAttempts；`calibrate()` 被调用 |
| 11 | **令牌桶默认值** | 默认配置下 Tier 1 是 `5/min, burst 1`（**不是** Full/Dev 的值） |
| 12 | **单飞** | 同 key 并发 5 次 → 底层 fetch 只调用 1 次 |
| 13 | **缓存 key 完整** | 改 `depth` 或 `ids` 顺序不同 → 视为不同 key；`ids` 顺序相同 → 命中 |
| 14 | **预算收紧只一次** | 超预算时 `fetchOnce` 最多被调用 **2** 次 |
| 15 | **spool 溢出** | 超预算 → 返回骨架 + `spool.write()` 被调用 |
| 16 | **脱敏** | 令牌值不出现在任何错误/结果字符串里 |
| 17 | **禁重定向** | `fetchImpl` 收到的 `redirect === 'error'` |
| 18 | **`textTruncatedAt`** | 超长 `characters` 截断且标注原长度 |

### 7.3 Fixtures 与脱敏 ⚠️

**绝对不要把真实 fileKey / 节点 id 硬编码进源码或 fixture。** `PLAN.md` 里的实测数据含真实文件与作者 handle，开源前必须脱敏。

做法：

```ts
// test/fixtures/real-file.ts
export const REAL_FILE_KEY = process.env.FIGMA_TEST_FILE_KEY      // 未设置则 skip
export const REAL_NODE_ID  = process.env.FIGMA_TEST_NODE_ID
export const hasLiveFixtures = Boolean(REAL_FILE_KEY && REAL_NODE_ID)
```

真实数据只用于**本地手工验证**（§7.5），**不进仓库**。`.gitignore` 已忽略 `fixtures/recorded/`。

### 7.4 合成 fixture

为 §7.2 的用例手写**最小合成节点树**，覆盖：

- 一个 SOLID fill（不透明）+ 一个半透明 fill
- 一个带 `opacity` 的 fill
- 一个 TEXT 节点（含 `style` 与 `characters`）
- 一个嵌套 `children`（≥3 层）
- 一个 `visible: false` 的节点
- 一个 `characters` 超长的 TEXT 节点
- `absoluteBoundingBox` 带小数（验证取整）

### 7.5 真实数据手工验证（P0 收尾）

真实 fileKey 与节点 id 不随仓库发布，用你自己的私有文件跑：

```
FIGMA_TEST_FILE_KEY=<你的私有 fileKey> \
FIGMA_TEST_NODE_ID=<该文件里的一个画板节点 id> \
FIGMA_TEST_NODE_ID_B=<明暗主题对里的另一个节点 id，可选> \
FIGMA_TEST_RATE_LIMIT=1 \
node --test test/
```

**注意**：真实数据只用于本机手工验证，**不要提交**；仓库里的 fixture 一律是合成值，`test/fixtures/recorded/` 已在 `.gitignore` 里。

---

## 8. CI 门禁（`scripts/check-layering.mjs`）

三个必须失败即报错的检查：

1. **`src/core/**` 里没有 `@deepseek-ai/`** —— grep，命中即失败。
2. **`src/core/**` 里没有 `ctx`** —— grep（注意排除注释里的说明性文字，用词边界）。
3. **所有 spec 的 `method` 都是 `'GET'`** —— 运行时/静态断言。

> 这三条是 `PLAN.md` §12.3.1 里"将来补 MCP 适配器不用重构"和 §11 第 9 条"只读"的**唯一执行机制**。纪律会随开发衰减，CI 不会。

`package.json` 已经有 `"check:layering": "node scripts/check-layering.mjs"`。

---

## 9. 收尾：替换 `lib/index.js` ⚠️

`lib/index.js` 当前是**占位插件**（能加载、能卸载、打日志）。它是**包的公开入口**（`package.json` 的 `main`）。

P0 完成后必须把它改成从 `src/adapter/index.ts` 的真实转发，或直接内联实现。

**为什么它必须留在仓库里**：GitHub 安装（`pnpm add github:...`）**不执行构建步骤**，所以编译产物必须提交，否则用户装到空包（`PLAN.md` §12.9.1）。

**注意**：本项目**不需要构建步骤**（纯 JS + JSDoc 类型），所以 `lib/index.js` 要么是手工维护的转发层，要么就地实现。**不要**引入 bundler。

---

## 10. 分步施工顺序

每步结束都要**能跑**，不要攒到最后一起测。

| 步 | 内容 | 完成的判据 |
|---|---|---|
| 0 | **依赖就绪（§1.0）** | `npm run check:deps` 三个 ✅ —— **不通过就不要往下走** |
| 1 | `core/types.ts`、`tokens.ts`、`url.ts` | URL 解析 4 个用例全绿（§7.2 #5/#6） |
| 2 | `core/projection.ts` | 颜色 3 个用例全绿（#1/#2/#3）+ 真实基准（§5.8 表格） |
| 3 | `core/specs/files.ts`、`images.ts`、`index.ts` | `ALL_SPECS` 可遍历；每条都通过 `capability.ts` 校验 |
| 4 | `core/capability.ts` + `errors.ts` | 只读断言用例绿（#7） |
| 5 | `core/http.ts`、`retry.ts` | 禁重定向（#17）、脱敏（#16）、429 退避（#10） |
| 6 | `core/scheduler.ts`、`cache.ts` | 桶默认值（#11）、单飞（#12）、缓存 key（#13） |
| 7 | `core/budget.ts`、`spool-sink.ts` | 收紧只一次（#14）、spool（#15） |
| 8 | `core/provider.ts` | 端到端：`call({op:'file_nodes', ids, ...})` 用注入 fetch 跑通 |
| 9 | `scripts/check-layering.mjs` | 三条门禁全绿；**故意注入一条 `ctx` 用法，必须报错** |
| 10 | `adapter/config.ts`、`spool-fs.ts`、`tools.ts`、`index.ts` | **前置：§1.0 的三个包已装且自检 ✅**；`verify-wiring.sh` 全绿且日志显示真实工具已注册 |
| 11 | 替换 `lib/index.js` | `verify-wiring.sh` 仍全绿 |
| 12 | 真实数据手工验证（§7.5） | §11 验收清单全过 |

---

## 11. 验收清单（P0 完成 = 全部打勾）

- [ ] **基准断言 1**：`Design File A` `11:12`（`depth=4`）投影 ≤ 6,000 chars；配色报出 `#111827 / #9CA3AF / #C4CCC8 / #F5F5F7 / #FFFFFF`；字体 `Inter 400 10.5px / 400 12.5px / 600 13px / 700 18px`
- [ ] **基准断言 2**：`Design File B` `3:4` 与 `5:6`（`depth=4`，各 154 节点）投影 ~35,400 chars（−71%）；**两版配色集合不同**；品牌绿 `#29CB97` **两版都出现**
- [ ] **半透明颜色回归**：`{r:0.5,g:0.5,b:0.5,a:0.3}` → `#808080`（防静默取错颜色）
- [ ] **depth 守卫**：传 `ids` 不传 `depth` → 自动补 `depth=2`，响应 < 10 KB（不得出现 48 KB / 1.19 MB 量级）
- [ ] 给一个真实 Figma 链接，模型能说出：页面、顶层 Frame 结构、主色 hex、字体与字号
- [ ] 追问"某个 Frame 里的按钮长什么样"，模型用 `file_nodes` **定点取**，不重取整个文件
- [ ] 导出 Frame 的 PNG，模型**当轮直接看到图**（图片落盘 + 持久引用）
- [ ] 连续 12 次 Tier 1 调用，观察排队与 429 退避按预期工作
- [ ] **令牌失效闭环**：把 `refs.FIGMA_TOKEN` 临时改成无效值 → 工具**不抛错**、返回结构化 `token_invalid` + 可执行步骤 → 模型**主动要求用户换令牌** → 用户写回新令牌（**不重启**）→ 重试成功；期间 `Tool.listTools` 不变
- [ ] `npm run check:deps` 三个 ✅（§1.0；脚本已就位）
- [ ] `bash scripts/verify-wiring.sh` 全绿
- [ ] `node --test test/core/` 全绿（§7.2 的 18 条）
- [ ] `npm run check:layering` 全绿，且**故意注入违规代码时确实报错**
- [ ] `npm run verify` 一条命令跑全部检查（deps + layering + test）
- [ ] `git status` 里**没有**真实 fileKey / 节点 id / Figma handle

---

## 12. 已知未验证项（不要假装确定）

诚实标注，避免执行者把假设当事实：

| 项 | 状态 |
|---|---|
| **企业版 / 变量 API 的真实返回结构** | ❌ `/files/:key/variables/local` 实测返回 **403**（缺 `file_variables:read`），且可能需要企业版套餐。P0 不实现变量能力（属 P1） |
| **组件实例 / 变体 / 样式引用** | ❌ 测试文件里 `INSTANCE` / `componentSets` / `styles` 均为 0，无法验证 `componentId` 解析路径。属 P1 |
| **`github:` 安装是否可用** | ❌ 本机网络吞吐 <1000 B/s，git 直接中止。`link:` 路径已实测通过；`github:` 留给用户在更好网络下验证 |
| **Figma 的 Tier 1 实际上限** | ⚠️ 约 12 次请求窗口内未触发 429，**样本不足以证明** Full 席位在 Pro 套餐下高于 10/min。保守预算因此保留 |
| **`ETag` 是否有别的用法** | ✅ 已确认条件请求不可用（200 非 304），**不要再花时间探索** |
| **token 估算精度** | ⚠️ `chars / 3.6` 是工程近似，非 tokenizer 精确计数。用于决策，不用于断言 |
| **npm 上 `dsh-tools` 的版本标签** | ⚠️ `latest` = `0.0.1-rc.1`（陈旧），部署在用的是 `0.1.5-rc.2`，npm 上另有 `0.1.5-rc.3` / `next` 标签。**永远钉精确版本，不要裸装** |

---

## 13. 与 `PLAN.md` 的对照

执行时若需背景，只看这些小节，**不必通读**：

| 需要什么 | 看哪里 |
|---|---|
| 为什么只有 2 个工具（上下文税实测数据） | `PLAN.md` §1.2 |
| API 行为实测（depth/ETag/限流头/401-403/图片导出） | §1.3 |
| 明暗主题实测基准 | §1.4 |
| 动态 depth 策略的完整推导 | §1.5 |
| 能力表为什么是数据 | §4.2 |
| 上下文管道的完整设计 | §4.5 |
| 错误归一与令牌失效闭环 | §5.4、§5.4.1 |
| 只读决策与三条硬约束 | §9.2 |
| 分层纪律与 CI 门禁的意义 | §11、§12.3.1 |
| 命名统一表（`name` vs `id`） | §9.1.2 |

**不要读**：§12.9.1（分发装配，已固化进 `scripts/verify-wiring.sh`）、§6 P2（MCP 适配器，当前不做）、§0.1（理论背景）。
