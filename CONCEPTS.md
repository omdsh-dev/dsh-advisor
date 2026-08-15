# CONCEPTS

本仓库（dsh-advisor）领域词汇。供 `{KNOWLEDGE_DIR}` 与 AGENTS.md 引用，避免重复定义。

## 顾问机制（advisor mechanism）

### advisor fiber / reviewer claim（评审者认领）
宿主会组合多个 dsh-advisor fiber（实测 3 个 active）；若每个 fiber 都挂全局 `session/event` 订阅，就会对每个回合产生 N×review / N×model-call。**第一个**成功 `apply` 的 fiber 通过 `globalThis['__dshAdvisorReviewer__']`（`REVIEWER_KEY`）认领评审者角色，负责接线 observer / runtime / delivery 与 `/advisor` 命令；后续 fiber 只尝试 settings 注册并保持惰性。认领在构造期配置门禁之后才进行（被拒绝的首行不会留下已认领标记），fiber dispose 时释放，允许重新挂载接管。标记骑在 `globalThis` 上，即使模块拷贝分歧也保持唯一。
*Avoid:* 每个 fiber 都挂全局订阅（N×评审 / N×调用）；绕过认领做多实例并行评审

### severity ranks（严重度等级）
每条建议携带的闭集严重度 `nit | concern | blocker`（`AdviceSeverity`），升级序 nit < concern < blocker。nit = 非唤醒的小问题；concern = 值得打断的实质风险；blocker = 保留给「继续明显浪费工作」（违背显式用户指令、原地打转、根本性不健全）。缺失 / 非法 severity 的回复按 nit 处理（最小侵入默认，与 omp「省略即 nit」一致）。
*Avoid:* 自造第四档；把 blocker 当普通提醒使用

### advice delivery（建议投递）
severity → 通道的路由：nit → `agent.inject`（非唤醒，下一个 step 边界消费）；concern/blocker → `agent.steer`（唤醒——空闲 driver 开跑、运行中的 driver 在下一 step 边界消费）。投递消息为 user-role、`source.kind === 'advisor'`（`MessageSourceMap` merge 扩展，见 `src/kinds.ts`）、内容自描述 `[advisor:{severity}] {note}`——主系统提示词不提 advisor，前缀是主模型判断「建议，不要盲从」的唯一提示。投递同步 fire-and-forget，throw 由 runtime 的包含 seam 兜住。
*Avoid:* 用 inject 承载 concern/blocker（破坏唤醒语义）；把建议当「已批准动作」注入

### immuneTurns cooldown（免疫回合冷却）
一次 concern/blocker 被**真实 steer** 后，接下来 `immuneTurns`（默认 3）个 stepped 主回合完成前，不允许再有一条打断性 note 触发 steer；窗口内的打断性 note 降级为 inject。围栏只在真实 steer 投递时武装，观察者的 `onSteppedTurnEnd` / `onRewrite` 钩子驱动计数与 KD-5 重置。
*Avoid:* 把窗口当成「每次注入后都冷却」（只有真实 steer 武装围栏）；跳过回合计数直接恢复

### explicit model gate（显式模型门禁）
`enabled: true` 而 `provider` 或 `model` 缺失 / 为空 → advisor **永不发起模型调用**，解析为 disabled-with-reason（`/advisor status` 展示原因）。硬门禁而非警告；`resolveAdvisorConfig` 是包括 gateway、runtime 在内所有消费者的 SSOT。未知配置键在 schema 层拒绝（严格 schema）。
*Avoid:* enabled 缺 provider/model 时静默改用默认模型；把门禁降级为 warning

### JSON frame（建议帧）
advisor 回复必须恰好是一个 JSON 对象 `{"note": "<text>", "severity": "nit"|"concern"|"blocker"}`（severity 可省略 = nit）。提取：定位回复中第一个平衡 `{…}`（容忍前后散文 / markdown 围栏，跳过字符串字面量内的花括号）后 `JSON.parse`。note 非空字符串校验失败 → drop + log（绝不 crash drain）；解析失败**不重试**（重试预算只留给传输错误）。调用带 token 上限（`ADVISOR_MAX_TOKENS`），单条 note 有长度上限（`ADVISOR_NOTE_MAX_CHARS`，超长以 `…` 截断）。
*Avoid:* 让 advisor 自由文本回复（帧契约失效）；解析失败无限重试

### transcript delta / self-review exclusion（转录增量与自审排除）
DeltaRenderer 用 cursor 在 `session.events` 序列上推进 + 已投递前缀的 fingerprint；检测到前缀重写（fingerprint 失配或 `surfaceOp replace`）→ 重置并全量重放。渲染为 role 标注的 markdown（`**user:**` / `**agent:**`，assistant 文本加 tool intent、tool 结果标 `[tool result]`、reasoning 排除）。`source.kind === 'advisor'` 的消息**永不**进入后续增量——advisor 不会读回自己的注入。`maxDeltaMessages`（默认 60，0 = 无界）约束重放窗口，超限保留最近 N 条并前置 `… <earlier messages omitted>` 标记。
*Avoid:* 把 advisor 自己的注入读回增量（自审污染）；长会话无界全量重放

### emission guard（发射守卫）
T4 提取与 T6 投递之间的守门员：normalize（小写 + NFKC + 非字母数字折叠为单空格）、content-free 短语抑制（`stop`/`done`/`complete`/`lgtm` 等）、one-note-per-update 限流、FIFO 去重（上限 4096，omp parity）带**升级放行**——同文重复在等 / 低 severity 被抑制，真实升级（nit→concern→blocker）放行并更新记忆。`accept` 返回 false 时静默抑制，调用方无法区分接受与抑制，也不抛错。
*Avoid:* 绕过守卫直接投递（噪音 + 重复注入）；把升级误判为重复而抑制

### failure policy（失败策略 / no-stall）
异步 drain + 有界 backlog（默认 32）：transient → 1 次重试后 drop；连续 3 次 drop → flush backlog；quota / rate-limit → pause（状态 `quota_exhausted`）并 requeue，无自动恢复定时器；permanent（`invalid_request_error` / model-not-found）→ halt 该会话 advisor；in-flight 调用在 dispose 时经 signal abort。整次调用有 deadline（`ADVISOR_CALL_TIMEOUT`）。**主循环永不 park**（MVP 无 `syncBacklog` 等待）——失败的 advisor 绝不阻塞主回合。
*Avoid:* 让 advisor 失败阻塞 / 拖慢主循环；无界重试

### reset triggers / seed-on-enable（重置触发与启用播种）
重置（renderer cursor + emission guard + immuneTurns 闩锁）：任何 `compact/*` 事件（`compact/start` | `summary` | `end`）、或带 `surfaceOp.op === 'replace'` 的 `user/message`（KD-5 权威触发；fingerprint 检查兜底）。`/advisor on` 会话中途启用 → `seedTo(currentLength)` 只把 cursor 播到当前转录长度，不全量回放（与 omp 一致）。
*Avoid:* 把 compaction 重写当普通追加继续增量（增量基准失效）

## 插件与宿主集成

### settings gateway（设置命名空间 + 配置网关）
`advisor` settings namespace（`settingsNamespace('advisor')`）：插件行配置是组合**基底**，settings 服务挂载时用户层叠加（schema defaults → 基底 → 用户层），runtime 经 bridge source 读**实时**组合值。宿主侧 `AdvisorConfigGateway`（`TypertRemoteService` 基类 + **显式 `ctx.typert.register(contribution)`**，非 `@Remote` SRC 标记——SRC 发现读模块私有 WeakMap，link 插件与 dlx 宿主物理分离永不共享）声明 `/api/advisor/get` + `/api/advisor/set`；client 经 `connection.rpc.call('/api', '<ns>/<method>', { args })` 读写。apiproxy `exposedNamespaces()` 白名单**不含** advisor 命名空间（上游 dsh 无注册级 opt-in，`exposeToWebClients` 不存在），gateway 是 mount-only 下 web 配置读写的唯一路径；`set` 先过 `Config` schema（未知键拒绝）再经进程内 `ctx.settings.update` 写用户层——进程内写无 exposed-namespace 检查，白名单闸只在 apiproxy wire 层。settings 服务缺省时 gateway `get` 仍工作（bridge source 回落 entry），`set` 明确报错（KD-G5 兜底）。
*Avoid:* 依赖 apiproxy `describe` 读写 advisor 配置（白名单不含 advisor）；把 gateway 当唯一配置源而不回退 bridge

### mount-only bundle（纯挂载 bundle）
交付约束：对 dsh 源码树**零本地修改**。`dsh.bundle.patch` → `cordis.patch.yml` 向 profile 插入一行插件（`id: advisor`）；registry / tarball 安装携带构建产物（`lib/` + `cordis.patch.yml`），无 install / postinstall 脚本、无需构建权限。无 `patches/`、无 autopatch 链路；升级 dsh 无需重打。本地 `dsh plugin add .` 走 pnpm `link:`，pnpm 不跑 prepare——需先 `pnpm install` / `pnpm build` 出 bundle。
*Avoid:* patch 交付 / 本地修改交付（历史方案，已移除）

### registry peers（开发期依赖解析）
私有 `@deepseek-ai/*` 包**只**作 `peerDependencies`（绝不进 `dependencies` / `devDependencies`）：`pnpm-workspace.yaml` 的 `autoInstallPeers: true` + 用户级 `~/.npmrc` registry 认证令牌从 npm registry 解析 `@deepseek-ai/*@0.1.0-rc.6`（pnpm 11 起项目级 `.npmrc` 不再展开 `${NPM_TOKEN}`；无本地 link farm，`nodeLinker: hoisted`）。`tests/peer-deps.test.ts` 数据驱动钉住该契约（peer-only、rc.6 钉版、autoInstallPeers、scoped schemastery、prepare 仅 build）。运行时值 import 保持 external，由宿主 in-box / 扁平 profile 模块 fallback 解析。
*Avoid:* peer-stubs / tsconfig paths / 本地 link farm（历史方案，已移除）

### /advisor commands
`/advisor on | off | status | usage`（T7）：session-scoped 临时 override（不写持久配置），runtime gate 读取；`status` 展示运行态（running / paused / quota_exhausted / halted / disabled）、门禁 disabled 原因、resolved provider/model、pending 数与最近一次接受 note 的活动时间。命令经条件 `ctx.inject(['commands'], ...)` 子 fiber 注册，宿主无 commands 服务时静默不注册。
*Avoid:* 把 `/advisor` 当持久配置写入入口（override 是临时的、会话级）

## 已决歧义

- `nit` / `concern` / `blocker` 三档 severity 是**闭集**：缺失 / 非法值按 `nit`（最小侵入默认），不要在代码里新增第四档。
- `inject` 与 `steer`：前者非唤醒、后者唤醒；免疫窗口内打断性 note **降级为 inject**，不是丢弃。
- `immuneTurns` 只在**真实 steer** 后武装：仅注入（inject）不启动冷却。
- advisor 命名空间在 apiproxy 白名单之外：web 配置读写只走 gateway RPC 通道（`/api/advisor/get|set`）；进程内 `ctx.settings.update` 无白名单检查，`exposedNamespaces()` 只管 apiproxy wire 路径。
- 配置组合：schema defaults → 插件行基底 → settings 用户层；`resolveAdvisorConfig` 是硬门禁的 SSOT，所有读取（runtime / gateway / status）都过它。
- `source.kind === 'advisor'` 消息的双重角色：投递时标记（会话流可见）与自审排除（不进后续 delta）——两者都 key 在同一 kind 上。
