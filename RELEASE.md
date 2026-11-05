# 发布资产与上传说明

当前版本：**0.15.2**（2026-11-05）。本文件面向维护者，说明发布包放哪、为什么不在 git 里、以及两个分发渠道怎么发。

## 当前资产

| 项目 | 值 |
|---|---|
| 文件 | `dist/dsh-memory-context-lab-0.15.2.tgz` |
| 大小 | 165,572,123 B（约 165.6 MB） |
| 条目 | 10,248 |
| sha256 | `BAC735A05BCFA60096481165A084837F2527B12170051E67FE9D904D0CA450BE` |
| npm | `dsh-memory-context-lab@0.15.2` |
| 安装说明 | [INSTALL.md](./INSTALL.md) |
| 变更记录 | [CHANGELOG.md](./CHANGELOG.md) |

## 为什么 tgz 不在 git 里

单文件约 165.5 MB，超过 GitHub 仓库单文件 **100 MB** 限制。直接 `git add` 会在推送时被拒绝，Git LFS 也会占用大额配额；因此：

- `release/.gitignore` 忽略 `dist/`；
- `dist/dsh-memory-context-lab-0.15.2.tgz` 只作为 **GitHub Release asset** 与 **npm 包** 分发；
- 仓库里保留源码、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`INSTALL.md`、`LICENSE` 与测试。

## 本地重建

在 `release/` 目录执行：

```powershell
npm pack --pack-destination ../dist
```

`prepack` 会调用 `scripts/vendor-ops.mjs --ensure` 检查 `vendor/dsh-ops`、`vendor/bash-win32-x64` 与 `bash-ipc` 回执。缺 vendor 时按 `scripts/vendor-ops.mjs` 的 `--dsh-tgz` / `--bash-tgz` 参数重新生成；Bash 载荷 tgz 放在 `../.cache/ops-vendor/`。

## 发布到 npm

```powershell
npm publish
```

- `prepack` 同样跑 vendor 自检；产物与 Release asset 是同一份。
- 需要已登录的 npm 账号（`npm login`），且该账号对 `dsh-memory-context-lab` 有发布权限。
- 发布前可先 `npm publish --dry-run` 核对条目数与体积。

## 上传到 GitHub Release

1. 在 GitHub 仓库创建与 `package.json` 同号的 tag：`v0.15.2`。
2. Release 说明写「相对上一个正式版本 v0.13.1」的变化，大项优先。
3. 上传资产 `dist/dsh-memory-context-lab-0.15.2.tgz`。
4. 上传后核对 GitHub 显示的 asset digest 与上面的 sha256 一致。

如果使用 `gh`：

```powershell
gh release create v0.15.2 "dist/dsh-memory-context-lab-0.15.2.tgz" --title "0.15.2" --notes-file release-notes.md
```

**不要**把 tgz 提交进仓库。

## 发布前检查

- `plugin` 与 `release` 各 `node scripts/test-all.mjs` 239/239；
- `node scripts/check-docs.mjs` errors = 0；
- `npm pack` 产物含 `package/INSTALL.md`、`package/README.md`、`package/CHANGELOG.md` 与两个 vendor；
- 临时 profile 安装 tgz 后，`dsh --dump-config` 显示 `memory-context-lab` 与 `dsh-ops` 两行；
- `bash.exe --version` 为 GNU bash 5.3.15。
