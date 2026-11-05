# 安装与升级

本文件是 0.15.2 的安装说明。发布资产在 GitHub Release 页面。

## 环境要求

| 项目 | 要求 |
|---|---|
| DSH Desktop | 0.2.1-rc.5（宿主契约按该版本源码核验） |
| Node.js | ≥ 22.19 |
| pnpm | ≥ 12.8（插件 tgz 内的 `file:` 依赖解析依赖该修复） |
| 平台 | Windows x64（随包 Bash 载荷与 worker 仅覆盖该平台） |

## 从 GitHub Release 安装

1. 在 [Releases](https://github.com/DreamRift/dsh-memory-context-lab/releases) 页面下载 `dsh-memory-context-lab-0.15.2.tgz`。
2. 在 PowerShell 中把 tgz 装进 desktop profile：

```powershell
dsh plugin --profile desktop add "<下载路径>\dsh-memory-context-lab-0.15.2.tgz"
```

如果 `dsh` 不在 PATH，使用 DSH 安装目录下的：

```powershell
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "<下载路径>\dsh-memory-context-lab-0.15.2.tgz"
```

3. 重启 DSH。
4. 侧边栏「插件」→ `dsh-memory-context-lab` →「包含的组件」，应看到两行：
   `memory-context-lab` 与 `dsh-ops`。点 `dsh-ops` 进入它的完整设置页。

## 为什么不在 npm 上

本包携带完整的 Windows x64 Bash 载荷（解压约 411 MB），打包后单文件约 165 MB。npm registry 对单次发布请求的实际承受范围撑不住这个体积——实测多次尝试均以 `PUT ... FETCH_ERROR` 或请求长时间挂起告终，registry 自身连通正常（`/-/ping` 返回 200），也可以确定不是带宽问题（同一份文件走 GitHub 上传通道成功）。

因此 0.15.2 只通过 GitHub Release 分发。若后续把 Bash 载荷拆成独立的可选下载项，npm 分发会重新评估。

## 升级与回滚

升级到同一条线的新版本时，重复上面的 `add` 命令并重启。回滚到 0.15.0（该版本不含 dsh-ops 组件）：

```powershell
dsh plugin --profile desktop add "<下载路径>\dsh-memory-context-lab-0.15.0.tgz"
```

回滚只替换插件包；会话数据仍在 `$DSH_HOME/.memory-context-lab/v3/`，不会被删除。

## 磁盘与首次使用

- 插件 tgz 约 165.5 MB；解压后的 Bash 载荷约 411 MB。
- 首次在受限模式使用 `ops_bash` 时，dsh-ops 会把受管 Bash 复制到
  `$DSH_HOME/dsh-ops/bash-ipc/`，因此总占用约为载荷的两倍（约 800 MB 级）。
- 不需要 Bash 时，可在 `dsh-ops` 组件页关闭 `bash`，并删除
  `$DSH_HOME/dsh-ops/bash-ipc/` 释放空间。

## 卸载

```text
插件：在插件管理器移除 dsh-memory-context-lab，或执行
      dsh plugin --profile desktop remove dsh-memory-context-lab
数据：删除 $DSH_HOME/.memory-context-lab/v3/（可选；会丢失本机会话隔离记忆）
Bash 受管副本：删除 $DSH_HOME/dsh-ops/bash-ipc/（可选）
```

## 验证

- 安装后重启，插件页「包含的组件」两行可见；
- `/memory-lab status` 正常返回；
- 若启用了官方工具替换，`read`/`glob`/`grep` 由 `ops_*` 接管；可在 `dsh-ops` 设置页关闭 `hideOfficialTools`。
