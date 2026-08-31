'use client'

import * as React from 'react'
import { makeStyles, mergeClasses, tokens, Button } from '@fluentui/react-components'
import { ChevronLeft20Regular, ChevronRight20Regular } from '@fluentui/react-icons'
import { toISO, fromISO, todayISO, startOfWeek, isInWeek } from '../lib/todo-utils'

const WEEK_HEADERS = ['一', '二', '三', '四', '五', '六', '日']

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    userSelect: 'none',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  monthLabel: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    rowGap: tokens.spacingVerticalXXS,
  },
  weekHeadCell: {
    textAlign: 'center',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground4,
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
  },
  cell: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '32px',
    borderRadius: tokens.borderRadiusMedium,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    border: 'none',
    backgroundColor: 'transparent',
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationFaster,
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
  },
  muted: {
    color: tokens.colorNeutralForeground4,
  },
  today: {
    fontWeight: tokens.fontWeightBold,
    color: tokens.colorBrandForeground1,
  },
  selected: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    ':hover': {
      backgroundColor: tokens.colorBrandBackgroundHover,
    },
  },
  inWeek: {
    backgroundColor: tokens.colorBrandBackground2,
  },
})

type MiniCalendarProps = {
  value: string
  onChange: (iso: string) => void
  /** Highlight the whole Monday-Sunday week of the value. */
  highlightWeek?: boolean
}

export function MiniCalendar({ value, onChange, highlightWeek = false }: MiniCalendarProps) {
  const styles = useStyles()
  const selected = value
  const [viewMonth, setViewMonth] = React.useState(() => {
    const d = fromISO(value || todayISO())
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })

  React.useEffect(() => {
    if (!value) return
    const d = fromISO(value)
    setViewMonth((prev) =>
      prev.getFullYear() === d.getFullYear() && prev.getMonth() === d.getMonth()
        ? prev
        : new Date(d.getFullYear(), d.getMonth(), 1),
    )
  }, [value])

  const today = todayISO()
  const selWeekStart = highlightWeek && selected ? startOfWeek(selected) : null

  const cells = React.useMemo(() => {
    const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1)
    // Monday-first offset
    const offset = (first.getDay() + 6) % 7
    const gridStart = new Date(first)
    gridStart.setDate(first.getDate() - offset)
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart)
      d.setDate(gridStart.getDate() + i)
      return d
    })
  }, [viewMonth])

  const goPrev = () =>
    setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))
  const goNext = () =>
    setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Button
          appearance="subtle"
          size="small"
          icon={<ChevronLeft20Regular />}
          onClick={goPrev}
          aria-label="上个月"
        />
        <span className={styles.monthLabel}>
          {`${viewMonth.getFullYear()}年 ${viewMonth.getMonth() + 1}月`}
        </span>
        <Button
          appearance="subtle"
          size="small"
          icon={<ChevronRight20Regular />}
          onClick={goNext}
          aria-label="下个月"
        />
      </div>
      <div className={styles.grid}>
        {WEEK_HEADERS.map((w) => (
          <div key={w} className={styles.weekHeadCell}>
            {w}
          </div>
        ))}
        {cells.map((d) => {
          const iso = toISO(d)
          const inMonth = d.getMonth() === viewMonth.getMonth()
          const isSelected = iso === selected
          const isToday = iso === today
          const inWeek =
            selWeekStart != null && isInWeek(iso, selWeekStart) && !isSelected
          return (
            <button
              type="button"
              key={iso}
              className={mergeClasses(
                styles.cell,
                !inMonth && styles.muted,
                isToday && styles.today,
                inWeek && styles.inWeek,
                isSelected && styles.selected,
              )}
              onClick={() => onChange(iso)}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}
