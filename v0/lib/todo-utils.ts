// Shared types and date helpers for the todo app.

export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly'

export type Task = {
  id: string
  title: string
  /** "HH:MM" or null when no time is set */
  time: string | null
  /** ISO date the task is due, e.g. "2026-08-30" */
  dueDate: string
  repeat: Repeat
  done: boolean
  /** ISO date the task was completed, or null */
  completedAt: string | null
  /** manual sort order within its group */
  order: number
}

export const REPEAT_LABELS: Record<Repeat, string> = {
  none: '不重复',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// ---- id generation (monotonic, avoids Date.now() collisions) ----
let idCounter = 0
export function nextId(): string {
  idCounter += 1
  return `t${Date.now().toString(36)}-${idCounter}`
}

// ---- date helpers ----
export function toISO(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function fromISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function todayISO(): string {
  return toISO(new Date())
}

export function weekdayLabel(d: Date): string {
  return WEEKDAYS[d.getDay()]
}

/** "8月30日 周日" */
export function formatHeader(iso: string): string {
  const d = fromISO(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${weekdayLabel(d)}`
}

/** "8月30日" */
export function formatMonthDay(iso: string): string {
  const d = fromISO(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function addDays(iso: string, n: number): string {
  const d = fromISO(iso)
  d.setDate(d.getDate() + n)
  return toISO(d)
}

/** Monday as the first day of the week. */
export function startOfWeek(iso: string): string {
  const d = fromISO(iso)
  const dow = d.getDay() // 0 Sun .. 6 Sat
  const diff = dow === 0 ? -6 : 1 - dow
  d.setDate(d.getDate() + diff)
  return toISO(d)
}

export function weekDays(weekStartISO: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStartISO, i))
}

export function isInWeek(iso: string, weekStartISO: string): boolean {
  const end = addDays(weekStartISO, 7)
  return iso >= weekStartISO && iso < end
}

// ---- time helpers ----
/** All half/full-hour slots of a day: "00:00", "00:30" ... "23:30". */
export const TIME_OPTIONS: string[] = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2)
  const m = i % 2 === 0 ? '00' : '30'
  return `${String(h).padStart(2, '0')}:${m}`
})

/** Nearest upcoming half/full-hour from now, e.g. 14:12 -> "14:30". */
export function nextTimeSlot(now: Date = new Date()): string {
  const h = now.getHours()
  const m = now.getMinutes()
  if (m === 0) return `${String(h).padStart(2, '0')}:00`
  if (m <= 30) return `${String(h).padStart(2, '0')}:30`
  const nh = (h + 1) % 24
  return `${String(nh).padStart(2, '0')}:00`
}

/** A task is overdue when it is undone and its due date/time is in the past. */
export function isOverdue(task: Task, now: Date = new Date()): boolean {
  if (task.done) return false
  const today = toISO(now)
  if (task.dueDate < today) return true
  if (task.dueDate > today) return false
  if (!task.time) return false
  const [h, m] = task.time.split(':').map(Number)
  const due = new Date(now)
  due.setHours(h, m, 0, 0)
  return due.getTime() < now.getTime()
}
