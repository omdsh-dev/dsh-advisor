# 安装指南

本文介绍如何把 `dsh-advisor` 装入 dsh profile、验证安装与卸载。快速版本见 [README](../README.zh.md#安装)。

## 前置条件

- 可用的 dsh 运行环境（`$DSH_HOME`，默认 `~/.dsh`），且其源码树在 `$DSH_SOURCE_DIR`（缺省 `${DSH_HOME}/source/current`）——开发期链接农场（`prepare` 构建）与开发期类型检查 / 测试都需要它。
- 构建需要 **node**（≥ 22）与 **pnpm**（≥ 10）——组合包的 `prepare` 脚本自构建（`tsc`，无 bun）。
- 目标 profile（如 `web`）可读写；安装后重启 dsh 会话。

## 1. 一条命令的 git 安装

```sh
dsh plugin --profile web add github:dsh-external/dsh-advisor   # <name> = 你的 profile 名；用 #<sha> 钉住 commit
# 完整 URL 形式等价：
# dsh plugin --profile web add https://github.com/dsh-external/dsh-advisor.git
```

git 安装拉取的是**源码而非构建产物**，因此组合包会在安装时自行构建。注意点：

- **prepare 自建**：pnpm 在安装 git 依赖时会执行包的 `prepare` 脚本（`node scripts/setup-dsh-links.mjs && pnpm build`）——开发期链接农场与构建。私有 `@deepseek-ai/dsh-*` 包（以及内置 `cordis`/`react`/`react-dom` 身份）的开发期解析来自**本地 dsh 源码树**，经 `$DSH_SOURCE_DIR` / `$DSH_HOME` —— 与宿主运行的同一棵树，因此无需访问私有 registry。
- **pnpm ≥ 10 构建放行（每次首次 `add` 必遇）**：pnpm ≥ 10 默认不执行 git 依赖的 `prepare` / `postinstall`。第一次 `add` 会失败并打印 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，同时给出确切的包 key（`dsh-advisor`）。把它加进此 profile 的 `pnpm-workspace.yaml`：

  ```yaml
  # $DSH_HOME/profiles/web/pnpm-workspace.yaml
  onlyBuiltDependencies:
    - dsh-advisor
  # pnpm ≥ 10.26 也接受 allowBuilds 形式：
  # allowBuilds:
  #   dsh-advisor: true
  ```

  然后重跑 `add`；也可交互式 `dsh plugin --profile web approve-builds` 选择放行。请把这次放行当作它本来的样子：允许该包的代码在安装期、在 agent 运行所在的任何沙箱之外，于你的机器上执行。只放行你信任其源码的包，并钉住 commit（`#<sha>`），防止后续 push 悄悄改变实际运行的代码。
- **传输协议**：`github:` 简写由 pnpm 解析（通常优先 HTTPS，探测失败时退回 SSH）；显式 https URL 形式则固定 HTTPS。两种形式等价，`#<ref>` 钉版均支持。

## 2. 本地目录安装（开发 / 验证）

```sh
pnpm install                  # 构建组合包（prepare 自建）
dsh plugin --profile web add .   # <name> = 你的 profile 名
```

`dsh plugin add` 会把组合包追加到 profile 的 `dsh.profile.bundles`（包声明了 `dsh.bundle`）；组合包插入一行插件配置 —— `id: advisor`，`name: dsh-advisor`（见 `cordis.patch.yml`）。本地 `add .` 走 pnpm 的 `link:` 依赖，pnpm **不会**为 `link:` 依赖运行 prepare/postinstall——请先用 `pnpm install`（或 `pnpm build`）构建好组合包再添加。无需任何宿主补丁：`advisor` 命名空间经上游 `exposeToWebClients` 注册 opt-in 加入 web 配置边界（见 [web Settings 暴露](#4-web-settings-暴露)）。

## 3. tarball 安装

```sh
pnpm pack
dsh plugin --profile web add dsh-advisor-0.0.1.tgz
```

tarball 附带的是构建产物（`lib/` + `cordis.patch.yml`），因此不会运行 `prepare` 脚本，也无需构建权限。运行时依赖（`cordis`、`schemastery` 与 `@deepseek-ai/dsh-{session,agent,llm,commands,timeout}`）声明为 peerDependencies，由 dsh 安装的扁平 profile module fallback 解析——无需额外安装步骤。

## 4. web Settings 暴露

dsh web Settings 页通过 dsh 宿主的 apiproxy 读写 settings 命名空间，而 apiproxy 历史上只向配置客户端暴露一个 allowlist 命名空间集合。`advisor` 命名空间通过**上游注册 opt-in** 加入该边界——settings 注册上的 `exposeToWebClients: true`（见 `src/settings.ts`）。在 dsh ≥ snapshot 20da39e 上，宿主把这些命名空间并入暴露集合，因此 Advisor section 可以 live 读写往返——**无需任何宿主补丁**。

在不具备该 opt-in 机制的旧版 dsh 构建上，section 会检测到未暴露的命名空间，显示明确的提示而非可写表单；此时请通过 profile 的 `cordis.patch.yml` 中的插件配置行（`- id: advisor` + `config:` 映射）配置顾问。

## 5. 验证

```sh
dsh --profile web --dump-config   # 显示带 advisor 配置行的 "# == dsh-advisor" 层
dsh --profile web
```

启动后，web Settings 页会渲染 Advisor section；在暴露该命名空间的 dsh 构建（≥ snapshot 20da39e）上，section 即可 live 读写 `advisor` settings namespace——保存后新会话立即生效。

## 6. 卸载

```sh
dsh plugin --profile web remove dsh-advisor
dsh --profile web --dump-config   # 确认 dsh-advisor 层已消失
```

重启 dsh 会话使卸载生效。
