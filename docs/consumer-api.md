# 消费者契约（Consumer API）

本文定义 `dsh-advisor` 暴露的**消费者表面**：(1) 包根库 API（`import { … } from 'dsh-advisor'`）；(2) 客户端入口（`dsh-advisor/client`，web 注入的 Advisor 卡片）；(3) `/advisor` 指令面（按会话控制）。安装 → [docs/install.zh.md](install.zh.md)；发布流程 → [docs/release.md](release.md)。

> **契约边界**：本文描述的是**本包**的导出表面与生命周期。**有效的包契约 ≠ 集成完成的下游仓库** —— 集成是否完整必须以目标仓库里的实际 wiring 为准。

## 包根导出（`src/index.ts`）

`src/index.ts` 是 cordis 插件入口（bundle 组合包的宿主半），从包根统一导出：

```ts
import { name, inject, Config, apply } from 'dsh-advisor'
import type { AdvisorConfig, ResolvedAdvisorConfig } from 'dsh-advisor'
```

| 导出 | 类型 | 说明 |
|---|---|---|
| `name` | `'dsh-advisor'`（string 常量） | 插件名。 |
| `inject` | `['sessions', 'agents', 'llm']` | 插件消费的服务；行在全部可用后加载。 |
| `Config` | schemastery schema（value） | Loader schema（严格：默认值 + 类型/边界校验），由 cordis Loader 校验插件行 config。见 [配置指南](configuration.md#配置字段)。 |
| `AdvisorConfig` | type | 插件行 config 契约（`enabled` / `provider` / `model` / `systemPrompt` / `immuneTurns` / `maxDeltaMessages`）。 |
| `ResolvedAdvisorConfig` | type | 显式模型门禁（S4）之后的运行时契约（含可选的 `disabledReason`）。 |
| `apply(ctx, config)` | function | 插件 apply：为 entry 的 volatile live 字段建立 settings bridge（`loader/volatile-update` 驱动）、注册 `AdvisorConfigGateway` 与 typert 端点（条件 `ctx.inject(['typert'], ...)`）、组合 observer / runtime / delivery、在组合 command registry 时注册 `/advisor` 指令（条件 `ctx.inject(['commands'], ...)`）。 |

> 包根**没有**按函数粒度重导出内部运行函数（如 `resolveAdvisorConfig` 不在包根导出面内 —— 它由 `src/config.ts` 内部使用；包根的运行时导出面就是 `name` / `inject` / `Config` / `apply`，类型面是 `AdvisorConfig` / `ResolvedAdvisorConfig`）。这与按「纯函数库」设计的插件不同 —— `dsh-advisor` 是组合包（bundle），不是函数库；内部模块（`src/advisor-runtime.ts`、`src/delivery.ts`、`src/commands.ts` 等）是 cordis-free 的实现单元，通过 `apply` 的 wiring 消费，不在包根暴露。

### 包导出映射（`package.json` `exports`）

| 入口 | 解析 |
|---|---|
| `dsh-advisor`（`.`） | `lib/index.js`（types `lib/index.d.ts`）—— 宿主半插件入口 |
| `dsh-advisor/client`（`./client`） | `lib/client.js`（types `lib/client.d.ts`）—— 浏览器半（web 卡片） |
| `dsh-advisor/package.json` | 元数据 |

发布物（`files`）为 `lib/` + `cordis.patch.yml` + `scripts/`；`cordis.patch.yml` 插入一行插件配置 —— `id: advisor`，`name: dsh-advisor`。运行时依赖全部声明为 peerDependencies（`@deepseek-ai/cordis` / `@deepseek-ai/schemastery` / `@deepseek-ai/dsh-*` / `react`），由 dsh 安装的扁平 profile module fallback 解析。

## cordis 服务键 `'advisor'`

`apply` 在 try/catch 中构造 `AdvisorConfigGateway`（`src/gateway.ts`），它以 cordis 服务键 **`'advisor'`** 注册（`TypertRemoteService` 基类）。这是 `/api/advisor/*` RPC 端点的**调度目标**（typertGateway 经 `ctx.get('advisor')` 分发）—— **不是**面向消费者的公共 API：它不暴露可调用的纯函数面，也没有稳定对象契约可依赖。跨插件需要读取 advisor 状态时，应使用文档化的面（`/api/advisor/get`、`/advisor status`），而不是读取该服务对象的内部。

### `/api/advisor/*` 端点面

| 端点 | 作用域 | 说明 |
|---|---|---|
| `/api/advisor/get` / `/api/advisor/set` | **全局** | entry config 的读取/写入（经硬门禁的 resolved 值）。 |
| `/api/advisor/getSession`（B2） | **会话** | 返回权威会话快照 `{ sessionId, enabled, modelOverride?, modelSource?, effectiveModel?, disabledReason?, lifetime: 'live-session' }`（缺省键在 wire 上省略）。只读，不分配状态。 |
| `/api/advisor/setSessionModel`（B2） | **会话** | `{ sessionId, selection: { provider, model } \| null }`：钉住/更新原子对；`selection: null` = reset（重新继承当前全局默认，从不触碰启用开关）。返回提交后的同一快照。写入经**同一** `AdvisorCommandController`（`resolveModelInfo` 60 秒校验、按会话 generation 栅栏、路由变更语义继承自指令面）。 |

业务结果（未知/已销毁会话、无 elected owner、校验拒绝/失败、被更新/取消）以**插件域错误标签**在返回数据中表达（`{ error: { tag, message } }`，`advisor/session-unknown` / `advisor/unavailable` / `advisor/rejected` / `advisor/failed` / `advisor/superseded` / `advisor/cancelled`）—— 不抛新的 coded 失败、不扩展 dsh 的失败词汇。未知/已销毁的会话目标在校验开始**之前**拒绝（不为死目标分配状态）；SessionId 不是授权——请求仍先经过 Connection 的 Host/Origin + 浏览器认证边界；无裸 HTTP 端点、无自创会话 ACL。两个会话端点由**获得 reviewer 角色的 fiber**的控制器提供（懒解析的 session face）；持有 `advisor` 服务键但无 elected owner 的 fiber 对其回答 `advisor/unavailable` 并保持惰性（无自动晋升）。

多 fiber 去重：宿主会组合多个 `dsh-advisor` fiber（观察到的典型情况是 3 个）。`advisor` 服务键的注册是「先注册者拥有」，后续 fiber 静默回退（不报错、不重复 wiring；settings bridge 无注册动作——每个 fiber 自己的 bridge 由 `loader/volatile-update` 的 owning-fiber 过滤天然隔离）；typert 端点注册同理（重复注册失败时该 fiber 不提供端点）。首个获得 reviewer 角色的 apply 负责 observer / runtime / delivery 与 `/advisor` 指令的 wiring（单评审者守卫，`src/index.ts` `claimReviewer`）。**生命周期**：所有注册都是 fiber 作用域 effect —— fiber dispose 后端点 / reviewer 声明随之撤销，后续 re-apply / re-mount 可接管。

## 客户端入口（`dsh-advisor/client`）

`src/client/index.ts` 是浏览器半，把 Advisor 卡片注册进宿主声明的 `plugins.bundle.config` 卡片 slot（web「插件」页上 dsh-advisor 组合包自己的页面，bundle key `dsh-advisor`），并（B2）把会话级 Advisor 动作注册进宿主声明的 `conversation.session.header.actions` 会话作用域 list slot——该动作绑定到插槽父级解析的 SessionId，是 `/advisor model` 的 web 对应面（显示有效 pair/来源/live-session 生存期，支持钉住与 reset）；全局卡片保持**仅全局**。会话动作只调用会话端点，控制面不可用时不提供写入、也绝不回退到全局写通道；打开时与断连/聚焦信号时刷新，无推送事件、无轮询，关闭态标签为中性（不显示模型名）：

```ts
import type { AdvisorCardProps, AdvisorSettingsStore, ModelOption, ProviderOption } from 'dsh-advisor/client'
import type { AdvisorSessionActionProps, AdvisorSessionModelController, AdvisorSessionMenuState, AdvisorSessionSnapshotView } from 'dsh-advisor/client'
```

- **`inject`**：`['slots', 'locale', 'connection', 'settingsSchema']`（cordis fiber 注入；`settingsSchema` 为 ui-settings 提供的不可变路径写入服务）；locale 字典命名空间 `settings.advisor`（zh / en）；
- **类型导出**：`AdvisorCardInjected`、`AdvisorCardProps`、`AdvisorKey`、`AdvisorDraft`、`AdvisorSettingsState`、`AdvisorSettingsStore`、`ApplyFailure`、`ApplyState`、`ModelOption`、`ModelsEmptyReason`、`ProviderOption`；B2 会话面：`AdvisorSessionActionInjected`、`AdvisorSessionActionProps`、`AdvisorSessionMenuState`、`AdvisorSessionModelController`、`AdvisorSessionRpcPayload`、`AdvisorSessionSelection`、`AdvisorSessionSnapshotView`；
- **value 导出**：`refreshIfLoaded`（纯 controller 辅助：仅在卡片首次加载后重取页面快照；未打开的卡片不在后台失效时发起 fetch）；
- **web 注入声明**（`package.json` `dsh.client`）：`@deepseek-ai/dsh-client-store` + `@deepseek-ai/dsh-client-ui-plugin-manager` + `@deepseek-ai/dsh-client-locale`，平台 `web`；
- **导入纯度边界**：客户端 half 只 value-import 冻结的平台模块表（`CLIENT_EXTERNALS`：react / `@deepseek-ai/cordis` / ui-slots / ui-primitives / `@deepseek-ai/dsh-client-store`）；其余 `@deepseek-ai/*` 全部 type-only（构建期擦除），值经 cordis 注入到达（含 `settingsSchema` 服务）。

卡片的数据面（`src/client/advisor-store.ts`）：

- **advisor 配置**：只经网关 RPC 通道（`connection.rpc.call('/api', 'advisor/get' | 'advisor/set', …)`）；`get` 返回 `{ config }`（宿主硬门禁后的 resolved 值，缺省键在 wire 上省略），`set` 接受 `{ patch }` 并返回新合成值；
- **会话级模型面（B2）**：`AdvisorSessionModelController`（每个会话作用域绑定一个实例，由插槽 inject 工厂构造、渲染器按 entry × 会话绑定 memoize）只调用 `/api/advisor/getSession` | `/api/advisor/setSessionModel`，每次调用携带自己的 `sessionId` 且只提交进自己的 store——旧绑定的迟到响应既改不到别的会话，也会被同会话的请求栅栏整体丢弃；
- **provider / model 目录**：走 `api.settings.describe` / `api.llm.*`（`llm-*` 命名空间在 exposed 集合内）；configured provider = 命名空间 + profile 均解析（KD-S2），model 选项 = profile 声明模型优先、catalog 回退；会话动作以**只读**方式复用同一目录 store；
- 保存时对草稿与上次读取的配置做 diff，只发送变更键为 patch；清空 provider/model 存显式 `''`（网关 merge 无法表达 unset，解析器把 `''` 当缺失）；`advisor.get` 失败 → 卡片显示 config-channel 提示而非可写表单（KD-G5），永不提供 Apply。

## `/advisor` 指令面

`/advisor` 指令在组合了 command registry（`commands` 服务）时经条件 `ctx.inject(['commands'], ...)` 子项注册（`src/commands.ts` `registerAdvisorCommands`）—— 无 registry 的 headless / standalone 组合静默不注册。解析器 `parseAdvisorCommand`（`src/commands.ts`）接受以下形式：

```
/advisor            toggle the advisor for this session
/advisor on         enable the advisor for this session
/advisor off        disable the advisor for this session
/advisor status     show state, effective model + source, runtime status, pending count, last activity
/advisor model      show the effective reviewer model, its source (session|global), and the live-session lifetime
/advisor model set <provider> <model>   pin a reviewer model for the invoking session only
/advisor model reset    drop the session pin and re-inherit the current global defaults
（其它输入）        → usage 文本
```

- **会话级且临时**：`on` / `off` / `toggle` 翻转的是按会话的启用 override（`AdvisorSessionOverrides`，`override ?? config.enabled`），**从不修改持久化配置**；`/advisor on` 开启一个 config 缺少 `provider`/`model` 的会话不会发起模型调用 —— 回复与 `/advisor status` 都会显示 S4 门禁原因；
- **会话级模型覆盖**：`model set` / `model reset` 读写同一会话级机制内的运行时 `modelOverride: { provider, model }` 原子对（生存期、解析顺序、校验细节 → [配置指南 · 会话级评审模型覆盖](configuration.md#会话级评审模型覆盖运行时临时)）——同样**从不写入持久化配置**；`set` 只作用于发起调用的会话（无 session-id 参数，模型 id 可含 `/`），提交前经 `resolveModelInfo` 校验（60 秒、可取消、无自动重试）；`reset` 重新继承当前全局默认且从不触碰启用开关；
- **`/advisor on` 是手动恢复路径**：恢复 `quota_exhausted`（KD-5 无自动恢复定时器）并**全新重建** `halted`（永久性模型错误）的会话 runtime；开启时把 observer 游标 seed 到当前 transcript 长度（KD-5 seed-on-enable，不做全史重放）；
- **`/advisor status`** 状态面（`src/commands.ts` `AdvisorSessionStatus` + `advisorStatusText`）：`enabled`（有效开关）、`disabledReason`（S4 门禁阻挡时）、`provider` / `model`（**有效**路由——会话覆盖优先于全局默认——即使禁用也显示）、`modelSource`（`session` | `global`）、`runtimeStatus`（`running` | `paused` | `quota_exhausted` | `halted` | `disabled`）、`pendingCount`（待 drain 的 delta 数）、`lastActivityAt`（最后一次 accepted-note 的 ISO 时间，之前为 `never`）。`/advisor config` 保持**全局默认值**回读（会话级覆盖不改变它的输出）。

## 安装 / 发布指针

- [安装指南](install.zh.md) — registry / 本地目录 / tarball 三种安装方式、web Settings 暴露、`--dump-config` 验证、卸载；
- [发布指南](release.md) — PR 驱动的 npm 发布与 GitHub Release 流程、版本策略、回滚；
- [配置指南](configuration.md) — advisor entry config 字段、显式模型门禁、行为要点；
- [README](../README.zh.md) — 概览、配置示例、`/advisor` 用法、工作原理、限制与路线图。
