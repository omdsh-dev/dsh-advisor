# 配置指南（`advisor` 命名空间）

`dsh-advisor` 的配置集中在 `advisor` settings 命名空间。它有两个持久化配置面，读写同一组键：

1. **插件行 config** —— 用户 profile 的 `cordis.patch.yml`（如 `profiles/web/cordis.patch.yml`）里 `id: advisor` 那一行的 `config` 字段。这是合成的 **base**（`src/settings.ts` `installAdvisorSettings` 以 entry 为 `base` 注册命名空间）。
2. **web Settings —— "插件配置"页的 Advisor 卡片**（`id advisor`，渲染在三张上游卡片 bash / agent-loop / web-search 之后）—— 卡片把编辑结果写入 `advisor` 命名空间的 **user layer**，覆盖插件行 config 而无需改动它；保存后新会话立即生效，无需重启（运行时 live 读取合成值，见 [live 重应用](#live-重应用)）。

卡片对配置的读写**只**走官方 `GatewayService` RPC 通道：`/api/advisor/get` + `/api/advisor/set`（`src/gateway.ts` 的 `AdvisorConfigGateway`，由宿主 typertGateway 认领，与 dsh 内建 `goals` 服务同一机制）。`advisor` 命名空间**不在**宿主 apiproxy 的 exposed-namespaces 白名单上（上游 dsh 没有注册级 opt-in），因此该通道也不受 settings 暴露白名单门控；进程内写入（`ctx.settings.update`）没有 exposed-namespace 检查。没有 settings service 时，source 就是插件行 entry，行为与未装插件时一致（`src/settings.ts`）。**插件不做任何宿主补丁**。

第三个控制面 `/advisor` 指令是**会话级且临时**的（翻转的是按会话的 override，从不修改持久化配置）——见 [消费者契约](consumer-api.md#advisor-指令面) 与 [用法](../README.zh.md#用法)。

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
    model: deepseek-v4-flash    # enabled: true 时必填（非空）
    systemPrompt: ""            # 可选；"" = 内置评审 prompt
    immuneTurns: 3              # 整数 ≥ 0，默认 3 —— 打断性送达后的冷却步数
    maxDeltaMessages: 60        # 整数 ≥ 0，默认 60 —— delta 窗口；0 = 无上限
```

## 显式模型门禁（S4）

`enabled: true` 而 `provider` 或 `model` **缺失或为空（含全空白字符串）** 时，`resolveAdvisorConfig`（`src/config.ts`）把配置解析为 **disabled-with-reason**：`enabled: false` + `disabledReason`，**绝不发起任何模型调用**（硬门禁，不是警告）。这是所有路径的 SSOT：

- 运行时每次读取都经过该解析器（`src/index.ts` `safeResolved` / `safeEffective`），因此 settings 编辑也永远无法绕过门禁发起模型调用；
- `/advisor status` 与 `/advisor on` 的回复在门禁阻挡时展示原因（`src/commands.ts`）；
- Settings 卡片在 enabled 且必填字段为空时阻止保存，但宿主侧硬门禁始终是最后防线。

**未知键严格拒绝**：`resolveAdvisorConfig` 显式拒绝未知键（`CONFIG_KEYS` 白名单，`src/config.ts`）与非对象输入；插件行加载时未知键抛错、拒绝该行（`src/index.ts` 构造期读取仍用抛错版 `resolved()`）。settings 的 user layer 若写入了解析器拒绝的值（如未知键），live 读取会解析为 disabled-with-reason 携带错误信息 —— 永不 wedge 热路径、永不启动模型调用（`src/index.ts` `safeFallback`；`src/gateway.ts` `readConfig` 同样包含该 containment）。

## 合成模型（composition）

三个来源按「后一层覆盖前一层」合成，各处使用同一组键（`src/settings.ts`）：

```text
schema 默认值 → 插件行 config（base）→ settings user layer（web 卡片写入）
```

- 无 settings service（未组合 `settings` 时，条件 `ctx.inject(['settings'], ...)` 子项不激活）→ source 恰为插件行 entry；
- 有 settings service → `AdvisorSettingsBridge.source()` 读 scope 的 live 合成值；每次 committed 变更触发 `onChange`。

## 行为要点

### 严重度与送达语义（spec §6）

每次评审至多发出一条 note，带严重度等级（`src/advisor-runtime.ts` `AdviceSeverity` = `'nit' | 'concern' | 'blocker'`）：

| 严重度 | 含义 | 送达通道 |
|---|---|---|
| `nit` | 轻微的风格 / 清晰度 / 质量建议，无需改变方向 | `agent.inject`（**非唤醒**，下一个 pre-step 边界消费） |
| `concern` | 值得在继续前权衡的重大风险或明显更优的方向 | `agent.steer`（**唤醒**），受 `immuneTurns` 冷却约束 |
| `blocker` | 继续下去明显浪费工作（与显式用户指令矛盾、原地打转、根本性不可行） | `agent.steer` |

送达消息是 user-role 消息，携带 advisor source kind（`src/kinds.ts` `ADVISOR_SOURCE_KIND`）与自我描述内容 `[advisor:{severity}] {note}`（`src/delivery.ts` `buildAdvisorMessage`；`form: 'notice'`，summary 有界 120 字符）—— 这是主模型获得的唯一关于如何对待它的线索。advisor 消息被排除在此后的 advisor delta 之外（自审排除，见下）。

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
- **自审排除**：advisor-source 消息永不被渲染进 advisor delta，advisor 不会读回自己的建议；
- `maxDeltaMessages` 有界窗口（`DeltaRenderer`）；compaction / surface replace / 指纹不匹配 → 重置游标、全量重放（KD-5）。

### Live 重应用

Settings 每次 committed 变更经 `bridge.onChange` 重派生（`src/index.ts`）：`immuneTurns` / `maxDeltaMessages` 原地更新（delivery / observer）；每个会话 runtime 仅在其「运行影响签名」（enabled / provider / model / systemPrompt）变化时重建 —— 只改免疫/窗口的编辑不会中断在途调用或丢弃 backlog；config 级开关跟随 live source，新会话立即生效。S4 门禁每次读取都经解析器重放，settings 编辑永远无法启动被门禁阻挡的模型调用。

## Web 卡片行为（`src/client`）

Advisor 卡片（`id advisor`，order 30，`src/client/index.ts` 注册进 `settings.plugin.item` slot）的行为契约：

- **enabled 开关**（默认 OFF）：关闭时显示配置表单被隐藏的提示，进行中的草稿保留；
- **provider / model 选择框**：只列出**已配置**的 provider（命名空间 + profile 均解析，KD-S2）；model 选项优先取 provider profile 的声明模型，否则回退 `llm.models` catalog；存储的 provider/model 不再可用时显示警告；join 为空时显示引导文案；
- **systemPrompt** 文本框（placeholder 提示空 = 默认）、`immuneTurns` / `maxDeltaMessages` 数字输入（清空数字输入保持空、不强制为 0）；
- **保存**经网关 `set`（`connection.rpc.call('/api', 'advisor/set', { patch })`）：只把相对上次读取的**变更键**作为 patch 发送；`set` 先经 `Config` schema 校验（未知键拒绝）再写 user layer，返回新合成值；
- **降级态**：网关不可达 → 卡片头部显示 config-channel 提示且不提供 Save；加载失败 → 头部提示 + 可重试；settings provider 只读 → 只读提示并禁用写入；
- 卡片**没有** reset-to-defaults 动作（网关只暴露 `get` / `set` 两个端点）。

## 相关文档

- [消费者契约](consumer-api.md) — 包根导出、客户端入口、`/advisor` 指令面
- [验证记录](verification.md) — 测试矩阵与真实环境验证步骤
- [安装指南](install.zh.md) — 安装 / 验证 / 卸载
- [README（配置与用法）](../README.zh.md)
