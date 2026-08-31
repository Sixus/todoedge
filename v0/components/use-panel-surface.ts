'use client'

import * as React from 'react'
import { useThemeMode } from '../app/providers'

/**
 * Computes the panel background per theme (light/dark) and material
 * (acrylic/solid). Acrylic is semi-transparent + blurred so the Mica/acrylic
 * material reads against the desktop wallpaper; solid is fully opaque.
 */
export function usePanelSurface(): React.CSSProperties {
  const { mode, material } = useThemeMode()
  return React.useMemo(() => {
    const isDark = mode === 'dark'
    const border = isDark
      ? '1px solid rgba(255,255,255,0.10)'
      : '1px solid rgba(0,0,0,0.08)'

    if (material === 'solid') {
      return {
        backgroundColor: isDark ? '#2b2b2b' : '#f6f6f6',
        border,
      }
    }
    // acrylic — noticeably translucent
    return {
      backgroundColor: isDark ? 'rgba(32,32,32,0.55)' : 'rgba(244,244,244,0.55)',
      backdropFilter: 'blur(60px) saturate(150%)',
      WebkitBackdropFilter: 'blur(60px) saturate(150%)',
      border,
    }
  }, [mode, material])
}
