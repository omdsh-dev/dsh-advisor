# dsh-advisor

[English](README.md) | 中文

[![License: MIT](https://img.shields.io/github/license/dsh-external/dsh-advisor)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![GitHub stars](https://img.shields.io/github/stars/dsh-external/dsh-advisor)](https://github.com/dsh-external/dsh-advisor)
[![GitHub release](https://img.shields.io/github/v/release/dsh-external/dsh-advisor)](https://github.com/dsh-external/dsh-advisor/releases)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/dsh-external/dsh-advisor)](https://github.com/dsh-external/dsh-advisor/pulls)

一个移植 omp「advisor」子系统的独立 dsh 插件组合包：一个按会话运行的评审模型，观察主会话 transcript，用显式配置的模型（provider 与 model 均为必填）评审每个已完成的 stepped turn，并把按严重度排序的建议（nit / concern / blocker）注入回会话 —— 不污染主循环，也不递归地评审自己。

```sh
dsh plugin --profile <name> add github:dsh-external/dsh-advisor   # pin a commit with #<sha>
```

pnpm ≥ 10 默认拦截 git 依赖的 `prepare` 脚本：如果第一次 `add` 报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，请在 profile 的 `pnpm-workspace.yaml` 中放行一次构建（`onlyBuiltDependencies`，或 pnpm ≥ 10.26 的 `allowBuilds`），然后重新执行 `add` —— 参见[从 git URL 安装](#从-git-url-安装一条命令)。

**仅作建议。** advisor 从不批准或否决主 agent 的动作，也绝不会像主 agent 那样发出命令。每条送达的消息都是自我描述的 advisory 内容；一个行为异常的评审者会被端到端约束（emission guard、immuneTurns 冷却、failure policy），因此它永远不会卡住或污染主循环。

## 安装

### 从 git URL 安装（一条命令）

```sh
dsh plugin --profile <name> add github:dsh-external/dsh-advisor   # pin a commit with #<sha>
```

git 安装拉取的是源码，因此 pnpm 在安装时会运行该组合包的 `prepare` 脚本（`pnpm build`）。pnpm ≥ 10 在显式放行之前拒绝运行 git 依赖的 `prepare`，所以第一次 `add` 会报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`；pnpm 会提示修复方法 —— 把它打印出的确切 package key 复制到 profile 的 `pnpm-workspace.yaml`：

```yaml
# $DSH_HOME/profiles/<name>/pnpm-workspace.yaml
onlyBuiltDependencies:
  - dsh-advisor
# pnpm ≥ 10.26 also accepts the allowBuilds form:
# allowBuilds:
#   dsh-advisor: true
```

然后重新执行 `add`。请把这次放行当作它本来的样子：在安装时、在 agent 运行所在的任何沙箱之外，允许该包的代码在你的机器上执行。只放行你信任其源码的包，并钉住 commit（`github:dsh-external/dsh-advisor#<sha>`），这样之后的 push 无法悄悄改变实际运行的代码。

### 从 tarball 安装

打包组合包并安装到 profile：

```sh
pnpm pack
dsh plugin --profile <name> add dsh-advisor-0.0.1.tgz
```

tarball 附带的是构建产物（`lib/` + `cordis.patch.yml`），因此不会运行 `prepare` 脚本，也无需构建权限。第一次使用 `dsh plugin` 会初始化 profile（以 `@deepseek-ai/dsh-base` 作为其第一个组合包）；由于包声明了 `dsh.bundle`，`dsh` 会把 `dsh-advisor` 追加到 profile 的 `dsh.profile.bundles`。该组合包插入一行插件配置 —— `id: advisor`，`name: dsh-advisor`（见 `cordis.patch.yml`）。运行时依赖（`cordis`、`schemastery` 与 `@deepseek-ai/dsh-{session,agent,llm,commands,timeout}`）声明为 peerDependencies，由 dsh 安装的扁平 profile module fallback 解析 —— 无需额外安装步骤。

### 从 git 安装构建

git 安装（见上）拉取的是**源码而非构建产物**，因此组合包会从源码自行构建：`package.json` 声明了 `"prepare": "pnpm build"` —— 与打包 tarball 时 `prepack` 运行的构建相同 —— pnpm 会在安装完 devDependencies 后自动运行它。devDependencies 从已提交的 `peer-stubs/` 类型垫片解析（五个直接消费的 `@deepseek-ai/dsh-*` 包为 `file:./peer-stubs/<name>`：`dsh-{llm,session,commands,timeout}` 为最小运行时 stand-in，`dsh-agent` 为纯类型），因此任何克隆里的 `pnpm install` 都是自洽的 —— 无需访问私有 registry 包，也无需本地 dsh 检出。（早期的 packaging 说明曾警告 git 安装会失败，因为组合包没有 `prepare` 脚本；该问题已解决 —— git 安装现已端到端可用。）

### 验证

不启动即可验证配置行，然后启动：

```sh
dsh --profile <name> --dump-config   # shows a "# == dsh-advisor" layer with the advisor row
dsh --profile <name>
```

## 配置

> **Settings 页（计划中）：**从 dsh Settings 页编辑这些设置将在同一迭代内通过 plan `dsh-advisor-settings-n2` 落地。
> TODO：该 plan 合入后，记录三面关系（Settings 页 / 插件行 config / `/advisor` 指令）。

advisor 默认关闭。启用后，`provider` 与 `model` 为**必填**：`enabled: true` 而缺少两者之一是一个硬门禁 —— advisor 不会发起任何模型调用，并报告带原因的禁用状态（disabled-with-reason）。未知配置键会被拒绝。

在 profile 自己的 patch 层配置（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）：

```yaml
# profiles/<name>/cordis.patch.yml — the profile's user patch layer
- id: advisor
  config:
    enabled: true              # master switch (default false)
    provider: deepseek         # REQUIRED when enabled
    model: deepseek-chat       # REQUIRED when enabled
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

在每个正常结束（`completed`、`max-tokens` 或 `error`）的 stepped 主 turn 之后，advisor 评审增量 transcript delta，并按严重度排序至多发出一条 note：

- **nit** —— 轻微的样式、清晰度或质量建议；通过 `agent.inject` 送达（非唤醒，在下一个 pre-step 边界消费）。
- **concern** —— 在继续之前值得权衡的重大风险或明显更优的方向；通过 `agent.steer` 送达（唤醒），受 `immuneTurns` 冷却约束。
- **blocker** —— 继续下去明显是在浪费工作（与显式用户指令矛盾、原地打转、根本性不可行）；通过 `agent.steer` 送达。

注入的建议以 user-role 消息出现在会话流中，携带 advisor source kind 与自我描述的内容，例如：

```
[advisor:concern] extract the helper into a module and unit-test it
```

`[advisor:{severity}]` 前缀是主模型获得的关于如何对待它的唯一线索 —— 主 system prompt 从不提及 advisory。advisor 消息会被排除在此后的 advisor delta 之外，因此 advisor 永远不会读回自己的建议。

## 工作原理

插件订阅 `session/event`；在每个 step 的 `turn/end` 之后，它渲染主 transcript 的增量 markdown delta（排除 advisor 自己的消息），并放入按会话的 runtime 队列。runtime 通过 `ctx.llm.stream` 调用一个单独配置的模型，从 JSON-framed 回复中提取一条 `{note, severity}`，经过 emission guard 门禁（normalize / dedupe / content-free 抑制 / 每次更新至多一条 note），然后路由：nit → inject，concern/blocker → steer。compaction 与 surface 重写会重置 observer、emission guard 与 immuneTurns latch（KD-5）；drain 完全异步且 backlog 有界，因此失败或 quota 耗尽的 advisor 只能丢弃自己的 backlog —— 永远不会卡住主循环。

## 限制与路线图

MVP 有意放弃与 omp 的完整对等。已接受的差距（在 harness 迭代路线图中跟踪）：

- **每个会话一个 advisor** —— 无并行 advisor roster 或 WATCHDOG 式文件发现（下一迭代）。
- **无 advisor tools** —— 评审者只是一个独立的模型调用；它无法自行核验主张（下下迭代）。
- **无 Web UI 面板** —— 建议仅以带标签的注入消息呈现（下下迭代）。
- **无 transcript 持久化或成本统计** —— 无可恢复的 advisor 历史或成本可观测性（下下迭代）。
- **无 delta 内容密钥混淆** —— transcript 中出现的 secrets 可能到达 advisor 模型；请通过配置可信的评审模型来缓解。
- **不隔离不安全的 advisor 输出** —— 行为异常的 note 可能携带指令性文本；JSON frame + 校验 + advisory-only 框架（`[advisor:…]`、"weigh, don't blindly obey"）是仅有的缓解手段，且 note 会原样送达主 transcript（路线图）。
- **无 `syncBacklog` 追赶等待** —— 落后很多的 advisor 不会等待主循环；其 backlog 有界且会被丢弃（永远不会卡住主循环），因此 advisor note 可能在下一次主 turn 开始之后才到达（路线图：context-maintenance batch）。
- **advisor 上下文有界** —— 长会话的完整重放会被截断（`maxDeltaMessages`），因此 compaction 后 advisor 可能丢失早期上下文；advisor 上下文维护在路线图中（下下迭代）。

## 开发

组合包在安装时自行构建：`package.json` 声明了 `"prepare": "pnpm build"`（与 `prepack` 运行的构建相同），因此任何克隆都立即可构建。私有的 `@deepseek-ai/dsh-*` 运行时依赖在开发时从已提交的 `peer-stubs/` 类型垫片解析 —— 五个直接消费的包声明为 `file:./peer-stubs/<name>` devDependencies（`dsh-{llm,session,commands,timeout}` 为最小运行时 stand-in，`dsh-agent` 为纯类型），每个垫片的 `package.json` 记录了它所镜像的 dsh-private commit。无需本地 dsh 检出或额外设置 —— 任何克隆里一次普通的 `pnpm install` 即自洽。

```sh
pnpm install      # registry deps + file: peer-stubs, no environment setup
pnpm test         # vitest (unit + the composed integration loop)
pnpm typecheck    # tsc --noEmit (strict, moduleResolution: bundler)
pnpm build        # tsc emit to lib/ (runs automatically via prepare/prepack)
pnpm pack         # build + produce dsh-advisor-0.0.1.tgz
```

集成测试（`tests/integration.test.ts`）把插件组合进一个带 stub LLM adapter 的真实 cordis 上下文，驱动完整的 turn → delta → advisor call → inject/steer 循环。

## 许可证

MIT
