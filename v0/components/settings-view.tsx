'use client'

import * as React from 'react'
import { makeStyles, tokens, Button, Switch } from '@fluentui/react-components'
import { ArrowLeft20Regular } from '@fluentui/react-icons'
import { useThemeMode } from '../app/providers'

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
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  body: {
    flex: 1,
    overflowY: 'auto',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalM,
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  itemText: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXXS,
  },
  itemTitle: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
  },
  itemDesc: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
})

type SettingsViewProps = {
  onBack: () => void
}

export function SettingsView({ onBack }: SettingsViewProps) {
  const styles = useStyles()
  const { mode, setMode, material, setMaterial } = useThemeMode()

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
        <span className={styles.title}>设置</span>
      </div>

      <div className={styles.body}>
        <div className={styles.item}>
          <div className={styles.itemText}>
            <span className={styles.itemTitle}>透明材质</span>
            <span className={styles.itemDesc}>
              {material === 'acrylic' ? '亚克力 · 半透明' : '实体 · 不透明'}
            </span>
          </div>
          <Switch
            checked={material === 'acrylic'}
            onChange={(_, d) => setMaterial(d.checked ? 'acrylic' : 'solid')}
            aria-label="切换透明材质"
          />
        </div>

        <div className={styles.item}>
          <div className={styles.itemText}>
            <span className={styles.itemTitle}>深色模式</span>
            <span className={styles.itemDesc}>
              {mode === 'dark' ? '深色主题' : '浅色主题'}
            </span>
          </div>
          <Switch
            checked={mode === 'dark'}
            onChange={(_, d) => setMode(d.checked ? 'dark' : 'light')}
            aria-label="切换深色模式"
          />
        </div>
      </div>
    </div>
  )
}
