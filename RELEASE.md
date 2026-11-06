# 发布资产与 GitHub 上传说明

当前版本：**0.15.3**（2026-11-06，DSH 0.2.2 命令通道兼容修复）。本文件面向维护者，说明发布包放哪、为什么不在 git 里、以及 GitHub Release 该怎么传。

## 当前资产

| 项目 | 值 |
|---|---|
| 文件 | `dist/dsh-memory-context-lab-0.15.3.tgz` |
| 大小 | 165,575,697 B（约 165.6 MB） |
| 条目 | 10,248 |
| sha256 | `E459A334E98923B1FD266A015DFE2D7668026BEC043223B5B6EC3BEB7AC95E78` |
| 分发 | GitHub Release asset（**不走 npm**，原因见下） |
| 安装说明 | [INSTALL.md](./INSTALL.md) |
| 变更记录 | [CHANGELOG.md](./CHANGELOG.md) |

## 为什么 tgz 不在 git 里

单文件约 165.5 MB，超过 GitHub 仓库单文件 **100 MB** 限制。直接 `git add` 会在推送时被拒绝，Git LFS 也会占用大额配额；因此：

- `release/.gitignore` 忽略 `dist/`；
- `dist/dsh-memory-context-lab-0.15.3.tgz` 只作为 **GitHub Release asset** 上传；
- 仓库里保留源码、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`INSTALL.md`、`LICENSE` 与测试。

## 为什么不在 npm 上

2026-11-05 实测：`npm publish` 三次尝试全部失败。

- registry 连通正常（`GET /-/ping` 返回 200），`GET /dsh-memory-context-lab` 正常返回 404（包尚不存在）；
- `PUT /dsh-memory-context-lab`（携带 165 MB 的请求体）表现为 `attempt N failed with FETCH_ERROR`，或请求长时间挂起无响应；
- 排除带宽因素：同一份文件经代理走 GitHub `uploads.github.com` 的 `POST` 通道，848 秒内完整上传并返回 201。

结论：165 MB 超出 npm 单次发布请求的实际承受范围。要恢复 npm 分发，需先把 Bash 载荷拆成独立的可选下载项，把主包压到可发布体积——这会改变安装语义，未在本版实施。

## 本地重建

在 `release/` 目录执行：

```powershell
npm pack --pack-destination ../dist
```

`prepack` 会调用 `scripts/vendor-ops.mjs --ensure` 检查 `vendor/dsh-ops`、`vendor/bash-win32-x64` 与 `bash-ipc` 回执。缺 vendor 时按 `scripts/vendor-ops.mjs` 的 `--dsh-tgz` / `--bash-tgz` 参数重新生成；Bash 载荷 tgz 放在 `../.cache/ops-vendor/`。

## 上传到 GitHub Release

1. 在 GitHub 仓库创建与 `package.json` 同号的 tag：`v0.15.3`。
2. Release 说明使用 `CHANGELOG.md` 的本版条目。
3. 上传资产 `dist/dsh-memory-context-lab-0.15.3.tgz`。
4. 上传后核对 GitHub 显示的 asset digest 与上面的 sha256 一致。

如果使用 `gh`：

```powershell
gh release create v0.15.3 "dist/dsh-memory-context-lab-0.15.3.tgz" --title "0.15.3" --notes-file release-notes.md
```

**不要**把 tgz 提交进仓库。

### 上传实操注意（2026-11-05）

- `gh release upload` 在大文件上会挂起（进程连上代理但请求体零字节），实测不可用；改用 `curl` 直传 API：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7890'
$tok = & gh auth token
curl.exe -X POST -H "Authorization: Bearer $tok" -H 'Content-Type: application/octet-stream' `
  --data-binary '@C:\Windows\Temp\mcl-0.15.3.tgz' `
  'https://uploads.github.com/repos/DreamRift/dsh-memory-context-lab/releases/<release-id>/assets?name=dsh-memory-context-lab-0.15.3.tgz'
```

- `curl --data-binary '@路径'` 的路径必须纯 ASCII：含中文或空格的路径会报 `error encountered when reading a file`。先把 tgz 复制到 `C:\Windows\Temp\`。
- 上传期间进程的 IO 计数与实际传输不同步（代理层缓冲），用网卡 `SentBytes` 增量估算进度。

## 发布前检查

- `plugin` 与 `release` 各 `node scripts/test-all.mjs` 239/239；
- `node scripts/check-docs.mjs` errors = 0；
- `npm pack` 产物含 `package/INSTALL.md`、`package/README.md`、`package/CHANGELOG.md` 与两个 vendor；
- 临时 profile 安装 tgz 后，`dsh --dump-config` 显示 `memory-context-lab` 与 `dsh-ops` 两行；
- `bash.exe --version` 为 GNU bash 5.3.15。
