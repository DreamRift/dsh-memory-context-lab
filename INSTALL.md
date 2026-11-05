# 安装与升级

本文件是 0.15.2 的安装说明。两种分发渠道内容完全一致：**npm 包** `dsh-memory-context-lab` 与 **GitHub Release** 里的 `dsh-memory-context-lab-0.15.2.tgz`。

## 环境要求

| 项目 | 要求 |
|---|---|
| DSH Desktop | 0.2.1-rc.5（宿主契约按该版本源码核验） |
| Node.js | ≥ 22.19 |
| pnpm | ≥ 12.8（tgz 内的 `file:` 依赖解析依赖该修复） |
| 平台 | Windows x64（随包 Bash 载荷与 worker 仅覆盖该平台） |

## 从 npm 安装（推荐）

```powershell
dsh plugin --profile desktop add dsh-memory-context-lab
```

如果 `dsh` 不在 PATH，使用 DSH 安装目录下的：

```powershell
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-memory-context-lab
```

装完重启 DSH。

## 从 GitHub Release 安装

1. 在 [Releases](https://github.com/DreamRift/dsh-memory-context-lab/releases) 页面下载 `dsh-memory-context-lab-0.15.2.tgz`。
2. 装进 desktop profile：

```powershell
dsh plugin --profile desktop add "<下载路径>\dsh-memory-context-lab-0.15.2.tgz"
```

3. 重启 DSH。

## 安装后确认

侧边栏「插件」→ `dsh-memory-context-lab` →「包含的组件」，应看到两行：
`memory-context-lab` 与 `dsh-ops`。点 `dsh-ops` 进入它的完整设置页。

`dsh-ops` 是随包捆绑的定制组件，**不需要单独安装**；它的上游是 [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops)。

## 升级与回滚

升级到同一条线的新版本时，重复上面的 `add` 命令并重启；npm 渠道下直接指定版本号即可：

```powershell
dsh plugin --profile desktop add dsh-memory-context-lab@0.15.2
```

回滚到 0.15.0（该版本不含 dsh-ops 组件）：

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
