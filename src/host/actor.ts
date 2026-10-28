/**
 * 「我是谁」——这个实例在看板上的身份，**只在这里解析**。
 *
 * 曾经有两份（`index.ts` 的 `selfActor()` 与会话工具里的 `actorOf()`），而它们不等价：
 * 前者认 `TASKBOARD_WATCH_NAMES` 的第一位（那份配置里第一位就是规范名），后者只认
 * `TASKBOARD_ACTOR`。于是照文档配 `TASKBOARD_WATCH_NAMES=dsh,dsh-agent` 时，同一进程
 * 里出现了两个身份：开场提示（`agent/session-start`）按 `dsh` 统计"压着你的 N 件事"，
 * 工具却按 `dsh-agent` 记账 —— 同一个人在自己看板上被拆成两个主人，提示里报的卡点开
 * 工具就没了。前一处注释当时写着「same resolution as the tools」，实际并不一致。
 *
 * 解析顺序（三处共用）：显式 `by` 参数 → `TASKBOARD_ACTOR` → `TASKBOARD_WATCH_NAMES`
 * 的第一位 → `dsh-agent`。
 *
 * @module dsh-taskboard-kit/actor
 */

/** 本实例在看板上的身份；显式传入的 `by` 优先。 */
export function selfActor(by?: string | null): string {
  const explicit = typeof by === 'string' ? by.trim() : ''
  if (explicit !== '') return explicit
  return process.env.TASKBOARD_ACTOR?.trim()
    || process.env.TASKBOARD_WATCH_NAMES?.split(',')[0]?.trim()
    || 'dsh-agent'
}
