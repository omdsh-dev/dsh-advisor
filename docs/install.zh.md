# 安装指南

本文介绍如何把 `dsh-advisor` 装入 dsh profile、验证安装与卸载。快速版本见 [README](../README.zh.md#安装)。

## 前置条件

- 可用的 dsh 运行环境（`$DSH_HOME`，默认 `~/.dsh`），且其源码树在 `$DSH_SOURCE_DIR`（缺省 `${DSH_HOME}/source/current`）——宿主 patch 脚本与开发期类型检查 / 测试都需要它。
- 构建需要 **node**（≥ 22）与 **pnpm**（≥ 10）——组合包的 `prepare` 脚本自构建（`tsc`，无 bun）。
- 目标 profile（如 `web`）可读写；安装后重启 dsh 会话。

## 1. 一条命令的 git 安装

```sh
dsh plugin --profile web add github:dsh-external/dsh-advisor   # <name> = 你的 profile 名；用 #<sha> 钉住 commit
# 完整 URL 形式等价：
# dsh plugin --profile web add https://github.com/dsh-external/dsh-advisor.git
```

git 安装拉取的是**源码而非构建产物**，因此组合包会在安装时自行构建。注意点：

- **prepare 自建**：pnpm 在安装 git 依赖时会执行包的 `prepare` 脚本（`node scripts/setup-dsh-links.mjs && pnpm build && bash scripts/autopatch-install.sh`）——开发期链接农场、构建、以及安装期宿主 patch 自动应用。私有 `@deepseek-ai/dsh-*` 包（以及内置 `cordis`/`react`/`react-dom` 身份）的开发期解析来自**本地 dsh 源码树**，经 `$DSH_SOURCE_DIR` / `$DSH_HOME` —— 与宿主运行的同一棵树，因此不存在 `peer-stubs/` 副本，也无需访问私有 registry。
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
- **自动 patch**：git 安装会从 `prepare` 与 `postinstall` 两处运行 `scripts/autopatch-install.sh`——它会幂等地把宿主暴露 patch 应用到本地 dsh 源码树，失败仅 warn、绝不中断安装。可用 `DSH_ADVISOR_AUTOPATCH=0` 完全禁用（上面的 `onlyBuiltDependencies` 条目同时门禁两个生命周期脚本）。

## 2. 本地目录安装（开发 / 验证）

```sh
pnpm install                  # 构建组合包（prepare 自建）
dsh plugin --profile web add .   # <name> = 你的 profile 名
```

`dsh plugin add` 会把组合包追加到 profile 的 `dsh.profile.bundles`（包声明了 `dsh.bundle`）；组合包插入一行插件配置 —— `id: advisor`，`name: dsh-advisor`（见 `cordis.patch.yml`）。本地 `add .` 走 pnpm 的 `link:` 依赖，pnpm **不会**为 `link:` 依赖运行 prepare/postinstall——因此此路径不触发 autopatch。若宿主尚未暴露 `advisor` 命名空间，手动执行一次宿主 patch：

```sh
bash scripts/autopatch-install.sh    # 幂等：已应用/已原生支持则跳过；失败仅 warn
# 或显式手动应用：scripts/apply-dsh-patch.sh && scripts/verify-dsh-patch.sh
```

## 3. tarball 安装

```sh
pnpm pack
dsh plugin --profile web add dsh-advisor-0.0.1.tgz
```

tarball 附带的是构建产物（`lib/` + `cordis.patch.yml` + `patches/` 与 `scripts/` 宿主 patch 机制），因此不会运行 `prepare` 脚本，也无需构建权限。运行时依赖（`cordis`、`schemastery` 与 `@deepseek-ai/dsh-{session,agent,llm,commands,timeout}`）声明为 peerDependencies，由 dsh 安装的扁平 profile module fallback 解析——无需额外安装步骤。tarball 安装不会运行 autopatch：当宿主尚未暴露 `advisor` 时，请按下文手动应用宿主 patch。

## 4. 宿主 patch（web Settings 页）

dsh web Settings 页通过 dsh 宿主的 apiproxy 读写 settings 命名空间，而 apiproxy 只向配置客户端暴露 model-provider 命名空间以及 `permission` / `ui-onboarding`。`advisor` 命名空间在该边界之外：没有 patch 时，页面无法完成 Advisor section 的读写往返——store 检测到未暴露的命名空间后，会显示明确的提示而非可写表单（已交付的插件侧缓解）。

组合包随附这一宿主侧缺口（C-1）的**修复机制**：一个把 `advisor` 加入宿主 exposure allowlist 的最小 git patch（`packages/host/apiproxy/src/api-proxy.ts` 的 `PRODUCT_SETTINGS_NAMESPACES`），外加 apply / revert / verify 脚本与安装期 autopatch——详见 [`patches/README.md`](../patches/README.md)。当宿主尚未暴露 `advisor` 时需要它（钉住的基线 dsh-private b8343cb 未暴露）；每次 dsh 升级后需重跑（升级会重置宿主改动）。

```sh
export DSH_SOURCE_DIR="$DSH_HOME/source/current"   # 或仅设置 DSH_HOME
scripts/apply-dsh-patch.sh --check   # 只读可应用性检查
scripts/apply-dsh-patch.sh           # 应用并重建宿主包
scripts/verify-dsh-patch.sh          # 断言源码与构建产物标记
scripts/revert-dsh-patch.sh          # 回滚（例如 dsh 升级前）
```

git 安装会在安装期自动运行 autopatch（`postinstall` 与 `prepare`）；用 `DSH_ADVISOR_AUTOPATCH=0` 完全跳过。**安全说明：** apply/revert 脚本（以及 autopatch）会在应用/安装时运行目标树的构建代码（`tsc` / `tsdown`），位于 agent 运行所在沙箱之外——只把它们指向你信任的 dsh 源码树，并把上面的 `onlyBuiltDependencies` 放行当作它本来的样子：允许该包在安装时执行其代码。

## 5. 验证

```sh
dsh --profile web --dump-config   # 显示带 advisor 配置行的 "# == dsh-advisor" 层
dsh --profile web
```

启动后，web Settings 页会渲染 Advisor section；一旦宿主暴露该命名空间（patch 已应用），section 即可 live 读写 `advisor` settings namespace——保存后新会话立即生效。

## 6. 卸载

```sh
dsh plugin --profile web remove dsh-advisor
dsh --profile web --dump-config   # 确认 dsh-advisor 层已消失
```

重启 dsh 会话使卸载生效。
