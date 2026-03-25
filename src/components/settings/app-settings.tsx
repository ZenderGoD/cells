import { useEffect, useMemo, useState } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { Check, Download, Loader2, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useStore } from '@/lib/store'
import { terminalThemes } from '@/lib/terminal-themes'
import { cn } from '@/lib/utils'

import { SETTINGS_SHEET_CLASSNAMES } from './settings-layout'
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '../ui/dialog'

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

const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; label: string; description: string }> = [
  { id: 'appearance', label: 'Appearance', description: 'Theme, font, and window surface.' },
  { id: 'canvas', label: 'Canvas', description: 'Navigation and focus behavior.' },
  { id: 'browser', label: 'Browser', description: 'Search and new-tab preferences.' },
  { id: 'about', label: 'About', description: 'Version and update status.' },
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

  const activeSectionMeta = useMemo(
    () => SETTINGS_SECTIONS.find((section) => section.id === activeSection) ?? SETTINGS_SECTIONS[0],
    [activeSection],
  )

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setActiveSection('appearance')
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPortal>
        <DialogOverlay />

        <aside className={SETTINGS_SHEET_CLASSNAMES.sidebarPanel}>
          <DialogHeader className="px-1 pb-5">
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Configure Cells from a dedicated control rail.</DialogDescription>
          </DialogHeader>

          <nav className="space-y-1.5 overflow-y-auto pr-1">
            {SETTINGS_SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  'w-full rounded-xl border px-3.5 py-3 text-left transition-colors',
                  activeSection === section.id
                    ? 'border-border/70 bg-accent text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]'
                    : 'border-transparent text-muted-foreground hover:border-border/40 hover:bg-muted/40 hover:text-foreground',
                )}
              >
                <div className="text-sm font-medium">{section.label}</div>
                <div className="mt-1 text-[11px] leading-4 text-muted-foreground/75">
                  {section.description}
                </div>
              </button>
            ))}
          </nav>
        </aside>

        <DialogPrimitive.Popup className={SETTINGS_SHEET_CLASSNAMES.contentPanel}>
          <section className="min-w-0">
            <DialogPrimitive.Close
              data-slot="dialog-close"
              render={<Button variant="ghost" className="absolute top-4 right-4" size="icon-sm" />}
            >
              <span aria-hidden="true">×</span>
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>

            <header className={SETTINGS_SHEET_CLASSNAMES.contentHeader}>
              <h2 className="text-[1.9rem] font-semibold tracking-[-0.04em] text-foreground">
                {activeSectionMeta.label}
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                {activeSectionMeta.description}
              </p>
            </header>

            <div className={SETTINGS_SHEET_CLASSNAMES.contentScroll}>
              {activeSection === 'appearance' ? (
                <div className="space-y-6">
                  <SettingsGroup title="Theme" description="Choose the terminal color palette.">
                    <div className="grid grid-cols-3 gap-1.5">
                      {Object.entries(terminalThemes).map(([key, theme]) => (
                        <button
                          key={key}
                          onClick={() => setTerminalTheme(key)}
                          className={cn(
                            'flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
                            key === terminalTheme
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground hover:bg-muted',
                          )}
                        >
                          <div className="flex shrink-0 gap-0.5">
                            <div
                              className="h-2 w-2 rounded-full"
                              style={{ background: theme.background }}
                            />
                            <div
                              className="h-2 w-2 rounded-full"
                              style={{ background: theme.green }}
                            />
                            <div
                              className="h-2 w-2 rounded-full"
                              style={{ background: theme.blue }}
                            />
                          </div>
                          <span className="truncate">{theme.name}</span>
                        </button>
                      ))}
                    </div>
                  </SettingsGroup>

                  <SettingsGroup
                    title="Typography"
                    description="Tune the terminal reading surface."
                  >
                    <div className="space-y-4">
                      <div>
                        <label className="mb-2 block text-xs font-medium text-muted-foreground">
                          Font Size
                        </label>
                        <div className="flex gap-1">
                          {FONT_SIZES.map((size) => (
                            <button
                              key={size}
                              onClick={() => setFontSize(size)}
                              className={cn(
                                'rounded-md px-2.5 py-1 text-xs transition-colors',
                                size === fontSize
                                  ? 'bg-accent text-foreground'
                                  : 'text-muted-foreground hover:bg-muted',
                              )}
                            >
                              {size}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <label className="mb-2 block text-xs font-medium text-muted-foreground">
                          Font
                        </label>
                        <div className="space-y-1">
                          {FONT_FAMILIES.map((font) => (
                            <button
                              key={font.value}
                              onClick={() => setFontFamily(font.value)}
                              className={cn(
                                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
                                fontFamily === font.value
                                  ? 'bg-accent text-foreground'
                                  : 'text-muted-foreground hover:bg-muted',
                              )}
                              style={{ fontFamily: font.value }}
                            >
                              <span className="flex-1">{font.label}</span>
                              {fontFamily === font.value && <Check className="h-3 w-3 shrink-0" />}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </SettingsGroup>

                  <SettingsGroup
                    title="Window Surface"
                    description="Fade the background glass without dimming terminal or browser content."
                  >
                    <SliderRow
                      label={`Window Opacity: ${windowOpacity}`}
                      min={0}
                      max={100}
                      step={1}
                      value={windowOpacity}
                      onChange={setWindowOpacity}
                    />
                  </SettingsGroup>
                </div>
              ) : null}

              {activeSection === 'canvas' ? (
                <div className="space-y-6">
                  <SettingsGroup
                    title="Canvas Motion"
                    description="Control how focus snaps around the workspace."
                  >
                    <button
                      onClick={() => setSnapOnFocus(!snapOnFocus)}
                      className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-xs transition-colors hover:bg-muted"
                    >
                      <span className="text-foreground">Snap on focus</span>
                      <div
                        className={cn(
                          'relative h-4 w-7 rounded-full transition-colors',
                          snapOnFocus ? 'bg-primary' : 'bg-muted-foreground/30',
                        )}
                      >
                        <div
                          className={cn(
                            'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform',
                            snapOnFocus ? 'translate-x-3.5' : 'translate-x-0.5',
                          )}
                        />
                      </div>
                    </button>
                    <p className="mt-1 px-2.5 text-[10px] text-muted-foreground/60">
                      Animate to a terminal when you click on it.
                    </p>

                    <div className="pt-3">
                      <label className="mb-2 block px-2.5 text-[10px] text-muted-foreground/60">
                        Ctrl+Tab order
                      </label>
                      <div className="space-y-1">
                        {[
                          {
                            value: 'chronological' as const,
                            label: 'Static',
                            description: 'Switch by creation order',
                          },
                          {
                            value: 'recent' as const,
                            label: 'Recent',
                            description: 'Switch by last focused',
                          },
                        ].map((mode) => (
                          <button
                            key={mode.value}
                            onClick={() => setTabSwitchMode(mode.value)}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
                              tabSwitchMode === mode.value
                                ? 'bg-accent text-foreground'
                                : 'text-muted-foreground hover:bg-muted',
                            )}
                          >
                            <span className="flex-1">{mode.label}</span>
                            <span className="text-[10px] text-muted-foreground/50">
                              {mode.description}
                            </span>
                            {tabSwitchMode === mode.value ? (
                              <Check className="h-3 w-3 shrink-0" />
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </div>
                  </SettingsGroup>
                </div>
              ) : null}

              {activeSection === 'browser' ? (
                <div className="space-y-6">
                  <SettingsGroup
                    title="Search"
                    description="Choose the default search engine for browser nodes."
                  >
                    <div className="space-y-1">
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
                            'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
                            searchEngine === engine.value
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground hover:bg-muted',
                          )}
                        >
                          <span className="flex-1">{engine.label}</span>
                          {searchEngine === engine.value ? (
                            <Check className="h-3 w-3 shrink-0" />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </SettingsGroup>

                  <SettingsGroup
                    title="New Tab"
                    description="Set an optional home page for new browser nodes."
                  >
                    <input
                      type="text"
                      value={homePage}
                      onChange={(event) => setHomePage(event.target.value)}
                      placeholder="Leave empty for new tab"
                      className="w-full rounded-md border border-border/30 bg-background px-2.5 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/40"
                    />
                  </SettingsGroup>
                </div>
              ) : null}

              {activeSection === 'about' ? <UpdateSection /> : null}
            </div>
          </section>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}

interface SettingsGroupProps {
  title: string
  description?: string
  children: React.ReactNode
}

function SettingsGroup({ title, description, children }: SettingsGroupProps) {
  return (
    <section className="rounded-2xl border border-border/60 bg-muted/12 p-5">
      <div className="mb-4">
        <h3 className="text-base font-medium text-foreground">{title}</h3>
        {description ? (
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  )
}

interface SliderRowProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}

function SliderRow({ label, value, min, max, step, onChange }: SliderRowProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-foreground">{label}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="cells-slider"
      />
    </div>
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
    <div className="space-y-6">
      <SettingsGroup title="Version" description="Current build and update status.">
        <div className="rounded-md bg-muted/30 px-2.5 py-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-foreground">Cells v{version}</span>
            {support && !support.enabled ? (
              <span className="text-[10px] text-muted-foreground">Manual updates only</span>
            ) : status === 'idle' || status === 'up-to-date' || status === 'error' ? (
              <button
                onClick={handleCheck}
                className="flex items-center gap-1.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <RefreshCw className="h-3 w-3" />
                Check for updates
              </button>
            ) : status === 'checking' ? (
              <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Checking...
              </span>
            ) : status === 'available' ? (
              <button
                onClick={() => window.cells.updater.download()}
                className="flex items-center gap-1.5 text-[10px] text-primary transition-colors hover:text-primary/80"
              >
                <Download className="h-3 w-3" />
                Download v{updateInfo?.version}
              </button>
            ) : status === 'downloading' ? (
              <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Downloading {updateInfo?.percent}%
              </span>
            ) : status === 'ready' ? (
              <button
                onClick={() => window.cells.updater.install()}
                className="flex items-center gap-1.5 text-[10px] font-medium text-primary transition-colors hover:text-primary/80"
              >
                <RefreshCw className="h-3 w-3" />
                Restart to update
              </button>
            ) : null}
          </div>
          {status === 'up-to-date' ? (
            <p className="mt-2 text-[10px] text-muted-foreground/50">
              You're on the latest version.
            </p>
          ) : null}
          {support && !support.enabled ? (
            <p className="mt-2 text-[10px] text-muted-foreground/60">{support.message}</p>
          ) : null}
          {status === 'error' ? (
            <p className="mt-2 text-[10px] text-red-400/70">
              Failed to check: {updateInfo?.message}
            </p>
          ) : null}
        </div>
      </SettingsGroup>
    </div>
  )
}
