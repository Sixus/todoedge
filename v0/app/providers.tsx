'use client'

import * as React from 'react'
import {
  FluentProvider,
  webLightTheme,
  webDarkTheme,
  SSRProvider,
  RendererProvider,
  createDOMRenderer,
  renderToStyleElements,
} from '@fluentui/react-components'
import { useServerInsertedHTML } from 'next/navigation'

type ThemeMode = 'light' | 'dark'
type Material = 'acrylic' | 'solid'

type AppThemeValue = {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  material: Material
  setMaterial: (material: Material) => void
}

const AppThemeContext = React.createContext<AppThemeValue>({
  mode: 'dark',
  setMode: () => {},
  material: 'acrylic',
  setMaterial: () => {},
})

export function useThemeMode() {
  return React.useContext(AppThemeContext)
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [renderer] = React.useState(() => createDOMRenderer())
  const didRenderRef = React.useRef(false)
  const [mode, setMode] = React.useState<ThemeMode>('dark')
  const [material, setMaterial] = React.useState<Material>('acrylic')

  useServerInsertedHTML(() => {
    if (didRenderRef.current) {
      return
    }
    didRenderRef.current = true
    return <>{renderToStyleElements(renderer)}</>
  })

  const value = React.useMemo(
    () => ({ mode, setMode, material, setMaterial }),
    [mode, material],
  )

  return (
    <RendererProvider renderer={renderer}>
      <SSRProvider>
        <AppThemeContext.Provider value={value}>
          <FluentProvider
            theme={mode === 'light' ? webLightTheme : webDarkTheme}
            id="__fluent-root"
          >
            {children}
          </FluentProvider>
        </AppThemeContext.Provider>
      </SSRProvider>
    </RendererProvider>
  )
}
