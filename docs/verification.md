# 验证记录（测试矩阵与真实环境验证）

本文记录 `dsh-advisor` 已完成的验证证据（**本仓库 workspace 内可完成的**：单测 / 集成 / 客户端组件 / 网关 / 指令 / 发布工具链测试 + typecheck + build + CI 契约），以及**必须在用户真实 dsh 环境执行**的验证步骤与预期。

> **范围声明**：本仓库的验证环境受沙箱约束 —— **不能对运行中的 dsh 安装（真实 `$DSH_HOME`）做任何写入**，不能操作 web Settings GUI、不能发起真实模型调用、不能跨进程观察真实会话。因此下方「已验证」只覆盖 workspace 内可完成的证据（测试套件、typecheck、build、CI 工作流契约）；「待用户运行」如实列出真实环境步骤与预期，不夸大已验证范围。验证数据采集于分支 `docs/align-docs-triplet`（base `origin/main` @ `c07827e`），vitest 3.2.7。

## 已验证（workspace 内证据）

### 1. 测试矩阵（16 个文件 / 319 个用例，全部通过）

`pnpm run test`（vitest run）输出：**Test Files 16 passed (16) / Tests 319 passed (319)**。逐文件用例数从该次运行的 verbose 输出统计（各文件 `describe` 块覆盖契约如下）：

| 测试文件 | 用例数 | 覆盖契约 |
|---|---|---|
| `advisor-card.spec.tsx` | 30 | Advisor 卡片：`settings.plugin.item` 注册（不污染 `settings.section`）；上游 PluginCard chrome（默认折叠 / aria-expanded / unsaved pill / Save-Discard 启停）；网关通道读写（`advisor/get` 读配置、`advisor/set` 保存、wire 失败提示、重试）；enabled 开关 + 必填 provider/model 门禁文案；只列已配置 provider；存储值不再可用时的警告；read-only provider 提示；网关不可达时不提供 Save；zh/en 文案 |
| `advisor-runtime.test.ts` | 27 | 每 delta 一次 `llm.stream` 调用与选项；`extractAdviceNote` JSON-frame 解析（KD-2，容忍 prose/fence、severity 缺省 nit）；failure policy（KD-5：transient 1 次重试→drop、连续 3 次 drop 冲刷 backlog、quota→暂停保留批次、permanent→halt）；60s 调用 deadline 超时；dispose 中止在途调用；对真实 `LlmRuntime` + 注册 adapter 的选项下发；`reasoningEffort` 能力门控（无推理元数据的 adapter 不发送） |
| `advisor-store.test.ts` | 51 | store：providers join（KD-S2 configured 判定）；model options（profile 优先、catalog 回退）；apply gate（KD-S4 enabled 必填）；apply patch + seed（只写变更键、清空字段存显式 `''`）；invalidations（`refreshIfLoaded`）；gateway availability（KD-G5 `advisorPresent`）；post-apply reload 失败保留反馈（qc3 N-1）；discard 回滚草稿；dirty 派生（KD-U2）；read-only apply guard（qc2 W-1）；卡片场景（load → edit → apply → discard 往返） |
| `client-build.test.ts` | 7 | 客户端 bundle 契约（`scripts/build-client.mjs`）：构建 `lib/client.js` + `lib/client.d.ts`；closure-factory load handoff；classic-script 安全（无 `import.meta` / 顶层 ESM）；`CLIENT_EXTERNALS` 纯度边界；automatic JSX runtime；CSS Modules 内联；`dsh.client` 声明 |
| `commands.test.ts` | 22 | `parseAdvisorCommand`（空 → toggle，on/off/status 精确匹配，其它 → usage）；`AdvisorSessionOverrides`（`override ?? config.enabled`）；`registerAdvisorCommands` 注册形态（name/description/hint/handler + disposer）；handler toggle/on/off 翻转 runtime gate（含 already-on、S4 gate caveat 文案）；`advisorStatusText` 状态面；未知子命令 → usage 且不触碰 controller |
| `config.test.ts` | 19 | Loader schema 默认值（`Config({})` = 全默认）；显式模型门禁 S4（缺省禁用无 reason、enabled-without-pair → disabled-with-reason、全空白字符串视为空）；未知键严格拒绝（禁用与启用两种状态） |
| `delivery.test.ts` | 17 | 严重度 → 通道路由（nit→inject 非唤醒、concern/blocker→steer 唤醒）；advisor 消息构造（user-role + advisor source kind + 自描述内容 + 有界 summary）；`immuneTurns` 冷却（窗口内降级 inject、倒计时耗尽再 steer、仅在真实 steer 后武装、`reset`/`unregisterAgent` 清栅栏）；缺 agent → drop + 日志（KD-4）；route 内 throw 被 containment（T4 F1）；`SessionTranscriptObserver` delivery hooks（每个 stepped 可评审 turn/end 触发一次、跳过 no-step 与 aborted） |
| `emission-guard.test.ts` | 20 | 归一化（等价拼写同一身份）；content-free 短语抑制（stop/done/complete/no issue continue/lgtm/nothing to add）；跨 update 去重；每次 update 至多一条 note；升级放行（nit→concern→blocker）；FIFO 有界历史（默认 4096）；`reset` 清状态；`createEmissionGuard` 工厂；runtime 接线（只对 accepted note 调 delivery 回调、被抑制的 note 继续 drain、throwing guard 被 containment） |
| `gateway.test.ts` | 22 | 无 settings service（entry fallback，`get` 可用，gateway 是已注册服务）；有 settings service（`set` 写 user layer、合成值 live 变化、`set` 返回新合成值、merge 语义、空/null patch 为 no-op）；`set` 校验（未知键在写入前被拒）；硬门禁回归（`resolveAdvisorConfig` 保持 SSOT）；typertGateway 端点认领 + payload 契约（`{ args }` 恰好一个 plain-object 字段、`/api` interceptor 分发、直接经 `ctx.typertGateway` 调用、bad user layer 的 get containment）；组合插件（apply wiring 后 dispatch 对 live 合成配置生效、多 fiber 去重） |
| `integration.test.ts` | 19 | 完整 advisor 循环（user → primary → turn/end → delta → advisor call → guard → steer，stub adapter，spec §7）；agentic reply-complete 门驱动循环（nit→inject / concern→steer、immuneTurns 栅栏衰减，KD-N4-5）；自送达不重触发评审门（C-1）；`/advisor` 指令条件激活（无 registry 全周期、组合后注册、on 启动 live runtime + KD-5 seed）；compact / surface-replace 重置组合 observer + guard（KD-5）；`/advisor` 恢复 + S4 gate 报告（quota 暂停手动恢复、halted 全新重建、config-enabled-but-gate-blocked 的 status/on 文案）；root-llm 从隔离子作用域解析（qc1 W-3）；单评审者守卫（n4 QC F-6：第二个 apply 不接第二个 reviewer、dispose 释放声明、被拒 config 不占声明） |
| `peer-deps.test.ts` | 6 | registry peer 契约：每个 `@deepseek-ai/*` 都是 peerDependency 且不出现在其它 dependency 字段、`dsh-*` 钉在 `^0.1.0-rc.7`、无 link farm（从 npm 解析） |
| `prepare-release.test.ts` | 20 | 发布准备脚本（`scripts/prepare-release.mjs`）：auto patch bump（正式版 / prerelease 线自增）、显式版本（含 prerelease）、非法版本拒绝、空版本范围拒绝、已有 tag 拒绝、`CHANGELOG.md` 小节写入（header 存在性 / 无尾换行 / 0 字节 / 纯空白 / 重复运行 no-op / 祖先 tag 范围） |
| `scaffold.test.ts` | 2 | bundle 清单契约（T1）：非 private 可打包、声明 `dsh.bundle` patch 与 advisor 行（`cordis.patch.yml`） |
| `settings-live.test.ts` | 8 | settings live 重应用：latched config + runtime rebuild（改 provider/model/systemPrompt 重建、immuneTurns 原地更新）；observer `maxDeltaMessages` 应用到已 live 的 per-session renderer；硬门禁穿透 live source（禁用仍阻止 runtime 创建、无 pair 再启用仍被门禁）；条件 runtime rebuild（qc3 W-1 / qc1 W-2：只改 immuneTurns 不重建、backlog 与 emission guard 存活）；未知键 user layer containment（qc2 W-1：不 wedge、无模型调用、status 显示 disabled-with-reason）；attach ordering + detach fallback（qc1 S-1 / qc3 S-2） |
| `settings.test.ts` | 13 | 无 settings service（entry fallback，行为与今日一致）；命名空间注册（`describe` 暴露 ns / `Config` schema / base / live 值；多 fiber 去重只注册一次）；user-layer 写入（schema 默认 → base → user 合成、source thunk live 反映）；硬门禁回归（settings 写入的 enabled-without-pair 仍解析 disabled-with-reason）；未知键严格拒绝不变 |
| `transcript.test.ts` | 36 | `DeltaRenderer`：append 游标推进；前缀重写检测（指纹不匹配 → 重置全量重放）；compact 事件重放（KD-5）；自审排除（advisor-source 消息不进 delta）；有界窗口（`maxDeltaMessages` 截断标记）；markdown 渲染（tool calls / tool results）；`seedTo`（KD-5）；`SessionTranscriptObserver`：agentic reply-complete 门（每次 human-input 到达恰一条 delta、trigger 排除）；inbox 拼接 payload 判别（C-1）；wiring（turn 检测 + per-session 分发） |
| **合计** | **319** | 16 个文件 / 319 个用例全部通过（`pnpm run test`，vitest 3.2.7） |

### 2. typecheck / build

- `pnpm run typecheck`（`tsc --noEmit` + `tsc -p tsconfig.client.json --noEmit` + `tsc -p tsconfig.spec.json --noEmit`）—— **通过**（本文档改动不含代码变更，typecheck 为回归确认）；
- `pnpm run build`（`tsc -p tsconfig.build.json` + `scripts/build-client.mjs` → `lib/client.js` + `lib/client.d.ts`）—— **通过**。

### 3. CI 契约（`.github/workflows/ci.yml`）

CI 在 PR 与 `main` push 上运行：`pnpm install --frozen-lockfile` → `pnpm run typecheck` → `pnpm run build` → `pnpm run test` → `npm pack --dry-run` 内容断言（`lib/index.js` 与 `cordis.patch.yml` 必须在 tarball 列表内）。发布链（Release prep / Release 工作流）见 [docs/release.md](release.md)。

## 真实环境待验证步骤（由用户在真实 dsh 环境执行）

> 以下步骤必须在**真实 dsh 环境**执行（可写 `$DSH_HOME` 安装、可操作的 web GUI、能发起真实模型调用）；路径一律以 `$DSH_HOME` 表达，不用本地绝对路径。步骤与预期来自 [docs/install.zh.md](install.zh.md)（§1–§6）与 `docs/configuration.md` 的行为要点，逐项对照。

### 1. 安装与 profile 验证

```sh
cd <plugin-repo>
pnpm install          # 构建组合包（prepare 自建）
dsh plugin --profile web add .   # <name> = 你的 profile 名
dsh --profile web --dump-config   # 应出现 "# == dsh-advisor" 层与 advisor 行
dsh --profile web                  # 重启 dsh 会话使宿主半与客户端半加载
```

**预期**：`dsh.profile.bundles` 追加本插件（`add` 默认追加到末尾）；`--dump-config` 输出含 `# == dsh-advisor` 层与 `id: advisor` 行（`name: dsh-advisor`）。

### 2. web 插件配置卡片验证

1. 打开 web Settings → **"插件配置"**页，确认 **Advisor 卡片**出现（与 bash / agent-loop / web-search 卡片同列，位于其后）。
2. **首次打开（无 `advisor` 配置）**：卡片渲染头部 + enabled 开关（默认 **OFF**）+ 表单（enabled 关闭时表单体隐藏、显示提示）。
3. 打开 `enabled` 开关 → 出现 provider / model 选择框（**只列出已配置的 provider** 及其模型）、`systemPrompt` 文本框（placeholder 提示空 = 默认）与 `immuneTurns` / `maxDeltaMessages` 数字输入。
4. 选择 provider/model 并保存 → **预期**：保存成功（经 `/api/advisor/set`）；`$DSH_HOME/settings.yaml`（或该 profile 的 settings 路径）写入 `advisor:` 段（含 `enabled: true` 与所选 provider/model）；重进页面显示已保存值。
5. 降级路径抽查：网关不可达时卡片显示 config-channel 提示且不提供 Save；settings provider 只读时显示只读提示并禁用写入；`advisor.get` 失败时头部显示可重试的加载失败提示。
6. **S4 门禁**：`enabled: true` 而 provider/model 为空时保存被阻止（卡片侧文案）；手工在 YAML 写 enabled-without-pair 后重进页面，卡片显示门禁后的值，且宿主侧绝不发起模型调用（日志无 advisor 模型调用）。

### 3. `/advisor` 指令验证（真实会话内）

1. 在任意会话输入 `/advisor status` → **预期**：输出 `Advisor: enabled/disabled`、门禁原因（如适用）、`Model: <provider>/<model>`、`Runtime: <running|paused|quota_exhausted|halted|disabled> (N pending)`、`Last activity: <ISO|never>`。
2. `/advisor on` / `/advisor off` / 裸 `/advisor`（toggle）→ **预期**：翻转会话级状态、回复带 S4 caveat（当门禁阻挡）；`settings.yaml` **不变**（指令是临时 override，不写持久化配置）。
3. 未知子命令（如 `/advisor foo`）→ usage 文本。
4. 恢复路径：制造 quota/rate-limit 暂停（`quota_exhausted`）后 `/advisor on` 原地恢复；制造永久性模型错误（`halted`）后 `/advisor on` 为该会话全新重建 —— 两者都无需重启宿主。

### 4. 运行时行为验证（真实模型调用）

1. 配置 enabled + provider/model，发起一次会话并完成若干 stepped 主 turn。
2. **预期**：每个可评审 turn/end 之后日志出现一次 advisor 模型调用（`ctx.llm.stream`，`maxTokens 768`）；抽取出的 note 以 `[advisor:{severity}] <note>` 出现在会话流（nit → 非唤醒注入；concern/blocker → steer 唤醒）；advisor 自己的消息不进入后续 advisor delta（自审排除）。
3. **immuneTurns 冷却**：连续产生 concern/blocker 时，前一条实际 steer 后接下来的 `immuneTurns` 个主 turn 内，打断性 note 降级为 inject。
4. **failure policy 抽查**：配置不可用的模型（如不存在/无效凭据）→ 日志出现 transient drop（或 permanent halt）；halted 后该会话 advisor 停止，`/advisor on` 重建。

### 5. 卸载验证

```sh
dsh plugin --profile web remove dsh-advisor
dsh --profile web --dump-config   # 确认 dsh-advisor 层已消失
```

## 已知限制（沙箱无法覆盖的真实运行时表面）

| 表面 | 为何未覆盖 | 验证归属 |
|---|---|---|
| web Settings GUI 交互（卡片出现、编辑保存、降级态） | 沙箱无法操作真实 web 会话 | 用户 §2（客户端 half 逻辑已由 `advisor-card.spec.tsx` 30 例 + `advisor-store.test.ts` 51 例覆盖） |
| 真实模型调用与 failure 注入（quota / permanent / 超时） | 沙箱没有真实模型凭据与运行中会话 | 用户 §4（决策逻辑已由 `advisor-runtime.test.ts` / `integration.test.ts` 覆盖） |
| 跨进程观察（日志、会话流中的 `[advisor:…]` 注入、真实 session/event 流） | 沙箱无法运行真实 dsh 会话 | 用户 §3/§4 |
| `/advisor` 在真实会话的输入/输出 | 沙箱无法运行真实 dsh 会话与 command registry | 用户 §3（指令逻辑已由 `commands.test.ts` 22 例 + `integration.test.ts` 的 T7 用例覆盖） |
| 写入真实 `$DSH_HOME` / `settings.yaml` | 沙箱禁止对运行中 dsh 安装写入 | 用户 §1/§2/§5（settings/gateway 写入逻辑已由 `settings.test.ts` / `gateway.test.ts` / `settings-live.test.ts` 覆盖） |

任何与上述预期不符的步骤 → 记录为 QA finding（严重度 + 复现步骤），如实上报，不写回「已验证」。
