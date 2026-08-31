'use client'

import * as React from 'react'
import {
  makeStyles,
  tokens,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Input,
  Dropdown,
  Option,
  Field,
} from '@fluentui/react-components'
import { MiniCalendar } from './mini-calendar'
import {
  TIME_OPTIONS,
  REPEAT_LABELS,
  nextTimeSlot,
  todayISO,
  type Repeat,
} from '../lib/todo-utils'

export type TaskDialogValues = {
  title: string
  dueDate: string
  time: string | null
  repeat: Repeat
}

const REPEATS: Repeat[] = ['none', 'daily', 'weekly', 'monthly']

const useStyles = makeStyles({
  surface: {
    maxWidth: '360px',
    width: '360px',
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalM,
  },
  pickerRow: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalS,
  },
  pickerCol: {
    flex: 1,
    minWidth: 0,
  },
  dropdown: {
    minWidth: 'unset',
    width: '100%',
  },
  actions: {
    display: 'flex',
    justifyContent: 'space-between',
    width: '100%',
  },
})

type TaskDialogProps = {
  open: boolean
  mode: 'reminder' | 'edit'
  initial: TaskDialogValues
  onConfirm: (values: TaskDialogValues) => void
  onClear: () => void
  onClose: () => void
}

export function TaskDialog({
  open,
  mode,
  initial,
  onConfirm,
  onClear,
  onClose,
}: TaskDialogProps) {
  const styles = useStyles()
  const [title, setTitle] = React.useState(initial.title)
  const [dueDate, setDueDate] = React.useState(initial.dueDate || todayISO())
  const [time, setTime] = React.useState<string | null>(initial.time)
  const [repeat, setRepeat] = React.useState<Repeat>(initial.repeat)

  // Re-seed local state whenever the dialog is (re)opened.
  React.useEffect(() => {
    if (!open) return
    setTitle(initial.title)
    setDueDate(initial.dueDate || todayISO())
    setTime(initial.time ?? nextTimeSlot())
    setRepeat(initial.repeat)
  }, [open, initial])

  const handleConfirm = () => {
    onConfirm({ title: title.trim() || initial.title, dueDate, time, repeat })
  }

  const handleClear = () => {
    setTime(null)
    setRepeat('none')
    onClear()
  }

  return (
    <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>{mode === 'edit' ? '修改任务' : '设置提醒'}</DialogTitle>
          <DialogContent className={styles.content}>
            {mode === 'edit' && (
              <Field label="任务">
                <Input
                  value={title}
                  onChange={(_, d) => setTitle(d.value)}
                  placeholder="任务标题"
                />
              </Field>
            )}

            <MiniCalendar value={dueDate} onChange={setDueDate} />

            <div className={styles.pickerRow}>
              <div className={styles.pickerCol}>
                <Field label="时间">
                  <Dropdown
                    className={styles.dropdown}
                    value={time ?? '无'}
                    selectedOptions={time ? [time] : ['']}
                    onOptionSelect={(_, d) =>
                      setTime(d.optionValue === '' ? null : (d.optionValue ?? null))
                    }
                  >
                    <Option value="" text="无">
                      无
                    </Option>
                    {TIME_OPTIONS.map((t) => (
                      <Option key={t} value={t} text={t}>
                        {t}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>
              <div className={styles.pickerCol}>
                <Field label="重复">
                  <Dropdown
                    className={styles.dropdown}
                    value={REPEAT_LABELS[repeat]}
                    selectedOptions={[repeat]}
                    onOptionSelect={(_, d) =>
                      setRepeat((d.optionValue as Repeat) ?? 'none')
                    }
                  >
                    {REPEATS.map((r) => (
                      <Option key={r} value={r} text={REPEAT_LABELS[r]}>
                        {REPEAT_LABELS[r]}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>
            </div>
          </DialogContent>
          <DialogActions className={styles.actions}>
            <Button appearance="subtle" onClick={handleClear}>
              清除
            </Button>
            <Button appearance="primary" onClick={handleConfirm}>
              确定
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
