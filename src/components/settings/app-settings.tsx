import { useState, useEffect } from 'react'
import { useStore } from '@/lib/store'
import { terminalThemes } from '@/lib/terminal-themes'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle, DialogHeader, DialogDescription } from '../ui/dialog'
import { Check, Download, Loader2, RefreshCw } from 'lucide-react'

interface AppSettingsProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const FONT_SIZES = [11, 12, 13, 14, 15, 16]
const FONT_FAMILIES = [
  { label: 'Geist Mono', value: '"Geist Mono", monospace' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", monospace' },
  { label: 'SF Mono', value: '"SFMono-Regular", monospace' },
  { label: 'Menlo', value: '"Menlo", monospace' },
  { label: 'Fira Code', value: '"Fira Code", monospace' },
]

export function AppSettings({ open, onOpenChange }: AppSettingsProps) {
  const terminalTheme = useStore((s) => s.terminalTheme)
  const fontSize = useStore((s) => s.fontSize)
  const fontFamily = useStore((s) => s.fontFamily)
  const snapOnFocus = useStore((s) => s.snapOnFocus)
  const searchEngine = useStore((s) => s.searchEngine)
  const homePage = useStore((s) => s.homePage)
  const setTerminalTheme = useStore((s) => s.setTerminalTheme)
  const setFontSize = useStore((s) => s.setFontSize)
  const setFontFamily = useStore((s) => s.setFontFamily)
  const setSnapOnFocus = useStore((s) => s.setSnapOnFocus)
  const setSearchEngine = useStore((s) => s.setSearchEngine)
  const setHomePage = useStore((s) => s.setHomePage)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Configure terminal and browser.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Theme */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-2 block">Theme</label>
            <div className="grid grid-cols-3 gap-1.5">
              {Object.entries(terminalThemes).map(([key, theme]) => (
                <button
                  key={key}
                  onClick={() => setTerminalTheme(key)}
                  className={cn(
                    'flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs transition-colors text-left',
                    key === terminalTheme
                      ? 'bg-accent text-foreground'
                      : 'hover:bg-muted text-muted-foreground',
                  )}
                >
                  <div className="flex gap-0.5 shrink-0">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ background: theme.background }}
                    />
                    <div className="w-2 h-2 rounded-full" style={{ background: theme.green }} />
                    <div className="w-2 h-2 rounded-full" style={{ background: theme.blue }} />
                  </div>
                  <span className="truncate">{theme.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Font Size */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-2 block">
              Font Size
            </label>
            <div className="flex gap-1">
              {FONT_SIZES.map((size) => (
                <button
                  key={size}
                  onClick={() => setFontSize(size)}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-xs transition-colors',
                    size === fontSize
                      ? 'bg-accent text-foreground'
                      : 'hover:bg-muted text-muted-foreground',
                  )}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>

          {/* Font Family */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-2 block">Font</label>
            <div className="space-y-0.5">
              {FONT_FAMILIES.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setFontFamily(f.value)}
                  className={cn(
                    'flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-xs transition-colors text-left',
                    fontFamily === f.value
                      ? 'bg-accent text-foreground'
                      : 'hover:bg-muted text-muted-foreground',
                  )}
                  style={{ fontFamily: f.value }}
                >
                  <span className="flex-1">{f.label}</span>
                  {fontFamily === f.value && <Check className="w-3 h-3 shrink-0" />}
                </button>
              ))}
            </div>
          </div>

          {/* Canvas */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-2 block">Canvas</label>
            <button
              onClick={() => setSnapOnFocus(!snapOnFocus)}
              className="flex items-center justify-between w-full px-2.5 py-2 rounded-md text-xs hover:bg-muted transition-colors"
            >
              <span className="text-foreground">Snap on focus</span>
              <div
                className={cn(
                  'w-7 h-4 rounded-full transition-colors relative',
                  snapOnFocus ? 'bg-primary' : 'bg-muted-foreground/30',
                )}
              >
                <div
                  className={cn(
                    'absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform',
                    snapOnFocus ? 'translate-x-3.5' : 'translate-x-0.5',
                  )}
                />
              </div>
            </button>
            <p className="text-[10px] text-muted-foreground/50 px-2.5 mt-1">
              Animate to a terminal when you click on it
            </p>
          </div>

          {/* Browser */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-2 block">Browser</label>
            <div className="space-y-2">
              <div>
                <label className="text-[10px] text-muted-foreground/50 px-2.5 block mb-1">
                  Search Engine
                </label>
                <div className="space-y-0.5">
                  {[
                    { label: 'Google', value: 'https://www.google.com/search?q=%s' },
                    { label: 'DuckDuckGo', value: 'https://duckduckgo.com/?q=%s' },
                    { label: 'Bing', value: 'https://www.bing.com/search?q=%s' },
                    { label: 'Brave Search', value: 'https://search.brave.com/search?q=%s' },
                  ].map((engine) => (
                    <button
                      key={engine.value}
                      onClick={() => setSearchEngine(engine.value)}
                      className={cn(
                        'flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-xs transition-colors text-left',
                        searchEngine === engine.value
                          ? 'bg-accent text-foreground'
                          : 'hover:bg-muted text-muted-foreground',
                      )}
                    >
                      <span className="flex-1">{engine.label}</span>
                      {searchEngine === engine.value && <Check className="w-3 h-3 shrink-0" />}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground/50 px-2.5 block mb-1">
                  Home Page
                </label>
                <input
                  type="text"
                  value={homePage}
                  onChange={(e) => setHomePage(e.target.value)}
                  placeholder="Leave empty for new tab"
                  className="w-full px-2.5 py-1.5 rounded-md text-xs bg-background border border-border/30 text-foreground placeholder:text-muted-foreground/40 outline-none"
                />
              </div>
            </div>
          </div>

          {/* Updates */}
          <UpdateSection />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function UpdateSection() {
  const [version, setVersion] = useState('')
  const [status, setStatus] = useState<string>('idle')
  const [updateInfo, setUpdateInfo] = useState<any>(null)

  useEffect(() => {
    window.cells.updater.getVersion().then(setVersion)
    const unsub = window.cells.updater.onStatus((s, info) => {
      setStatus(s)
      if (info) setUpdateInfo(info)
    })
    return unsub
  }, [])

  const handleCheck = () => {
    setStatus('checking')
    window.cells.updater.check()
  }

  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground mb-2 block">About</label>
      <div className="px-2.5 py-2 rounded-md bg-muted/30 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-foreground">Cells v{version}</span>
          {status === 'idle' || status === 'up-to-date' || status === 'error' ? (
            <button
              onClick={handleCheck}
              className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              Check for updates
            </button>
          ) : status === 'checking' ? (
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              Checking...
            </span>
          ) : status === 'available' ? (
            <button
              onClick={() => window.cells.updater.download()}
              className="flex items-center gap-1.5 text-[10px] text-primary hover:text-primary/80 transition-colors"
            >
              <Download className="w-3 h-3" />
              Download v{updateInfo?.version}
            </button>
          ) : status === 'downloading' ? (
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              Downloading {updateInfo?.percent}%
            </span>
          ) : status === 'ready' ? (
            <button
              onClick={() => window.cells.updater.install()}
              className="flex items-center gap-1.5 text-[10px] text-primary font-medium hover:text-primary/80 transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              Restart to update
            </button>
          ) : null}
        </div>
        {status === 'up-to-date' && (
          <p className="text-[10px] text-muted-foreground/50">You're on the latest version.</p>
        )}
        {status === 'error' && (
          <p className="text-[10px] text-red-400/70">Failed to check: {updateInfo?.message}</p>
        )}
      </div>
    </div>
  )
}
