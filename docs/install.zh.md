# 安装指南

本文介绍如何把 `dsh-advisor` 装入 dsh profile、验证安装与卸载。快速版本见 [README](../README.zh.md#安装)。

## 前置条件

- 可用的 dsh 运行环境（`$DSH_HOME`，默认 `~/.dsh`）与可写的目标 profile（如 `web`）；安装后重启 dsh 会话。
- registry 安装只需 PATH 上有 pnpm（`dsh plugin` 是 pnpm 转发器）。从源码构建（下文 git / 本地目录 / tarball 安装）另需 **node**（≥ 22）与私有 `@deepseek-ai/*` peers 的 registry 认证——`prepare` 只运行 `pnpm build`（依赖解析不需要 `DSH_HOME` 源码树前置条件；peers 经 `autoInstallPeers` + `~/.npmrc` 认证令牌从 npm registry 解析）。

## 1. 一条命令的 registry 安装

```sh
dsh plugin --profile web add dsh-advisor   # <name> = 你的 profile 名
# 需要可复现安装时钉住精确版本：
# dsh plugin --profile web add dsh-advisor@0.1.0
```

registry 安装拉取的是已发布的 tarball，其中自带构建产物（`lib/` + `cordis.patch.yml`）且没有 `install` / `postinstall` 脚本——不会运行 `prepare` 构建，也无需构建权限。运行时依赖（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-*` peers）声明为 peerDependencies，由 dsh 安装的扁平 profile module fallback 解析——无需额外安装步骤。

- **版本钉住**：追加 `@<version>` 即可（如 `dsh-advisor@0.1.0`）。registry 包没有 commit 钉住；要测试未发布改动，用下面的[本地目录安装](#2-本地目录安装开发--验证)。

## 2. 本地目录安装（开发 / 验证）

```sh
pnpm install                  # 构建组合包（prepare 自建）
dsh plugin --profile web add .   # <name> = 你的 profile 名
```

`dsh plugin add` 会把组合包追加到 profile 的 `dsh.profile.bundles`（包声明了 `dsh.bundle`）；组合包插入一行插件配置 —— `id: advisor`，`name: dsh-advisor`（见 `cordis.patch.yml`）。本地 `add .` 走 pnpm 的 `link:` 依赖，pnpm **不会**为 `link:` 依赖运行 prepare/postinstall——请先用 `pnpm install`（或 `pnpm build`）构建好组合包再添加。无需任何宿主补丁：插件完全通过插件配置行运行（见 [web Settings 暴露](#5-web-settings-暴露)）。

## 3. tarball 安装

```sh
pnpm pack
dsh plugin --profile web add dsh-advisor-0.1.0.tgz
```

tarball 附带的是构建产物（`lib/` + `cordis.patch.yml`），因此不会运行 `prepare` 脚本，也无需构建权限。运行时依赖（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-{session,agent,llm,commands,timeout}`）声明为 peerDependencies，由 dsh 安装的扁平 profile module fallback 解析——无需额外安装步骤。

## 4. dsh-tui profile 安装

advisor 也可以用与 web profile 相同的命令装入终端 TUI profile（`dsh --profile dsh-tui`）：

```sh
dsh plugin --profile dsh-tui add dsh-advisor   # <name> = 你的 profile 名
# 需要可复现安装时钉住精确版本：
# dsh plugin --profile dsh-tui add dsh-advisor@0.1.0
# 本地目录变体（在已构建的 checkout 中）：
dsh plugin --profile dsh-tui add .
```

组合包把同样的 `- insert: id: advisor` 行插入 dsh-tui profile 的补丁层（`~/.dsh/profiles/dsh-tui/cordis.patch.yml`）。`advisor` settings namespace 经全局 `$DSH_HOME/settings.yaml` 的 `advisor:` 段跨 profile 共享（web Settings 卡片也写入该文件）。dsh-tui ≥ v0.8.0 时，TUI `/settings` 屏幕同样可编辑这五个键（`enabled` / `provider` / `model` / `immuneTurns` / `maxDeltaMessages`）——在 Advisor 分节中暂存编辑，保存时经 revision 栅栏保护的 `settings.mutate` 写入同一个命名空间 user layer，live 重应用、无需重启。该分节随 v0.8.0+ 组合包的 `dsh-tui-settings-sections` 行提供；旧版 dsh-tui 干净地 no-op，仍以补丁层 / settings.yaml 为编辑路径。`systemPrompt` 不是 TUI 字段（单行输入）——请经 web 卡片或 `$DSH_HOME/settings.yaml` 编辑。`/advisor config` 是回读手段（只读，seam 挂载时编辑提示指向 `/settings` 屏幕），`/advisor` / `on|off|status|config` 则出现在 TUI 的 `/` 菜单中并带子命令补全（要求 `dsh-tui-command-trees` 行，随附的 dsh-tui 组合包自带）。

验证：

```sh
dsh --profile dsh-tui --dump-config   # 显示带 advisor 配置行的 "# == dsh-advisor" 层
dsh --profile dsh-tui
```

卸载：

```sh
dsh plugin --profile dsh-tui remove dsh-advisor
dsh --profile dsh-tui --dump-config   # 确认 dsh-advisor 层已消失
```

## 5. web Settings 暴露

dsh web Settings 页的**"插件配置"页**为每个注册进 `settings.plugin.item` 卡片 slot 的插件渲染一张卡片。Advisor 卡片（`id advisor`，渲染在三张上游卡片 bash / agent-loop / web-search 之后）通过 dsh 宿主的 apiproxy `describe` 读取 provider 目录（已暴露的 `llm-*` 命名空间），但 advisor 配置只通过**官方 `GatewayService` RPC 通道**读写——它不依赖 apiproxy allowlist（allowlist 仅覆盖模型提供者命名空间 + 产品命名空间：locale / permission / ui-conversation / ui-theme / ui-onboarding / agent-presets）。**上游 dsh 没有注册级 opt-in**（`exposeToWebClients` 不存在于上游 `SettingsRegisterOptions`——已在 pristine 20da39e 快照上核实），因此 `advisor` 命名空间**不在 apiproxy allowlist 上**。插件注册 `AdvisorConfigGateway`（带 `@Remote('get')`/`@Remote('set')` 方法的 `GatewayService`），宿主的 typertGateway 认领 `/api/advisor/get` + `/api/advisor/set`（与 dsh 内建 `goals` 服务同一机制），卡片经 `connection.rpc` 调用它们。进程内写入（`ctx.settings.update`）没有 exposed-namespace 检查，因此在任何提供 GatewayService 通道的 dsh 构建上保存都可用。无需也不施加任何宿主补丁。

## 6. 验证

```sh
dsh --profile web --dump-config   # 显示带 advisor 配置行的 "# == dsh-advisor" 层
dsh --profile web
```

启动后，web Settings 页的"插件配置"页会渲染 Advisor 卡片；它通过 `/api/advisor/get` + `/api/advisor/set` live 读写 `advisor` 命名空间——保存后新会话立即生效。

## 7. 卸载

```sh
dsh plugin --profile web remove dsh-advisor
dsh --profile web --dump-config   # 确认 dsh-advisor 层已消失
```

重启 dsh 会话使卸载生效。
