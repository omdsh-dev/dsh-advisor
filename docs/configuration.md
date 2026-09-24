# 配置指南（advisor entry config）

`dsh-advisor` 的配置就是**插件自己 entry 的 config**——profile 补丁层（如 `profiles/web/cordis.patch.yml`）里 `id: advisor` 那一行的 `config` 字段。dsh ≥ 0.1.7-rc.1 起全部六个字段都声明为 schema-volatile 的 **live 字段**：Loader 把编辑提交进运行中 fiber 的引用，**无需重挂载**（旧的全局 `$DSH_HOME/settings.yaml` user layer 已移除——dsh 首次启动时把该文件导入活跃 profile 并改名 `.imported`；`src/settings.ts` 的 bridge 读取的正是 entry config 的 live 引用）。三个并行的编辑路径读写同一份存储：

1. **插件行 config** —— 上面的补丁层字段本体，配置就存放在这里（`src/config.ts` 的 `Config` schema 即该 entry 的 Loader schema）。
2. **web「插件」页 —— dsh-advisor 组合包自己页面上的 Advisor 卡片**（bundle key `dsh-advisor`，经 `plugins.bundle.config` keyed slot 注册）—— 卡片把编辑结果写进**同一份 entry config**（经 `settings.update('advisor', …)` → config editor → Loader 落盘到 profile 补丁层）；保存后运行中的会话立即生效，无需重启（运行时 live 读取 entry 引用，见 [live 重应用](#live-重应用)）。
3. **dsh-tui `/settings` 屏幕**（dsh-tui ≥ v0.8.0，随 v0.8.0+ 组合包的 `dsh-tui-settings-sections` 行提供；旧版 dsh-tui 干净地 no-op）—— `/settings` 里的 **Advisor** 分节编辑同样的五个键（`enabled` / `provider` / `model` / `immuneTurns` / `maxDeltaMessages`，各带中英文标签与提示）。编辑先暂存，保存时经 revision 栅栏保护的 `settings.mutate` 写入同一份 entry config，live 重应用、无需重启。`systemPrompt` 不是 TUI 字段（TUI text 控件为单行；多行 prompt 会被截断）——经 web 卡片或 profile 补丁层编辑。

三条路径对等（web 卡片、TUI `/settings`、profile 补丁层读写同一组键、同一份 entry config）。**保存行为差异（如实记录）**：web 卡片在 `enabled: true` 且必填字段为空时**阻止保存**；TUI seam 没有跨字段校验（上游行为），一次保存可能把 `enabled: true` 与空 `provider`/`model` 一起写入——S4 显式模型门禁（spec §5.2）会把该配置解析为 disabled-with-reason，可见于 `/advisor status` 与 `/advisor config`（见 [显式模型门禁（S4）](#显式模型门禁s4)）。

卡片对配置的读写**只**走官方 `GatewayService` RPC 通道：`/api/advisor/get` + `/api/advisor/set`（`src/gateway.ts` 的 `AdvisorConfigGateway`，由宿主 typertGateway 认领，与 dsh 内建 `goals` 服务同一机制）。该通道不受 settings 暴露白名单门控；进程内写入（`settings.update`，`ns` 即 profile entry id `advisor`——bundle 行 id，`cordis.patch.yml`）经 config editor 落入 Loader，由 Loader 提交 volatile 字段并派发 `loader/volatile-update`。没有 config editor 的组合（headless/集成环境）里 `get` 仍读 entry、`set` 干净报错（KD-G5）。**插件不做任何宿主补丁**。

第三个控制面 `/advisor` 指令是**会话级且临时**的（翻转的是按会话的启用 override、并可按会话钉住评审模型，从不修改持久化配置）——见 [消费者契约](consumer-api.md#advisor-指令面)、[会话级评审模型覆盖](#会话级评审模型覆盖运行时临时) 与 [用法](../README.zh.md#用法)。

## 配置字段

字段契约定义在 `src/config.ts`（`AdvisorConfig` 接口 + `Config` Loader schema）。`Config` 是 schemastery schema，由 cordis Loader 用来校验插件行并施加默认值与类型/边界（整数 ≥ 0）。

| 键 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `false` | 总开关。`false` 时插件不干预任何会话。 |
| `provider` | string（可选） | 未设置 | 供应商路由。**`enabled: true` 时必须（非空）** —— 见 [显式模型门禁](#显式模型门禁s4)。 |
| `model` | string（可选） | 未设置 | 模型 id。**`enabled: true` 时必须（非空）** —— 见 [显式模型门禁](#显式模型门禁s4)。 |
| `systemPrompt` | string | `""` | 覆盖内置评审 prompt（严重度定义 + JSON-frame 输出契约，`src/prompts.ts` `DEFAULT_ADVISOR_SYSTEM_PROMPT`）。`""` = 用内置。 |
| `immuneTurns` | number（整数 ≥ 0） | `3` | 冷却步数：实际 steer 过一次 concern/blocker 后，接下来 N 个完成的 stepped 主 turn 必须走完，另一条打断性 note 才可再次 steer；窗口内的 note 降级为 inject。 |
| `maxDeltaMessages` | number（整数 ≥ 0） | `60` | 有界的 advisor 输入窗口。超过 N 的 delta 以 `… <earlier messages omitted>` 标记截断；`0` = 无上限。 |

> 默认值即 `Config` schema 的默认值（`z.boolean().default(false)`、`z.string().default('')`、`z.number().step(1).min(0).default(3)` / `.default(60)`，`src/config.ts`）。`provider` / `model` 在 schema 上没有默认值 —— 保持可选是为了让 enabled-without-pair 的配置能通过 Loader 校验、再由门禁解析为 disabled-with-reason（而不是加载失败）。

### 示例 YAML

```yaml
# profiles/web/cordis.patch.yml — profile 的 user patch layer
- id: advisor
  config:
    enabled: true               # 总开关（默认 false）
    provider: deepseek-official # enabled: true 时必填（非空）
    model: deepseek-flash       # enabled: true 时必填（非空）；网关未开放 V41 路由时回退 deepseek-v4-flash（或其它 V4 id）
    systemPrompt: ""            # 可选；"" = 内置评审 prompt
    immuneTurns: 3              # 整数 ≥ 0，默认 3 —— 打断性送达后的冷却步数
    maxDeltaMessages: 60        # 整数 ≥ 0，默认 60 —— delta 窗口；0 = 无上限
```

## 显式模型门禁（S4）

`enabled: true` 而 `provider` 或 `model` **缺失或为空（含全空白字符串）** 时，`resolveAdvisorConfig`（`src/config.ts`）把配置解析为 **disabled-with-reason**：`enabled: false` + `disabledReason`，**绝不发起任何模型调用**（硬门禁，不是警告）。这是所有路径的 SSOT：

- 运行时每次读取都经过该解析器（`src/index.ts` `safeResolved` / `safeEffective`），因此配置编辑也永远无法绕过门禁发起模型调用；门禁在会话解析**之后**作用于有效路由（见 [会话级评审模型覆盖](#会话级评审模型覆盖运行时临时)）——全局缺 pair 可由完整会话对满足，非法全局配置不可绕过；
- `/advisor status` 与 `/advisor on` 的回复在门禁阻挡时展示原因（`src/commands.ts`）；
- Settings 卡片在 enabled 且必填字段为空时阻止保存（TUI `/settings` seam 无此跨字段校验——保存行为差异见文档开头），但宿主侧硬门禁始终是最后防线。

**未知键严格拒绝**：`resolveAdvisorConfig` 显式拒绝未知键（`CONFIG_KEYS` 白名单，`src/config.ts`）与非对象输入；插件行加载时未知键抛错、拒绝该行（`src/index.ts` 构造期读取仍用抛错版 `resolved()`）。entry config 若携带解析器拒绝的值（如经非严格 schemastery object merge 混入的未知键），live 读取会解析为 disabled-with-reason 携带错误信息 —— 永不 wedge 热路径、永不启动模型调用（`src/index.ts` `safeFallback`；`src/gateway.ts` `readConfig` 同样包含该 containment）。

## 会话级评审模型覆盖（运行时，临时）

除上表六个**持久化的全局默认值**键外，插件还支持一个**运行时、内存态、按会话**的评审模型覆盖：`modelOverride: { provider, model }` 原子对。它**绝不**写入 entry config、绝不持久化（持久化 schema 冻结在上述六键），由 `/advisor model` 指令面驱动：

| 指令 | 行为 |
|---|---|
| `/advisor model` | 显示有效评审模型（provider/model）、来源（`session` 覆盖或 `global` 默认）与生存期说明 |
| `/advisor model set <provider> <model>` | 仅为**发起调用的会话**钉住模型；参数分开传，允许模型 id 含 `/`；不接受任意 session-id 参数 |
| `/advisor model reset` | 删除本会话覆盖，重新继承**当前**全局默认值；从不触碰启用开关 |

- **解析顺序（单一有效解析器）**：(1) 先校验全局配置形状（非法仍然失败关闭）；(2) 启用 = 会话启用 override（`/advisor on|off`）?? 全局 `enabled`；(3) 路由 = 会话的**完整** `modelOverride` 对 ?? 组合后的全局 advisor 对——两级之间的**半个 pair 永不拼接**；(4) 全局组合保持 用户设置 → 插件行基础值 → schema 默认值。
- **与 S4 门禁的关系**：显式 pair 门禁在会话解析**之后**作用于*有效*路由——全局默认缺 pair 时，完整的会话对可为该会话满足门禁；但**非法的全局配置**（未知键、坏值）无法被任何会话覆盖绕过。
- **对校验**：缺失即继承、reset 即删除；空白/不完整对、含空白的标识符、多余字段一律拒绝；外侧空白裁剪；大小写保留。set/reset **从不**改变启用开关；`/advisor off` 保留会话对供之后 `/advisor on` 使用；钉住与今日全局默认相同的对仍然有效（保护会话免受日后默认值修改影响）。
- **校验提交**：提交前经 app 根 LLM 服务 `resolveModelInfo(provider, model, signal)` 解析（catalog 成员资格仅是参考——手填可路由 id 允许）；查找绑定 60 秒（与运行时调用 deadline 默认一致）、可取消、**无自动重试**；失败时先前选择与运行时保持不变。
- **生存期（KD-5）**：与启用 override 同一临时类别——同一 Agent 与 advisor owner 存活期间有效（导航/重连保持），agent/session dispose、owner 卸载、冷恢复、重启即清除；fork 的新会话继承全局默认值。状态是 O(活跃覆盖数)：reset 移除空条目，无历史 SessionId 堆积、无 TTL/GC。
- **路由变更生效**：有效对变化时中止该会话旧的 advisor 调用、丢弃 backlog、重新 seed 到当前会话 seq，在**下一个**新的可评审 delta 上生效；有效对不变则不重启运行时。全局默认值修改影响继承者，不影响已钉住的会话。
- **Web 会话控制面（B2）**：同一控制器经两个插件自有端点暴露给 web 客户端——`/api/advisor/getSession`（返回权威会话快照：`sessionId`、`enabled`、`modelOverride`、`modelSource`、`effectiveModel`、可选 `disabledReason`、`lifetime: 'live-session'`）与 `/api/advisor/setSessionModel`（`selection` 为原子对或 `null`=reset），提交后返回同一快照。业务结果以插件域错误标签在返回数据中表达（如 `advisor/session-unknown` / `advisor/unavailable` / `advisor/rejected` / `advisor/failed`），不扩展 dsh 的失败词汇；未知/已销毁的会话目标直接拒绝且**不分配任何状态**；SessionId 不是授权——请求仍先经过 Connection 的 Host/Origin + 浏览器认证边界。web 界面是 `conversation.session.header.actions` 上的 **Advisor 动作**（非主模型插槽、非根卡片——全局卡片保持仅全局）：显示有效 pair/来源/生存期，支持钉住与「Use global default」；打开时（及打开期间断连/聚焦时）刷新，无推送事件、无轮询；控制面不可用时不提供写入，也**绝不回退**到全局写通道。

## 配置读取模型（composition）

只有一个存储：schema 默认值在 `Config` schema 上，值在插件 entry 的 config 里（`src/settings.ts`）：

```text
schema 默认值（.volatile() live 字段）→ entry config（插件行本体；web 卡片 / TUI `/settings` 经 settings.update/mutate 写入同一处）
```

- `AdvisorSettingsBridge.source()` 每次调用都解包 entry 的 volatile 引用快照——读到的就是当前提交值；
- 每次 Loader 提交（`loader/volatile-update`，仅派发给持有该 entry 的 fiber、且派发前值已提交）触发 `onChange`；
- **TUI `/settings` 与 web 卡片对等**（dsh-tui ≥ v0.8.0）：两者都写同一份 entry config。唯一的行为差异：web 卡片在 `enabled: true` 且必填字段为空时阻止保存；TUI seam 没有跨字段校验（上游行为，如实记录），保存可能写入 `enabled: true` + 空 `provider`/`model`——S4 门禁仍把该配置解析为 disabled-with-reason，运行时绝不发起模型调用（见 [显式模型门禁（S4）](#显式模型门禁s4)）。

## 行为要点

### 严重度与送达语义（spec §6）

每次评审至多发出一条 note，带严重度等级（`src/advisor-runtime.ts` `AdviceSeverity` = `'nit' | 'concern' | 'blocker'`）：

| 严重度 | 含义 | 送达通道 |
|---|---|---|
| `nit` | 轻微的风格 / 清晰度 / 质量建议，无需改变方向 | `agent.inject`（**非唤醒**，下一个 pre-step 边界消费） |
| `concern` | 值得在继续前权衡的重大风险或明显更优的方向 | `agent.steer`（**唤醒**），受 `immuneTurns` 冷却约束 |
| `blocker` | 继续下去明显浪费工作（与显式用户指令矛盾、原地打转、根本性不可行） | `agent.steer` |

送达消息是 user-role 消息，`source` 携带 advisor 自己的 producer kind（`src/kinds.ts` `ADVISOR_PLUGIN_ID`；`kind: 'advisor'`，dsh 0.1.7-rc.1 起经声明合并进入 `MessageSourceMap`）与自我描述内容 `[advisor:{severity}] {note}`（`src/delivery.ts` `buildAdvisorMessage`；`form: 'notice'`，summary 有界 120 字符）—— 这是主模型获得的唯一关于如何对待它的线索。advisor 消息被排除在此后的 advisor delta 之外（自审排除，含两种历史形状，见下）。

**`immuneTurns` 冷却**（`src/delivery.ts` `AdvisorDelivery`）：仅在一条 concern/blocker **实际 steer 送达**后武装冷却栅栏；接下来 `immuneTurns` 个完成的 stepped 主 turn 走完之前，新的打断性 note 降级为 inject；`onSteppedTurnEnd`（每个完成的 stepped 可评审 turn/end）驱动倒计时。compaction / surface 重写（KD-5）清空栅栏。缺 agent 时 note 丢弃并记日志 —— advisory only，永不 throw、永不 stall。

### 评审运行策略（`src/advisor-runtime.ts`）

- 每个会话一个 `AdvisorRuntime`；delta 进有界 FIFO 队列（默认 32，满时丢最新并记日志），串行异步 drain —— **主循环永不被 park**；
- 每次 `llm.stream` 调用：`{ provider, model, system, messages: [user delta], maxTokens: 768 }`（768 = 用户指示的 256 → 5120 → 768 超驰链终值：thinking-off 为默认后无需 reasoning 余量；`purpose` 不设置，KD-5）。`reasoningEffort: 'off'` 仅在所配置模型的 adapter 声明该档位时发送（`src/advisor-runtime.ts` `resolveModelInfo` 能力查询）；
- 每次调用有 60s 整调用 deadline（超时按 transient 处理，KD-5 retry → drop）；
- **failure policy（KD-5）**：transient → 1 次重试（1s backoff）→ drop；连续 3 次 drop → 冲刷积压 backlog（不 stall）；quota/rate-limit → `quota_exhausted` 暂停（批次保留，**无自动恢复定时器** —— `/advisor on` 手动恢复）；permanent（`invalid_request_error` / model-not-found / "is not supported when" / does not exist）→ `halted`（原地终止；`/advisor on` 为该会话全新重建）；
- **KD-2 抽取**：解析回复中第一个平衡 JSON 帧（容忍 prose/fence）为 `{note, severity}`；`note` 非空否则 drop+log；`severity` 缺失/非法默认 `nit`；不做解析重试；note 文本有界（768 字符，`ADVISOR_NOTE_MAX_CHARS`）；
- **T5 emission guard**（`src/emission-guard.ts`）：normalize（等价拼写归一到同一身份）、content-free 短语抑制（stop / done / complete / no issue continue / lgtm / nothing to add）、跨 update 去重（允许 nit → concern → blocker 升级）、每次 update 至多一条 note、FIFO 有界去重历史（默认 4096）；compaction / surface 重写清空历史与 latch。

### 双模式触发与自审排除（`src/transcript.ts`）

- **标准 stepped 会话**：每个正常结束（`reason.kind ∈ {completed, 'max-tokens', error}`）的 stepped 主 turn/end 之后评审增量 delta；跳过 `aborted` / `blocked` / `interrupted`（不评审被用户截断的 turn）；
- **agentic / harness 会话**（从不发出 `turn/end`）：每个完成的 agent 回复轮次后 —— 当新的用户输入（含 `agent/inbox/spliced` 拼接的用户输入）在未评审的 assistant 增量之后到达时评审；非用户 inbox 拼接（advisor 自己的 inject/steer 送达等）永不触发（C-1 自触发修复）；
- **自审排除**：带 advisor producer kind 的消息（`isAdvisorMessage`：`kind: 'advisor'`，或 0.1.6 时代 `{ kind: 'plugin', plugin: 'advisor' }` note 经 V3→V4 内存迁移后的 `kind: 'plugin:advisor'`）不被渲染进 advisor delta —— advisor 不会读回自己投递的建议。史前直接 `{ kind: 'advisor' }` 的 note 作为直接 kind 被迁移边原样保留，同样被重新匹配——身份迁移不再孤儿化任何一代已持久化的 note（dsh ≥ 0.1.7-rc.1 的 V4 写入侧直接拒绝裸 `plugin` kind）；
- `maxDeltaMessages` 有界窗口（`DeltaRenderer`）；compaction / surface replace / 指纹不匹配 → 重置游标、全量重放（KD-5）。

### Live 重应用

每次 Loader 提交的 volatile 编辑（`loader/volatile-update`）经 `bridge.onChange` 重派生（`src/index.ts`）：`immuneTurns` / `maxDeltaMessages` 原地更新（delivery / observer）；每个会话 runtime 仅在其「运行影响签名」（enabled / provider / model / systemPrompt）变化时重建 —— 只改免疫/窗口的编辑不会中断在途调用或丢弃 backlog；config 级开关跟随 live source，新会话立即生效。S4 门禁每次读取都经解析器重放，配置编辑永远无法启动被门禁阻挡的模型调用。

## Web 卡片行为（`src/client`）

Advisor 卡片（bundle key `dsh-advisor`，`src/client/index.ts` 注册进 `plugins.bundle.config` keyed slot）的行为契约：

- **enabled 开关**（默认 OFF）：关闭时显示配置表单被隐藏的提示，进行中的草稿保留；
- **provider / model 选择框**：只列出**已配置**的 provider（命名空间 + profile 均解析，KD-S2）；model 选项优先取 provider profile 的声明模型，否则回退 `llm.models` catalog；存储的 provider/model 不再可用时显示警告；join 为空时显示引导文案；
- **systemPrompt** 文本框（placeholder 提示空 = 默认）、`immuneTurns` / `maxDeltaMessages` 数字输入（清空数字输入保持空、不强制为 0）；
- **保存**经网关 `set`（`connection.rpc.call('/api', 'advisor/set', { patch })`）：只把相对上次读取的**变更键**作为 patch 发送；`set` 先经 `Config` schema 校验（未知键拒绝）再写 entry config（经 config editor 落入 profile 补丁层的 advisor 行），返回新合成值；
- **降级态**：网关不可达 → 卡片头部显示 config-channel 提示且不提供 Save；加载失败 → 头部提示 + 可重试；settings provider 只读 → 只读提示并禁用写入；
- 卡片**没有** reset-to-defaults 动作（网关只暴露 `get` / `set` 两个端点）。

## 相关文档

- [消费者契约](consumer-api.md) — 包根导出、客户端入口、`/advisor` 指令面
- [验证记录](verification.md) — 测试矩阵与真实环境验证步骤
- [安装指南](install.zh.md) — 安装 / 验证 / 卸载
- [README（配置与用法）](../README.zh.md)
