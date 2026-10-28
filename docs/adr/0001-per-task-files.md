# ADR 0001 — 板可以用两种布局存储，默认不变

- 状态：已采纳（v0.9.5，2026-10-28）
- 相关：Issue #1 · 上游 `feat/per-task-files`

## 背景

一块板原本是**一份 JSON 台账**（`.dsh/taskboard.json`），卡号来自板级计数
`next_seq`。

实测（两个 clone 各自 `taskboard create`，base 的 `next_seq` 相同）：

```
CONFLICT (content): Merge conflict in .dsh/taskboard.json
```

两边都分配了 `T-2`，落进同一个 JSON key。更糟的是「手工合并」这条路：JSON 允许
重复 key，后写的那个静默覆盖前一个 —— 冲突看得见，丢卡看不见。

另外两个次要噪音：`workspace` 字段存的是绝对路径（换机器/换目录每次保存都产生 diff），
`next_seq` 本身也是一个共享计数器。

## 决策

在**同一块 `Board`** 后面提供第二种布局，按 workspace 选择，默认行为不变：

| 布局 | 磁盘 | 卡号 |
| --- | --- | --- |
| `file`（默认，兼容） | `.dsh/taskboard.json` | `T-<n>`，来自 `next_seq` |
| `tasks`（每卡） | `.dsh/taskboard/T-7K2M.json` + `.dsh/taskboard/meta.json` | `T-` + 4 位随机 |

`storage` 的取值：`auto`（默认）/ `file` / `tasks`，也可用 `TASKBOARD_STORAGE`。
`auto` = 有 `.dsh/taskboard/` 目录就是 `tasks`，否则 `file`。所以**新板默认仍是单文件**，
只有显式迁移或配置过的 workspace 用新布局 —— 上游合并不改变任何现有用户的行为。

`taskboard migrate --to tasks|file` 双向迁移，旧产物改名保留：
`taskboard.json.pre-tasks` / `taskboard.pre-file/`。

## 为什么不是直接改默认

1. 默认即新布局会让升级后的第一次读写出人意料地改变磁盘结构；
2. 上游 20 个测试文件里有大量「板文件存在、mode 0600、手工写 JSON」的前提，默认切换
   等于一次性改写测试语义；
3. 布局是项目级决策（是否把板提交进 git），不该由升级替用户决定。

## 关键约束：不能把冲突挪个地方

拆文件只解决了**卡与卡**之间的冲突。板级共享字段如果仍在普通动作里被改写，冲突只是
从 `taskboard.json` 搬到 `meta.json`。因此：

1. **`next_seq` 不再参与每卡布局**：随机卡号，不分配、不读计数、不撞号。
2. **`actors` 不落盘**：每次加载由卡派生（activity 来自日志/留言，reference 来自
   创建人/负责人/审核人/等待对象，`last_seen_at` 为 `null`）。派生是精确的：
   活性的证据本来就只有日志与留言，`touchActor` 写下的正是同一份证据。
3. **`review_notices` 挪到卡上**：key 是 `<卡>#log:<下标>@<reviewer>`，天然属于那张卡。
   留在板级会让**每次 submit** 都写一次共享文件。旧板仍可读（惰性迁移）。
4. **`meta.json` 只放 `tails`**（`taskboard tails --waive` 这类显式 CLI 动作才写）。
5. **`workspace` 不落盘**：加载时由 cwd 派生；换目录不再产生 diff。

## 写盘策略

`loadBoard` 在每卡布局下记录「读到时的字节 + 文件名 + meta 字节」快照；`saveBoard`
只写字节变了的卡。一次普通动作（claim / start / comment）改写**恰好一个文件**。
卡号以文件内容里的 `id` 为准，文件名只是投影（所以将来加可读 slug 不需要迁移）。

## 被否决的方案

- **task-passport 当底座 + 自建面板**：它没有 DSH 客户端界面，也没有
  status/assignee/reviewer/waiting_on 的概念，等于在这套 3,300 行 store 与 200 KB
  已构建 UI 之外重写一遍看板。它的价值是跨 Harness 交接（TaskPack），不是看板。
- **在 `saveBoard` 里做「全量重写」**：每卡布局下会把所有卡文件的 mtime 刷新，
  git 每次动作都产生 N 个 diff，等于放弃拆分的收益。
- **每卡一把锁**：只服务于「同机并发改不同卡」，而工作区级锁已经覆盖；额外锁引入
  死锁面与新测试矩阵，收益为零。
- **`expected_version`（乐观并发）**：只在网络共享目录（SMB/NFS）并发写时才需要，
  而那种场景下文件锁本身也不可靠。本期目标是 git 异步协作，不做。

## 后果

- 两个分支各建一张卡 ⇒ 两个不同文件 ⇒ `git merge` 无冲突；
  同一张卡两边都改 ⇒ 同一个文件 ⇒ 冲突（期望行为，由人裁决）。
- 读板成本从「1 次读 + 1 次 parse」变成「readdir + N 次读 + N 次 parse」。百级卡量
  下可忽略；`/board` 的 `board_mtime` 取目录内最大 mtime。
- 监听从「`.dsh/` 里看 `taskboard.json`」变成「再挂一个 `.dsh/taskboard/` 目录监听」。
- 迁移期间（file → tasks）两套产物短暂并存；迁移在锁内进行，旧文件改名后 `auto`
  才切到 `tasks`。
- 测试基线：顺手修了 Windows 上原本就红的用例（CLI 的 `import()` 路径、
  `precommit-guard` 用 `URL.pathname` 拼出 `C:\C:\...`、NTFS 无 0600、`/etc`
  与 POSIX shell 夹具），平台专属用例在 Windows 上显式 skip 并说明理由。
