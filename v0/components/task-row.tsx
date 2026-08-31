'use client'

import * as React from 'react'
import { makeStyles, mergeClasses, tokens, Checkbox } from '@fluentui/react-components'
import { ReOrderDotsVertical20Regular } from '@fluentui/react-icons'
import { isOverdue, type Task } from '../lib/todo-utils'

const useStyles = makeStyles({
  row: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXS,
    minHeight: '44px',
    paddingLeft: tokens.spacingHorizontalXS,
    paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    transitionProperty: 'background-color, opacity',
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
  },
  dragging: {
    opacity: 0.4,
  },
  dropTarget: {
    backgroundColor: tokens.colorSubtleBackgroundHover,
  },
  handle: {
    display: 'flex',
    alignItems: 'center',
    color: tokens.colorNeutralForeground4,
    cursor: 'grab',
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationFaster,
  },
  handleVisible: {
    opacity: 1,
  },
  checkbox: {
    flexShrink: 0,
  },
  main: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    cursor: 'pointer',
    height: '100%',
  },
  title: {
    flex: 1,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  titleDone: {
    color: tokens.colorNeutralForeground4,
    textDecorationLine: 'line-through',
  },
  time: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  timeOverdue: {
    color: tokens.colorStatusDangerForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
})

type TaskRowProps = {
  task: Task
  dragging: boolean
  isDropTarget: boolean
  onToggle: (id: string) => void
  onEdit: (id: string) => void
  onDragStart: (id: string) => void
  onDragEnter: (id: string) => void
  onDragEnd: () => void
}

export function TaskRow({
  task,
  dragging,
  isDropTarget,
  onToggle,
  onEdit,
  onDragStart,
  onDragEnter,
  onDragEnd,
}: TaskRowProps) {
  const styles = useStyles()
  const [hover, setHover] = React.useState(false)
  const overdue = isOverdue(task)

  return (
    <div
      className={mergeClasses(
        styles.row,
        dragging && styles.dragging,
        isDropTarget && styles.dropTarget,
      )}
      role="listitem"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        onDragStart(task.id)
      }}
      onDragEnter={() => onDragEnter(task.id)}
      onDragOver={(e) => e.preventDefault()}
      onDragEnd={onDragEnd}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span
        className={mergeClasses(styles.handle, hover && styles.handleVisible)}
        aria-hidden
      >
        <ReOrderDotsVertical20Regular />
      </span>
      <Checkbox
        className={styles.checkbox}
        shape="circular"
        checked={task.done}
        onChange={() => onToggle(task.id)}
        aria-label={`标记完成：${task.title}`}
      />
      <div
        className={styles.main}
        onClick={() => onEdit(task.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onEdit(task.id)
          }
        }}
      >
        <span
          className={mergeClasses(styles.title, task.done && styles.titleDone)}
        >
          {task.title}
        </span>
        {task.time && (
          <span
            className={mergeClasses(styles.time, overdue && styles.timeOverdue)}
          >
            {task.time}
          </span>
        )}
      </div>
    </div>
  )
}
