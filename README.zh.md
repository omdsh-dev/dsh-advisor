# dsh-advisor

[English](README.md) | 中文

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933.svg)
![dsh](https://img.shields.io/badge/dsh-DeepSeek%20Harness%20compatible-4B32C3.svg)

一个移植 omp「advisor」子系统的独立 dsh 插件组合包：一个按会话运行的评审模型，观察主会话 transcript，用显式配置的模型（provider 与 model 均为必填）评审每个已完成的 stepped turn，并把按严重度排序的建议（nit / concern / blocker）注入回会话 —— 不污染主循环，也不递归地评审自己。

```sh
dsh plugin --profile <name> add github:dsh-external/dsh-advisor   # pin a commit with #<sha>
```

pnpm ≥ 10 默认拦截 git 依赖的 `prepare` 与 `postinstall` 脚本：如果第一次 `add` 报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，请在 profile 的 `pnpm-workspace.yaml` 中添加放行条目（`onlyBuiltDependencies`，或 pnpm ≥ 10.26 的 `allowBuilds`），然后重新执行 `add` —— 参见[从 git URL 安装](#从-git-url-安装一条命令)。

**仅作建议。** advisor 从不批准或否决主 agent 的动作，也绝不会像主 agent 那样发出命令。每条送达的消息都是自我描述的 advisory 内容；一个行为异常的评审者会被端到端约束（emission guard、immuneTurns 冷却、failure policy），因此它永远不会卡住或污染主循环。

## 安装

### 从 git URL 安装（一条命令）

```sh
dsh plugin --profile <name> add github:dsh-external/dsh-advisor   # pin a commit with #<sha>
```

git 安装拉取的是源码，因此 pnpm 在安装时会运行该组合包的生命周期脚本：`prepare`（`pnpm build`）与 `postinstall`（`bash scripts/autopatch-install.sh` —— 宿主 patch 的安装期自动应用，见[宿主 patch（Settings 页）](#宿主-patchsettings-页)）。pnpm ≥ 10 在显式放行之前拒绝运行 git 依赖的 `prepare`，所以第一次 `add` 会报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`；pnpm 会提示修复方法 —— 把它打印出的确切 package key 复制到 profile 的 `pnpm-workspace.yaml`：

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

tarball 附带的是构建产物（`lib/` + `cordis.patch.yml` + `patches/` 与 `scripts/` 宿主 patch 机制），因此不会运行 `prepare` 脚本，也无需构建权限。第一次使用 `dsh plugin` 会初始化 profile（以 `@deepseek-ai/dsh-base` 作为其第一个组合包）；由于包声明了 `dsh.bundle`，`dsh` 会把 `dsh-advisor` 追加到 profile 的 `dsh.profile.bundles`。该组合包插入一行插件配置 —— `id: advisor`，`name: dsh-advisor`（见 `cordis.patch.yml`）。运行时依赖（`cordis`、`schemastery` 与 `@deepseek-ai/dsh-{session,agent,llm,commands,timeout}`）声明为 peerDependencies，由 dsh 安装的扁平 profile module fallback 解析 —— 无需额外安装步骤。（tarball 安装不会运行 autopatch：当宿主尚未暴露 `advisor` 命名空间时，请用 `scripts/apply-dsh-patch.sh` 手动应用宿主 patch。）

### 从 git 安装构建

git 安装（见上）拉取的是**源码而非构建产物**，因此组合包会从源码自行构建：`package.json` 声明了 `"prepare": "node scripts/setup-dsh-links.mjs && pnpm build && bash scripts/autopatch-install.sh"` —— 开发期链接农场、与打包 tarball 时 `prepack` 运行的构建相同，外加安装期宿主 patch 自动应用 —— pnpm 会在安装完 devDependencies 后自动运行它。私有 `@deepseek-ai/dsh-*` 包（以及内置 `cordis`/`react`/`react-dom` 身份）的开发期解析来自**本地 dsh 源码树**，经 `$DSH_SOURCE_DIR` / `$DSH_HOME`（见[开发](#开发)）—— 与宿主运行的同一棵树，因此不存在 `peer-stubs/` 副本，每位开发者解析到的都是真实包。git 安装因此要求该树（宿主 patch 自动应用本来也需要它）；具备该树后，任何克隆里的 `pnpm install` 即自洽 —— 无需访问私有 registry 包。

### 宿主 patch（Settings 页）

dsh web Settings 页通过 dsh 宿主的 apiproxy 读写 settings 命名空间，而 apiproxy 只向配置客户端暴露 model-provider 命名空间以及 `permission` / `ui-onboarding`。`advisor` 命名空间在该边界之外，因此面对这样的宿主时，页面无法完成 Advisor section 的读写往返 —— store 检测到未暴露的命名空间后，会显示明确的提示而非可写表单（已交付的插件侧缓解）。

组合包随附这一宿主侧缺口（C-1）的**修复机制**，镜像已验证的 `dsh-llm-fallbacks` 模式：一个把 `advisor` 加入宿主 exposure allowlist 的最小 git patch（`packages/host/apiproxy/src/api-proxy.ts` 的 `PRODUCT_SETTINGS_NAMESPACES`），外加 apply / revert / verify 脚本与安装期 autopatch —— 详见 [`patches/README.md`](patches/README.md)。当宿主尚未暴露 `advisor` 时需要它（钉住的基线 dsh-private b8343cb 未暴露）；每次 dsh 升级后需重跑（升级会重置宿主改动）。

```sh
export DSH_SOURCE_DIR="$DSH_HOME/source/current"   # 或仅设置 DSH_HOME
scripts/apply-dsh-patch.sh --check   # 只读可应用性检查
scripts/apply-dsh-patch.sh           # 应用并重建宿主包
scripts/verify-dsh-patch.sh          # 断言源码与构建产物标记
scripts/revert-dsh-patch.sh          # 回滚（例如 dsh 升级前）
```

git 安装会在安装期自动运行 autopatch（`postinstall` 与 `prepare`）；用 `DSH_ADVISOR_AUTOPATCH=0` 完全跳过。autopatch 只 warn、绝不导致安装失败；tarball 安装请按上面的命令手动应用。**安全说明：**apply/revert 脚本（以及 autopatch）会在应用/安装时运行目标树的构建代码（`tsc` / `tsdown`），位于 agent 运行所在沙箱之外 —— 只把它们指向你信任的 dsh 源码树，并把上面的 `onlyBuiltDependencies` 放行当作它本来的样子：允许该包在安装时执行其代码。

### 验证

不启动即可验证配置行，然后启动：

```sh
dsh --profile <name> --dump-config   # shows a "# == dsh-advisor" layer with the advisor row
dsh --profile <name>
```

## 配置

advisor 默认关闭。启用后，`provider` 与 `model` 为**必填**：`enabled: true` 而缺少两者之一是一个硬门禁 —— advisor 不会发起任何模型调用，并报告带原因的禁用状态（disabled-with-reason）。未知配置键会被拒绝。

配置在**三个配置面**之间合成（后一层覆盖前一层；各处使用同一组键）：

1. **插件行 config** —— `$DSH_HOME/profiles/<name>/cordis.patch.yml`（见下）。这是合成 base。
2. **dsh web Settings 页** —— Advisor section（enabled 开关、只列出系统内已配置 provider 及其模型的 provider/model 选择框、可选字段）保存到 `advisor` settings namespace，覆盖插件行 config 而无需改动它。保存后新会话立即生效，无需重启（运行时 live 读取合成值）。需要当前版本的 dsh web 构建（其 web shell 能加载 `dshClient` 包并渲染 `settings.section` slot）。
3. **`/advisor` 指令** —— 按会话且临时：翻转的是会话级 override，从不修改持久化配置（见[用法](#用法)）。

两个持久化配置面共享同一个硬门禁：`enabled: true` 而 `provider`/`model` 为空时绝不发起模型调用（disabled-with-reason）。Settings 页还会在 enabled 且必填字段为空时阻止保存；宿主侧硬门禁始终是所有路径上的最后防线。

插件行配置：

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

在每个正常结束（`completed`、`max-tokens` 或 `error`）的 stepped 主 turn 之后，advisor 评审增量 transcript delta，并按严重度排序，至多发出一条 note：

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
- **无会话内 advisor 面板** —— 建议仅以带标签的注入消息呈现（本迭代新增的 Advisor **Settings** section 是配置面，不是会话内视图；会话内卡片为下下迭代）。
- **无 transcript 持久化或成本统计** —— 无可恢复的 advisor 历史或成本可观测性（下下迭代）。
- **无 delta 内容密钥混淆** —— transcript 中出现的 secrets 可能到达 advisor 模型；请通过配置可信的评审模型来缓解。
- **不隔离不安全的 advisor 输出** —— 行为异常的 note 可能携带指令性文本；JSON frame + 校验 + advisory-only 框架（`[advisor:…]`、"weigh, don't blindly obey"）是仅有的缓解手段，且 note 会原样送达主 transcript（路线图）。
- **无 `syncBacklog` 追赶等待** —— 落后很多的 advisor 不会等待主循环；其 backlog 有界且会被丢弃（永远不会卡住主循环），因此 advisor note 可能在下一次主 turn 开始之后才到达（路线图：context-maintenance batch）。
- **advisor 上下文有界** —— 长会话的完整重放会被截断（`maxDeltaMessages`），因此 compaction 后 advisor 可能丢失早期上下文；advisor 上下文维护在路线图中（下下迭代）。

## 开发

组合包在安装时自行构建：`package.json` 声明了 `"prepare": "node scripts/setup-dsh-links.mjs && pnpm build && bash scripts/autopatch-install.sh"`（开发期链接农场、与 `prepack` 相同的构建、外加安装期宿主 patch 自动应用），因此任何克隆在 **`DSH_HOME` 指向一个含 `source/current` 的 dsh home（或 `DSH_SOURCE_DIR` 直接指向一个 dsh 源码树 —— 与宿主 patch 脚本的解析一致）** 后立即可构建。私有的 `@deepseek-ai/dsh-*` 运行时依赖**只声明为 peerDependencies**；开发期由 `scripts/setup-dsh-links.mjs`（挂在 `prepare` 上、独立命令为 `pnpm dsh:link`、用 `pnpm dsh:link:check` 校验）把该树里的**真实包**链接进 `node_modules/@deepseek-ai/` —— 树声明的每个 `@deepseek-ai/*` 包（声明 `bin` 的工具 CLI 会被跳过：链接它们会让 pnpm 向共享树写入 bin）、无 bin 的内置 `cordis` 框架 shim、以及树自带的 `react`/`react-dom` 副本（node 解析 —— 包括外部化的 CJS 依赖 —— 必须看到同一个 react 身份，即真实 client 包所用的身份；`.npmrc` 设了 `node-linker=hoisted`（dsh profile 约定），避免 `.pnpm` 逐包目录遮蔽这些链接）。农场幂等、会清理陈旧条目，并在树缺失或 peer 无法链接时给出明确指引。`.npmrc` 还设了 `auto-install-peers=false`（dsh profile 约定）：私有 peer 绝不能从 npm registry 获取。

```sh
export DSH_HOME=~/.dsh    # 含 source/current 的 dsh home（或直接设置 DSH_SOURCE_DIR）
pnpm install              # registry deps + 链接农场（经 prepare），无需访问私有 registry
pnpm test                 # vitest (unit + the composed integration loop)
pnpm typecheck            # tsc --noEmit (node) + tsc -p tsconfig.client.json --noEmit + tsc -p tsconfig.spec.json --noEmit
pnpm build                # tsc -p tsconfig.build.json emit to lib/ + node scripts/build-client.mjs (client bundle)
pnpm pack                 # build + produce dsh-advisor-0.0.1.tgz
```

`cordis` 声明为确定性的 devDependency（`^4.0.0-rc.7` —— npm registry 最高就是该版本，因此范围精确钉住 dsh 宿主内置的基线）；安装后链接农场的无 bin cordis shim 仍会把 `node_modules/cordis` 覆盖为 vendored 文件，因为真实包是对着 vendored 构建类型化/运行的，模块身份要求开发期的 `import 'cordis'` 解析到同一份文件。其余公开 devDependencies（`schemastery`、`react` 等）照常从 npm registry 解析。

`prepack` 运行 `pnpm build`；`prepare` 运行链接农场、构建外加宿主 patch 自动应用（`bash scripts/autopatch-install.sh`），因此 `pnpm pack` 会构建两次（每个生命周期一次）——这是为保持 git 安装可构建而接受的取舍。`postinstall` 只运行 autopatch（tarball 安装已带构建产物，完全跳过构建）。

集成测试（`tests/integration.test.ts`）把插件组合进一个带 stub LLM adapter 的真实 cordis 上下文，驱动完整的 turn → delta → advisor call → inject/steer 循环。

## 许可证

MIT
