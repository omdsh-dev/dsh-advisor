# 发布指南

本文介绍如何发布新版 `dsh-advisor` 到 npm 并创建 GitHub Release。发布流程是 **PR 驱动**的：先由 **Release prep** 工作流准备版本号并打开 `release vX.Y.Z` PR，合并该 PR 后由 **Release** 工作流自动完成发布、打 tag 与 GitHub Release。安装与卸载见[安装指南](install.zh.md)。

## 前置条件

- **`NPM_TOKEN` secret 必须存在**：Release 工作流通过 `NODE_AUTH_TOKEN` 环境变量（取自仓库 **Settings → Secrets and variables → Actions** 的 `NPM_TOKEN`）向 npm registry 认证。token 缺失或失效时，`npm publish` 会因 401 失败。除 `NPM_TOKEN` 外，默认流程不需要其它 secret——tag 与 GitHub Release 都用工作流自带的 `GITHUB_TOKEN`（需 `contents: write` 权限，Release 工作流已声明）。
- 仓库启用 GitHub Actions；发布 PR 需通过仓库的分支保护检查（CI 校验 + review）才能合并。

## 1. 发布流程

1. 打开仓库 **Actions** 页，在左侧选择 **Release prep** 工作流。
2. （可选）在 **Run workflow** 表单的 `version` 输入框填写目标版本号（如 `0.2.0`）；**留空则自动打 patch 版本**（见[版本策略](#3-版本策略)）。
3. 点击 **Run workflow** 触发发布准备。
4. 等待 **Release prep** 运行完成：它会把版本号写入 `package.json` 并同步 `pnpm-lock.yaml`，跑一遍 typecheck / build / test 校验，然后创建 `release/vX.Y.Z` 分支并打开标题为 **`release vX.Y.Z`** 的 PR（PR 正文带自上一个 tag 以来的提交记录）。
5. 合并该 **`release vX.Y.Z`** PR。**合并即发布**——不需要再手动运行任何工作流。

## 2. 合并后自动发生什么

合并 `release vX.Y.Z` PR 后，**Release** 工作流在 `pull_request`（closed）事件上运行，按顺序自动执行：

1. **校验**：检出合并提交（`merge_commit_sha`），读取 `package.json` 版本号并确认非空。
2. **构建**：`pnpm run typecheck && pnpm run build && pnpm run test`（与 CI 相同的校验命令）。
3. **发布**：`npm publish --access public`，向 npm 发布 `dsh-advisor@X.Y.Z`（认证走 `NPM_TOKEN` secret）。
4. **打 tag**：以 `github-actions[bot]` 身份创建并推送注解 tag `vX.Y.Z`（commit message `Release vX.Y.Z`）；若该 tag 已存在，tag 步骤会跳过。**tag 跳过只覆盖 tag**——npm 不允许重复发布同一版本（`npm error ... previously published versions`），因此重跑工作流只在 **`npm publish` 步骤本身失败**（尚未发布任何版本、也未创建 tag）时才能继续完成发布；如果发布已经成功（例如随后 tag 或 GitHub Release 步骤失败），重跑会在 `npm publish` 步骤失败，而不是照常发布。**注意「已发布但未打 tag」的缺口**：发布成功后若 tag 步骤失败，仓库中没有任何 `vX.Y.Z` tag（基于 tag 的重复版本检查也拦不住该版本），此时重跑会卡在 `npm publish`；恢复只能人工处理——用 `gh release create vX.Y.Z --generate-notes`（或 `gh release create` 手动编辑正文）为已发布版本补建 tag 与 GitHub Release，或 bump 一个新版本重新走发布流程。
5. **创建 GitHub Release**：以 `vX.Y.Z` 为 tag 与标题创建 Release，正文为自上一个 tag 以来的提交记录（`git log --oneline --first-parent`，取最近祖先 tag 为基准）。注意：Release 正文在**合并提交**上提取，会包含 `chore(release): prepare` 提交以及合并前合入的其它提交，因此可能与 PR 正文的发布说明（在 prep 时提取）略有不同——这是设计使然。

## 3. 版本策略

- **留空 = 自动 patch**：`scripts/prepare-release.mjs` 读取当前 `package.json` 版本并把 patch 位 +1（`0.1.0` → `0.1.1` → `0.1.2`…）。
- **显式 X.Y.Z**：在 `version` 输入框填写完整 semver（如 `0.2.0`、`1.0.0`）。需要 minor / major 升级、或想跳过中间 patch 版本时用这个方式。
- **重复版本会被拒绝**：若 `vX.Y.Z` 对应的 git tag 已存在（该版本已发布过），Release prep 会直接报错退出，请改填一个新版本号再跑。

## 4. 回滚 / 修正

- **npm 不允许覆盖已发布的版本**：同一 `X.Y.Z` 不能重复 `npm publish`。发布后发现缺陷时，**不要试图重发同版本**——修复后在主分支合并，再走一遍发布流程 bump 出新版本（patch / minor / major 视严重程度）。
- **yank 需谨慎**：`npm unpublish` / `npm deprecate` 可以下线或废弃某个版本，但会破坏已安装该版本用户的升级路径与依赖解析，只在极端情况（误发、包含敏感信息等）下使用。`npm unpublish` 仅限发布后 72 小时内，且可能影响依赖你的包；`npm deprecate dsh-advisor@X.Y.Z "说明"` 是更温和的标记方式（标记后仍可安装，但会显示弃用警告）。
- **tag 与 GitHub Release 不会自动删除**：需要时由维护者手动清理（删除远端 tag：`git push origin :refs/tags/vX.Y.Z`，再删除对应 GitHub Release）；但删除 tag 并不会让 npm 上的同版本变为可重发——npm 版本不可覆盖是硬限制。

## 5. 相关文档

- [安装指南](install.zh.md) — registry / 本地目录 / tarball 三种安装方式与卸载
- [README](../README.zh.md) — 项目概览
