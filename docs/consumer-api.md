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
| `apply(ctx, config)` | function | 插件 apply：安装 `advisor` settings 命名空间（条件 `ctx.inject(['settings'], ...)`）、注册 `AdvisorConfigGateway` 与 typert 端点（条件 `ctx.inject(['typert'], ...)`）、组合 observer / runtime / delivery、在组合 command registry 时注册 `/advisor` 指令（条件 `ctx.inject(['commands'], ...)`）。 |

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

多 fiber 去重：宿主会组合多个 `dsh-advisor` fiber（观察到的典型情况是 3 个）。settings 命名空间与 `advisor` 服务键的注册都是「先注册者拥有」，后续 fiber 静默回退（不报错、不重复 wiring）；typert 端点注册同理（重复注册失败时该 fiber 不提供端点）。首个获得 reviewer 角色的 apply 负责 observer / runtime / delivery 与 `/advisor` 指令的 wiring（单评审者守卫，`src/index.ts` `claimReviewer`），后续实例仅做 settings 注册尝试。**生命周期**：所有注册都是 fiber 作用域 effect —— fiber dispose 后端点 / 命名空间 / reviewer 声明随之撤销，后续 re-apply / re-mount 可接管。

## 客户端入口（`dsh-advisor/client`）

`src/client/index.ts` 是浏览器半，把 Advisor 卡片注册进宿主声明的 `settings.plugin.item` 卡片 slot（"插件配置"页，namespace key `advisor`，按注册顺序位于上游 bash / agent-loop / web-search 卡片之后）：

```ts
import type { AdvisorCardProps, AdvisorSettingsStore, ModelOption, ProviderOption } from 'dsh-advisor/client'
```

- **`inject`**：`['slots', 'locale', 'connection', 'settingsSchema']`（cordis fiber 注入；`settingsSchema` 为 ui-settings 提供的不可变路径写入服务）；locale 字典命名空间 `settings.advisor`（zh / en）；
- **类型导出**：`AdvisorCardInjected`、`AdvisorCardProps`、`AdvisorKey`、`AdvisorDraft`、`AdvisorSettingsState`、`AdvisorSettingsStore`、`ApplyFailure`、`ApplyState`、`ModelOption`、`ModelsEmptyReason`、`ProviderOption`；
- **value 导出**：`refreshIfLoaded`（纯 controller 辅助：仅在卡片首次加载后重取页面快照；未打开的卡片不在后台失效时发起 fetch）；
- **web 注入声明**（`package.json` `dsh.client`）：`@deepseek-ai/dsh-client-store` + `@deepseek-ai/dsh-client-ui-settings-plugins` + `@deepseek-ai/dsh-client-locale`，平台 `web`；
- **导入纯度边界**：客户端 half 只 value-import 冻结的平台模块表（`CLIENT_EXTERNALS`：react / `@deepseek-ai/cordis` / ui-slots / ui-primitives / `@deepseek-ai/dsh-client-store`）；其余 `@deepseek-ai/*` 全部 type-only（构建期擦除），值经 cordis 注入到达（含 `settingsSchema` 服务）。

卡片的数据面（`src/client/advisor-store.ts`）：

- **advisor 配置**：只经网关 RPC 通道（`connection.rpc.call('/api', 'advisor/get' | 'advisor/set', …)`）；`get` 返回 `{ config }`（宿主硬门禁后的 resolved 值，缺省键在 wire 上省略），`set` 接受 `{ patch }` 并返回新合成值；
- **provider / model 目录**：走 `api.settings.describe` / `api.llm.*`（`llm-*` 命名空间在 exposed 集合内）；configured provider = 命名空间 + profile 均解析（KD-S2），model 选项 = profile 声明模型优先、catalog 回退；
- 保存时对草稿与上次读取的配置做 diff，只发送变更键为 patch；清空 provider/model 存显式 `''`（网关 merge 无法表达 unset，解析器把 `''` 当缺失）；`advisor.get` 失败 → 卡片显示 config-channel 提示而非可写表单（KD-G5），永不提供 Apply。

## `/advisor` 指令面

`/advisor` 指令在组合了 command registry（`commands` 服务）时经条件 `ctx.inject(['commands'], ...)` 子项注册（`src/commands.ts` `registerAdvisorCommands`）—— 无 registry 的 headless / standalone 组合静默不注册。解析器 `parseAdvisorCommand`（`src/commands.ts`）接受恰好五种形式：

```
/advisor            toggle the advisor for this session
/advisor on         enable the advisor for this session
/advisor off        disable the advisor for this session
/advisor status     show state, model, runtime status, pending count, last activity
（其它输入）        → usage 文本
```

- **会话级且临时**：`on` / `off` / `toggle` 翻转的是按会话的 override（`AdvisorSessionOverrides`，`override ?? config.enabled`），**从不修改持久化配置**；`/advisor on` 开启一个 config 缺少 `provider`/`model` 的会话不会发起模型调用 —— 回复与 `/advisor status` 都会显示 S4 门禁原因；
- **`/advisor on` 是手动恢复路径**：恢复 `quota_exhausted`（KD-5 无自动恢复定时器）并**全新重建** `halted`（永久性模型错误）的会话 runtime；开启时把 observer 游标 seed 到当前 transcript 长度（KD-5 seed-on-enable，不做全史重放）；
- **`/advisor status`** 状态面（`src/commands.ts` `AdvisorSessionStatus` + `advisorStatusText`）：`enabled`（有效开关）、`disabledReason`（S4 门禁阻挡时）、`provider` / `model`（即使禁用也显示）、`runtimeStatus`（`running` | `paused` | `quota_exhausted` | `halted` | `disabled`）、`pendingCount`（待 drain 的 delta 数）、`lastActivityAt`（最后一次 accepted-note 的 ISO 时间，之前为 `never`）。

## 安装 / 发布指针

- [安装指南](install.zh.md) — registry / 本地目录 / tarball 三种安装方式、web Settings 暴露、`--dump-config` 验证、卸载；
- [发布指南](release.md) — PR 驱动的 npm 发布与 GitHub Release 流程、版本策略、回滚；
- [配置指南](configuration.md) — `advisor` 命名空间字段、显式模型门禁、行为要点；
- [README](../README.zh.md) — 概览、配置示例、`/advisor` 用法、工作原理、限制与路线图。
