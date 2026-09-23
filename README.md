# Figma × DeepSeek Harness 插件

把 Figma 设计文件变成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里模型能直接读的东西：文件结构、配色、字体层级，以及**当轮就能看见**的设计稿截图。**只读。**

> ⚠️ 本项目**非 Figma 官方项目，未获 Figma 背书**。

> **当前状态：P0 + P1 已完成并通过验收。**
>
> 决策已定：包名 **`dsh-plugin-figma`** · 交付形态 **仅 DSH 原生 Cordis 插件**（MCP 适配器当前不做，但保留可补回的 CI 不变量）· **只读**，不做任何写操作 · **npm + GitHub 双通道分发**。
>
> - 施工图（做什么、按什么顺序、怎么算做完）：[`docs/P0-IMPLEMENTATION.md`](docs/P0-IMPLEMENTATION.md)
> - 决策与证据（为什么）：[`docs/PLAN.md`](docs/PLAN.md)

## 模型看到什么

**两个工具**，不是 130 个。

| 工具 | 作用 |
|---|---|
| `figma_capabilities` | 能力目录。默认只回名字 + 一句话；`detail="full"` 才展开参数 schema（渐进式披露） |
| `figma_call` | 统一执行入口。`op` 指定能力，`target` 可以直接粘 Figma 链接 |

为什么是两个而不是 130 个：工具定义是**每次请求都要付**的上下文税。实测本机 34 个工具的定义约 30.9k 字符（≈8.6k tokens）；把 Figma 的 130+ REST 端点各做一个工具会**再加约 3.3 万 tokens/请求**。所以能力做成**声明式数据表**（`src/core/specs/`），加一个端点 = 加一行数据，工具表长度不变。

当前提供 7 个能力（P0 的 4 个 + P1 的 3 个）：

| op | 用途 | 档位 |
|---|---|---|
| `file_meta` | 最便宜：名字、版本、最后修改时间、你的 role | Tier 3 |
| `file` | 浅浅地读整个文件：页面 + 顶层 Frame 结构 | Tier 1 |
| `file_nodes` | **首选入口**：按 node id 精确读一个或多个子树 | Tier 1 |
| `image_render` | 导出 Frame 为图片，落盘 + 当轮作为图片块返回 | Tier 1 |

P1 追加的 3 个能力：设计系统的语义。它们读的是 `/v1/files/:fileKey` 请求**自带的资源映射**，而不是专门的 `/components`、`/component_sets`、`/styles` 端点——实测后者只回答团队库里**已发布**的资源，对一个本地组件明明存在的文件会答"没有组件"，把两种视角混进一个能力会让模型理直气壮地说错话。`depth` 在 spec 里**固定为 2**、模型不可选：实测 `depth=1` 时映射为空，`depth=2` 才填充，且只要 6,338 B。

| op | 用途 | 档位 |
|---|---|---|
| `components` | 列出本文件定义的组件（id / 名称 / 变体，变体从名称解析） | Tier 1 |
| `component_sets` | 列出组件集（变体组）；空列表是真实答案 | Tier 1 |
| `styles` | 列出本文件定义的样式（FILL / TEXT / EFFECT / GRID） | Tier 1 |

**变量（Variables）不支持**：Figma 只在企业版开放该 API，且令牌还需额外 scope，所以本插件不做——`figma_capabilities` 的能力目录里对此有说明，模型自查就能看到，不会误以为漏了参数。

典型用法：

```
figma_call({ op: "file_meta", target: "https://www.figma.com/design/<key>/<name>?node-id=12-345" })
figma_call({ op: "file_nodes", target: "<同一个链接>" })                                   // 自动补 depth=2
figma_call({ op: "file_nodes", args: { fileKey: "<key>", ids: ["101:202"], depth: 4 } })
figma_call({ op: "image_render", args: { fileKey: "<key>", ids: ["101:202"] } })               // 当轮可见
```

`target` 支持 `/file/`、`/design/`、`/board/`、`/proto/`、`/slides/` 五种路径，自动做 `?node-id=12-345` → `12:345` 的转换，忽略 `?t=…` 之类的追踪参数，也接受裸 fileKey 与裸 nodeId。

## 安装

### 0. 开发环境准备（clone 本仓库后唯一必需步骤）

插件通过 `link:` 装进 DSH profile，所以 Node 会按**本仓库**（符号链接的真实路径）解析 import，**不会**去 profile 的 `node_modules` 找。因此宿主包必须在本仓库里也装一份：

```bash
# ⚠️ 版本必须与"你正在跑的那份 DSH"一致，不要裸装（npm 的 latest 标签经常滞后）：
D="$(dirname "$(readlink -f "$(command -v dsh)")")/../@deepseek-ai"
node -p "require('$D/dsh-tools/package.json').version"    # 例如 0.1.5-rc.3

pnpm add -D @deepseek-ai/dsh-tools@<上面读到的版本> \
           @deepseek-ai/schemastery@3.18.2 \
           @deepseek-ai/cordis@4.0.2

npm run check:deps     # 三个必须全 ✅，且版本三元组要与 peerDependencies 对齐
```

**为什么版本必须对齐**：`defineTool`、config schema、凭据接口的契约都由宿主提供。装错版本**不会在加载时报错**，只在工具调用时表现为类型或行为不一致——是最难定位的一类问题。`check:deps` 因此不只检查"能否解析"，还比较版本三元组。

一条命令跑全部检查：`npm run verify`（deps + 分层门禁 + 全部测试）。

### 1. 装进 profile

```bash
# 通道一 · link（最快路径）
cd ~/.dsh/profiles/web && pnpm add link:~/dsh-plugin-figma

# 通道二 · npm（发布后）
dsh plugin --profile web add dsh-plugin-figma

# 通道三 · GitHub（不占 npm 名；本机网络吞吐 <1000 B/s，未在此验证）
cd ~/.dsh/profiles/web && pnpm add github:<user>/dsh-plugin-figma
```

### 2. 挂载

在 `~/.dsh/profiles/web/cordis.patch.yml` 里追加：

```yaml
- insert:
    # ⚠️ name = 包名（loader 据此解析模块）；id = Cordis 行 id（可短，用于 patch 定位与日志）
    - id: figma
      name: 'dsh-plugin-figma'
      # config 全部可选，省略即取"最弱席位"默认值：
      # config:
      #   credentialRef: FIGMA_TOKEN
      #   spoolDir: .figma
      #   rateLimits:
      #     tier1: { perMinute: 5, burst: 1 }
```

`cordis.patch.yml` 是热载的，`package.json` 的依赖变更不是——**先装依赖，再挂载**。

### 3. 配置令牌

**令牌不进配置文件**，走 DSH 凭据服务：

```yaml
# ~/.dsh/.credentials.yaml
refs:
  FIGMA_TOKEN: <你的 Figma 令牌>
```

保存即生效，**不需要重启**（凭据是每次操作重新解析的）。也支持环境变量 `FIGMA_TOKEN`。

令牌去哪拿、勾哪些 scope、PAT 的坑（最长 90 天、明文只显示一次、不可刷新），见 **[`docs/TOKEN_SETUP.md`](docs/TOKEN_SETUP.md)**；为什么建议改用计划访问令牌，见 [`docs/PLAN.md`](docs/PLAN.md) §4.4.1。插件需要的只读 scope：

```
file_content:read, file_metadata:read, file_comments:read, file_dev_resources:read
```

## 只读：架构约束，不是开关

不实现任何会改变 Figma 云端真实数据的调用。这不是"默认关闭、可以打开"的配置项——`allowWrites` 不作为可配置项存在，因为**当前不存在任何合法取值**。

四条执行机制：

1. 能力表里**没有**写端点（`src/core/specs/`）；
2. 派发前断言 `spec.method === 'GET'`，否则抛 `ReadOnlyViolationError`（`src/core/capability.js`）；
3. CI 门禁 `npm run check:layering` 静态检查每条 spec 都是 `GET`；
4. **禁止自动重定向**（`redirect: 'error'`）——令牌在请求头里，跟随重定向会把它带到非 Figma 域。这是安全项，不是偏好。

## 上下文管道（本方案的真正难点）

实测过的事实决定了这里的每一个设计：

**① `ids` 只决定"从哪开始"，`depth` 才决定"取多少"。**

| 请求 | 响应体 |
|---|---|
| `/nodes?ids=<一个 FRAME>`（不传 depth） | 48,659 B |
| `/nodes?ids=<同一个 FRAME>&depth=1` | 2,491 B（−95%） |
| `/nodes?ids=<根画布>`（不传 depth） | 1,193,266 B ≈ 整个文件 |

所以 `figma_call` 在 `ids` 存在而 `depth` 缺失时**自动补 `depth=2`**，不把球踢给模型——模型对"取一个节点"的直觉预期是"取这一层"。

**② 投影把节点树压到约四分之一。** 白名单保留 `id/name/type/layout*/padding*/fills/strokes/box/characters/style/component*/children`，丢弃 `constraints/relativeTransform/exportSettings/interactions/…`。实测：

| 文件 / 节点 | 原始 | 投影后 | 压缩 |
|---|---|---|---|
| 单画板 `depth=4`（18 节点） | 19,476 B | 4,940 B | −75% |
| 仪表盘 LIGHT（154 节点） | 130,212 B | 30,960 B | −76% |
| 同一仪表盘 DARK（154 节点） | 129,782 B | 30,900 B | −76% |

**③ 颜色归一有一个会静默出错的坑。** Figma 的 paint 是 `{color:{r,g,b,a}}`，但 **`color.a` 是颜色的 alpha 通道，不是图层透明度**；图层透明度是另一个字段 **`fill.opacity`**。混用不会报错，只会算出看起来合理的错误颜色——而且实测样本里 8 个 fill 全部 `a=1.0`，写错也测不出来。所以：hex 只取 `r/g/b`，透明度只读 `fill.opacity` 且仅在 `≠1` 时输出。回归测试在 `test/core/projection.test.js`。

**④ 超预算不是失败。** 投影仍超预算时：收紧 depth **重取一次**（只一次，无限收紧会烧掉 Tier 1 额度）→ 仍超 → 回落"结构骨架 + 节点计数 + 配色/字体摘要"，完整投影落盘到 `.figma/<hash>.json`，结果里给路径。结果 meta 回报 `nodeCount / projectedChars / depthUsed / cached / waitedMs / spooled`，**模型看得见成本，下一轮会自己收窄**。

**⑤ 图片立刻落盘。** Figma 的图片端点返回的是**短期签名 URL**（会过期），所以拿到就下载、落盘到 `.figma/images/`、并存进 DSH 的附件存储；工具结果同时给出相对路径、字节数，**并把图片作为持久 image block 挂上**，模型当轮就能看见。注意：下载签名 URL 时**不带令牌**——那是第三方域。

**⑥ 限流按"最弱席位"给默认值。** Tier 1 默认 `5/min, burst 1`，因为别的 DSH 用户很可能是 View/Collab 席位（Tier 1 只有 20 次/月），而调用前无法得知。桶空时**排队而不是丢弃**，并把等待时长回报给模型；只在收到 429 时用响应头事后校正（`Retry-After` / `X-Figma-Rate-Limit-Type` / `X-Figma-Upgrade-Link` **只在 429 上出现**，成功响应没有）。

**⑦ 缓存只用 TTL，没有 304 分支。** `/meta` 虽然返回 `etag`，但带 `If-None-Match` 重请求得到 `200` + 全量而非 `304`，且响应头写着 `cache-control: no-cache, no-store`。所以条件请求分支是死代码，不存在。失效判据改用 `/meta` 的 `version`，变化时清掉该文件的全部缓存。

## 令牌失效时会主动要求你换令牌

插件**能检测**（401 `Invalid token`）、**能提示**，但**不能替你自动申请**——Figma 生成令牌时明文只显示一次，PAT 也不可刷新，新令牌必须由人粘贴回来。

做法是把失效变成一条**活跃的补救指令**而不是失败的调用（工具**不抛错**，返回结构化的 `token_invalid` + 可执行步骤），并明确授权模型**主动找你换令牌、换完自动重试**。

在此基础上加了两条：**401 不重试**（重试不会让令牌复活，只会白烧一个额度、还让模型以为这是暂时故障），以及**进程内记忆**——同一个凭据值失效过就立刻失败并复用同一份指引，判据是凭据值的哈希而不是时间，所以**放好新令牌后下一次调用自动恢复**。

## 仓库结构

```
src/
├── core/               # ⛔ 零 DSH 依赖、⛔ 不出现 ctx（CI 门禁守住）
│   ├── types.js        #   类型词汇（无运行时逻辑）
│   ├── tokens.js       #   近似 token / 精确字节估算
│   ├── capability.js   #   spec 校验 + 只读断言 + 参数校验 + 缓存 key
│   ├── specs/          #   ★ 能力声明表（纯数据）
│   ├── url.js          #   Figma URL → { fileKey, nodeId }
│   ├── auth.js         #   TokenSource + 集中脱敏
│   ├── http.js         #   fetch 封装（禁重定向、超时、错误归一）
│   ├── retry.js        #   只对 429 / 5xx 退避，加抖动
│   ├── scheduler.js    #   令牌桶 + 同参单飞
│   ├── cache.js        #   LRU + 纯 TTL
│   ├── projection.js   #   ★ 节点树 → 模型友好结构（颜色归一在这里）
│   ├── budget.js       #   动态 depth + spool 溢出
│   ├── provider.js     #   把上面组装成 ToolProvider
│   ├── errors.js       #   错误归一（remedy 是可执行的下一步）
│   └── spool-sink.js   #   落盘接口（core 只定义接口，不碰 fs）
└── adapter/            # 唯一允许 import DSH 之处
    ├── index.js        #   apply(ctx, config)
    ├── config.js       #   Schemastery config
    ├── tools.js        #   figma_capabilities / figma_call
    └── spool-fs.js     #   用 ctx.fs / ctx.attachments 实现 core 的接口
lib/index.js            # 包入口（转发层，必须提交：git 安装不执行构建）
test/core/              # 不 import 任何 DSH，注入 fetch/时钟，可离线跑
```

**分层纪律**：`src/core/**` 里不得出现宿主包 import，不得出现 `ctx`。这不是洁癖——它是"将来补 MCP 适配器不用重构"的唯一保证，由 `npm run check:layering` 守住，且**门禁本身有测试证明它会失败**（`test/core/layering.test.js` 会故意注入违规代码）。

**为什么源码是 `.js` 而不是 `.ts`**：`package.json` 的 `main` 指向必须提交的 `lib/index.js`，而 git 安装不执行构建。用 `.ts` 就要依赖 Node 的类型擦除（Node ≥ 22.18），与 `engines: node >= 20` 冲突。所以是**纯 JS + JSDoc 类型**，没有 bundler、没有构建步骤。`docs/P0-IMPLEMENTATION.md` §3 的 `.ts` 文件名是命名简写，§9 明确要求"纯 JS + JSDoc、不要引入 bundler"，两者冲突时按后者。

## 验证

```bash
npm run verify             # deps + 分层门禁 + 全部测试（离线，不需要网络和令牌）
npm run check:deps         # 三个宿主包可从本仓库解析
npm run check:layering     # core 无宿主依赖 / 无 ctx；每条 spec 都是 GET
npm test                   # 195 条测试（181 通过 / 14 跳过；跳过的都是真实数据用例）
bash scripts/verify-wiring.sh   # 在隔离 profile 里端到端验证装配（会创建并删除临时 profile）
```

真实数据验证（**不进仓库**，需要环境变量）：

```bash
FIGMA_TEST_FILE_KEY=<key> FIGMA_TEST_NODE_ID=<id> FIGMA_TOKEN=<token> \
  node --test test/core/real-data.test.js
```

`scripts/verify-wiring.sh` 检查四件事，全绿才算装配正确：包名能从 profile 的 `node_modules` 解析 → `cordis.patch.yml` 的 insert 行进入组合配置 → **DSH 真的加载、激活，且两个工具确实在注册表里** → 日志无加载错误。

## 分期

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0** | core + 2 个工具 + 接线，端到端可用 | ✅ 完成 |
| P1 | 设计系统语义（组件 / 组件集 / 样式；变量不支持——Figma 仅企业版开放，能力目录中有说明） | ✅ 完成 |
| P2 | MCP 适配器，可移植到其他宿主 | 当前不做（core 已具备条件） |
| P3 | 伴生 Figma 插件 + 画布桥 + `figma_canvas` | 未开始 |

## 参考文献

- Shi, Y., Zhang, W., Cui, T. — *A Programming Paradigm for Spatiotemporal Composability*, [arXiv:2608.25512](https://arxiv.org/abs/2608.25512)（北京大学 / DeepSeek-AI）。Cordis 的形式化基础，本方案的生命周期设计依据其 revertible effects / reactive coeffects 概念。
- [Figma REST API 文档](https://developers.figma.com/docs/rest-api/) · [Figma Plugin API 文档](https://developers.figma.com/docs/plugins/api/api-reference/)

## 脱敏与隐私

本仓库的**全部实测数据来自真实的私有设计文件**，但真实标识符不随仓库发布：

- 文档里的 fileKey、节点 id、文件名与作者 handle 已全部替换为**合成标识符**（例如 fileKey `Aa1Bb2Cc3Dd4Ee5Ff6Gg7H`、文件名 `Design File A`）。合成 fileKey 仍是 22 位 `[A-Za-z0-9]`，所以文中关于长度、URL 形态与 `depth` 体积的结论依然成立。说明见 [`docs/PLAN.md`](docs/PLAN.md) 文首。
- `test/` **只用合成 fixture**——断言写的是"某个组件有 40 字符的 key""变体名能被解析成 `{Ratio: '2:3'}`"这类与真实名称无关的事实。
- 可能夹带私有内容的路径已被 `.gitignore` 忽略：`.env.*`、`.credentials.yaml`、`.figma/`（投影落盘与渲染图）、`fixtures/recorded/`。
- `npm run check:secrets` 守门：它扫描**工作树**（已跟踪 + 未跟踪但未忽略）与 **git 历史**，命中真实令牌形态、真实 Figma 链接或已从本仓库移除的标识符即失败。合成标识符走 `scripts/check-secrets.mjs` 的 `SYNTHETIC_ALLOWLIST` 显式放行——新增一个合成值是一次**需要想清楚**的动作，而不是顺手通过。

**给贡献者**：新增实测数据时，先问"这个字符串能不能反推出一个真实的 Figma 文件"。能，就不要提交——把 fixture 换成本地文件（走 `.env.local` 或忽略目录），只把**结论**写进测试与文档。
