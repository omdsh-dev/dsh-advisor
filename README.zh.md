# dsh-advisor

[English](README.md) | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/dt/dsh-advisor)](https://www.npmjs.com/package/dsh-advisor)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933.svg)
![dsh](https://img.shields.io/badge/dsh-0.1.7--rc.2-4B32C3.svg)
![dsh tui](https://img.shields.io/badge/dsh%20tui-compatible-4B32C3.svg)
[![dshfind](https://dshfind.com/api/badge/omdsh-dev/dsh-advisor?lang=zh)](https://dshfind.com/zh/plugins/omdsh-dev/dsh-advisor?ref=badge)

一个移植 omp「advisor」子系统的独立 dsh（DeepSeek Harness）插件组合包：一个按会话运行的独立评审模型，观察主会话 transcript，用显式配置的模型（provider 与 model 均为必填）评审每个已完成的 stepped turn，并把按严重度排序的建议（nit / concern / blocker）注入回会话——不污染主循环，也不递归地评审自己。

**仅作建议。** advisor 从不批准或否决主 agent 的动作，也绝不会像主 agent 那样发出命令。每条送达的消息都是自我描述的 advisory 内容；一个行为异常的评审者会被端到端约束（emission guard、immuneTurns 冷却、failure policy），因此它永远不会卡住或污染主循环。

两个 dsh 前端均可用：**web** profile（侧边栏 → 插件 → dsh-advisor → Advisor 卡片）与 **dsh-tui** 终端 profile（`/advisor` + `/advisor config`）。

## 快速开始

### 安装

```sh
dsh plugin --profile web add dsh-advisor      # web profile（设置 → Advisor 卡片）
dsh plugin --profile dsh-tui add dsh-advisor  # dsh-tui 终端 profile
```

同一个插件、两个前端——区别只在 `--profile` 参数。钉版本：加 `@<version>`（如 `dsh-advisor@0.1.0`）。registry 安装拉取的是已发布的 tarball，自带构建产物（`lib/` + `cordis.patch.yml`）——目标机无需构建；运行时依赖（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-*` peers）经 dsh 安装的扁平 profile module fallback 解析——无需额外安装步骤。registry / git / tarball / 本地目录变体（本地目录从已构建 checkout 安装：`dsh plugin --profile web add .` 或 `dsh plugin --profile dsh-tui add .`）、web Settings 暴露、卸载与 `--dump-config` 验证 → [docs/install.zh.md](docs/install.zh.md)。

### 配置

编辑 profile 补丁层（`~/.dsh/profiles/<profile>/cordis.patch.yml`）里 `advisor` 行的 `config`。六个字段全部是 schema-volatile 的 live 字段（dsh ≥ 0.1.7-rc.1）：web 卡片与 TUI `/settings` 屏幕写入的就是这同一份 entry config——持久化在 profile 补丁层，无需重挂载即生效。（pre-0.1.7 的 `$DSH_HOME/settings.yaml` `advisor:` 分节已不存在：dsh 会在首次启动时把它导入活跃 profile 一次，并将该文件改名为 `.imported`。）

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml —— advisor 行的 config
- id: advisor
  config:
    enabled: true                # 总开关（默认 false）——需显式打开后生效
    provider: deepseek-official  # enabled: true 时必填（非空）
    model: deepseek-flash        # enabled: true 时必填（非空）；网关未开放 V41 路由时回退 deepseek-v4-flash（或其它 V4 id）
    systemPrompt: ""             # 可选；"" = 内置评审 prompt
    immuneTurns: 3               # 整数 ≥ 0，默认 3 —— 打断性送达后的冷却步数
    maxDeltaMessages: 60         # 整数 ≥ 0，默认 60 —— delta 窗口；0 = 无上限
```

advisor 默认关闭。启用后，`provider` 与 `model` 为**必填**：`enabled: true` 而缺少两者之一是一个硬门禁——advisor 不会发起任何模型调用，并报告带原因的禁用状态（disabled-with-reason）；未知配置键会被拒绝。

同一组键可在**三个配置面**读取与编辑（只有一份存储——上面的 advisor entry config；各处使用同一组键与同一个硬门禁，宿主侧门禁始终是所有路径上的最后防线）：

1. **插件行 config** —— profile 补丁层（`~/.dsh/profiles/<profile>/cordis.patch.yml`）。配置就存放在这里。
2. **dsh web 的「插件」页 —— dsh-advisor 组合包自己的页面** —— Advisor **卡片**（bundle key `dsh-advisor`），含 enabled 开关、只列出系统内已配置 provider 及其模型的 provider/model 选择框与可选字段。保存写入 advisor entry 的 config（经 config editor 落入 profile 补丁层），运行中的会话立即生效，无需重启。卡片要求 dsh web 构建的 shell 声明了 `plugins.bundle.config` 卡片 slot（dsh ≥ 0.1.7-rc.1）并能加载 `dsh.client` 声明包；它通过官方 `GatewayService` RPC 通道读写该配置（`/api/advisor/get` + `/api/advisor/set`），不受 settings 暴露白名单门控。卡片还会在 enabled 且必填字段为空时阻止保存。
3. **`/advisor` 指令** —— 按会话且临时：翻转的是会话级 override、并为会话钉住评审模型，从不修改持久化配置（见[验证](#验证)）。

在 **dsh-tui** profile 中，同样的五个键可在 TUI `/settings` 屏幕编辑：运行 `dsh --profile dsh-tui`、打开 `/settings`，编辑 **Advisor** 分节（`enabled` / `provider` / `model` / `immuneTurns` / `maxDeltaMessages`，每项均带中英文标签与提示）。编辑先暂存，保存时经 revision 栅栏保护的 `settings.mutate` 写入 web 卡片所写的同一份 advisor entry config，并 live 重应用、无需重启。`systemPrompt` **不是** TUI 字段（TUI text 控件为单行；多行 prompt 会被截断）——请经 web 卡片或 profile 补丁层编辑。该分节要求 dsh-tui ≥ v0.8.0（随 v0.8.0+ 组合包的 `dsh-tui-settings-sections` 行提供）；旧版 dsh-tui 会干净地 no-op，profile 补丁层仍是编辑路径。`/advisor config` 仍是只读回读，seam 挂载时其编辑提示指向 `/settings` 屏幕。保存行为与 web 卡片不同：TUI seam 没有跨字段校验，一次保存可能把 `enabled: true` 与空 `provider`/`model` 一起写入——显式模型门禁会在运行时把它解析为 disabled-with-reason（可见于 `/advisor status` 与 `/advisor config`）；web 卡片则会直接阻止这样的保存。完整参考 → [docs/configuration.md](docs/configuration.md)。

![dsh web「插件」页（dsh-advisor 组合包页面）上的 Advisor 卡片](docs/screenshots/advisor-settings-card.webp)

### 验证

```sh
dsh --profile web --dump-config   # 显示带 advisor 配置行的 "# == dsh-advisor" 层
```

安装并启用后，在会话内用 `/advisor` 指令控制它（组合了 command registry 时可用）：

```
/advisor            toggle the advisor for this session
/advisor on         enable the advisor for this session
/advisor off        disable the advisor for this session
/advisor status     show state, model, runtime status, pending count, last activity
/advisor model      show the effective reviewer model and its source (session override or global default)
/advisor model set <provider> <model>   pin a reviewer model for this session only
/advisor model reset    drop the session pin and re-inherit the global defaults
```

`/advisor on|off|toggle` 是会话级且临时的：它们翻转的是按会话的 override，从不修改持久化配置。启用一个 config 缺少 `provider`/`model` 的会话不会发起模型调用——`/advisor status`（以及 `/advisor on` 的回复）会显示门禁原因：advisor 只有在启用**且**两者均已配置时才运行。`/advisor on` 也是手动恢复路径：被 quota/rate-limit 暂停的会话 advisor（`quota_exhausted`——无自动恢复定时器）会在原地恢复；被终止的 advisor（永久性模型错误，如凭据无效）会为该会话全新重建。

`/advisor model set` 只为**发起调用的会话**钉住一个评审模型——一个内存中的原子 `provider + model` 对，生存期为活跃会话（dispose、owner 卸载、冷恢复或重启时清除；fork 的新会话继承全局默认值）。它叠加在持久化的全局默认值之上而不改写它们：全局配置还没有 pair 时，完整的会话对即可生效；全局配置非法时所有会话照旧被阻挡；两级之间的半个 pair 永不拼接；set/reset 从不触碰启用开关。提交前会经 LLM 服务解析校验该对（60 秒上界、可取消、无自动重试）；失败时先前选择保持不变。`/advisor config` 始终是**全局默认值**的回读，不是会话状态。

在 **dsh-tui** profile 中，`/advisor config` 额外回读组合配置——即全局默认值，只读，编辑提示指向真实的写路径：TUI `/settings` 屏幕（Advisor 分节，dsh-tui ≥ v0.8.0）与 profile 补丁层。`/advisor` / `on|off|status|config|model` 指令出现在 TUI 的 `/` 菜单中并带子命令补全（指令发现要求 `dsh-tui-command-trees` 行——随附的 dsh-tui 组合包自带）。

在 **web** 端，同样的会话级模型控制由会话头部的 **Advisor 动作**承载（要求 dsh web 构建的 shell 声明 `conversation.session.header.actions` 插槽——dsh ≥ 0.1.7-rc.1）。该动作绑定在它所在的会话上：显示生效的评审 pair、其来源（`session override` / `global default`）与 live-session 生存期；**Pin this model** 为该会话钉住 provider + model，**Use global default** 去除钉住（即 reset 路径）。它只通过插件会话端点（`/api/advisor/getSession` + `/api/advisor/setSessionModel`）写入——与 `/advisor model` 同一控制器、同一校验与栅栏，从不写持久化配置——并且当会话控制面不可用时，绝不回退到全局配置写通道。控件在打开时刷新（打开期间断连/聚焦也会刷新）；没有后台轮询。插件页上的全局卡片保持仅全局。

## 能力一览

- **每个会话一个独立评审者**：独立的模型调用观察主 transcript 并评审每个 stepped 主 turn；advisor 消息被排除在此后的 delta 之外，因此 advisor 不会读回自己的建议。自审排除同时识别 advisor 当前的 producer kind（`advisor`）与仍可打开日志中可能出现的两种历史形状：史前直接 `{ kind: 'advisor' }` 的 note，以及 0.1.6 时代的 note 经 V3→V4 内存迁移后的形状（`kind: 'plugin:advisor'`）——身份迁移不会孤儿化任何一代已持久化的 note。
- **按严重度排序的建议 + inject/steer 语义**：每次评审至多发出一条 note——**nit**（轻微的样式、清晰度或质量建议；经非唤醒的 `agent.inject` 送达，在下一个 pre-step 边界消费）、**concern**（继续之前值得权衡的重大风险或明显更优的方向；经唤醒的 `agent.steer` 送达，受 `immuneTurns` 冷却约束）、**blocker**（继续下去明显是在浪费工作——与显式用户指令矛盾、原地打转、根本性不可行；经 `agent.steer` 送达）。送达的消息携带 `[advisor:{severity}]` 前缀且为自我描述的 advisory 内容：

  ```
  [advisor:concern] extract the helper into a module and unit-test it
  ```

- **显式模型门禁**：`enabled` 默认关闭；`enabled: true` 而缺少 `provider` + `model` 时绝不发起模型调用——状态报告 disabled-with-reason。门禁在会话解析**之后**作用于*有效*路由：完整的会话级覆盖对可为其会话满足门禁；非法的全局配置不可被绕过。未知配置键会被拒绝。
- **零工具的最小启动**：评审者只是一个独立的模型调用——无 advisor tools，除了 advisory 消息之外它无法对会话做任何事。
- **不卡主循环的失败策略**：失败或 quota 耗尽的 advisor 只会丢弃自己有界的 backlog——永远不会卡住或污染主循环。
- **会话级控制**：`/advisor on|off|status|config|model` 按会话工作；开关与会话级模型钉住都是临时的 override，从不修改持久化配置——`/advisor config` 始终报告全局默认值。在 web 端，会话头部的 **Advisor 动作**经由专属会话端点驱动同一个会话级钉住（见 [Verify](#verify)）。

![注入到会话流中的 advisor 建议](docs/screenshots/advisor-injected-note.webp)

## 纯挂载（零 dsh 修改）

插件以**纯挂载**方式安装：bundle 插入 + 客户端卡片（web「插件」页）+ 自有 gateway 通道（`/api/advisor/get|set` 承载全局配置，`/api/advisor/getSession|setSessionModel` 承载会话级模型面，由宿主 typertGateway 认领——与 dsh 内建 `goals` 服务同一机制，不受 settings 暴露白名单门控）+ `/advisor` 指令——无 dsh 补丁、无 postinstall 步骤，dsh 升级永不需重打。

## 限制与路线图

MVP 有意放弃与 omp 的完整对等。已接受的差距（在 harness 迭代路线图中跟踪）：

- **每个会话一个 advisor**——无并行 advisor roster 或 WATCHDOG 式文件发现（下一迭代）。
- **无 advisor tools**——评审者只是一个独立的模型调用；它无法自行核验主张（下下迭代）。
- **无会话内 advisor 面板**——建议仅以带标签的注入消息呈现；web Advisor 卡片是配置面，不是会话内视图（下下迭代）。
- **无 transcript 持久化或成本统计**——无可恢复的 advisor 历史或成本可观测性（下下迭代）。
- **无 delta 内容密钥混淆**——transcript 中出现的 secrets 可能到达 advisor 模型；请通过配置可信的评审模型来缓解。
- **不隔离不安全的 advisor 输出**——行为异常的 note 可能携带指令性文本；JSON frame + 校验 + advisory-only 框架是仅有的缓解手段，且 note 会原样送达主 transcript（路线图）。
- **无 `syncBacklog` 追赶等待**——落后很多的 advisor 不会等待主循环；其 backlog 有界且会被丢弃，因此 note 可能在下一次主 turn 开始之后才到达（路线图：context-maintenance batch）。
- **advisor 上下文有界**——长会话的完整重放会被截断（`maxDeltaMessages`），因此 compaction 后 advisor 可能丢失早期上下文（路线图：下下迭代）。

**旧版本写入的会话——pre-V3 日志不在此修复。** 其中的 advisor note 带有旧的自定义 `source.kind`（`kind: 'advisor'`），dsh 的 V2→V3 会话格式边会拒绝它，因此这些 **pre-V3** 日志无法迁移（原始文件完好，只是打不开）。已经是 V3 的日志仍可正常打开——它们只受上文的「自审例外」影响。修复这些 pre-V3 日志属于上游工作：针对这一类缺陷的统一修复正在 [`omdsh-dev/dsh-llm-fallbacks`](https://github.com/omdsh-dev/dsh-llm-fallbacks) 开发中，**尚未可用**。本版本及之后写入的日志不受影响。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/install.zh.md](docs/install.zh.md) | profile 安装（web + dsh-tui）/ registry / git / tarball / 本地目录变体 / web Settings 暴露 / 卸载 / `--dump-config` 验证 |
| [docs/configuration.md](docs/configuration.md) | advisor 配置全字段：键与默认值、显式模型门禁（S4）、配置面（web 卡片 / TUI `/settings` / 补丁层）、示例 YAML、live 重应用行为 |
| [docs/consumer-api.md](docs/consumer-api.md) | 开发者消费契约：包根库 API、`dsh-advisor/client` 入口、`/advisor` 指令面、导出清单、生命周期 |
| [docs/verification.md](docs/verification.md) | 验证记录：测试矩阵（16 文件 / 319 用例）、typecheck/build、CI 契约、真实环境步骤 |
| [docs/release.md](docs/release.md) | 发布流程：PR 驱动的 Release prep + Release 工作流、OIDC trusted publishing、版本策略、回滚 |

## 许可

本项目以 **MIT** 许可证发布，全文见 [LICENSE](LICENSE)。版权与许可条款以 LICENSE 文件为准。
