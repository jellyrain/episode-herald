import type { ScheduledTask, Settings, TaskDraft } from '../shared/types'

export function legacyTask(settings: Settings): ScheduledTask {
  return { id: 'daily', name: '每日检查', enabled: settings.autoCheck, mode: 'changes',
    time: settings.checkTime, frequency: { kind: 'daily' }, startAt: 0 }
}

export function validDraft(task: TaskDraft): boolean {
  if (!task || typeof task.name !== 'string' || !task.name.trim() || task.name.length > 80 ||
      typeof task.enabled !== 'boolean' || !['changes', 'full'].includes(task.mode) ||
      typeof task.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(task.time)) return false
  const f = task.frequency
  if (f?.kind === 'daily') return true
  if (f?.kind === 'interval') return Number.isInteger(f.minutes) && f.minutes >= 1 && f.minutes <= 10080
  return f?.kind === 'weekly' && Array.isArray(f.days) && f.days.length > 0 && f.days.length <= 7 &&
    f.days.every(day => Number.isInteger(day) && day >= 0 && day <= 6) && new Set(f.days).size === f.days.length
}

function localTime(day: number, time: string, offset = 0): number {
  const date = new Date(day)
  const [hours, minutes] = time.split(':').map(Number)
  date.setDate(date.getDate() + offset)
  return date.setHours(hours, minutes, 0, 0)
}

export function firstStart(task: TaskDraft, now: number): number {
  if (task.frequency.kind !== 'interval') return now
  const today = localTime(now, task.time)
  return today >= now ? today : localTime(now, task.time, 1)
}

/** Most recent eligible slot and the following slot in the machine's local timezone. */
export function taskWindow(task: ScheduledTask, now: number): { due?: number; next: number } {
  const f = task.frequency
  if (f.kind === 'interval') {
    if (now < task.startAt) return { next: task.startAt }
    const period = f.minutes * 60000
    const due = now - (now - task.startAt) % period
    return { due, next: due + period }
  }
  const reference = Math.max(task.startAt, now)
  let due: number | undefined
  for (let offset = -7; offset <= 7; offset++) {
    const at = localTime(reference, task.time, offset)
    if (at < task.startAt || (f.kind === 'weekly' && !f.days.includes(new Date(at).getDay()))) continue
    if (at > now) return { due, next: at }
    due = at
  }
  throw new Error('无法计算任务时间。')
}
