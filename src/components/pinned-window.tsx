import { useEffect, useState } from 'react'
import { ArrowDownLeft } from 'lucide-react'
import { CellTerminal } from './terminal/cell-terminal'
import { useStore } from '@/lib/store'
import { getTerminalTheme } from '@/lib/terminal-themes'
import { hapticBuzz } from '@/lib/haptics'

const TITLE_BAR_HEIGHT = 38

export function PinnedWindow({ termId, type }: { termId: string; type: 'terminal' | 'browser' }) {
  const init = useStore((s) => s.init)
  const initialized = useStore((s) => s.initialized)
  const themeName = useStore((s) => s.terminalTheme)
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight })
  const customTitle = useStore((s) => s.terminals.find((t) => t.id === termId)?.customTitle)
  const [inferredTitle, setInferredTitle] = useState('Terminal')
  const title = customTitle || inferredTitle

  useEffect(() => {
    init()
  }, [init])

  useEffect(() => {
    document.title = title
  }, [title])

  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  if (!initialized) return null

  const theme = getTerminalTheme(themeName)

  // Browser pop-outs are handled by the main process (loads URL directly),
  // so this component only renders for terminal pop-outs.
  if (type === 'browser') return null

  return (
    <div
      className="w-screen h-screen flex flex-col overflow-hidden"
      style={{ background: theme.background }}
    >
      {/* Custom title bar */}
      <div
        className="flex items-center shrink-0"
        style={{
          height: TITLE_BAR_HEIGHT,
          background: theme.background,
          borderBottom: `1px solid ${theme.foreground}12`,
          // @ts-expect-error -- Electron-specific CSS
          WebkitAppRegion: 'drag',
        }}
      >
        {/* Spacer for traffic lights */}
        <div className="w-[78px] shrink-0" />

        <span
          className="flex-1 text-center text-[11px] font-medium truncate select-none"
          style={{ color: theme.foreground, opacity: 0.5 }}
        >
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
            onClick={() => {
              hapticBuzz()
              void window.cells.app.unpinWindow(termId)
            }}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] transition-colors"
            style={{ color: `${theme.foreground}80` }}
            onMouseEnter={(e) => (e.currentTarget.style.color = theme.foreground)}
            onMouseLeave={(e) => (e.currentTarget.style.color = `${theme.foreground}80`)}
            title="Pop back into canvas"
          >
            <ArrowDownLeft className="w-3 h-3" />
            Pop in
          </button>
        </div>
      </div>

      {/* Terminal content */}
      <div className="flex-1 min-h-0" style={{ background: theme.background }}>
        <CellTerminal
          termId={termId}
          width={size.width}
          height={size.height - TITLE_BAR_HEIGHT}
          isFocused={true}
          onTitleChange={(newTitle) => {
            setInferredTitle(newTitle)
            document.title = customTitle || newTitle
          }}
        />
      </div>
    </div>
  )
}
