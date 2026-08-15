# dsh-advisor

[English](README.md) | 中文

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933.svg)
![dsh](https://img.shields.io/badge/dsh-DeepSeek%20Harness%20compatible-4B32C3.svg)
[![dshfind](https://dshfind.com/api/badge/omdsh-dev/dsh-advisor?lang=zh)](https://dshfind.com/zh/plugins/omdsh-dev/dsh-advisor?ref=badge)

一个移植 omp「advisor」子系统的独立 dsh 插件组合包：一个按会话运行的评审模型，观察主会话 transcript，用显式配置的模型（provider 与 model 均为必填）评审每个已完成的 stepped turn，并把按严重度排序的建议（nit / concern / blocker）注入回会话 —— 不污染主循环，也不递归地评审自己。

一条命令即可安装：

```sh
dsh plugin --profile web add dsh-advisor   # <name> = 你的 profile 名
```

**仅作建议。** advisor 从不批准或否决主 agent 的动作，也绝不会像主 agent 那样发出命令。每条送达的消息都是自我描述的 advisory 内容；一个行为异常的评审者会被端到端约束（emission guard、immuneTurns 冷却、failure policy），因此它永远不会卡住或污染主循环。

## 安装

### 一条命令的 registry 安装

```sh
dsh plugin --profile web add dsh-advisor   # <name> = 你的 profile 名
```

registry 安装拉取的是已发布的 tarball，其中自带构建产物（`lib/` + `cordis.patch.yml`），因此不会运行 `prepare` 构建，也无需构建放行。运行时依赖（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-*` peers）声明为 peerDependencies，由 dsh 安装的扁平 profile module fallback 解析——无需额外安装步骤。需要可复现安装时用 `dsh-advisor@0.1.0` 钉住精确版本。

### 本地目录安装（推荐用于开发 / 验证）

```sh
pnpm install                    # 构建组合包（prepare 自建）
dsh plugin --profile web add .  # <name> = 你的 profile 名
```

### 验证

```sh
dsh --profile web --dump-config   # 显示带 advisor 配置行的 "# == dsh-advisor" 层
dsh --profile web
```

tarball 安装与卸载见 [docs/install.zh.md](docs/install.zh.md)。

## 配置

![dsh web Settings（"插件配置"）页上的 Advisor 卡片](docs/screenshots/advisor-settings-card.webp)

advisor 默认关闭。启用后，`provider` 与 `model` 为**必填**：`enabled: true` 而缺少两者之一是一个硬门禁 —— advisor 不会发起任何模型调用，并报告带原因的禁用状态（disabled-with-reason）。未知配置键会被拒绝。

配置在**三个配置面**之间合成（后一层覆盖前一层；各处使用同一组键）：

1. **插件行 config** —— `$DSH_HOME/profiles/web/cordis.patch.yml`（见下）。这是合成 base。
2. **dsh web Settings 页 —— "插件配置"页** —— Advisor **卡片**（id `advisor`，渲染在三张上游卡片 bash / agent-loop / web-search 之后），含 enabled 开关、只列出系统内已配置 provider 及其模型的 provider/model 选择框与可选字段。保存写入 `advisor` settings namespace，覆盖插件行 config 而无需改动它。保存后新会话立即生效，无需重启（运行时 live 读取合成值）。需要当前版本的 dsh web 构建（其 web shell 声明了 `settings.plugin.item` 卡片 slot 并能加载 `dsh.client` 声明包）。卡片通过**官方 `GatewayService` RPC 通道**读写该命名空间（`/api/advisor/get` + `/api/advisor/set`，由宿主的 typertGateway claims——与 dsh 内建 `goals` 服务同一机制），该通道**不受 settings 暴露白名单门控**：进程内写入（`ctx.settings.update`）没有 exposed-namespace 检查。无需也不施加任何宿主补丁。
3. **`/advisor` 指令** —— 按会话且临时：翻转的是会话级 override，从不修改持久化配置（见[用法](#用法)）。

两个持久化配置面共享同一个硬门禁：`enabled: true` 而 `provider`/`model` 为空时绝不发起模型调用（disabled-with-reason）。Settings 页还会在 enabled 且必填字段为空时阻止保存；宿主侧硬门禁始终是所有路径上的最后防线。

插件行配置：

```yaml
# profiles/web/cordis.patch.yml — the profile's user patch layer
- id: advisor
  config:
    enabled: true              # master switch (default false)
    provider: deepseek-official  # REQUIRED when enabled
    model: deepseek-v4-flash     # REQUIRED when enabled
    systemPrompt: ""           # optional; "" = built-in reviewer prompt
    immuneTurns: 3             # int ≥ 0, default 3 — cooldown after a delivered interrupt
    maxDeltaMessages: 60       # int ≥ 0, default 60 — delta window; 0 = unbounded
```

| 键 | 类型 / 默认值 | 含义 |
|---|---|---|
| `enabled` | bool, `false` | 总开关。 |
| `provider` | string, optional | 供应商路由。`enabled: true` 时必须（非空）。 |
| `model` | string, optional | 模型 id。`enabled: true` 时必须（非空）。 |
| `systemPrompt` | string, `""` | 覆盖内置评审 prompt（严重度定义 + JSON-frame 输出契约）。 |
| `immuneTurns` | int ≥ 0, `3` | 实际 steer 过一次 concern/blocker 后，接下来 N 个完成的 stepped 主 turn 必须走完，另一条打断性 note 才可再次 steer；窗口内的 note 降级为 inject。 |
| `maxDeltaMessages` | int ≥ 0, `60` | 有界的 advisor 输入窗口。超过 N 的 delta 以 `… <earlier messages omitted>` 标记截断；`0` = 无上限。 |

**模型能力与预算**：advisor 调用以 `reasoningEffort: 'off'` 运行 —— 仅当所配置模型的 adapter 声明该档位时才发送（deepseek 模型声明；其他模型会自动省略该选项，因此非推理供应商照常工作）—— 并以 **5120 tokens** 作为输出上限（用户指示的 256 → 5120 的 20 倍超驰）。抽取出的 note 有界（1000 字符），notice summary 有界（120 字符），因此提高的预算不会变成注入主会话的无界内容。

## 用法

安装并启用后，advisor 观察每个会话。用 `/advisor` 指令按会话控制它（组合了 command registry 时可用）：

```
/advisor            toggle the advisor for this session
/advisor on         enable the advisor for this session
/advisor off        disable the advisor for this session
/advisor status     show state, model, runtime status, pending count, last activity
```

`/advisor on|off|toggle` 是会话级且临时的：它们翻转的是按会话的 override，从不修改持久化配置。启用一个 config 缺少 `provider`/`model` 的会话不会发起模型调用 —— `/advisor status`（以及 `/advisor on` 的回复）会显示门禁原因。

`/advisor on` 也是手动恢复路径：被 quota/rate-limit 暂停的会话 advisor（`quota_exhausted` —— KD-5 没有自动恢复定时器）会在原地恢复；被终止的 advisor（永久性模型错误，如凭据无效）会为该会话全新重建。

advisor 采用双模式触发，取决于会话形态：

- **标准 stepped 会话** —— 在每个正常结束（`completed`、`max-tokens` 或 `error`）的 stepped 主 turn 之后，评审增量 transcript delta。
- **agentic / harness 会话**（从不发出 `turn/end`）—— 在每个完成的 agent 回复轮次之后：当新的用户输入（含 inbox 拼接输入）在未评审的 assistant 增量之后到达时，评审该增量。

无论哪种模式，每次评审至多发出一条 note，按严重度排序：

- **nit** —— 轻微的样式、清晰度或质量建议；通过 `agent.inject` 送达（非唤醒，在下一个 pre-step 边界消费）。
- **concern** —— 在继续之前值得权衡的重大风险或明显更优的方向；通过 `agent.steer` 送达（唤醒），受 `immuneTurns` 冷却约束。
- **blocker** —— 继续下去明显是在浪费工作（与显式用户指令矛盾、原地打转、根本性不可行）；通过 `agent.steer` 送达。

注入的建议以 user-role 消息出现在会话流中，携带 advisor source kind 与自我描述的内容，例如：

```
[advisor:concern] extract the helper into a module and unit-test it
```

`[advisor:{severity}]` 前缀是主模型获得的关于如何对待它的唯一线索 —— 主 system prompt 从不提及 advisory。advisor 消息会被排除在此后的 advisor delta 之外，因此 advisor 永远不会读回自己的建议。

![注入到会话流中的 advisor 建议](docs/screenshots/advisor-injected-note.webp)

## 工作原理

插件订阅 `session/event`。两种触发方式会把主 transcript 的增量 markdown delta（排除 advisor 自己的消息）渲染出来并放入按会话的 runtime 队列：标准 stepped 会话在每个 stepped `turn/end` 之后；agentic/harness 会话（从不发出 `turn/end`）则在新的用户输入（含 inbox 拼接输入）于未评审的 assistant 增量之后到达时 —— 即每个完成的 agent 回复轮次。runtime 通过 `ctx.llm.stream` 调用一个单独配置的模型，从 JSON-framed 回复中提取一条 `{note, severity}`，经过 emission guard 门禁（normalize / dedupe / content-free 抑制 / 每次更新至多一条 note），然后路由：nit → inject，concern/blocker → steer。advisor 调用以关闭推理（reasoning off）和 20 倍 token 预算运行，因此 JSON note 绝不会被推理输出挤占。compaction 与 surface 重写会重置 observer、emission guard 与 immuneTurns latch（KD-5）；drain 完全异步且 backlog 有界，因此失败或 quota 耗尽的 advisor 只能丢弃自己的 backlog —— 永远不会卡住主循环。

## 限制与路线图

MVP 有意放弃与 omp 的完整对等。已接受的差距（在 harness 迭代路线图中跟踪）：

- **每个会话一个 advisor** —— 无并行 advisor roster 或 WATCHDOG 式文件发现（下一迭代）。
- **无 advisor tools** —— 评审者只是一个独立的模型调用；它无法自行核验主张（下下迭代）。
- **无会话内 advisor 面板** —— 建议仅以带标签的注入消息呈现（"插件配置"设置页上的 Advisor 卡片是配置面，不是会话内视图；会话内卡片为下下迭代）。
- **无 transcript 持久化或成本统计** —— 无可恢复的 advisor 历史或成本可观测性（下下迭代）。
- **无 delta 内容密钥混淆** —— transcript 中出现的 secrets 可能到达 advisor 模型；请通过配置可信的评审模型来缓解。
- **不隔离不安全的 advisor 输出** —— 行为异常的 note 可能携带指令性文本；JSON frame + 校验 + advisory-only 框架（`[advisor:…]`、"weigh, don't blindly obey"）是仅有的缓解手段，且 note 会原样送达主 transcript（路线图）。
- **无 `syncBacklog` 追赶等待** —— 落后很多的 advisor 不会等待主循环；其 backlog 有界且会被丢弃（永远不会卡住主循环），因此 advisor note 可能在下一次主 turn 开始之后才到达（路线图：context-maintenance batch）。
- **advisor 上下文有界** —— 长会话的完整重放会被截断（`maxDeltaMessages`），因此 compaction 后 advisor 可能丢失早期上下文；advisor 上下文维护在路线图中（下下迭代）。

## 开发

组合包在安装时自行构建：`package.json` 声明了 `"prepare": "pnpm build"`（与 `prepack` 相同的构建），因此任何克隆都立即可构建。私有的 `@deepseek-ai/dsh-*` 运行时依赖**只声明为 peerDependencies**（绝不进 `dependencies` / `devDependencies`）；`pnpm-workspace.yaml` 设了 `autoInstallPeers: true` + `nodeLinker: hoisted`（pnpm 11+ 忽略 `.npmrc` 中的非认证设置），因此开发期 pnpm 用你用户级 `~/.npmrc` 里的认证令牌从 npm registry 解析真实的 `@deepseek-ai/*` 包。没有本地链接农场，依赖解析也不需要 `DSH_HOME` / `DSH_SOURCE_DIR` 前置条件。

```sh
pnpm install              # registry deps，含 @deepseek-ai/* peers（经 autoInstallPeers + ~/.npmrc 认证）
pnpm test                 # vitest (unit + the composed integration loop)
pnpm typecheck            # tsc --noEmit (node) + tsc -p tsconfig.client.json --noEmit + tsc -p tsconfig.spec.json --noEmit
pnpm build                # tsc -p tsconfig.build.json emit to lib/ + node scripts/build-client.mjs (client bundle)
pnpm pack                 # build + produce dsh-advisor-0.0.1.tgz
```

内置 `cordis` 框架声明为 scoped peer `@deepseek-ai/cordis`（绝不用裸名 `cordis`）。针对 prerelease 发布的 peer 范围必须带精确的发布 tag —— 例如 `@deepseek-ai/dsh-*` peers 钉在 `^0.1.0-rc.6`；按 node-semver prerelease-tuple 规则，带 prerelease 的 comparator 只匹配同 `[major, minor, patch]` tuple，因此 `^4.0.0-rc.7` 这样的范围永远匹配不到 `4.0.1-rc.1` 的发布。scoped peer 与其他 `@deepseek-ai/*` peers 一样从 npm registry 解析，所以开发期的 `import '@deepseek-ai/cordis'` 与宿主看到的是同一个包身份。

`prepack` 运行 `pnpm build`；`prepare` 运行 `pnpm build`，因此 `pnpm pack` 会构建两次（每个生命周期一次）——这是为保持 git 安装可构建而接受的取舍。没有 `postinstall` 步骤：tarball 安装已带构建产物，完全跳过构建。本地 `dsh plugin add .` 从工作树挂载 bundle，因此请先运行 `pnpm build`（或 `pnpm install`）——pnpm 不会为 `link:` 依赖运行 `prepare`。

集成测试（`tests/integration.test.ts`）把插件组合进一个带 stub LLM adapter 的真实 cordis 上下文，驱动完整的 turn → delta → advisor call → inject/steer 循环。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/install.zh.md](docs/install.zh.md) | 完整安装指南：git / tarball / 本地目录安装、web Settings 暴露、卸载、`--dump-config` 验证 |

## 许可证

MIT
