'use client'

import * as React from 'react'
import {
  makeStyles,
  mergeClasses,
  tokens,
  Button,
  Popover,
  PopoverTrigger,
  PopoverSurface,
  Checkbox,
} from '@fluentui/react-components'
import {
  ArrowLeft20Regular,
  ChevronLeft20Regular,
  ChevronRight20Regular,
  Copy20Regular,
  CheckmarkCircle20Regular,
} from '@fluentui/react-icons'
import { MiniCalendar } from './mini-calendar'
import {
  startOfWeek,
  addDays,
  weekDays,
  formatMonthDay,
  formatHeader,
  weekdayLabel,
  fromISO,
  todayISO,
  type Task,
} from '../lib/todo-utils'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalS,
  },
  title: {
    flex: 1,
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  weekBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingBottom: tokens.spacingVerticalS,
  },
  weekLabel: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  list: {
    flex: 1,
    overflowY: 'auto',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingBottom: tokens.spacingVerticalM,
  },
  dayGroup: {
    marginTop: tokens.spacingVerticalM,
  },
  dayLabel: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    paddingLeft: tokens.spacingHorizontalXS,
    paddingBottom: tokens.spacingVerticalXXS,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    minHeight: '40px',
    paddingLeft: tokens.spacingHorizontalXS,
    paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  rowTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowTime: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground4,
  },
  empty: {
    textAlign: 'center',
    color: tokens.colorNeutralForeground4,
    fontSize: tokens.fontSizeBase300,
    paddingTop: tokens.spacingVerticalXXXL,
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
  },
  countText: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
})

type CompletedViewProps = {
  tasks: Task[]
  onBack: () => void
  onToggle: (id: string) => void
}

export function CompletedView({ tasks, onBack, onToggle }: CompletedViewProps) {
  const styles = useStyles()
  const [weekStart, setWeekStart] = React.useState(() => startOfWeek(todayISO()))
  const [copied, setCopied] = React.useState(false)

  const days = React.useMemo(() => weekDays(weekStart), [weekStart])

  const byDay = React.useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const t of tasks) {
      if (!t.done || !t.completedAt) continue
      if (t.completedAt < weekStart || t.completedAt >= addDays(weekStart, 7)) continue
      const arr = map.get(t.completedAt) ?? []
      arr.push(t)
      map.set(t.completedAt, arr)
    }
    return map
  }, [tasks, weekStart])

  const total = React.useMemo(
    () => Array.from(byDay.values()).reduce((n, a) => n + a.length, 0),
    [byDay],
  )

  const weekEnd = addDays(weekStart, 6)
  const rangeLabel = `${formatMonthDay(weekStart)} - ${formatMonthDay(weekEnd)}`

  const copyReport = React.useCallback(async () => {
    const lines: string[] = [`周报（${rangeLabel}）`, '']
    for (const day of days) {
      const items = byDay.get(day)
      if (!items || items.length === 0) continue
      const d = fromISO(day)
      lines.push(`${weekdayLabel(d)} ${formatMonthDay(day)}`)
      for (const it of items) {
        lines.push(`· ${it.title}${it.time ? ` ${it.time}` : ''}`)
      }
      lines.push('')
    }
    lines.push(`合计完成 ${total} 项`)
    const text = lines.join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // clipboard may be unavailable; ignore silently
    }
  }, [byDay, days, rangeLabel, total])

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Button
          appearance="subtle"
          size="small"
          icon={<ArrowLeft20Regular />}
          onClick={onBack}
          aria-label="返回"
        />
        <span className={styles.title}>已完成</span>
        <Button
          appearance="subtle"
          size="small"
          icon={<Copy20Regular />}
          onClick={copyReport}
        >
          {copied ? '已复制' : '周报'}
        </Button>
      </div>

      <div className={styles.weekBar}>
        <Button
          appearance="subtle"
          size="small"
          icon={<ChevronLeft20Regular />}
          onClick={() => setWeekStart((w) => addDays(w, -7))}
          aria-label="上一周"
        />
        <Popover trapFocus>
          <PopoverTrigger disableButtonEnhancement>
            <button type="button" className={styles.weekLabel}>
              {rangeLabel}
            </button>
          </PopoverTrigger>
          <PopoverSurface>
            <MiniCalendar
              value={weekStart}
              highlightWeek
              onChange={(iso) => setWeekStart(startOfWeek(iso))}
            />
          </PopoverSurface>
        </Popover>
        <Button
          appearance="subtle"
          size="small"
          icon={<ChevronRight20Regular />}
          onClick={() => setWeekStart((w) => addDays(w, 7))}
          aria-label="下一周"
        />
      </div>

      <div className={styles.list}>
        {total === 0 && <div className={styles.empty}>本周暂无已完成事项</div>}
        {days.map((day) => {
          const items = byDay.get(day)
          if (!items || items.length === 0) return null
          const d = fromISO(day)
          return (
            <div key={day} className={styles.dayGroup}>
              <div className={styles.dayLabel}>
                {`${weekdayLabel(d)} · ${formatMonthDay(day)}`}
              </div>
              {items.map((t) => (
                <div key={t.id} className={styles.row}>
                  <Checkbox
                    shape="circular"
                    checked
                    onChange={() => onToggle(t.id)}
                    aria-label={`取消完成：${t.title}`}
                  />
                  <span className={styles.rowTitle}>{t.title}</span>
                  {t.time && <span className={styles.rowTime}>{t.time}</span>}
                </div>
              ))}
            </div>
          )
        })}
      </div>

      <div className={styles.footer}>
        <span className={styles.countText}>{`共 ${total} 项`}</span>
        <CheckmarkCircle20Regular color={tokens.colorNeutralForeground4} />
      </div>
    </div>
  )
}
