# 发布指南

本文介绍如何发布新版 `dsh-advisor` 到 npm 并创建 GitHub Release。发布流程是 **PR 驱动**的：先由 **Release prep** 工作流准备版本号、自动生成 `CHANGELOG.md` 并打开 `release vX.Y.Z` PR（CHANGELOG 随该 PR 一起提交），合并该 PR 后由 **Release** 工作流自动完成发布、打 tag 与 GitHub Release（PR 正文与 Release 正文同源于已提交的 `CHANGELOG.md` 对应小节：PR 正文为该小节并附一行合并说明，Release 正文仅含该小节）。安装与卸载见[安装指南](install.zh.md)。

## 前置条件

- **npm 发布走 OIDC trusted publishing，无需任何 npm secret**：Release 工作流声明了 `id-token: write` 权限，`npm publish` 用 OIDC 令牌交换短时发布凭证（并生成 provenance），仓库**不需要**配置 `NPM_TOKEN` / `NODE_AUTH_TOKEN`。但 npmjs 侧必须为 `dsh-advisor` 配置 trusted publisher（绑定本仓库 + Release 工作流；见 https://docs.npmjs.com/generating-provenance-statements），配置缺失或失效时 `npm publish` 会因 401 失败。除此之外默认流程不需要其它 secret——tag 与 GitHub Release 都用工作流自带的 `GITHUB_TOKEN`（需 `contents: write` 权限，Release 工作流已声明）。
- 仓库启用 GitHub Actions；发布 PR 需通过仓库的分支保护检查（CI 校验 + review）才能合并。

## 1. 发布流程

1. 打开仓库 **Actions** 页，在左侧选择 **Release prep** 工作流。
2. （可选）在 **Run workflow** 表单的 `version` 输入框填写目标版本号（如 `0.2.0`）；**留空则自动打 patch 版本**（见[版本策略](#3-版本策略)）。
3. 点击 **Run workflow** 触发发布准备。
4. 等待 **Release prep** 运行完成：它会把版本号写入 `package.json` 并同步 `pnpm-lock.yaml`，把自上一个 tag 以来的提交记录以 `## [X.Y.Z]` 小节写入 `CHANGELOG.md`（自动生成，已有小节保持不变；重复运行同一版本不会重复写入），跑一遍 typecheck / build / test 校验，然后创建 `release/vX.Y.Z` 分支并打开标题为 **`release vX.Y.Z`** 的 PR（PR 正文 = `CHANGELOG.md` 中该版本的 `## [X.Y.Z]` 小节 + 一行合并说明；合并后 GitHub Release 正文仅取同一小节、不含合并说明——两者提取来源相同；CHANGELOG 随提交一起进入该 PR）。
5. 合并该 **`release vX.Y.Z`** PR。**合并即发布**——不需要再手动运行任何工作流。

## 2. 合并后自动发生什么

合并 `release vX.Y.Z` PR 后，**Release** 工作流在 `pull_request`（closed）事件上运行，按顺序自动执行：

1. **校验**：检出合并提交（`merge_commit_sha`），读取 `package.json` 版本号并确认非空。
2. **构建**：`pnpm run typecheck && pnpm run build && pnpm run test`（与 CI 相同的校验命令）。
3. **发布**：`npm publish --access public`，向 npm 发布 `dsh-advisor@X.Y.Z`（认证走 OIDC trusted publishing，无需任何 secret）。版本号含 `-` 的 prerelease（如 `0.1.3-alpha.1`）自动带 `--tag <前缀>`（前缀 = 首个 `-` 之后到首个 `.` 之前的文本，如 `alpha`），发布到 `alpha` dist-tag；正式版本（`X.Y.Z`）不带 `--tag`，默认发布到 `latest`。
4. **打 tag**：以 `github-actions[bot]` 身份创建并推送注解 tag `vX.Y.Z`（commit message `Release vX.Y.Z`）；若该 tag 已存在，tag 步骤会跳过。**tag 跳过只覆盖 tag**——npm 不允许重复发布同一版本（`npm error ... previously published versions`），因此重跑工作流只在 **`npm publish` 步骤本身失败**（尚未发布任何版本、也未创建 tag）时才能继续完成发布；如果发布已经成功（例如随后 tag 或 GitHub Release 步骤失败），重跑会在 `npm publish` 步骤失败，而不是照常发布。**注意「已发布但未打 tag」的缺口**：发布成功后若 tag 步骤失败，仓库中没有任何 `vX.Y.Z` tag（基于 tag 的重复版本检查也拦不住该版本），此时重跑会卡在 `npm publish`；恢复只能人工处理——用 `gh release create vX.Y.Z --generate-notes`（或 `gh release create` 手动编辑正文）为已发布版本补建 tag 与 GitHub Release，或 bump 一个新版本重新走发布流程。
5. **创建 GitHub Release**：以 `vX.Y.Z` 为 tag 与标题创建 Release，正文取自 `CHANGELOG.md` 中对应版本的 `## [X.Y.Z]` 小节（该小节由 **Release prep** 写入并随发布 PR 提交），仅包含该小节本身；PR 正文取自同一小节（提取来源相同），并额外附一行合并说明（见 [§1 步骤 4](#1-发布流程)）。版本号含 `-`（如 `0.1.3-alpha.1`）时，该 Release 会被标记为 **Pre-release**，不会作为最新稳定版展示。若该小节缺失（例如在引入 `CHANGELOG.md` 之前准备的旧发布 PR），则回退为自上一个 tag 以来的提交记录（`git log --oneline --first-parent`，取最近祖先 tag 为基准；无 tag 时为完整历史）。注：在 `CHANGELOG.md` 引入之前就已打开的在途发布 PR（例如本次变更时在途的 0.1.1 PR）合并后，其 Release 正文经回退逻辑以 git-log 格式生成，且该版本不会在 `CHANGELOG.md` 中留下小节（同版本不可重复准备）；从下一个版本起，Release 正文恢复为对应 `## [X.Y.Z]` 小节。

## 3. 版本策略

> **当前策略：发布流程恢复正常之前，一律使用 alpha 预发布版本发版（显式填写如 `0.2.0-alpha.1`），禁止发布正式版本；何时恢复正常由维护者明确宣布。**
>
> **发布触发标准：仅当合并内容包含实质变更（代码 / 行为 / 用户可见的文档或配置变更）时才发起发布；纯注释、格式化、工作流注释等 trivial 变更直接合入 main，随下一个实质版本一起发布（空范围守卫只拦截零提交，不拦截 trivial 提交）。判断标准由维护者把握。**

- **留空 = 自动 patch**：`scripts/prepare-release.mjs` 读取当前 `package.json` 版本并把 patch 位 +1，同时**丢弃 prerelease 后缀**（`0.1.3-alpha.1` → `0.1.4`）。**注意**：自动 patch 产出的是**正式版本号**——alpha 规则生效期间，留空会绕过 alpha 规则发出正式版本，因此**必须显式填写 alpha 版本**（如 `0.1.4-alpha.1`），不要留空。
- **显式版本**：在 `version` 输入框填写完整 semver，支持 `X.Y.Z`（如 `0.2.0`、`1.0.0`）与 `X.Y.Z-alpha.N`（如 `0.1.4-alpha.1`）。需要 minor / major 升级、或想跳过中间 patch 版本时用这个方式；alpha 规则生效期间一律用 `X.Y.Z-alpha.N` 形式。
- **prerelease 不污染 `latest`**：`X.Y.Z-alpha.N` 发布到 `alpha` dist-tag（`npm install dsh-advisor@alpha` 可安装），不会更新 `latest`；只有正式版本 `X.Y.Z` 才会更新 `latest`。
- **空版本范围会被拒绝**：若自上一个 release tag 以来没有新提交（没有可发布内容），Release prep 会直接报错退出（exit 1），不会产生空版本 / 空发布 PR。
- **重复版本会被拒绝**：若 `vX.Y.Z` 对应的 git tag 已存在（该版本已发布过），Release prep 会直接报错退出，请改填一个新版本号再跑。

## 4. 回滚 / 修正

- **npm 不允许覆盖已发布的版本**：同一 `X.Y.Z` 不能重复 `npm publish`。发布后发现缺陷时，**不要试图重发同版本**——修复后在主分支合并，再走一遍发布流程 bump 出新版本（patch / minor / major 视严重程度）。
- **yank 需谨慎**：`npm unpublish` / `npm deprecate` 可以下线或废弃某个版本，但会破坏已安装该版本用户的升级路径与依赖解析，只在极端情况（误发、包含敏感信息等）下使用。`npm unpublish` 仅限发布后 72 小时内，且可能影响依赖你的包；`npm deprecate dsh-advisor@X.Y.Z "说明"` 是更温和的标记方式（标记后仍可安装，但会显示弃用警告）。
- **tag 与 GitHub Release 不会自动删除**：需要时由维护者手动清理（删除远端 tag：`git push origin :refs/tags/vX.Y.Z`，再删除对应 GitHub Release）；但删除 tag 并不会让 npm 上的同版本变为可重发——npm 版本不可覆盖是硬限制。

## 5. 相关文档

- [安装指南](install.zh.md) — registry / 本地目录 / tarball 三种安装方式与卸载
- [README](../README.zh.md) — 项目概览
