'use client'

import * as React from 'react'
import {
  makeStyles,
  tokens,
  Input,
  Button,
  Tooltip,
} from '@fluentui/react-components'
import {
  Clock20Regular,
  Add20Regular,
  Settings20Regular,
  ClipboardTaskListLtr20Regular,
} from '@fluentui/react-icons'
import { TaskRow } from './task-row'
import { TaskDialog, type TaskDialogValues } from './task-dialog'
import { CompletedView } from './completed-view'
import { SettingsView } from './settings-view'
import { usePanelSurface } from './use-panel-surface'
import {
  nextId,
  todayISO,
  formatHeader,
  isOverdue,
  nextTimeSlot,
  type Task,
  type Repeat,
} from '../lib/todo-utils'

const T = todayISO()
const yday = (() => {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()
const lastWeek = (() => {
  const d = new Date()
  d.setDate(d.getDate() - 4)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()

const INITIAL_TASKS: Task[] = [
  { id: 's1', title: '回复项目组邮件', time: '09:30', dueDate: T, repeat: 'none', done: false, completedAt: null, order: 0 },
  { id: 's2', title: '提交周报初稿', time: '11:00', dueDate: T, repeat: 'weekly', done: false, completedAt: null, order: 1 },
  { id: 's3', title: '团队站会同步', time: '14:00', dueDate: T, repeat: 'daily', done: false, completedAt: null, order: 2 },
  { id: 's4', title: '整理设计评审文档', time: '15:00', dueDate: T, repeat: 'none', done: false, completedAt: null, order: 3 },
  { id: 's5', title: '预约下周会议室', time: '16:30', dueDate: T, repeat: 'none', done: false, completedAt: null, order: 4 },
  { id: 's6', title: '晨间冥想', time: '08:00', dueDate: T, repeat: 'daily', done: true, completedAt: T, order: 5 },
  { id: 's7', title: '整理收件箱', time: '10:00', dueDate: yday, repeat: 'none', done: true, completedAt: yday, order: 6 },
  { id: 's8', title: '周会纪要归档', time: '17:00', dueDate: lastWeek, repeat: 'none', done: true, completedAt: lastWeek, order: 7 },
]

type View = 'home' | 'completed' | 'settings'

const DEFAULT_REMINDER = { dueDate: T, time: null as string | null, repeat: 'none' as Repeat }

const useStyles = makeStyles({
  desktop: {
    minHeight: '100vh',
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    backgroundImage: 'url(/wallpaper.png)',
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    paddingTop: tokens.spacingVerticalXXL,
    paddingBottom: tokens.spacingVerticalXXL,
    paddingRight: tokens.spacingHorizontalXXXL,
    paddingLeft: tokens.spacingHorizontalXXXL,
  },
  panel: {
    width: '340px',
    height: '70vh',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow28,
    overflow: 'hidden',
  },
  overview: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    columnGap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXL,
    paddingBottom: tokens.spacingVerticalL,
    paddingLeft: tokens.spacingHorizontalXL,
    paddingRight: tokens.spacingHorizontalXL,
  },
  dateLine: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  summary: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  overdueText: {
    color: tokens.colorStatusDangerForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  dot: { color: tokens.colorNeutralForeground4 },
  newTask: {
    paddingLeft: tokens.spacingHorizontalXL,
    paddingRight: tokens.spacingHorizontalXL,
    paddingBottom: tokens.spacingVerticalM,
  },
  input: { width: '100%' },
  inlineButtons: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXXS,
  },
  list: {
    flex: 1,
    overflowY: 'auto',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalS,
    display: 'flex',
    flexDirection: 'column',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    paddingLeft: tokens.spacingHorizontalXL,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
  },
  footerText: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  footerButtons: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXXS,
  },
})

export function TodoPanel() {
  const styles = useStyles()
  const surface = usePanelSurface()

  const [tasks, setTasks] = React.useState<Task[]>(INITIAL_TASKS)
  const [view, setView] = React.useState<View>('home')
  const [draft, setDraft] = React.useState('')
  const [pendingReminder, setPendingReminder] = React.useState(DEFAULT_REMINDER)

  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [dialogMode, setDialogMode] = React.useState<'reminder' | 'edit'>('reminder')
  const [editingId, setEditingId] = React.useState<string | null>(null)

  const dragIdRef = React.useRef<string | null>(null)
  const [dragId, setDragId] = React.useState<string | null>(null)

  // ----- derived home lists -----
  const activeTasks = React.useMemo(
    () => tasks.filter((t) => !t.done).sort((a, b) => a.order - b.order),
    [tasks],
  )
  const doneToday = React.useMemo(
    () =>
      tasks
        .filter((t) => t.done && t.completedAt === T)
        .sort((a, b) => a.order - b.order),
    [tasks],
  )
  const homeRows = React.useMemo(
    () => [...activeTasks, ...doneToday],
    [activeTasks, doneToday],
  )

  const overdueCount = React.useMemo(
    () => activeTasks.filter((t) => isOverdue(t)).length,
    [activeTasks],
  )
  const todayCount = React.useMemo(
    () => activeTasks.filter((t) => t.dueDate === T).length,
    [activeTasks],
  )

  const groupOf = React.useCallback((t: Task): 'active' | 'doneToday' | 'other' => {
    if (!t.done) return 'active'
    if (t.completedAt === T) return 'doneToday'
    return 'other'
  }, [])

  const maxOrder = React.useCallback(
    (predicate: (t: Task) => boolean) =>
      tasks.reduce((m, t) => (predicate(t) ? Math.max(m, t.order) : m), -1),
    [tasks],
  )

  // ----- actions -----
  const addTask = React.useCallback(() => {
    setDraft((current) => {
      const title = current.trim()
      if (!title) return current
      setTasks((prev) => {
        const nextOrder =
          prev.reduce((m, t) => (!t.done ? Math.max(m, t.order) : m), -1) + 1
        return [
          ...prev,
          {
            id: nextId(),
            title,
            time: pendingReminder.time,
            dueDate: pendingReminder.dueDate,
            repeat: pendingReminder.repeat,
            done: false,
            completedAt: null,
            order: nextOrder,
          },
        ]
      })
      setPendingReminder(DEFAULT_REMINDER)
      return ''
    })
  }, [pendingReminder])

  const toggleTask = React.useCallback(
    (id: string) => {
      setTasks((prev) => {
        const target = prev.find((t) => t.id === id)
        if (!target) return prev
        const willDone = !target.done
        // bottom of the destination group
        const destMax = prev.reduce((m, t) => {
          if (t.id === id) return m
          const inDest = willDone
            ? t.done && t.completedAt === T
            : !t.done
          return inDest ? Math.max(m, t.order) : m
        }, -1)
        return prev.map((t) =>
          t.id === id
            ? {
                ...t,
                done: willDone,
                completedAt: willDone ? T : null,
                order: destMax + 1,
              }
            : t,
        )
      })
    },
    [],
  )

  const openReminder = React.useCallback(() => {
    setDialogMode('reminder')
    setEditingId(null)
    setDialogOpen(true)
  }, [])

  const openEdit = React.useCallback((id: string) => {
    setDialogMode('edit')
    setEditingId(id)
    setDialogOpen(true)
  }, [])

  const dialogInitial: TaskDialogValues = React.useMemo(() => {
    if (dialogMode === 'edit' && editingId) {
      const t = tasks.find((x) => x.id === editingId)
      if (t)
        return {
          title: t.title,
          dueDate: t.dueDate,
          time: t.time,
          repeat: t.repeat,
        }
    }
    return {
      title: draft,
      dueDate: pendingReminder.dueDate,
      time: pendingReminder.time ?? nextTimeSlot(),
      repeat: pendingReminder.repeat,
    }
  }, [dialogMode, editingId, tasks, draft, pendingReminder])

  const handleConfirm = React.useCallback(
    (values: TaskDialogValues) => {
      if (dialogMode === 'edit' && editingId) {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === editingId
              ? {
                  ...t,
                  title: values.title,
                  dueDate: values.dueDate,
                  time: values.time,
                  repeat: values.repeat,
                }
              : t,
          ),
        )
      } else {
        setPendingReminder({
          dueDate: values.dueDate,
          time: values.time,
          repeat: values.repeat,
        })
      }
      setDialogOpen(false)
    },
    [dialogMode, editingId],
  )

  const handleClear = React.useCallback(() => {
    if (dialogMode === 'edit' && editingId) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === editingId ? { ...t, time: null, repeat: 'none' } : t,
        ),
      )
    } else {
      setPendingReminder(DEFAULT_REMINDER)
    }
    setDialogOpen(false)
  }, [dialogMode, editingId])

  // ----- drag reorder within a group -----
  const handleDragStart = React.useCallback((id: string) => {
    dragIdRef.current = id
    setDragId(id)
  }, [])

  const handleDragEnter = React.useCallback(
    (targetId: string) => {
      const draggingId = dragIdRef.current
      if (!draggingId || draggingId === targetId) return
      setTasks((prev) => {
        const dragging = prev.find((t) => t.id === draggingId)
        const target = prev.find((t) => t.id === targetId)
        if (!dragging || !target) return prev
        const g = groupOf(dragging)
        if (g === 'other' || groupOf(target) !== g) return prev
        const groupSorted = prev
          .filter((t) => groupOf(t) === g)
          .sort((a, b) => a.order - b.order)
        const fromIdx = groupSorted.findIndex((t) => t.id === draggingId)
        const toIdx = groupSorted.findIndex((t) => t.id === targetId)
        if (fromIdx === -1 || toIdx === -1) return prev
        const reordered = [...groupSorted]
        const [moved] = reordered.splice(fromIdx, 1)
        reordered.splice(toIdx, 0, moved)
        const orderById = new Map(reordered.map((t, i) => [t.id, i]))
        return prev.map((t) =>
          orderById.has(t.id) ? { ...t, order: orderById.get(t.id)! } : t,
        )
      })
    },
    [groupOf],
  )

  const handleDragEnd = React.useCallback(() => {
    dragIdRef.current = null
    setDragId(null)
  }, [])

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'Enter') return
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      addTask()
    },
    [addTask],
  )

  const remaining = activeTasks.length

  return (
    <div className={styles.desktop}>
      <section className={styles.panel} style={surface} aria-label="待办事项面板">
        {view === 'home' && (
          <>
            <header className={styles.overview}>
              <span className={styles.dateLine}>{formatHeader(T)}</span>
              <span className={styles.summary}>
                <span className={styles.overdueText}>{`过期 ${overdueCount}`}</span>
                <span className={styles.dot} aria-hidden>
                  ·
                </span>
                <span>{`今日 ${todayCount}`}</span>
              </span>
            </header>

            <div className={styles.newTask}>
              <Input
                className={styles.input}
                appearance="outline"
                value={draft}
                onChange={(_, data) => setDraft(data.value)}
                onKeyDown={onKeyDown}
                placeholder="添加任务"
                aria-label="新建任务"
                contentAfter={
                  <span className={styles.inlineButtons}>
                    <Tooltip content="设置提醒" relationship="label">
                      <Button
                        appearance="transparent"
                        size="small"
                        icon={<Clock20Regular />}
                        onClick={openReminder}
                      />
                    </Tooltip>
                    <Tooltip content="添加任务" relationship="label">
                      <Button
                        appearance="transparent"
                        size="small"
                        icon={<Add20Regular />}
                        onClick={addTask}
                      />
                    </Tooltip>
                  </span>
                }
              />
            </div>

            <div className={styles.list} role="list">
              {homeRows.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  dragging={dragId === task.id}
                  isDropTarget={false}
                  onToggle={toggleTask}
                  onEdit={openEdit}
                  onDragStart={handleDragStart}
                  onDragEnter={handleDragEnter}
                  onDragEnd={handleDragEnd}
                />
              ))}
            </div>

            <footer className={styles.footer}>
              <span className={styles.footerText}>{`未完成 ${remaining}`}</span>
              <div className={styles.footerButtons}>
                <Tooltip content="已完成" relationship="label">
                  <Button
                    appearance="transparent"
                    size="small"
                    icon={<ClipboardTaskListLtr20Regular />}
                    onClick={() => setView('completed')}
                  />
                </Tooltip>
                <Tooltip content="设置" relationship="label">
                  <Button
                    appearance="transparent"
                    size="small"
                    icon={<Settings20Regular />}
                    onClick={() => setView('settings')}
                  />
                </Tooltip>
              </div>
            </footer>
          </>
        )}

        {view === 'completed' && (
          <CompletedView
            tasks={tasks}
            onBack={() => setView('home')}
            onToggle={toggleTask}
          />
        )}

        {view === 'settings' && <SettingsView onBack={() => setView('home')} />}
      </section>

      <TaskDialog
        open={dialogOpen}
        mode={dialogMode}
        initial={dialogInitial}
        onConfirm={handleConfirm}
        onClear={handleClear}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  )
}
