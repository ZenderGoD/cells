import { useEffect, useMemo, useState } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { Check, Download, ExternalLink, Github, Loader2, RefreshCw, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useStore } from '@/lib/store'
import { terminalThemes } from '@/lib/terminal-themes'
import { cn } from '@/lib/utils'

import { SETTINGS_SHEET_CLASSNAMES } from './settings-layout'
import { Dialog, DialogOverlay, DialogPortal } from '../ui/dialog'

interface AppSettingsProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type SettingsSectionId = 'appearance' | 'canvas' | 'browser' | 'about'

const FONT_SIZES = [11, 12, 13, 14, 15, 16]
const FONT_FAMILIES = [
  { label: 'Geist Mono', value: '"Geist Mono", monospace' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", monospace' },
  { label: 'SF Mono', value: '"SFMono-Regular", monospace' },
  { label: 'Menlo', value: '"Menlo", monospace' },
  { label: 'Fira Code', value: '"Fira Code", monospace' },
]

const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'browser', label: 'Browser' },
  { id: 'about', label: 'About' },
]

export function AppSettings({ open, onOpenChange }: AppSettingsProps) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('appearance')

  const terminalTheme = useStore((s) => s.terminalTheme)
  const fontSize = useStore((s) => s.fontSize)
  const fontFamily = useStore((s) => s.fontFamily)
  const windowOpacity = useStore((s) => s.windowOpacity)
  const snapOnFocus = useStore((s) => s.snapOnFocus)
  const tabSwitchMode = useStore((s) => s.tabSwitchMode)
  const searchEngine = useStore((s) => s.searchEngine)
  const homePage = useStore((s) => s.homePage)
  const setTerminalTheme = useStore((s) => s.setTerminalTheme)
  const setFontSize = useStore((s) => s.setFontSize)
  const setFontFamily = useStore((s) => s.setFontFamily)
  const setWindowOpacity = useStore((s) => s.setWindowOpacity)
  const setSnapOnFocus = useStore((s) => s.setSnapOnFocus)
  const setTabSwitchMode = useStore((s) => s.setTabSwitchMode)
  const setSearchEngine = useStore((s) => s.setSearchEngine)
  const setHomePage = useStore((s) => s.setHomePage)

  const activeSectionLabel = useMemo(
    () =>
      (SETTINGS_SECTIONS.find((section) => section.id === activeSection) ?? SETTINGS_SECTIONS[0])
        .label,
    [activeSection],
  )

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setActiveSection('appearance')
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPortal>
        <DialogOverlay />

        <DialogPrimitive.Popup className={SETTINGS_SHEET_CLASSNAMES.contentPanel}>
          {/* Sidebar nav */}
          <div className="w-[168px] shrink-0 border-r border-border/20 p-3">
            <div className="px-2 pb-3">
              <span className="text-xs font-medium text-foreground">Settings</span>
            </div>
            <nav className="space-y-0.5">
              {SETTINGS_SECTIONS.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setActiveSection(section.id)}
                  className={cn(
                    'w-full rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors',
                    activeSection === section.id
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground/60 hover:bg-muted/30 hover:text-foreground',
                  )}
                >
                  {section.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Content */}
          <div className="flex flex-1 flex-col min-w-0 min-h-0">
            <header className={SETTINGS_SHEET_CLASSNAMES.contentHeader}>
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-medium text-foreground">{activeSectionLabel}</h2>
                <DialogPrimitive.Close
                  data-slot="dialog-close"
                  render={<Button variant="ghost" size="icon-xs" />}
                >
                  <X className="w-2.5 h-2.5" />
                  <span className="sr-only">Close</span>
                </DialogPrimitive.Close>
              </div>
            </header>

            <div className={SETTINGS_SHEET_CLASSNAMES.contentScroll}>
              {activeSection === 'appearance' ? (
                <div className="space-y-5">
                  <SettingsGroup title="Theme">
                    <div className="grid grid-cols-3 gap-1">
                      {Object.entries(terminalThemes).map(([key, theme]) => (
                        <button
                          key={key}
                          onClick={() => setTerminalTheme(key)}
                          className={cn(
                            'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors',
                            key === terminalTheme
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground',
                          )}
                        >
                          <div className="flex shrink-0 gap-0.5">
                            <div
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ background: theme.background }}
                            />
                            <div
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ background: theme.green }}
                            />
                            <div
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ background: theme.blue }}
                            />
                          </div>
                          <span className="truncate">{theme.name}</span>
                        </button>
                      ))}
                    </div>
                  </SettingsGroup>

                  <SettingsGroup title="Font Size">
                    <div className="flex gap-0.5">
                      {FONT_SIZES.map((size) => (
                        <button
                          key={size}
                          onClick={() => setFontSize(size)}
                          className={cn(
                            'rounded-md px-2.5 py-1 text-[11px] tabular-nums transition-colors',
                            size === fontSize
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground',
                          )}
                        >
                          {size}
                        </button>
                      ))}
                    </div>
                  </SettingsGroup>

                  <SettingsGroup title="Font">
                    <div className="space-y-0.5">
                      {FONT_FAMILIES.map((font) => (
                        <button
                          key={font.value}
                          onClick={() => setFontFamily(font.value)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors',
                            fontFamily === font.value
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground',
                          )}
                          style={{ fontFamily: font.value }}
                        >
                          <span className="flex-1">{font.label}</span>
                          {fontFamily === font.value && (
                            <Check className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                          )}
                        </button>
                      ))}
                    </div>
                  </SettingsGroup>

                  <SettingsGroup title="Window Opacity">
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={windowOpacity}
                        onChange={(event) => setWindowOpacity(Number(event.target.value))}
                        className="cells-slider flex-1"
                      />
                      <span className="text-[10px] tabular-nums text-muted-foreground/50 w-6 text-right">
                        {windowOpacity}
                      </span>
                    </div>
                  </SettingsGroup>
                </div>
              ) : null}

              {activeSection === 'canvas' ? (
                <div className="space-y-5">
                  <SettingsGroup title="Snap on Focus">
                    <button
                      onClick={() => setSnapOnFocus(!snapOnFocus)}
                      className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[11px] transition-colors hover:bg-muted/40"
                    >
                      <span className="text-foreground">Animate to window on click</span>
                      <div
                        className={cn(
                          'relative h-3.5 w-6 rounded-full transition-colors',
                          snapOnFocus ? 'bg-primary' : 'bg-muted-foreground/25',
                        )}
                      >
                        <div
                          className={cn(
                            'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-transform',
                            snapOnFocus ? 'translate-x-3' : 'translate-x-0.5',
                          )}
                        />
                      </div>
                    </button>
                  </SettingsGroup>

                  <SettingsGroup title="Ctrl+Tab Order">
                    <div className="space-y-0.5">
                      {[
                        {
                          value: 'chronological' as const,
                          label: 'Static',
                          hint: 'Creation order',
                        },
                        {
                          value: 'recent' as const,
                          label: 'Recent',
                          hint: 'Last focused',
                        },
                      ].map((mode) => (
                        <button
                          key={mode.value}
                          onClick={() => setTabSwitchMode(mode.value)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors',
                            tabSwitchMode === mode.value
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground',
                          )}
                        >
                          <span className="flex-1">{mode.label}</span>
                          <span className="text-[10px] text-muted-foreground/40">{mode.hint}</span>
                          {tabSwitchMode === mode.value && (
                            <Check className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                          )}
                        </button>
                      ))}
                    </div>
                  </SettingsGroup>
                </div>
              ) : null}

              {activeSection === 'browser' ? (
                <div className="space-y-5">
                  <SettingsGroup title="Search Engine">
                    <div className="space-y-0.5">
                      {[
                        { label: 'Google', value: 'https://www.google.com/search?q=%s' },
                        { label: 'DuckDuckGo', value: 'https://duckduckgo.com/?q=%s' },
                        { label: 'Bing', value: 'https://www.bing.com/search?q=%s' },
                        {
                          label: 'Brave Search',
                          value: 'https://search.brave.com/search?q=%s',
                        },
                      ].map((engine) => (
                        <button
                          key={engine.value}
                          onClick={() => setSearchEngine(engine.value)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors',
                            searchEngine === engine.value
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground',
                          )}
                        >
                          <span className="flex-1">{engine.label}</span>
                          {searchEngine === engine.value && (
                            <Check className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                          )}
                        </button>
                      ))}
                    </div>
                  </SettingsGroup>

                  <SettingsGroup title="Home Page">
                    <input
                      type="text"
                      value={homePage}
                      onChange={(event) => setHomePage(event.target.value)}
                      placeholder="Leave empty for new tab"
                      className="w-full rounded-md border border-border/20 bg-background/40 px-2.5 py-1.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/30 focus:border-border/40"
                    />
                  </SettingsGroup>
                </div>
              ) : null}

              {activeSection === 'about' ? <UpdateSection /> : null}
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}

interface SettingsGroupProps {
  title: string
  children: React.ReactNode
}

function SettingsGroup({ title, children }: SettingsGroupProps) {
  return (
    <section>
      <h3 className="mb-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/40">
        {title}
      </h3>
      {children}
    </section>
  )
}

function UpdateSection() {
  const [version, setVersion] = useState('')
  const [status, setStatus] = useState<string>('idle')
  const [updateInfo, setUpdateInfo] = useState<any>(null)
  const [support, setSupport] = useState<{
    enabled: boolean
    reason?: string
    message?: string
  } | null>(null)

  useEffect(() => {
    window.cells.updater.getVersion().then(setVersion)
    window.cells.updater.getSupport().then(setSupport)
    const unsub = window.cells.updater.onStatus((nextStatus, info) => {
      setStatus(nextStatus)
      if (info) setUpdateInfo(info)
    })
    return unsub
  }, [])

  const handleCheck = () => {
    setStatus('checking')
    window.cells.updater.check()
  }

  return (
    <div className="space-y-5">
      <SettingsGroup title="Version">
        <div className="rounded-lg bg-muted/20 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-foreground">Cells v{version}</span>
            {support && !support.enabled ? (
              <span className="text-[10px] text-muted-foreground/50">Manual updates only</span>
            ) : status === 'idle' || status === 'up-to-date' || status === 'error' ? (
              <button
                onClick={handleCheck}
                className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60 transition-colors hover:text-foreground"
              >
                <RefreshCw className="h-2.5 w-2.5" />
                Check for updates
              </button>
            ) : status === 'checking' ? (
              <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                Checking...
              </span>
            ) : status === 'available' ? (
              <button
                onClick={() => window.cells.updater.download()}
                className="flex items-center gap-1.5 text-[10px] text-primary transition-colors hover:text-primary/80"
              >
                <Download className="h-2.5 w-2.5" />
                Download v{updateInfo?.version}
              </button>
            ) : status === 'downloading' ? (
              <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                Downloading {updateInfo?.percent}%
              </span>
            ) : status === 'ready' ? (
              <button
                onClick={() => window.cells.updater.install()}
                className="flex items-center gap-1.5 text-[10px] font-medium text-primary transition-colors hover:text-primary/80"
              >
                <RefreshCw className="h-2.5 w-2.5" />
                Restart to update
              </button>
            ) : null}
          </div>
          {status === 'up-to-date' ? (
            <p className="mt-1.5 text-[10px] text-muted-foreground/40">
              You're on the latest version.
            </p>
          ) : null}
          {support && !support.enabled ? (
            <p className="mt-1.5 text-[10px] text-muted-foreground/40">{support.message}</p>
          ) : null}
          {status === 'error' ? (
            <p className="mt-1.5 text-[10px] text-red-400/60">
              Failed to check: {updateInfo?.message}
            </p>
          ) : null}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Contribute">
        <button
          onClick={() => window.open('https://github.com/xrehpicx/cells', '_blank')}
          className="flex w-full items-center gap-2.5 rounded-lg bg-muted/20 px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
        >
          <Github className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          <div className="flex-1 min-w-0">
            <div className="text-[11px] text-foreground">Help build Cells</div>
            <div className="text-[10px] text-muted-foreground/40 mt-0.5">
              Report bugs, suggest features, or contribute code on GitHub
            </div>
          </div>
          <ExternalLink className="h-2.5 w-2.5 shrink-0 text-muted-foreground/30" />
        </button>
      </SettingsGroup>
    </div>
  )
}
