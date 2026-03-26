import { useEffect, useState } from 'react'
import { CellTerminal } from './terminal/cell-terminal'
import { useStore } from '@/lib/store'
import { buildWindowAppearanceStyle } from '@/lib/window-appearance'

export function PinnedWindow({ termId, type }: { termId: string; type: 'terminal' | 'browser' }) {
  const init = useStore((s) => s.init)
  const initialized = useStore((s) => s.initialized)
  const windowOpacity = useStore((s) => s.windowOpacity)
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight })

  useEffect(() => {
    init()
  }, [init])

  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  if (!initialized) return null

  const shellStyle = buildWindowAppearanceStyle({ windowOpacity })

  if (type === 'browser') {
    // For browsers, the pinned window just shows a message — the main process
    // could open a standalone browser window in the future
    return (
      <div
        className="w-screen h-screen flex items-center justify-center bg-background"
        style={shellStyle}
      >
        <p className="text-muted-foreground text-sm">Browser pinning coming soon</p>
      </div>
    )
  }

  return (
    <div className="w-screen h-screen" style={shellStyle}>
      <CellTerminal
        termId={termId}
        width={size.width}
        height={size.height}
        isFocused={true}
        onTitleChange={(title) => {
          document.title = title
        }}
      />
    </div>
  )
}
