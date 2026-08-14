# 安装指南

本文介绍如何把 `dsh-advisor` 装入 dsh profile、验证安装与卸载。快速版本见 [README](../README.zh.md#安装)。

## 前置条件

- 可用的 dsh 运行环境（`$DSH_HOME`，默认 `~/.dsh`）与可写的目标 profile（如 `web`）；安装后重启 dsh 会话。
- registry 安装只需 PATH 上有 pnpm（`dsh plugin` 是 pnpm 转发器）。从源码构建（下文 git / 本地目录 / tarball 安装）另需 **node**（≥ 22）与位于 `$DSH_SOURCE_DIR`（缺省 `${DSH_HOME}/source/current`）的 dsh 源码树——开发期链接农场（`prepare` 构建）与开发期类型检查 / 测试都用它。
- **Windows**：从源码安装（git / 本地目录）的 `prepare` 链接农场会创建文件符号链接，请先开启[开发者模式](https://learn.microsoft.com/windows/apps/get-started/enable-your-device-for-development)（目录 junction 无需特权）。Windows 没有 `HOME`，链接农场自动回退 `USERPROFILE` 解析 dsh 源码树。

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

`dsh plugin add` 会把组合包追加到 profile 的 `dsh.profile.bundles`（包声明了 `dsh.bundle`）；组合包插入一行插件配置 —— `id: advisor`，`name: dsh-advisor`（见 `cordis.patch.yml`）。本地 `add .` 走 pnpm 的 `link:` 依赖，pnpm **不会**为 `link:` 依赖运行 prepare/postinstall——请先用 `pnpm install`（或 `pnpm build`）构建好组合包再添加。无需任何宿主补丁：插件完全通过插件配置行运行（见 [web Settings 暴露](#4-web-settings-暴露)）。

## 3. tarball 安装

```sh
pnpm pack
dsh plugin --profile web add dsh-advisor-0.1.0.tgz
```

tarball 附带的是构建产物（`lib/` + `cordis.patch.yml`），因此不会运行 `prepare` 脚本，也无需构建权限。运行时依赖（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-{session,agent,llm,commands,timeout}`）声明为 peerDependencies，由 dsh 安装的扁平 profile module fallback 解析——无需额外安装步骤。

## 4. web Settings 暴露

dsh web Settings 页的**"插件配置"页**为每个注册进 `settings.plugin.item` 卡片 slot 的插件渲染一张卡片。Advisor 卡片（`id advisor`，渲染在三张上游卡片 bash / agent-loop / web-search 之后）通过 dsh 宿主的 apiproxy `describe` 读取 provider 目录（已暴露的 `llm-*` 命名空间），但 advisor 配置只通过**官方 `GatewayService` RPC 通道**读写——它不依赖 apiproxy allowlist（allowlist 仅覆盖模型提供者命名空间 + 产品命名空间：locale / permission / ui-conversation / ui-theme / ui-onboarding / agent-presets）。**上游 dsh 没有注册级 opt-in**（`exposeToWebClients` 不存在于上游 `SettingsRegisterOptions`——已在 pristine 20da39e 快照上核实），因此 `advisor` 命名空间**不在 apiproxy allowlist 上**。插件注册 `AdvisorConfigGateway`（带 `@Remote('get')`/`@Remote('set')` 方法的 `GatewayService`），宿主的 typertGateway 认领 `/api/advisor/get` + `/api/advisor/set`（与 dsh 内建 `goals` 服务同一机制），卡片经 `connection.rpc` 调用它们。进程内写入（`ctx.settings.update`）没有 exposed-namespace 检查，因此在任何提供 GatewayService 通道的 dsh 构建上保存都可用。无需也不施加任何宿主补丁。

## 5. 验证

```sh
dsh --profile web --dump-config   # 显示带 advisor 配置行的 "# == dsh-advisor" 层
dsh --profile web
```

启动后，web Settings 页的"插件配置"页会渲染 Advisor 卡片；它通过 `/api/advisor/get` + `/api/advisor/set` live 读写 `advisor` 命名空间——保存后新会话立即生效。

## 6. 卸载

```sh
dsh plugin --profile web remove dsh-advisor
dsh --profile web --dump-config   # 确认 dsh-advisor 层已消失
```

重启 dsh 会话使卸载生效。
