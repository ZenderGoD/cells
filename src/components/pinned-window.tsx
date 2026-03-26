import { useEffect, useState } from 'react'
import { PinOff } from 'lucide-react'
import { CellTerminal } from './terminal/cell-terminal'
import { useStore } from '@/lib/store'
import { buildWindowAppearanceStyle } from '@/lib/window-appearance'

const TITLE_BAR_HEIGHT = 38

export function PinnedWindow({ termId, type }: { termId: string; type: 'terminal' | 'browser' }) {
  const init = useStore((s) => s.init)
  const initialized = useStore((s) => s.initialized)
  const windowOpacity = useStore((s) => s.windowOpacity)
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight })
  const [title, setTitle] = useState('Terminal')

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
    <div
      className="w-screen h-screen flex flex-col bg-background overflow-hidden"
      style={shellStyle}
    >
      {/* Custom title bar */}
      <div
        className="flex items-center shrink-0 border-b border-border/20 bg-card/60"
        style={{
          height: TITLE_BAR_HEIGHT,
          // @ts-expect-error -- Electron-specific CSS
          WebkitAppRegion: 'drag',
        }}
      >
        {/* Spacer for traffic lights */}
        <div className="w-[78px] shrink-0" />

        <span className="flex-1 text-center text-[11px] font-medium text-muted-foreground truncate select-none">
          {title}
        </span>

        <div
          className="flex items-center gap-1 px-3 shrink-0"
          style={{
            // @ts-expect-error -- Electron-specific CSS
            WebkitAppRegion: 'no-drag',
          }}
        >
          <button
            onClick={() => void window.cells.app.unpinWindow(termId)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] text-muted-foreground/60 hover:text-foreground hover:bg-muted/40 transition-colors"
            title="Unpin back to canvas"
          >
            <PinOff className="w-3 h-3" />
            Unpin
          </button>
        </div>
      </div>

      {/* Terminal content */}
      <div className="flex-1 min-h-0 bg-background">
        <CellTerminal
          termId={termId}
          width={size.width}
          height={size.height - TITLE_BAR_HEIGHT}
          isFocused={true}
          onTitleChange={(newTitle) => {
            setTitle(newTitle)
            document.title = newTitle
          }}
        />
      </div>
    </div>
  )
}
