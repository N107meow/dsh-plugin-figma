# 安全说明

本插件是 DeepSeek Harness 的**只读** Figma 客户端：它持有你的 Figma 令牌，能读你的设计文件。这份文档讲清楚三件事——令牌怎么被对待、为什么它改不了你的设计、发现问题往哪报。

## 令牌处理

**每次操作重新解析。** 令牌经 DSH 凭据服务（`ctx.credentials.resolve`）在**每次工具调用时**取用，插件不跨操作缓存它。所以你在 `~/.dsh/.credentials.yaml` 里改完保存，**下一次调用就是新令牌**，不需要重启 DSH。

**不进日志、不进错误体、不进工具结果。** 令牌只出现在发往 `api.figma.com` 的请求头里。上游错误的响应体、图片下载失败的原因、返回给模型的提示文本，全部先过一遍集中脱敏器（`src/core/auth.js`）再出去。插件自身只打三处日志——激活/失活、以及配置或落盘失败——都是接口名与文件路径级别，不含请求内容，更不含令牌。

**脱敏覆盖 percent-encoded 形态。** 同一个令牌既可能原样出现，也可能在某条 URL 里被编码成另一种拼法，所以两种拼法都会被替换。脱敏器还会**记住**凭据服务给过的令牌值——包括已经失效的旧值，避免它在报错信息里回流。

**禁止跟随重定向。** 请求固定 `redirect: 'error'`：令牌在请求头里，跟随 302/301 会把它交给重定向目标域。这是最容易被忽略的凭据泄漏路径，所以它不是可配置的默认值——`figmaFetch` 会**拒绝**任何其它重定向策略（`test/core/http.test.js`）。

**下载签名图片时不带令牌。** Figma 的图片端点返回的是短期签名的第三方 URL，取图那次请求是**匿名**的（空请求头），令牌不会递给 Figma 之外的域。

## 只读：是架构约束，不是开关

不实现任何会改变 Figma 云端真实数据的调用。四层机制，任何一层单独都够用：

1. **能力表里没有写端点**——`src/core/specs/` 只声明 GET（当前 7 个能力）；
2. **派发前断言**——`src/core/capability.js` 在每次执行前检查 `spec.method === 'GET'`，否则抛 `ReadOnlyViolationError`；
3. **加载时全量校验 + CI 静态门禁**——能力表在模块 import 时校验一次（含 method），`npm run check:layering` 再静态检查一遍每条 spec 都是 GET；
4. **没有开关可打开**——`allowWrites` 这类配置项**不存在**，因为当前不存在任何合法取值。

另外两条边界：端点由能力表决定，模型**无法构造任意 URL**（`op` 不在表里就拒绝）；落盘路径固定在 session workspace 之下，文件名由 core 生成并做穿越检查（`assertSafeSpoolName`）。

## 本地敏感文件

以下路径已被 `.gitignore` 忽略，**不得入库**：

| 路径 | 里面是什么 |
|---|---|
| `.env` / `.env.*` | 真实数据测试的环境变量（含令牌与真实 fileKey） |
| `.credentials.yaml` | DSH 凭据文件 |
| `.figma/` | 插件落盘的超大投影与渲染出的设计图——**渲染图就是私有设计内容** |
| `fixtures/recorded/` | 抓取下来的真实 Figma 响应 |

仓库侧的守门人是 `npm run check:secrets`：它扫描工作树（已跟踪 + 未跟踪但未忽略）**与 git 历史**，命中真实令牌形态、真实 Figma 文件链接或已从本仓库移除的标识符即失败。合成标识符走显式白名单放行（`scripts/check-secrets.mjs`）。

## 报告安全问题

- **安全漏洞**：请走 GitHub 的私有 [Security Advisory](https://github.com/N107meow/figma-mcp-dsh/security/advisories/new)（仓库 **Security** 标签页 → *Report a vulnerability*），**不要**开公开 Issue。
- **一般问题**：走 [Issue](https://github.com/N107meow/figma-mcp-dsh/issues)，附 `npm run verify` 输出与脱敏后的结构化错误。
- **报告里不要贴令牌**，也不要贴真实设计文件的链接。需要复现时，用合成值描述，或先说明"可以私下提供"。
- 如果令牌已经贴出去过：立刻去 Figma → Settings → Security 撤销并重建（PAT 不可刷新，只能重建），然后把新值写回 `~/.dsh/.credentials.yaml`——保存即生效。

## 支持范围

当前为 P0 + P1：只读的 Figma REST 能力（文件结构、节点子树、图片导出、组件 / 组件集 / 样式）。**变量（Variables）不支持**——Figma 仅在企业版开放该 API。MCP 适配器未实现，`figma_doctor` 延期。
