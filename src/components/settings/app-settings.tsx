import { useCallback, useEffect, useMemo, useState } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import {
  Check,
  Circle,
  Download,
  ExternalLink,
  FolderOpen,
  Github,
  GripVertical,
  KeyRound,
  Loader2,
  PanelsTopLeft,
  Pin,
  PinOff,
  Plus,
  Puzzle,
  RefreshCw,
  Server,
  Skull,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { Reorder } from 'motion/react'

import { AgentIcon } from '@/components/agent-icon'

import type { DaemonStatus, ExtensionMeta, InputPrefix, Project } from '@/types'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useStore } from '@/lib/store'
import { getActiveAppThemeKey, resolveAppColorScheme } from '@/lib/app-themes'
import {
  getTitleBarProjects,
  hasPinnedTitleBarProjects,
  TITLE_BAR_AUTO_PROJECT_LIMIT,
} from '@/lib/project-title-bar'
import { TERMINAL_SESSION_BACKEND_OPTIONS } from '@/lib/terminal-session-backend'
import {
  MAX_TERMINAL_SCROLLBACK_LINES,
  MIN_TERMINAL_SCROLLBACK_LINES,
} from '@/lib/terminal-scrollback'
import { TERMINAL_CURSOR_STYLE_OPTIONS } from '@/lib/terminal-cursor'
import { TERMINAL_FONT_FAMILIES } from '@/lib/terminal-fonts'
import {
  DARK_TERMINAL_THEME_KEYS,
  LIGHT_TERMINAL_THEME_KEYS,
  terminalThemes,
} from '@/lib/terminal-themes'
import { cn } from '@/lib/utils'
import type {
  CanvasSnapMode,
  DwindleForceSplit,
  TitleBarPosition,
  WindowAutoArrangeMode,
} from '@/types'

import { SETTINGS_SHEET_CLASSNAMES } from './settings-layout'
import { NewProjectDialog } from '../new-project-dialog'
import { Dialog, DialogOverlay, DialogPortal } from '../ui/dialog'
import { ScrollArea } from '../ui/scroll-area'

interface AppSettingsProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type SettingsSectionId =
  | 'appearance'
  | 'projects'
  | 'canvas'
  | 'editor'
  | 'terminal'
  | 'browser'
  | 'agents'
  | 'notifications'
  | 'prefixes'
  | 'help'
  | 'about'
type SettingsSelectOption = { value: string; label: string; hint?: string }

const FONT_SIZES = [11, 12, 13, 14, 15, 16]

const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'projects', label: 'Projects' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'editor', label: 'Editor' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'browser', label: 'Browser' },
  { id: 'agents', label: 'Agents' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'prefixes', label: 'Prefixes' },
  { id: 'help', label: 'Help' },
  { id: 'about', label: 'About' },
]

const CURRENT_PROJECT_VALUE = '__current-project__'

const TERMINAL_THEME_SCHEME_TABS = [
  { value: 'dark' as const, label: 'Dark' },
  { value: 'light' as const, label: 'Light' },
]

const TERMINAL_LINK_TARGET_OPTIONS: SettingsSelectOption[] = [
  { value: 'system', label: 'System Browser', hint: 'Default' },
  { value: 'browser', label: 'Built-in Browser', hint: 'Opens a new tab' },
]

const DIRECTORY_LINK_TARGET_OPTIONS: SettingsSelectOption[] = [
  { value: 'finder', label: 'Finder', hint: 'Open the folder in Finder' },
  { value: 'terminal', label: 'New Terminal', hint: 'Open a terminal at that path' },
]

const LINK_RULE_TARGET_OPTIONS: SettingsSelectOption[] = [
  { value: 'system', label: 'System', hint: 'Default browser' },
  { value: 'browser', label: 'Built-in', hint: 'Open in Cells' },
]

const SWITCH_MODE_OPTIONS = [
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
]

const SNAP_MODE_OPTIONS: Array<{ value: CanvasSnapMode; label: string; hint: string }> = [
  { value: 'fill', label: 'Fill', hint: 'Maximize' },
  { value: 'peek', label: 'Peek', hint: 'Show neighbors' },
]

const AUTO_ARRANGE_MODE_OPTIONS: Array<{
  value: WindowAutoArrangeMode
  label: string
  hint: string
}> = [
  { value: 'grid', label: 'Grid', hint: 'Keep rows tidy' },
  { value: 'dwindle', label: 'Sections', hint: 'Hyprland-style splits' },
]

const DWINDLE_FORCE_SPLIT_OPTIONS: Array<{
  value: DwindleForceSplit
  label: string
  hint: string
}> = [
  { value: 'auto', label: 'Auto', hint: 'Use shape' },
  { value: 'right', label: 'Right / Bottom', hint: 'New after' },
  { value: 'left', label: 'Left / Top', hint: 'New before' },
]

const CLOSE_UNDO_TIMEOUT_OPTIONS: SettingsSelectOption[] = [
  { value: '0', label: 'Immediate', hint: 'Delete on close' },
  { value: '5000', label: '5 seconds', hint: 'Short undo window' },
  { value: '15000', label: '15 seconds', hint: 'Default' },
  { value: '30000', label: '30 seconds', hint: 'Safer' },
  { value: '60000', label: '1 minute', hint: 'Longest built-in' },
]

const TITLE_BAR_POSITION_OPTIONS: Array<{
  value: TitleBarPosition
  label: string
  hint: string
}> = [
  { value: 'bottom', label: 'Bottom', hint: 'Current layout' },
  { value: 'top', label: 'Top', hint: 'macOS-style' },
]

export function AppSettings({ open, onOpenChange }: AppSettingsProps) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('appearance')

  const activeProjectId = useStore((s) => s.activeProjectId)
  const appDarkTheme = useStore((s) => s.appDarkTheme)
  const appLightTheme = useStore((s) => s.appLightTheme)
  const terminalTheme = useStore((s) => s.terminalTheme)
  const terminalSessionBackend = useStore((s) => s.terminalSessionBackend)
  const fontSize = useStore((s) => s.fontSize)
  const fontFamily = useStore((s) => s.fontFamily)
  const editorVimMode = useStore((s) => s.editorVimMode)
  const editorVimConfig = useStore((s) => s.editorVimConfig)
  const terminalScrollbackLines = useStore((s) => s.terminalScrollbackLines)
  const terminalCursorStyle = useStore((s) => s.terminalCursorStyle)
  const terminalCursorBlink = useStore((s) => s.terminalCursorBlink)
  const showTerminalHeaderOverlay = useStore((s) => s.showTerminalHeaderOverlay)
  const windowOpacity = useStore((s) => s.windowOpacity)
  const useTransparentWindow = useStore((s) => s.useTransparentWindow)
  const agentWindowColorOpacity = useStore((s) => s.agentWindowColorOpacity)
  const titleBarPosition = useStore((s) => s.titleBarPosition)
  const dimWhenUnfocused = useStore((s) => s.dimWhenUnfocused)
  const snapOnFocus = useStore((s) => s.snapOnFocus)
  const snapMode = useStore((s) => s.snapMode)
  const autoArrangeOnCreate = useStore((s) => s.autoArrangeOnCreate)
  const autoArrangeMode = useStore((s) => s.autoArrangeMode)
  const dwindleLayoutSettings = useStore((s) => s.dwindleLayoutSettings)
  const tabSwitchMode = useStore((s) => s.tabSwitchMode)
  const projectSwitchMode = useStore((s) => s.projectSwitchMode)
  const reducedMotion = useStore((s) => s.reducedMotion)
  const searchEngine = useStore((s) => s.searchEngine)
  const homePage = useStore((s) => s.homePage)
  const agentNotificationSettings = useStore((s) => s.agentNotificationSettings)
  const setTerminalTheme = useStore((s) => s.setTerminalTheme)
  const setAppTheme = useStore((s) => s.setAppTheme)
  const setTerminalSessionBackend = useStore((s) => s.setTerminalSessionBackend)
  const setFontSize = useStore((s) => s.setFontSize)
  const setFontFamily = useStore((s) => s.setFontFamily)
  const setEditorVimMode = useStore((s) => s.setEditorVimMode)
  const setEditorVimConfig = useStore((s) => s.setEditorVimConfig)
  const setTerminalScrollbackLines = useStore((s) => s.setTerminalScrollbackLines)
  const setTerminalCursorStyle = useStore((s) => s.setTerminalCursorStyle)
  const setTerminalCursorBlink = useStore((s) => s.setTerminalCursorBlink)
  const setShowTerminalHeaderOverlay = useStore((s) => s.setShowTerminalHeaderOverlay)
  const setWindowOpacity = useStore((s) => s.setWindowOpacity)
  const setUseTransparentWindow = useStore((s) => s.setUseTransparentWindow)
  const setAgentWindowColorOpacity = useStore((s) => s.setAgentWindowColorOpacity)
  const setTitleBarPosition = useStore((s) => s.setTitleBarPosition)
  const setDimWhenUnfocused = useStore((s) => s.setDimWhenUnfocused)
  const setSnapOnFocus = useStore((s) => s.setSnapOnFocus)
  const setSnapMode = useStore((s) => s.setSnapMode)
  const setAutoArrangeOnCreate = useStore((s) => s.setAutoArrangeOnCreate)
  const setAutoArrangeMode = useStore((s) => s.setAutoArrangeMode)
  const setDwindleLayoutSettings = useStore((s) => s.setDwindleLayoutSettings)
  const setTabSwitchMode = useStore((s) => s.setTabSwitchMode)
  const setProjectSwitchMode = useStore((s) => s.setProjectSwitchMode)
  const setReducedMotion = useStore((s) => s.setReducedMotion)
  const colorScheme = useStore((s) => s.colorScheme)
  const setColorScheme = useStore((s) => s.setColorScheme)
  const setAgentNotificationSettings = useStore((s) => s.setAgentNotificationSettings)
  const setSearchEngine = useStore((s) => s.setSearchEngine)
  const setHomePage = useStore((s) => s.setHomePage)
  const persist = useStore((s) => s.persist)
  const terminalLinkTarget = useStore((s) => s.terminalLinkTarget)
  const terminalLinkProjectId = useStore((s) => s.terminalLinkProjectId)
  const setTerminalLinkTarget = useStore((s) => s.setTerminalLinkTarget)
  const setTerminalLinkProjectId = useStore((s) => s.setTerminalLinkProjectId)
  const linkRules = useStore((s) => s.linkRules)
  const setLinkRules = useStore((s) => s.setLinkRules)
  const directoryLinkTarget = useStore((s) => s.directoryLinkTarget)
  const setDirectoryLinkTarget = useStore((s) => s.setDirectoryLinkTarget)
  const agentAliases = useStore((s) => s.agentAliases)
  const setAgentAliases = useStore((s) => s.setAgentAliases)
  const agentPaths = useStore((s) => s.agentPaths)
  const setAgentPaths = useStore((s) => s.setAgentPaths)
  const enabledAgents = useStore((s) => s.enabledAgents)
  const setEnabledAgents = useStore((s) => s.setEnabledAgents)
  const inputPrefixes = useStore((s) => s.inputPrefixes)
  const setInputPrefixes = useStore((s) => s.setInputPrefixes)
  const saveStatus = useStore((s) => s.saveStatus)
  const closeUndoTimeoutMs = useStore((s) => s.closeUndoTimeoutMs)
  const closeProcessSuppressions = useStore((s) => s.closeProcessSuppressions)
  const setCloseUndoTimeoutMs = useStore((s) => s.setCloseUndoTimeoutMs)
  const setCloseProcessSuppressions = useStore((s) => s.setCloseProcessSuppressions)
  const projects = useStore((s) => s.projects)
  const switchProject = useStore((s) => s.switchProject)
  const reorderProjects = useStore((s) => s.reorderProjects)
  const requestCloseProject = useStore((s) => s.requestCloseProject)
  const setProjectTitleBarPinned = useStore((s) => s.setProjectTitleBarPinned)
  const [showNewProject, setShowNewProject] = useState(false)
  const activeAppThemeKey = useMemo(
    () =>
      getActiveAppThemeKey({
        colorScheme,
        appDarkTheme,
        appLightTheme,
      }),
    [appDarkTheme, appLightTheme, colorScheme],
  )
  const resolvedAppColorScheme = useMemo(() => resolveAppColorScheme(colorScheme), [colorScheme])
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  )
  const pinnedProjectCount = useMemo(
    () => projects.filter((project) => project.titleBarPinned === true).length,
    [projects],
  )
  const visibleTitleBarProjects = useMemo(
    () => getTitleBarProjects(projects, activeProjectId),
    [activeProjectId, projects],
  )
  const [appearanceThemeSchemeTab, setAppearanceThemeSchemeTab] = useState<'dark' | 'light'>(
    terminalThemes[activeAppThemeKey]?.scheme ?? resolvedAppColorScheme,
  )
  const [terminalThemeSchemeTab, setTerminalThemeSchemeTab] = useState<'dark' | 'light'>(
    terminalThemes[terminalTheme]?.scheme ?? 'dark',
  )
  const appearanceVisibleThemeKeys = useMemo(
    () =>
      appearanceThemeSchemeTab === 'dark' ? DARK_TERMINAL_THEME_KEYS : LIGHT_TERMINAL_THEME_KEYS,
    [appearanceThemeSchemeTab],
  )
  const terminalVisibleThemeKeys = useMemo(
    () =>
      terminalThemeSchemeTab === 'dark' ? DARK_TERMINAL_THEME_KEYS : LIGHT_TERMINAL_THEME_KEYS,
    [terminalThemeSchemeTab],
  )

  const projectOptions = useMemo<SettingsSelectOption[]>(
    () => [
      {
        value: CURRENT_PROJECT_VALUE,
        label: 'Current Project',
        hint: activeProject?.name ?? 'Uses the active project',
      },
      ...projects.map((project) => ({
        value: project.id,
        label: project.name,
        hint: project.path || undefined,
      })),
    ],
    [activeProject?.name, projects],
  )

  const activeSectionLabel = useMemo(
    () =>
      (SETTINGS_SECTIONS.find((section) => section.id === activeSection) ?? SETTINGS_SECTIONS[0])
        .label,
    [activeSection],
  )

  const saveBadge = useMemo(() => {
    if (saveStatus === 'saving') {
      return {
        label: 'Saving...',
        icon: <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/60" />,
      }
    }
    if (saveStatus === 'saved') {
      return {
        label: 'Saved',
        icon: <Check className="h-3 w-3 text-emerald-500/80" />,
      }
    }
    if (saveStatus === 'error') {
      return {
        label: 'Save failed',
        icon: <span className="size-1.5 rounded-full bg-destructive/80" />,
      }
    }
    return {
      label: 'Auto-save on',
      icon: <span className="size-1.5 rounded-full bg-emerald-500/70" />,
    }
  }, [saveStatus])

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setActiveSection('appearance')
      setAppearanceThemeSchemeTab(
        terminalThemes[activeAppThemeKey]?.scheme ?? resolvedAppColorScheme,
      )
      setTerminalThemeSchemeTab(terminalThemes[terminalTheme]?.scheme ?? 'dark')
    } else {
      setShowNewProject(false)
    }
    onOpenChange(nextOpen)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogPortal>
          <DialogOverlay />

          <DialogPrimitive.Popup className={SETTINGS_SHEET_CLASSNAMES.contentPanel}>
            {/* Sidebar nav */}
            <div className="w-[152px] shrink-0 border-r border-border/20 p-2.5">
              <div className="px-2 pb-2">
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
                        ? 'bg-accent text-accent-foreground'
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
                  <div className="flex items-center gap-1.5">
                    <div className="inline-flex items-center gap-1.5 rounded-md border border-border/30 bg-background/60 px-2 py-1 text-[10px] text-muted-foreground/70">
                      {saveBadge.icon}
                      <span>{saveBadge.label}</span>
                    </div>
                    <DialogPrimitive.Close
                      data-slot="dialog-close"
                      render={<Button variant="ghost" size="icon-xs" />}
                    >
                      <X className="w-2.5 h-2.5" />
                      <span className="sr-only">Close</span>
                    </DialogPrimitive.Close>
                  </div>
                </div>
              </header>

              <ScrollArea
                className={SETTINGS_SHEET_CLASSNAMES.contentScroll}
                viewportClassName="overflow-x-hidden px-4 py-3 [&>div]:!block [&>div]:min-w-0"
              >
                {activeSection === 'appearance' ? (
                  <div className="space-y-3.5">
                    <SettingsGroup title="Mode">
                      <div className="space-y-0.5">
                        {(
                          [
                            { value: 'light', label: 'Light' },
                            { value: 'dark', label: 'Dark' },
                            { value: 'system', label: 'System' },
                          ] as const
                        ).map((opt) => (
                          <button
                            key={opt.value}
                            onClick={() => setColorScheme(opt.value)}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors',
                              colorScheme === opt.value
                                ? 'bg-accent text-accent-foreground'
                                : 'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground',
                            )}
                          >
                            <span className="flex-1">{opt.label}</span>
                            {colorScheme === opt.value && (
                              <Check className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                            )}
                          </button>
                        ))}
                      </div>
                    </SettingsGroup>

                    <SettingsGroup title="Cells Theme">
                      <div className="space-y-2">
                        <p className="px-0.5 text-[10px] text-muted-foreground/40">
                          Changing the Cells theme also updates Terminal. You can override Terminal
                          separately in Terminal settings afterward.
                        </p>

                        <div className="inline-flex rounded-md border border-border/20 bg-background/40 p-0.5">
                          {TERMINAL_THEME_SCHEME_TABS.map((tab) => (
                            <button
                              key={tab.value}
                              onClick={() => setAppearanceThemeSchemeTab(tab.value)}
                              className={cn(
                                'rounded-[6px] px-2.5 py-1 text-[10px] font-medium transition-colors',
                                appearanceThemeSchemeTab === tab.value
                                  ? 'bg-accent text-accent-foreground'
                                  : 'text-muted-foreground/60 hover:text-foreground',
                              )}
                            >
                              {tab.label}
                            </button>
                          ))}
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          {appearanceVisibleThemeKeys.map((key) => {
                            const theme = terminalThemes[key]
                            const selectedTheme =
                              appearanceThemeSchemeTab === 'dark' ? appDarkTheme : appLightTheme

                            return (
                              <ThemePreviewButton
                                key={key}
                                themeKey={key}
                                selected={key === selectedTheme}
                                active={key === activeAppThemeKey}
                                onClick={() => {
                                  setAppearanceThemeSchemeTab(theme.scheme)
                                  setAppTheme(key)
                                }}
                              />
                            )
                          })}
                        </div>
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

                    <SettingsGroup title="Agent Color Opacity">
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={20}
                          max={100}
                          step={1}
                          value={agentWindowColorOpacity}
                          onChange={(event) =>
                            setAgentWindowColorOpacity(Number(event.target.value))
                          }
                          className="cells-slider flex-1"
                        />
                        <span className="w-8 text-right text-[10px] tabular-nums text-muted-foreground/50">
                          {agentWindowColorOpacity}%
                        </span>
                      </div>
                    </SettingsGroup>

                    <SettingsGroup title="Window Transparency">
                      <div className="space-y-2">
                        <button
                          onClick={() => setUseTransparentWindow(!useTransparentWindow)}
                          className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[11px] transition-colors hover:bg-muted/40"
                        >
                          <div className="flex min-w-0 flex-col items-start gap-0.5 text-left">
                            <span className="text-foreground">Use translucent Electron window</span>
                            <span className="text-[10px] text-muted-foreground/40">
                              Turn this off to reduce WindowServer compositing. Applies after
                              restart.
                            </span>
                          </div>
                          <div
                            className={cn(
                              'relative h-3.5 w-6 rounded-full transition-colors',
                              useTransparentWindow ? 'bg-primary' : 'bg-muted-foreground/25',
                            )}
                          >
                            <div
                              className={cn(
                                'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-background transition-transform',
                                useTransparentWindow ? 'translate-x-3' : 'translate-x-0.5',
                              )}
                            />
                          </div>
                        </button>
                        <div className="flex justify-end px-0.5">
                          <button
                            onClick={() => {
                              persist()
                              window.setTimeout(() => {
                                void window.cells.app.relaunch()
                              }, 150)
                            }}
                            className="rounded-md border border-border/20 bg-background/40 px-2.5 py-1 text-[10px] text-muted-foreground/65 transition-colors hover:bg-muted/40 hover:text-foreground"
                          >
                            Restart now
                          </button>
                        </div>
                      </div>
                    </SettingsGroup>

                    <SettingsGroup title="Title Bar">
                      <div className="space-y-0.5">
                        {TITLE_BAR_POSITION_OPTIONS.map((option) => (
                          <button
                            key={option.value}
                            onClick={() => setTitleBarPosition(option.value)}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors',
                              titleBarPosition === option.value
                                ? 'bg-accent text-accent-foreground'
                                : 'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground',
                            )}
                          >
                            <span className="flex-1">{option.label}</span>
                            <span className="text-[10px] text-muted-foreground/40">
                              {option.hint}
                            </span>
                            {titleBarPosition === option.value && (
                              <Check className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                            )}
                          </button>
                        ))}
                      </div>
                    </SettingsGroup>

                    <SettingsGroup title="Dim When Unfocused">
                      <button
                        onClick={() => setDimWhenUnfocused(!dimWhenUnfocused)}
                        className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[11px] transition-colors hover:bg-muted/40"
                      >
                        <span className="text-foreground">Dim overlay when window loses focus</span>
                        <div
                          className={cn(
                            'relative h-3.5 w-6 rounded-full transition-colors',
                            dimWhenUnfocused ? 'bg-primary' : 'bg-muted-foreground/25',
                          )}
                        >
                          <div
                            className={cn(
                              'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-background transition-transform',
                              dimWhenUnfocused ? 'translate-x-3' : 'translate-x-0.5',
                            )}
                          />
                        </div>
                      </button>
                    </SettingsGroup>
                  </div>
                ) : null}

                {activeSection === 'projects' ? (
                  <ProjectManagerSection
                    projects={projects}
                    activeProjectId={activeProjectId}
                    visibleTitleBarProjects={visibleTitleBarProjects}
                    pinnedProjectCount={pinnedProjectCount}
                    onAddProject={() => setShowNewProject(true)}
                    onSwitchProject={switchProject}
                    onReorderProjects={(nextProjects) =>
                      reorderProjects(nextProjects.map((project) => project.id))
                    }
                    onTogglePinned={setProjectTitleBarPinned}
                    onRequestCloseProject={requestCloseProject}
                  />
                ) : null}

                {activeSection === 'canvas' ? (
                  <div className="space-y-3.5">
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
                              'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-background transition-transform',
                              snapOnFocus ? 'translate-x-3' : 'translate-x-0.5',
                            )}
                          />
                        </div>
                      </button>
                    </SettingsGroup>

                    <SettingsGroup title="Snap Framing">
                      <div className="space-y-0.5">
                        {SNAP_MODE_OPTIONS.map((mode) => (
                          <button
                            key={mode.value}
                            onClick={() => setSnapMode(mode.value)}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors',
                              snapMode === mode.value
                                ? 'bg-accent text-accent-foreground'
                                : 'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground',
                            )}
                          >
                            <span className="flex-1">{mode.label}</span>
                            <span className="text-[10px] text-muted-foreground/40">
                              {mode.hint}
                            </span>
                            {snapMode === mode.value && (
                              <Check className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                            )}
                          </button>
                        ))}
                      </div>
                    </SettingsGroup>

                    <SettingsGroup title="Auto Arrange">
                      <button
                        onClick={() => setAutoArrangeOnCreate(!autoArrangeOnCreate)}
                        className="mb-2 flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[11px] transition-colors hover:bg-muted/40"
                      >
                        <span className="text-foreground">Arrange new windows automatically</span>
                        <div
                          className={cn(
                            'relative h-3.5 w-6 rounded-full transition-colors',
                            autoArrangeOnCreate ? 'bg-primary' : 'bg-muted-foreground/25',
                          )}
                        >
                          <div
                            className={cn(
                              'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-background transition-transform',
                              autoArrangeOnCreate ? 'translate-x-3' : 'translate-x-0.5',
                            )}
                          />
                        </div>
                      </button>
                      <div className="space-y-0.5">
                        {AUTO_ARRANGE_MODE_OPTIONS.map((mode) => (
                          <button
                            key={mode.value}
                            onClick={() => setAutoArrangeMode(mode.value)}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors',
                              autoArrangeMode === mode.value
                                ? 'bg-accent text-accent-foreground'
                                : 'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground',
                            )}
                          >
                            {mode.value === 'dwindle' ? (
                              <PanelsTopLeft className="h-3.5 w-3.5 shrink-0" />
                            ) : null}
                            <span className="flex-1">{mode.label}</span>
                            <span className="text-[10px] text-muted-foreground/40">
                              {mode.hint}
                            </span>
                            {autoArrangeMode === mode.value && (
                              <Check className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                            )}
                          </button>
                        ))}
                      </div>

                      {autoArrangeMode === 'dwindle' ? (
                        <div className="mt-2 space-y-2.5 border-t border-border/40 pt-2">
                          <SettingsField label="New split">
                            <div className="space-y-0.5">
                              {DWINDLE_FORCE_SPLIT_OPTIONS.map((option) => (
                                <button
                                  key={option.value}
                                  onClick={() =>
                                    setDwindleLayoutSettings({ forceSplit: option.value })
                                  }
                                  className={cn(
                                    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors',
                                    dwindleLayoutSettings.forceSplit === option.value
                                      ? 'bg-accent text-accent-foreground'
                                      : 'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground',
                                  )}
                                >
                                  <span className="flex-1">{option.label}</span>
                                  <span className="text-[10px] text-muted-foreground/40">
                                    {option.hint}
                                  </span>
                                  {dwindleLayoutSettings.forceSplit === option.value && (
                                    <Check className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                                  )}
                                </button>
                              ))}
                            </div>
                          </SettingsField>
                          <button
                            onClick={() =>
                              setDwindleLayoutSettings({
                                preserveSplit: !dwindleLayoutSettings.preserveSplit,
                              })
                            }
                            className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[11px] transition-colors hover:bg-muted/40"
                          >
                            <span className="text-foreground">Preserve split direction</span>
                            <div
                              className={cn(
                                'relative h-3.5 w-6 rounded-full transition-colors',
                                dwindleLayoutSettings.preserveSplit
                                  ? 'bg-primary'
                                  : 'bg-muted-foreground/25',
                              )}
                            >
                              <div
                                className={cn(
                                  'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-background transition-transform',
                                  dwindleLayoutSettings.preserveSplit
                                    ? 'translate-x-3'
                                    : 'translate-x-0.5',
                                )}
                              />
                            </div>
                          </button>
                          <SettingsField
                            label="Section padding"
                            hint={`${dwindleLayoutSettings.padding}px`}
                          >
                            <div className="flex items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-muted/40">
                              <input
                                type="range"
                                min={0}
                                max={80}
                                step={1}
                                value={dwindleLayoutSettings.padding}
                                onChange={(event) =>
                                  setDwindleLayoutSettings({
                                    padding: Number(event.currentTarget.value),
                                  })
                                }
                                className="h-4 min-w-0 flex-1 accent-primary"
                              />
                              <input
                                type="number"
                                min={0}
                                max={120}
                                step={1}
                                value={dwindleLayoutSettings.padding}
                                onChange={(event) =>
                                  setDwindleLayoutSettings({
                                    padding: Number(event.currentTarget.value),
                                  })
                                }
                                className="h-6 w-14 rounded border border-border/60 bg-background px-1.5 text-right text-[11px] text-foreground outline-none focus:border-primary/60"
                              />
                            </div>
                          </SettingsField>
                          <SettingsField label="Window gap" hint={`${dwindleLayoutSettings.gap}px`}>
                            <div className="flex items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-muted/40">
                              <input
                                type="range"
                                min={0}
                                max={64}
                                step={1}
                                value={dwindleLayoutSettings.gap}
                                onChange={(event) =>
                                  setDwindleLayoutSettings({
                                    gap: Number(event.currentTarget.value),
                                  })
                                }
                                className="h-4 min-w-0 flex-1 accent-primary"
                              />
                              <input
                                type="number"
                                min={0}
                                max={80}
                                step={1}
                                value={dwindleLayoutSettings.gap}
                                onChange={(event) =>
                                  setDwindleLayoutSettings({
                                    gap: Number(event.currentTarget.value),
                                  })
                                }
                                className="h-6 w-14 rounded border border-border/60 bg-background px-1.5 text-right text-[11px] text-foreground outline-none focus:border-primary/60"
                              />
                            </div>
                          </SettingsField>
                        </div>
                      ) : null}
                    </SettingsGroup>

                    <SettingsGroup title="Switcher Order">
                      <p className="text-[10px] text-muted-foreground/40 mb-3">
                        Configure how the window and project switchers cycle through items. These
                        settings control the behavior when you hold Ctrl and press Tab (for windows)
                        or ` (for projects).
                      </p>
                      <div className="space-y-2.5">
                        <SettingsField label="Ctrl+Tab windows">
                          <div className="space-y-0.5">
                            {SWITCH_MODE_OPTIONS.map((mode) => (
                              <button
                                key={mode.value}
                                onClick={() => setTabSwitchMode(mode.value)}
                                className={cn(
                                  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors',
                                  tabSwitchMode === mode.value
                                    ? 'bg-accent text-accent-foreground'
                                    : 'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground',
                                )}
                              >
                                <span className="flex-1">{mode.label}</span>
                                <span className="text-[10px] text-muted-foreground/40">
                                  {mode.hint}
                                </span>
                                {tabSwitchMode === mode.value && (
                                  <Check className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                                )}
                              </button>
                            ))}
                          </div>
                        </SettingsField>

                        <SettingsField label="Ctrl+` projects">
                          <div className="space-y-0.5">
                            {SWITCH_MODE_OPTIONS.map((mode) => (
                              <button
                                key={mode.value}
                                onClick={() => setProjectSwitchMode(mode.value)}
                                className={cn(
                                  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors',
                                  projectSwitchMode === mode.value
                                    ? 'bg-accent text-accent-foreground'
                                    : 'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground',
                                )}
                              >
                                <span className="flex-1">{mode.label}</span>
                                <span className="text-[10px] text-muted-foreground/40">
                                  {mode.hint}
                                </span>
                                {projectSwitchMode === mode.value && (
                                  <Check className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                                )}
                              </button>
                            ))}
                          </div>
                        </SettingsField>
                      </div>
                    </SettingsGroup>

                    <SettingsGroup title="Animations">
                      <button
                        onClick={() => setReducedMotion(!reducedMotion)}
                        className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[11px] transition-colors hover:bg-muted/40"
                      >
                        <span className="text-foreground">Disable switcher animations</span>
                        <div
                          className={cn(
                            'relative h-3.5 w-6 rounded-full transition-colors',
                            reducedMotion ? 'bg-primary' : 'bg-muted-foreground/25',
                          )}
                        >
                          <div
                            className={cn(
                              'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-background transition-transform',
                              reducedMotion ? 'translate-x-3' : 'translate-x-0.5',
                            )}
                          />
                        </div>
                      </button>
                    </SettingsGroup>
                  </div>
                ) : null}

                {activeSection === 'editor' ? (
                  <div className="space-y-3.5">
                    <SettingsGroup title="Vim">
                      <div className="space-y-2.5">
                        <SettingsField label="Mode" hint={editorVimMode ? 'Enabled' : 'Disabled'}>
                          <SettingsSwitchRow
                            label="Use Vim keybindings"
                            checked={editorVimMode}
                            onToggle={() => setEditorVimMode(!editorVimMode)}
                          />
                        </SettingsField>

                        <SettingsField label="Config" hint="vimrc mappings">
                          <Textarea
                            value={editorVimConfig}
                            onChange={(event) => setEditorVimConfig(event.target.value)}
                            disabled={!editorVimMode}
                            spellCheck={false}
                            placeholder={
                              'let mapleader = " "\nnmap <leader>w :w<CR>\nimap jj <Esc>'
                            }
                            className="min-h-32 resize-y rounded-md border-border/20 bg-background/40 font-mono text-[11px] leading-5 text-foreground placeholder:text-muted-foreground/30 disabled:opacity-45"
                          />
                        </SettingsField>
                      </div>
                    </SettingsGroup>
                  </div>
                ) : null}

                {activeSection === 'terminal' ? (
                  <div className="space-y-3.5">
                    <SettingsGroup title="Theme">
                      <div className="space-y-2">
                        <div className="inline-flex rounded-md border border-border/20 bg-background/40 p-0.5">
                          {TERMINAL_THEME_SCHEME_TABS.map((tab) => (
                            <button
                              key={tab.value}
                              onClick={() => setTerminalThemeSchemeTab(tab.value)}
                              className={cn(
                                'rounded-[6px] px-2.5 py-1 text-[10px] font-medium transition-colors',
                                terminalThemeSchemeTab === tab.value
                                  ? 'bg-accent text-accent-foreground'
                                  : 'text-muted-foreground/60 hover:text-foreground',
                              )}
                            >
                              {tab.label}
                            </button>
                          ))}
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          {terminalVisibleThemeKeys.map((key) => {
                            const theme = terminalThemes[key]
                            return (
                              <ThemePreviewButton
                                key={key}
                                themeKey={key}
                                selected={key === terminalTheme}
                                onClick={() => {
                                  setTerminalThemeSchemeTab(theme.scheme)
                                  setTerminalTheme(key)
                                }}
                              />
                            )
                          })}
                        </div>
                      </div>
                    </SettingsGroup>

                    <SettingsGroup title="Session Backend">
                      <div className="space-y-2.5">
                        <SettingsField
                          label="Backend"
                          hint="Applies after relaunch. New installs and existing profiles use Zellij."
                        >
                          <div className="space-y-0.5">
                            {TERMINAL_SESSION_BACKEND_OPTIONS.map((option) => {
                              const disabled = option.value === 'tmux'
                              return (
                                <button
                                  key={option.value}
                                  disabled={disabled}
                                  onClick={() => {
                                    if (!disabled) setTerminalSessionBackend(option.value)
                                  }}
                                  className={cn(
                                    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors',
                                    terminalSessionBackend === option.value
                                      ? 'bg-accent text-accent-foreground'
                                      : 'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground',
                                    disabled &&
                                      'cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground/70',
                                  )}
                                >
                                  <span className="flex-1">{option.label}</span>
                                  <span className="text-[10px] text-muted-foreground/40">
                                    {option.hint}
                                  </span>
                                  {terminalSessionBackend === option.value && (
                                    <Check className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                                  )}
                                </button>
                              )
                            })}
                          </div>
                        </SettingsField>
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
                                ? 'bg-accent text-accent-foreground'
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
                        {TERMINAL_FONT_FAMILIES.map((font) => (
                          <button
                            key={font.value}
                            onClick={() => setFontFamily(font.value)}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors',
                              fontFamily === font.value
                                ? 'bg-accent text-accent-foreground'
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

                    <SettingsGroup title="Cursor">
                      <div className="space-y-2.5">
                        <SettingsField label="Style">
                          <div className="space-y-0.5">
                            {TERMINAL_CURSOR_STYLE_OPTIONS.map((option) => (
                              <button
                                key={option.value}
                                onClick={() => setTerminalCursorStyle(option.value)}
                                className={cn(
                                  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors',
                                  terminalCursorStyle === option.value
                                    ? 'bg-accent text-accent-foreground'
                                    : 'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground',
                                )}
                              >
                                <span className="flex-1">{option.label}</span>
                                <span className="text-[10px] text-muted-foreground/40">
                                  {option.hint}
                                </span>
                                {terminalCursorStyle === option.value && (
                                  <Check className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                                )}
                              </button>
                            ))}
                          </div>
                        </SettingsField>

                        <SettingsField
                          label="Blink"
                          hint={terminalCursorBlink ? 'Animated' : 'Steady'}
                        >
                          <button
                            onClick={() => setTerminalCursorBlink(!terminalCursorBlink)}
                            className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[11px] transition-colors hover:bg-muted/40"
                          >
                            <span className="text-foreground">Blink terminal cursor</span>
                            <div
                              className={cn(
                                'relative h-3.5 w-6 rounded-full transition-colors',
                                terminalCursorBlink ? 'bg-primary' : 'bg-muted-foreground/25',
                              )}
                            >
                              <div
                                className={cn(
                                  'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-background transition-transform',
                                  terminalCursorBlink ? 'translate-x-3' : 'translate-x-0.5',
                                )}
                              />
                            </div>
                          </button>
                        </SettingsField>

                        <SettingsField
                          label="Window overlay"
                          hint={showTerminalHeaderOverlay ? 'Visible' : 'Hidden'}
                        >
                          <button
                            onClick={() => setShowTerminalHeaderOverlay(!showTerminalHeaderOverlay)}
                            className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[11px] transition-colors hover:bg-muted/40"
                          >
                            <span className="text-foreground">
                              Show terminal top-right controls
                            </span>
                            <div
                              className={cn(
                                'relative h-3.5 w-6 rounded-full transition-colors',
                                showTerminalHeaderOverlay ? 'bg-primary' : 'bg-muted-foreground/25',
                              )}
                            >
                              <div
                                className={cn(
                                  'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-background transition-transform',
                                  showTerminalHeaderOverlay ? 'translate-x-3' : 'translate-x-0.5',
                                )}
                              />
                            </div>
                          </button>
                        </SettingsField>
                      </div>
                    </SettingsGroup>

                    <SettingsGroup title="History">
                      <SettingsField
                        label="Scrollback lines"
                        hint={`${MIN_TERMINAL_SCROLLBACK_LINES.toLocaleString()}-${MAX_TERMINAL_SCROLLBACK_LINES.toLocaleString()}`}
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={MIN_TERMINAL_SCROLLBACK_LINES}
                            max={MAX_TERMINAL_SCROLLBACK_LINES}
                            step={1000}
                            value={terminalScrollbackLines}
                            onChange={(event) =>
                              setTerminalScrollbackLines(Number(event.target.value))
                            }
                            className="h-7 w-28 rounded-md border border-border/20 bg-background/40 px-2.5 text-[11px] text-foreground outline-none focus:border-border/40"
                          />
                          <span className="text-[10px] text-muted-foreground/40">
                            Live terminals rebuild when this changes. Search and reconnect replay
                            use chunked history loads to keep large buffers responsive.
                          </span>
                        </div>
                      </SettingsField>
                    </SettingsGroup>

                    <SettingsGroup title="Close Behavior">
                      <div className="space-y-2.5">
                        <SettingsField
                          label="Undo timeout"
                          hint={
                            closeUndoTimeoutMs > 0
                              ? `Cmd+Shift+T restores for ${Math.round(closeUndoTimeoutMs / 1000)}s`
                              : 'Windows delete immediately'
                          }
                        >
                          <SettingsCombobox
                            value={String(closeUndoTimeoutMs)}
                            options={CLOSE_UNDO_TIMEOUT_OPTIONS}
                            onValueChange={(value) =>
                              setCloseUndoTimeoutMs(Number(value ?? '15000'))
                            }
                            placeholder="Choose undo timeout"
                          />
                        </SettingsField>

                        <SettingsField
                          label="Skip confirmation for"
                          hint={
                            closeProcessSuppressions.length > 0
                              ? `${closeProcessSuppressions.length} saved`
                              : 'Only shells close silently by default'
                          }
                        >
                          {closeProcessSuppressions.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {closeProcessSuppressions.map((process) => (
                                <button
                                  key={process}
                                  onClick={() =>
                                    setCloseProcessSuppressions(
                                      closeProcessSuppressions.filter(
                                        (candidate) => candidate !== process,
                                      ),
                                    )
                                  }
                                  className="inline-flex items-center gap-1 rounded-md border border-border/20 bg-background/40 px-2 py-1 text-[10px] text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground"
                                >
                                  <span>{process}</span>
                                  <X className="h-2.5 w-2.5" />
                                </button>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-md border border-dashed border-border/25 px-2.5 py-2 text-[10px] text-muted-foreground/40">
                              Use the close dialog checkbox to remember a running process.
                            </div>
                          )}
                        </SettingsField>
                      </div>
                    </SettingsGroup>

                    <SettingsGroup title="Link Click Behavior">
                      <div className="space-y-2.5">
                        <SettingsField label="Default target">
                          <SettingsCombobox
                            value={terminalLinkTarget}
                            options={TERMINAL_LINK_TARGET_OPTIONS}
                            onValueChange={(value) =>
                              setTerminalLinkTarget((value as 'system' | 'browser') ?? 'system')
                            }
                            placeholder="Choose where links open"
                          />
                        </SettingsField>

                        <SettingsField
                          label="Built-in browser project"
                          hint={
                            terminalLinkProjectId
                              ? 'Switches to that project before opening the tab'
                              : 'Uses whichever project is active when the link opens'
                          }
                        >
                          <SettingsCombobox
                            value={terminalLinkProjectId ?? CURRENT_PROJECT_VALUE}
                            options={projectOptions}
                            onValueChange={(value) =>
                              setTerminalLinkProjectId(
                                !value || value === CURRENT_PROJECT_VALUE ? null : value,
                              )
                            }
                            placeholder="Choose a project"
                            emptyText="No matching projects"
                            disabled={projects.length === 0}
                          />
                        </SettingsField>

                        <SettingsField
                          label="Directory clicks"
                          hint="Files always open with the system default app"
                        >
                          <SettingsCombobox
                            value={directoryLinkTarget}
                            options={DIRECTORY_LINK_TARGET_OPTIONS}
                            onValueChange={(value) =>
                              setDirectoryLinkTarget((value as 'finder' | 'terminal') ?? 'finder')
                            }
                            placeholder="Choose directory link behavior"
                          />
                        </SettingsField>
                      </div>
                    </SettingsGroup>

                    <SettingsGroup title="Link Rules">
                      <p className="text-[10px] text-muted-foreground/40 mb-3">
                        Route specific URLs to different targets. Uses regex patterns. Rules are
                        matched top to bottom.
                      </p>
                      <div className="space-y-2">
                        {linkRules.map((rule, i) => (
                          <div key={i} className="flex items-center gap-1.5 group">
                            <input
                              type="text"
                              value={rule.pattern}
                              onChange={(e) => {
                                const next = [...linkRules]
                                next[i] = { ...rule, pattern: e.target.value }
                                setLinkRules(next)
                              }}
                              placeholder="e.g. github\.com"
                              className="flex-1 min-w-0 rounded-md border border-border/20 bg-background/40 px-2 py-1 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/30 focus:border-border/40 font-mono"
                            />
                            <SettingsCombobox
                              value={rule.target}
                              options={LINK_RULE_TARGET_OPTIONS}
                              onValueChange={(value) => {
                                const nextTarget = (value as 'system' | 'browser') ?? 'system'
                                const next = [...linkRules]
                                next[i] = {
                                  ...rule,
                                  target: nextTarget,
                                  projectId: nextTarget === 'system' ? undefined : rule.projectId,
                                }
                                setLinkRules(next)
                              }}
                              placeholder="Target"
                              className="w-[112px] shrink-0"
                            />
                            {rule.target === 'browser' && (
                              <SettingsCombobox
                                value={rule.projectId ?? CURRENT_PROJECT_VALUE}
                                options={projectOptions}
                                onValueChange={(value) => {
                                  const next = [...linkRules]
                                  next[i] = {
                                    ...rule,
                                    projectId:
                                      !value || value === CURRENT_PROJECT_VALUE ? undefined : value,
                                  }
                                  setLinkRules(next)
                                }}
                                placeholder="Project"
                                emptyText="No matching projects"
                                className="w-[148px] shrink-0"
                              />
                            )}
                            <button
                              onClick={() => setLinkRules(linkRules.filter((_, j) => j !== i))}
                              className="text-muted-foreground/30 hover:text-foreground transition-colors p-0.5"
                            >
                              <X className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        ))}
                        <button
                          onClick={() =>
                            setLinkRules([
                              ...linkRules,
                              {
                                pattern: '',
                                target: terminalLinkTarget,
                                projectId:
                                  terminalLinkTarget === 'browser'
                                    ? (terminalLinkProjectId ?? undefined)
                                    : undefined,
                              },
                            ])
                          }
                          className="text-[10px] text-muted-foreground/50 hover:text-foreground transition-colors"
                        >
                          + Add rule
                        </button>
                      </div>
                    </SettingsGroup>
                  </div>
                ) : null}

                {activeSection === 'browser' ? (
                  <div className="space-y-3.5">
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
                                ? 'bg-accent text-accent-foreground'
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

                    <ExtensionsSection projectId={activeProjectId} />
                  </div>
                ) : null}

                {activeSection === 'agents' ? (
                  <div className="space-y-3.5">
                    <AgentAuthSection />
                    <SettingsGroup title="Command aliases">
                      <p className="text-[10px] text-muted-foreground/40 mb-3">
                        Enable or disable agents and configure custom commands. Aliases are used
                        when launching agents from the command palette and for auto-detection in
                        terminals.
                      </p>
                      <div className="space-y-3">
                        {(
                          [
                            { id: 'claude', label: 'Claude Code', placeholder: 'claude' },
                            { id: 'codex', label: 'Codex', placeholder: 'codex' },
                            { id: 'cursor', label: 'Cursor', placeholder: 'cursor-agent' },
                            { id: 'copilot', label: 'GitHub Copilot', placeholder: 'copilot' },
                            { id: 'opencode', label: 'OpenCode', placeholder: 'opencode' },
                          ] as const
                        ).map(({ id, label, placeholder }) => {
                          const override = enabledAgents[id]
                          const isEnabled =
                            override === true || override === undefined || override === 'auto'
                          return (
                            <div
                              key={id}
                              className="rounded-md border border-border/10 p-2.5 space-y-2"
                            >
                              <button
                                onClick={() => {
                                  const current = enabledAgents[id]
                                  // Toggle: enabled (true/auto/undefined) → false, false → true (force on)
                                  const next =
                                    current === false ? (true as const) : (false as const)
                                  setEnabledAgents({ ...enabledAgents, [id]: next })
                                }}
                                className="flex w-full items-center justify-between text-[11px]"
                              >
                                <span
                                  className={cn(
                                    'text-foreground',
                                    !isEnabled && 'text-muted-foreground/50',
                                  )}
                                >
                                  {label}
                                </span>
                                <div
                                  className={cn(
                                    'relative h-3.5 w-6 rounded-full transition-colors',
                                    isEnabled ? 'bg-primary' : 'bg-muted-foreground/25',
                                  )}
                                >
                                  <div
                                    className={cn(
                                      'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-background transition-transform',
                                      isEnabled ? 'translate-x-3' : 'translate-x-0.5',
                                    )}
                                  />
                                </div>
                              </button>
                              {isEnabled && (
                                <div className="space-y-2">
                                  <div>
                                    <label className="text-[10px] text-muted-foreground/40 mb-1 block">
                                      Command alias
                                    </label>
                                    <input
                                      type="text"
                                      value={agentAliases[id] ?? ''}
                                      onChange={(e) =>
                                        setAgentAliases({ ...agentAliases, [id]: e.target.value })
                                      }
                                      placeholder={placeholder}
                                      className="w-full rounded-md border border-border/20 bg-background/40 px-2.5 py-1.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/30 focus:border-border/40 font-mono"
                                    />
                                  </div>
                                  <div>
                                    <label className="text-[10px] text-muted-foreground/40 mb-1 block">
                                      Custom CLI path
                                    </label>
                                    <input
                                      type="text"
                                      value={agentPaths[id] ?? ''}
                                      onChange={(e) =>
                                        setAgentPaths({ ...agentPaths, [id]: e.target.value })
                                      }
                                      placeholder={`/usr/local/bin/${placeholder}`}
                                      className="w-full rounded-md border border-border/20 bg-background/40 px-2.5 py-1.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/30 focus:border-border/40 font-mono"
                                    />
                                    <p className="mt-1 text-[10px] text-muted-foreground/30">
                                      Override auto-detection with an absolute path to the CLI
                                      binary.
                                    </p>
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </SettingsGroup>
                  </div>
                ) : null}

                {activeSection === 'notifications' ? (
                  <div className="space-y-3.5">
                    <SettingsGroup title="Desktop Notifications">
                      <p className="mb-3 text-[10px] text-muted-foreground/40">
                        Native macOS notifications for agent sessions. Cells only sends them on
                        meaningful state changes, not on every streaming update. Smart delivery only
                        suppresses alerts when the exact agent window is already focused.
                      </p>
                      <div className="space-y-2.5">
                        <SettingsField
                          label="Agent notifications"
                          hint={agentNotificationSettings.enabled ? 'Enabled' : 'Disabled'}
                        >
                          <SettingsSwitchRow
                            label="Send system notifications for agent events"
                            checked={agentNotificationSettings.enabled}
                            onToggle={() =>
                              setAgentNotificationSettings({
                                enabled: !agentNotificationSettings.enabled,
                              })
                            }
                          />
                        </SettingsField>

                        <SettingsField
                          label="Play sound"
                          hint={agentNotificationSettings.playSound ? 'On' : 'Off'}
                        >
                          <SettingsSwitchRow
                            label="Play the system notification sound"
                            checked={agentNotificationSettings.playSound}
                            disabled={!agentNotificationSettings.enabled}
                            onToggle={() =>
                              setAgentNotificationSettings({
                                playSound: !agentNotificationSettings.playSound,
                              })
                            }
                          />
                        </SettingsField>

                        <SettingsField
                          label="Delivery"
                          hint={agentNotificationSettings.onlyWhenUnfocused ? 'Smart' : 'Always'}
                        >
                          <SettingsSwitchRow
                            label="Skip notifications when that agent window is already focused"
                            checked={agentNotificationSettings.onlyWhenUnfocused}
                            disabled={!agentNotificationSettings.enabled}
                            onToggle={() =>
                              setAgentNotificationSettings({
                                onlyWhenUnfocused: !agentNotificationSettings.onlyWhenUnfocused,
                              })
                            }
                          />
                        </SettingsField>
                      </div>
                    </SettingsGroup>

                    <SettingsGroup title="Notify When">
                      <div className="space-y-2.5">
                        <SettingsField
                          label="Turn complete"
                          hint={agentNotificationSettings.notifyOnDone ? 'On' : 'Off'}
                        >
                          <SettingsSwitchRow
                            label="An agent finishes a turn"
                            checked={agentNotificationSettings.notifyOnDone}
                            disabled={!agentNotificationSettings.enabled}
                            onToggle={() =>
                              setAgentNotificationSettings({
                                notifyOnDone: !agentNotificationSettings.notifyOnDone,
                              })
                            }
                          />
                        </SettingsField>

                        <SettingsField
                          label="Needs attention"
                          hint={agentNotificationSettings.notifyOnAttention ? 'On' : 'Off'}
                        >
                          <SettingsSwitchRow
                            label="An agent asks a question, requests approval, or proposes a plan"
                            checked={agentNotificationSettings.notifyOnAttention}
                            disabled={!agentNotificationSettings.enabled}
                            onToggle={() =>
                              setAgentNotificationSettings({
                                notifyOnAttention: !agentNotificationSettings.notifyOnAttention,
                              })
                            }
                          />
                        </SettingsField>

                        <SettingsField
                          label="Errors"
                          hint={agentNotificationSettings.notifyOnError ? 'On' : 'Off'}
                        >
                          <SettingsSwitchRow
                            label="An agent turn fails"
                            checked={agentNotificationSettings.notifyOnError}
                            disabled={!agentNotificationSettings.enabled}
                            onToggle={() =>
                              setAgentNotificationSettings({
                                notifyOnError: !agentNotificationSettings.notifyOnError,
                              })
                            }
                          />
                        </SettingsField>

                        <SettingsField
                          label="Queued message starts"
                          hint={agentNotificationSettings.notifyOnQueuedStart ? 'On' : 'Off'}
                        >
                          <SettingsSwitchRow
                            label="A queued message begins running (silent, no sound)"
                            checked={agentNotificationSettings.notifyOnQueuedStart}
                            disabled={!agentNotificationSettings.enabled}
                            onToggle={() =>
                              setAgentNotificationSettings({
                                notifyOnQueuedStart: !agentNotificationSettings.notifyOnQueuedStart,
                              })
                            }
                          />
                        </SettingsField>
                      </div>
                    </SettingsGroup>

                    <SettingsGroup title="Preview">
                      <button
                        type="button"
                        onClick={() =>
                          void window.cells.app.showNotification(
                            'Cells test notification',
                            'Agent notifications are configured and working.',
                            {
                              playSound: agentNotificationSettings.playSound,
                            },
                          )
                        }
                        className="flex w-full items-center justify-between rounded-lg bg-muted/20 px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
                      >
                        <div>
                          <div className="text-[11px] text-foreground">Send test notification</div>
                          <div className="mt-0.5 text-[10px] text-muted-foreground/40">
                            Uses the current sound setting.
                          </div>
                        </div>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                      </button>
                    </SettingsGroup>
                  </div>
                ) : null}

                {activeSection === 'prefixes' ? (
                  <div className="space-y-3.5">
                    <SettingsGroup title="Input Prefixes">
                      <p className="text-[10px] text-muted-foreground/40 mb-3">
                        Prefixes let you route command palette input directly to a terminal,
                        browser, or AI agent. For example, typing{' '}
                        <code className="font-mono text-foreground/60">!ls -la</code> runs the
                        command in a new terminal.
                      </p>
                      <div className="space-y-2">
                        {inputPrefixes.map((p, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <input
                              type="text"
                              value={p.prefix}
                              onChange={(e) => {
                                const updated = [...inputPrefixes]
                                updated[i] = { ...updated[i], prefix: e.target.value }
                                setInputPrefixes(updated)
                              }}
                              placeholder="!"
                              className="w-14 rounded-md border border-border/20 bg-background/40 px-2.5 py-1.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/30 focus:border-border/40 font-mono text-center"
                            />
                            <select
                              value={p.target}
                              onChange={(e) => {
                                const updated = [...inputPrefixes]
                                const target = e.target.value as InputPrefix['target']
                                updated[i] = {
                                  ...updated[i],
                                  target,
                                  agentId: target === 'agent' ? 'claude' : undefined,
                                }
                                setInputPrefixes(updated)
                              }}
                              className="flex-1 rounded-md border border-border/20 bg-background/40 px-2.5 py-1.5 text-[11px] text-foreground outline-none focus:border-border/40"
                            >
                              <option value="terminal">Terminal</option>
                              <option value="browser">Browser</option>
                              <option value="agent">Agent</option>
                            </select>
                            {p.target === 'agent' && (
                              <select
                                value={p.agentId ?? 'claude'}
                                onChange={(e) => {
                                  const updated = [...inputPrefixes]
                                  updated[i] = { ...updated[i], agentId: e.target.value }
                                  setInputPrefixes(updated)
                                }}
                                className="w-24 rounded-md border border-border/20 bg-background/40 px-2.5 py-1.5 text-[11px] text-foreground outline-none focus:border-border/40"
                              >
                                <option value="claude">Claude</option>
                                <option value="codex">Codex</option>
                                <option value="cursor">Cursor</option>
                                <option value="copilot">Copilot</option>
                                <option value="opencode">OpenCode</option>
                                <option value="pi">Pi</option>
                              </select>
                            )}
                            <button
                              onClick={() => {
                                setInputPrefixes(inputPrefixes.filter((_, j) => j !== i))
                              }}
                              className="p-1 rounded-md text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                        <button
                          onClick={() => {
                            setInputPrefixes([...inputPrefixes, { prefix: '', target: 'terminal' }])
                          }}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] text-muted-foreground/50 hover:text-foreground hover:bg-muted/40 transition-colors"
                        >
                          <Plus className="w-3 h-3" />
                          Add prefix
                        </button>
                      </div>
                    </SettingsGroup>
                  </div>
                ) : null}

                {activeSection === 'help' ? <HelpSection /> : null}

                {activeSection === 'about' ? (
                  <div className="space-y-6">
                    <UpdateSection />
                    <DaemonSection />
                  </div>
                ) : null}
              </ScrollArea>
            </div>
          </DialogPrimitive.Popup>
        </DialogPortal>
      </Dialog>
      <NewProjectDialog open={showNewProject} onOpenChange={setShowNewProject} />
    </>
  )
}

interface SettingsGroupProps {
  title: string
  children: React.ReactNode
}

interface SettingsFieldProps {
  label: string
  hint?: string
  children: React.ReactNode
}

function ProjectManagerSection({
  projects,
  activeProjectId,
  visibleTitleBarProjects,
  pinnedProjectCount,
  onAddProject,
  onSwitchProject,
  onReorderProjects,
  onTogglePinned,
  onRequestCloseProject,
}: {
  projects: Project[]
  activeProjectId: string | null
  visibleTitleBarProjects: Project[]
  pinnedProjectCount: number
  onAddProject: () => void
  onSwitchProject: (id: string) => void
  onReorderProjects: (projects: Project[]) => void
  onTogglePinned: (id: string, pinned: boolean) => void
  onRequestCloseProject: (id: string) => Promise<void>
}) {
  const titleBarMode = hasPinnedTitleBarProjects(projects)
    ? `${pinnedProjectCount} pinned`
    : projects.length <= TITLE_BAR_AUTO_PROJECT_LIMIT
      ? 'Auto: all projects'
      : 'Auto: active project'
  const visibleNames = visibleTitleBarProjects.map((project) => project.name).join(', ')

  return (
    <div className="space-y-3.5">
      <SettingsGroup title="Project Manager">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 rounded-md border border-border/20 bg-background/35 px-2.5 py-2">
            <div className="min-w-0">
              <div className="text-[11px] text-foreground">Title bar projects</div>
              <div className="mt-0.5 truncate text-[10px] text-muted-foreground/40">
                {visibleNames || 'No projects visible'}
              </div>
            </div>
            <span className="shrink-0 rounded-md bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground/60">
              {titleBarMode}
            </span>
          </div>

          <button
            type="button"
            onClick={onAddProject}
            className="flex h-8 w-full items-center justify-center gap-2 rounded-md border border-border/25 bg-background/40 text-[11px] text-foreground transition-colors hover:bg-muted/40"
          >
            <Plus className="h-3 w-3 text-muted-foreground" />
            Add project
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Projects">
        {projects.length > 0 ? (
          <Reorder.Group
            axis="y"
            values={projects}
            onReorder={onReorderProjects}
            className="space-y-1"
          >
            {projects.map((project) => {
              const isActive = project.id === activeProjectId
              const isPinned = project.titleBarPinned === true
              const windowCount =
                (project.terminals?.length ?? 0) +
                (project.browsers?.length ?? 0) +
                (project.agentWindows?.length ?? 0)

              return (
                <Reorder.Item
                  key={project.id}
                  value={project}
                  className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] transition-colors hover:bg-muted/35"
                >
                  <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground/30 group-active:cursor-grabbing" />

                  <button
                    type="button"
                    onClick={() => onSwitchProject(project.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground/35" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-foreground">{project.name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground/35">
                        {project.path || 'No folder path'}
                      </span>
                    </span>
                  </button>

                  {isActive ? (
                    <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary/80">
                      Active
                    </span>
                  ) : null}

                  {windowCount > 0 ? (
                    <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/35">
                      {windowCount}
                    </span>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => onTogglePinned(project.id, !isPinned)}
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-md transition-colors',
                      isPinned
                        ? 'bg-primary/10 text-primary/80 hover:bg-primary/15'
                        : 'text-muted-foreground/35 hover:bg-muted/50 hover:text-foreground',
                    )}
                    title={isPinned ? 'Unpin from title bar' : 'Pin to title bar'}
                  >
                    {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => void onRequestCloseProject(project.id)}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/35 transition-colors hover:bg-destructive/10 hover:text-destructive"
                    title="Remove project"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </Reorder.Item>
              )
            })}
          </Reorder.Group>
        ) : (
          <p className="px-2 py-1.5 text-[10px] text-muted-foreground/35">
            Add a project to start using Cells.
          </p>
        )}
      </SettingsGroup>
    </div>
  )
}

function ThemePreviewButton({
  themeKey,
  selected,
  active = false,
  onClick,
}: {
  themeKey: string
  selected: boolean
  active?: boolean
  onClick: () => void
}) {
  const theme = terminalThemes[themeKey]

  if (!theme) return null

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'group flex h-[82px] min-w-0 flex-col rounded-lg border p-1.5 text-left outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
        selected
          ? 'border-primary/35 bg-accent text-accent-foreground shadow-minimal'
          : 'border-border/20 bg-background/35 text-muted-foreground/75 hover:border-border/45 hover:bg-muted/35 hover:text-foreground',
      )}
    >
      <div
        className="relative h-10 overflow-hidden rounded-md border shadow-minimal"
        style={{
          background: theme.background,
          borderColor: `${theme.foreground}1f`,
          color: theme.foreground,
        }}
      >
        <div
          className="flex h-4 items-center gap-1 border-b px-1.5"
          style={{ borderColor: `${theme.foreground}16` }}
        >
          <span className="size-1 rounded-full" style={{ background: theme.red }} />
          <span className="size-1 rounded-full" style={{ background: theme.yellow }} />
          <span className="size-1 rounded-full" style={{ background: theme.green }} />
        </div>
        <div className="space-y-0.5 px-1.5 py-1 font-mono text-[8.5px] leading-none">
          <div>
            <span style={{ color: theme.blue }}>src</span>
            <span style={{ color: theme.foreground }}>/app.tsx</span>
          </div>
          <div>
            <span style={{ color: theme.green }}>$</span>{' '}
            <span style={{ color: theme.cyan }}>pnpm</span>{' '}
            <span style={{ color: theme.yellow }}>dev</span>
          </div>
        </div>
      </div>

      <div className="mt-1 flex h-2 overflow-hidden rounded-[4px]">
        {[theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan].map(
          (color) => (
            <span key={color} className="min-w-0 flex-1" style={{ background: color }} />
          ),
        )}
      </div>

      <div className="mt-1 flex min-w-0 items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{theme.name}</span>
        {active || selected ? (
          <Check
            className={cn(
              'size-3 shrink-0',
              selected ? 'text-accent-foreground/80' : 'text-muted-foreground/70',
            )}
          />
        ) : null}
      </div>
    </button>
  )
}

type AgentAuthState = {
  agent: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode'
  binaryPath: string | null
  authenticated: boolean | 'unknown'
}

const AGENT_AUTH_ITEMS = [
  { id: 'claude' as const, label: 'Claude Code' },
  { id: 'codex' as const, label: 'Codex' },
  { id: 'cursor' as const, label: 'Cursor' },
  { id: 'copilot' as const, label: 'GitHub Copilot' },
  { id: 'opencode' as const, label: 'OpenCode' },
]
type AgentAuthId = (typeof AGENT_AUTH_ITEMS)[number]['id']

type LoginPhase = 'idle' | 'starting' | 'awaiting_browser' | 'success' | 'failed' | 'cancelled'

function AgentAuthSection() {
  const [statuses, setStatuses] = useState<Record<AgentAuthId, AgentAuthState | null>>({
    claude: null,
    codex: null,
    cursor: null,
    copilot: null,
    opencode: null,
  })
  const [phases, setPhases] = useState<Record<AgentAuthId, LoginPhase>>({
    claude: 'idle',
    codex: 'idle',
    cursor: 'idle',
    copilot: 'idle',
    opencode: 'idle',
  })
  const [errors, setErrors] = useState<Record<AgentAuthId, string | null>>({
    claude: null,
    codex: null,
    cursor: null,
    copilot: null,
    opencode: null,
  })

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      window.cells.agentSession.getAuth('claude'),
      window.cells.agentSession.getAuth('codex'),
      window.cells.agentSession.getAuth('cursor'),
      window.cells.agentSession.getAuth('copilot'),
      window.cells.agentSession.getAuth('opencode'),
    ])
    setStatuses((prev) => ({
      claude: results[0].status === 'fulfilled' ? results[0].value : prev.claude,
      codex: results[1].status === 'fulfilled' ? results[1].value : prev.codex,
      cursor: results[2].status === 'fulfilled' ? results[2].value : prev.cursor,
      copilot: results[3].status === 'fulfilled' ? results[3].value : prev.copilot,
      opencode: results[4].status === 'fulfilled' ? results[4].value : prev.opencode,
    }))
  }, [])

  useEffect(() => {
    void refresh()
    const unsubscribe = window.cells.agentSession.onLoginEvent((event) => {
      setPhases((prev) => ({ ...prev, [event.agent]: event.phase }))
      setErrors((prev) => ({
        ...prev,
        [event.agent]: event.phase === 'failed' ? (event.message ?? 'Sign-in failed') : null,
      }))
      if (event.phase === 'success' || event.phase === 'failed' || event.phase === 'cancelled') {
        setTimeout(() => void refresh(), 250)
      }
    })
    return unsubscribe
  }, [refresh])

  const launchLogin = async (agent: AgentAuthId) => {
    setErrors((prev) => ({ ...prev, [agent]: null }))
    setPhases((prev) => ({ ...prev, [agent]: 'starting' }))
    try {
      await window.cells.agentSession.startLogin(agent)
    } catch (err) {
      setPhases((prev) => ({ ...prev, [agent]: 'failed' }))
      setErrors((prev) => ({
        ...prev,
        [agent]: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  const cancelLogin = (agent: AgentAuthId) => {
    void window.cells.agentSession.cancelLogin(agent)
  }

  return (
    <SettingsGroup title="Accounts">
      <p className="mb-3 max-w-full text-[10px] leading-[1.45] text-muted-foreground/40">
        Cells drives Claude Code, Codex, Cursor, GitHub Copilot, and OpenCode agent sessions. Sign
        in once per provider and every agent window will inherit the credentials.
      </p>
      <div className="max-w-full space-y-2">
        {AGENT_AUTH_ITEMS.map(({ id, label }) => {
          const status = statuses[id]
          const checking = status === null && phases[id] === 'idle'
          const canRunLogin = Boolean(status?.binaryPath)
          const installed =
            canRunLogin ||
            ((id === 'cursor' || id === 'copilot' || id === 'opencode') &&
              status?.authenticated === 'unknown')
          const signedIn = status?.authenticated === true
          const phase = phases[id]
          const errorText = errors[id]
          const isBusy = phase === 'starting' || phase === 'awaiting_browser'

          const stateLabel = checking
            ? 'Checking…'
            : isBusy
              ? phase === 'starting'
                ? 'Starting…'
                : 'Waiting for browser'
              : phase === 'failed'
                ? 'Failed'
                : phase === 'cancelled'
                  ? 'Cancelled'
                  : !installed
                    ? 'Not installed'
                    : signedIn
                      ? 'Signed in'
                      : 'Not signed in'
          const stateTone = checking
            ? 'text-muted-foreground/60'
            : isBusy
              ? 'text-amber-400'
              : phase === 'failed' || phase === 'cancelled'
                ? 'text-red-400'
                : !installed
                  ? 'text-muted-foreground/60'
                  : signedIn
                    ? 'text-emerald-400'
                    : 'text-amber-400'
          const dotTone = checking
            ? 'bg-muted-foreground/40'
            : isBusy
              ? 'bg-amber-400'
              : phase === 'failed' || phase === 'cancelled'
                ? 'bg-red-400'
                : !installed
                  ? 'bg-muted-foreground/40'
                  : signedIn
                    ? 'bg-emerald-400'
                    : 'bg-amber-400'

          return (
            <div
              key={id}
              className="max-w-full overflow-hidden rounded-md border border-border/10 p-2.5"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-foreground/5">
                  <AgentIcon agent={id} className="size-4" />
                </div>
                <div className="min-w-0 flex-1 overflow-hidden">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
                      {label}
                    </span>
                    <span className={cn('inline-flex items-center gap-1 text-[10.5px]', stateTone)}>
                      <span className={cn('size-1.5 rounded-full', dotTone)} />
                      {stateLabel}
                    </span>
                  </div>
                  <div
                    className="mt-0.5 block max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-muted-foreground/50"
                    title={
                      status?.binaryPath ??
                      (id === 'cursor'
                        ? 'Cursor SDK / CURSOR_API_KEY'
                        : id === 'copilot'
                          ? 'GitHub Copilot SDK / CLI'
                          : id === 'opencode'
                            ? 'OpenCode CLI'
                            : 'binary not detected on PATH')
                    }
                  >
                    {status?.binaryPath ??
                      (id === 'cursor'
                        ? 'Cursor SDK / CURSOR_API_KEY'
                        : id === 'copilot'
                          ? 'GitHub Copilot SDK / CLI'
                          : id === 'opencode'
                            ? 'OpenCode CLI'
                            : 'binary not detected on PATH')}
                  </div>
                </div>
                {isBusy ? (
                  <button
                    type="button"
                    onClick={() => cancelLogin(id)}
                    className="inline-flex h-7 w-[78px] shrink-0 items-center justify-center gap-1.5 rounded-md border border-border/30 bg-background/60 px-2 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                  >
                    <Loader2 className="size-3 animate-spin" />
                    <span>Cancel</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void launchLogin(id)}
                    disabled={checking || !canRunLogin}
                    className="inline-flex h-7 w-[78px] shrink-0 items-center justify-center gap-1.5 rounded-md border border-border/30 bg-background/60 px-2 text-[11px] text-foreground transition-colors hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-50"
                    title={
                      checking
                        ? 'Checking sign-in status'
                        : !canRunLogin
                          ? `Install the ${label} CLI first`
                          : signedIn
                            ? 'Re-authenticate'
                            : 'Sign in'
                    }
                  >
                    <KeyRound className="size-3" />
                    <span>{signedIn ? 'Re-auth' : 'Sign in'}</span>
                  </button>
                )}
              </div>
              {errorText ? (
                <div className="mt-2 rounded border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-[10.5px] leading-[1.45] text-red-300">
                  {errorText}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </SettingsGroup>
  )
}

function SettingsGroup({ title, children }: SettingsGroupProps) {
  return (
    <section>
      <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/40">
        {title}
      </h3>
      {children}
    </section>
  )
}

function SettingsField({ label, hint, children }: SettingsFieldProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 px-0.5">
        <span className="text-[10px] text-muted-foreground/50">{label}</span>
        {hint ? <span className="text-[10px] text-muted-foreground/35">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}

function SettingsSwitchRow({
  label,
  checked,
  onToggle,
  disabled = false,
}: {
  label: string
  checked: boolean
  onToggle: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[11px] transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="text-left text-foreground">{label}</span>
      <div
        className={cn(
          'relative h-3.5 w-6 rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-muted-foreground/25',
        )}
      >
        <div
          className={cn(
            'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-background transition-transform',
            checked ? 'translate-x-3' : 'translate-x-0.5',
          )}
        />
      </div>
    </button>
  )
}

interface SettingsComboboxProps {
  value: string | null
  options: SettingsSelectOption[]
  onValueChange: (value: string | null) => void
  placeholder: string
  emptyText?: string
  disabled?: boolean
  className?: string
}

function SettingsCombobox({
  value,
  options,
  onValueChange,
  placeholder,
  emptyText = 'No matches',
  disabled = false,
  className,
}: SettingsComboboxProps) {
  const selectedOption = options.find((option) => option.value === value) ?? null

  return (
    <Combobox<SettingsSelectOption>
      value={selectedOption}
      onValueChange={(next) => onValueChange(next?.value ?? null)}
      itemToStringLabel={(item) => item.label}
      itemToStringValue={(item) => item.value}
      isItemEqualToValue={(item, selected) => item.value === selected.value}
    >
      <ComboboxInput
        disabled={disabled}
        placeholder={placeholder}
        className={cn(
          'w-full border-border/20 bg-background/40 dark:bg-background/40',
          '[&_[data-slot=input-group-control]]:h-7 [&_[data-slot=input-group-control]]:px-2.5 [&_[data-slot=input-group-control]]:text-[11px] [&_[data-slot=input-group-control]]:text-foreground [&_[data-slot=input-group-control]]:placeholder:text-muted-foreground/30 [&_[data-slot=input-group-addon]]:text-muted-foreground/35',
          className,
        )}
      />
      <ComboboxContent>
        <ComboboxEmpty className="py-2 text-[11px]">{emptyText}</ComboboxEmpty>
        <ComboboxList>
          {options.map((option) => (
            <ComboboxItem
              key={option.value}
              value={option}
              className="items-start gap-2 px-2 py-1.5 text-[11px]"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-foreground">{option.label}</div>
                {option.hint ? (
                  <div className="truncate text-[10px] text-muted-foreground/40">{option.hint}</div>
                ) : null}
              </div>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

const SHORTCUT_GROUPS = [
  {
    title: 'General',
    shortcuts: [
      { keys: '⌘ T', action: 'Command palette / New terminal' },
      { keys: '⌘ W', action: 'Close focused window' },
      { keys: '⌘ ⇧ T', action: 'Restore recently closed window' },
      { keys: '⌘ ⇧ P', action: 'Pop out / pop in focused window' },
      { keys: '⌘ ,', action: 'Open settings' },
      { keys: '⌘ Q', action: 'Quit' },
    ],
  },
  {
    title: 'Canvas Navigation',
    shortcuts: [
      { keys: '⌘ ←/→/↑/↓', action: 'Snap to nearest window' },
      { keys: '⌘ Enter', action: 'Snap to focused window' },
      { keys: '⌘ 0', action: 'Zoom to fit focused window' },
      { keys: '⌘ ⇧ Enter', action: 'Resize focused window or section to fill viewport' },
      { keys: '⌘ ⇧ 0', action: 'Resize app to fit focused window' },
      { keys: '⌘ H / J / K / L', action: 'Snap to nearest window left/down/up/right' },
      { keys: '⌘ O / ⌘ ⇧ O', action: 'Zoom to fit all windows' },
      { keys: '⌃ S', action: 'Toggle selection mode' },
      { keys: 'Click + Drag', action: 'Marquee select in selection mode' },
    ],
  },
  {
    title: 'Window Switching',
    shortcuts: [
      { keys: '⌃ Tab', action: 'Cycle forward through windows' },
      { keys: '⌃ ⇧ Tab', action: 'Cycle backward' },
      { keys: 'Release ⌃', action: 'Confirm switch' },
    ],
  },
  {
    title: 'Project Switching',
    shortcuts: [
      { keys: '⌃ `', action: 'Cycle forward through projects' },
      { keys: '⌃ ~', action: 'Cycle backward' },
      { keys: 'Release ⌃', action: 'Confirm project switch' },
      { keys: '⌃ A', action: 'Open project switcher panel' },
      { keys: '1 – 9', action: 'Switch to project by number' },
      { keys: 'Esc', action: 'Close project switcher panel' },
    ],
  },
  {
    title: 'Browser',
    shortcuts: [
      { keys: '⌘ [', action: 'Go back' },
      { keys: '⌘ ]', action: 'Go forward' },
      { keys: '⌘ L', action: 'Focus URL bar' },
      { keys: '⌘ ⇧ C', action: 'Copy current URL' },
      { keys: 'Swipe ←/→', action: 'Navigate back/forward (at scroll edge)' },
    ],
  },
  {
    title: 'Terminal Editing',
    shortcuts: [
      { keys: '⌘ F', action: 'Find in focused terminal' },
      { keys: '⌘ V', action: 'Paste (supports files/images)' },
      { keys: '⌥ ⌫', action: 'Delete word backward' },
      { keys: '⌘ ⌫', action: 'Delete to start of line' },
      { keys: '⌥ ←/→', action: 'Move word left/right' },
      { keys: '⌘ ←/→', action: 'Move to start/end of line' },
      { keys: 'Click link', action: 'Open link (configurable target)' },
    ],
  },
]

const PLAIN_WORDS = new Set([
  '/',
  '–',
  '+',
  'Click',
  'Drag',
  'Swipe',
  'Release',
  'link',
  'in',
  'mode',
])

function ShortcutKeys({ keys }: { keys: string }) {
  const parts = keys.split(' ')
  return (
    <KbdGroup className="ml-3 shrink-0 gap-1">
      {parts.map((part, i) =>
        PLAIN_WORDS.has(part) ? (
          <span key={i} className="text-[10px] text-muted-foreground/40">
            {part}
          </span>
        ) : (
          <Kbd key={i} className="h-auto min-w-0 px-1.5 py-0.5 text-[10px]">
            {part}
          </Kbd>
        ),
      )}
    </KbdGroup>
  )
}

function HelpSection() {
  const openOnboardingGuide = useStore((s) => s.openOnboardingGuide)

  return (
    <div className="space-y-3.5">
      <SettingsGroup title="Getting Started">
        <button
          onClick={() => openOnboardingGuide()}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors text-sm"
        >
          <span className="text-foreground">Keyboard shortcuts guide</span>
          <span className="text-xs text-muted-foreground">View all shortcuts</span>
        </button>
      </SettingsGroup>

      {SHORTCUT_GROUPS.map((group) => (
        <SettingsGroup key={group.title} title={group.title}>
          <div className="space-y-0">
            {group.shortcuts.map((shortcut) => (
              <div
                key={shortcut.keys}
                className="flex items-center justify-between px-2.5 py-1.5 rounded-md text-[11px]"
              >
                <span className="text-muted-foreground/70">{shortcut.action}</span>
                <ShortcutKeys keys={shortcut.keys} />
              </div>
            ))}
          </div>
        </SettingsGroup>
      ))}
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
  const autoUpdate = useStore((s) => s.autoUpdate)
  const setAutoUpdate = useStore((s) => s.setAutoUpdate)

  useEffect(() => {
    window.cells.updater.getVersion().then(setVersion)
    window.cells.updater.getSupport().then(setSupport)
    const unsub = window.cells.updater.onStatus((nextStatus, info) => {
      setStatus(nextStatus)
      if (info) setUpdateInfo(info)
    })
    // Auto-check when the settings dialog opens, unless already in progress
    window.cells.updater.check()
    return unsub
  }, [])

  const handleCheck = () => {
    setStatus('checking')
    window.cells.updater.check()
  }

  return (
    <div className="space-y-3.5">
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
                onClick={() => {
                  setStatus('downloading')
                  window.cells.updater.download()
                }}
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
            ) : status === 'agent-cli-updating' || status === 'agent-cli-updated' ? (
              <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                Updating CLIs...
              </span>
            ) : status === 'agent-cli-complete' || status === 'installing' ? (
              <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                Installing...
              </span>
            ) : null}
          </div>
          {status === 'up-to-date' ? (
            <p className="mt-1.5 text-[10px] text-muted-foreground/40">
              You're on the latest version.
            </p>
          ) : null}
          {status === 'ready' ? (
            <p className="mt-1.5 text-[10px] text-muted-foreground/40">
              Compatible daemon updates keep sessions alive. If an update requires a daemon restart,
              Cells will warn before installing because running processes may be killed.
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

      {support?.enabled ? (
        <SettingsGroup title="Updates">
          <button
            onClick={() => setAutoUpdate(!autoUpdate)}
            className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[11px] transition-colors hover:bg-muted/40"
          >
            <span className="text-foreground">Check for updates on launch</span>
            <div
              className={cn(
                'relative h-3.5 w-6 rounded-full transition-colors',
                autoUpdate ? 'bg-primary' : 'bg-muted-foreground/25',
              )}
            >
              <div
                className={cn(
                  'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-background transition-transform',
                  autoUpdate ? 'translate-x-3' : 'translate-x-0.5',
                )}
              />
            </div>
          </button>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="Contribute">
        <button
          onClick={() => void window.cells.app.repairTerminalFonts()}
          className="flex w-full items-center gap-2.5 rounded-lg bg-muted/20 px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
        >
          <RefreshCw className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          <div className="flex-1 min-w-0">
            <div className="text-[11px] text-foreground">Repair terminal fonts</div>
            <div className="text-[10px] text-muted-foreground/40 mt-0.5">
              Resets cached renderer state, repairs saved terminal font settings, and relaunches
              Cells.
            </div>
          </div>
        </button>

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

interface DaemonSession {
  termId: string
  processInfo: {
    pid: number
    command: string
    label: string
    key: string
    isShell: boolean
  } | null
  subscribed: boolean
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  if (hours < 24) return `${hours}h ${remainMins}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function DaemonSection() {
  const [status, setStatus] = useState<DaemonStatus | null>(null)
  const [sessions, setSessions] = useState<DaemonSession[]>([])
  const [loading, setLoading] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)

  const refresh = useCallback(() => {
    window.cells.daemon.getStatus().then(setStatus)
    window.cells.daemon.listSessions().then(setSessions)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleRestart = async () => {
    setRestarting(true)
    try {
      await window.cells.daemon.restart()
    } finally {
      setRestarting(false)
      setConfirmRestart(false)
      refresh()
    }
  }

  const handleKillAll = async () => {
    setLoading(true)
    try {
      await window.cells.daemon.killAll()
    } finally {
      setLoading(false)
      refresh()
    }
  }

  const handleKillSession = async (termId: string) => {
    await window.cells.daemon.killSession(termId)
    refresh()
  }

  const needsUpdate = status?.restartRecommended ?? false

  return (
    <div className="space-y-3.5">
      <SettingsGroup title="Daemon">
        <div className="rounded-lg bg-muted/20 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="h-3 w-3 text-muted-foreground/60" />
              <span className="text-[11px] text-foreground">PTY Daemon</span>
              {status === null ? (
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground/40">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                </span>
              ) : status.connected ? (
                <span className="flex items-center gap-1 text-[10px] text-emerald-400/70">
                  <Circle className="h-1.5 w-1.5 fill-current" />
                  Connected
                </span>
              ) : status.enabled === false ? (
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground/40">
                  <Circle className="h-1.5 w-1.5 fill-current" />
                  Disabled
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[10px] text-red-400/70">
                  <Circle className="h-1.5 w-1.5 fill-current" />
                  Disconnected
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {restarting ? (
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground/50">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  {needsUpdate ? 'Updating...' : 'Restarting...'}
                </span>
              ) : needsUpdate ? (
                <button
                  onClick={() => setConfirmRestart(true)}
                  className="flex items-center gap-1 text-[10px] text-primary transition-colors hover:text-primary/80"
                >
                  <RefreshCw className="h-2.5 w-2.5" />
                  Update daemon
                </button>
              ) : (
                <button
                  onClick={() => setConfirmRestart(true)}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground/60 transition-colors hover:text-foreground"
                >
                  <RefreshCw className="h-2.5 w-2.5" />
                  Restart
                </button>
              )}
            </div>
          </div>
          {status?.connected ? (
            <div className="mt-1.5 space-y-0.5">
              <p className="text-[10px] text-muted-foreground/40">
                {status.sessionCount} session{status.sessionCount !== 1 ? 's' : ''} managed
                {status.daemonVersion
                  ? ` \u2022 PID ${status.daemonVersion.pid} \u2022 up ${formatUptime(status.daemonVersion.uptime)}`
                  : ''}
              </p>
              {status.daemonVersion?.appVersion ? (
                <p className="text-[10px] text-muted-foreground/40">
                  Daemon v{status.daemonVersion.appVersion}
                  {needsUpdate ? (
                    status.restartReason === 'node-abi-mismatch' ? (
                      <span className="text-amber-400/70">
                        {' '}
                        (ABI {status.daemonVersion.nodeAbi ?? '?'} does not match current ABI{' '}
                        {status.currentNodeAbi})
                      </span>
                    ) : (
                      <span className="text-amber-400/70">
                        {' '}
                        (daemon compatibility mismatch; restart required)
                      </span>
                    )
                  ) : null}
                </p>
              ) : null}
              {status.restartRecommended && status.restartReason === 'node-abi-mismatch' ? (
                <p className="text-[10px] text-amber-400/70">
                  Restart recommended because the daemon is still running on an older runtime ABI.
                </p>
              ) : status.restartRecommended ? (
                <p className="text-[10px] text-amber-400/70">
                  Restart required because the daemon is from an incompatible Cells build.
                </p>
              ) : null}
            </div>
          ) : status ? (
            <p className="mt-1.5 text-[10px] text-muted-foreground/40">
              {status.enabled === false
                ? 'Daemon is not available in this build. Using direct PTY mode.'
                : 'Daemon is not running. Sessions will not persist across restarts.'}
            </p>
          ) : null}
          {confirmRestart && status?.connected ? (
            <div className="mt-2 rounded-md border border-destructive/15 bg-destructive/5 px-2.5 py-2">
              <div className="text-[11px] text-foreground">
                {needsUpdate ? 'Update PTY daemon?' : 'Restart PTY daemon?'}
              </div>
              <div className="mt-1 text-[10px] leading-4 text-muted-foreground/45">
                This will immediately kill {status.sessionCount} daemon-managed process
                {status.sessionCount === 1 ? '' : 'es'}. Their terminal windows and visible
                scrollback stay in place, but every running shell or agent inside those windows will
                stop and need to be relaunched.
              </div>
              <div className="mt-2 flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setConfirmRestart(false)}
                  className="rounded-md border border-border/20 bg-background/40 px-2.5 py-1 text-[10px] text-muted-foreground/65 transition-colors hover:bg-muted/40 hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleRestart}
                  className="rounded-md border border-destructive/20 bg-destructive/10 px-2.5 py-1 text-[10px] text-destructive transition-colors hover:bg-destructive/15"
                >
                  {needsUpdate ? 'Update and kill processes' : 'Restart and kill processes'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </SettingsGroup>

      {sessions.length > 0 ? (
        <SettingsGroup title="Active Sessions">
          <div className="space-y-0.5">
            {sessions.map((session) => (
              <div
                key={session.termId}
                className="flex min-w-0 items-center gap-2 overflow-hidden rounded-md px-2.5 py-1.5 text-[11px] transition-colors hover:bg-muted/40"
              >
                <Terminal className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <span className="block truncate text-foreground">
                    {session.processInfo?.label ?? 'shell'}
                  </span>
                  <div className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground/40 font-mono">
                    <span className="shrink-0">PID {session.processInfo?.pid ?? '?'}</span>
                    {session.processInfo?.command ? (
                      <>
                        <span className="shrink-0">\u2022</span>
                        <span className="min-w-0 flex-1 truncate">
                          {session.processInfo.command}
                        </span>
                      </>
                    ) : null}
                  </div>
                </div>
                {session.subscribed ? (
                  <span className="text-[9px] text-emerald-400/50 shrink-0">active</span>
                ) : (
                  <span className="text-[9px] text-muted-foreground/30 shrink-0">background</span>
                )}
                <button
                  onClick={() => handleKillSession(session.termId)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground/30 transition-colors hover:bg-destructive/20 hover:text-destructive"
                  title="Kill session"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between px-2.5">
            <button
              onClick={refresh}
              className="flex items-center gap-1 text-[10px] text-muted-foreground/40 transition-colors hover:text-foreground"
            >
              <RefreshCw className="h-2 w-2" />
              Refresh
            </button>
            {sessions.length > 0 ? (
              <button
                onClick={handleKillAll}
                disabled={loading}
                className="flex items-center gap-1 text-[10px] text-red-400/60 transition-colors hover:text-red-400"
              >
                {loading ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Skull className="h-2.5 w-2.5" />
                )}
                Kill all sessions
              </button>
            ) : null}
          </div>
        </SettingsGroup>
      ) : status?.connected ? (
        <SettingsGroup title="Active Sessions">
          <p className="px-2.5 py-1.5 text-[10px] text-muted-foreground/40">No active sessions.</p>
        </SettingsGroup>
      ) : null}
    </div>
  )
}

function ExtensionsSection({ projectId }: { projectId: string | null }) {
  const [extensions, setExtensions] = useState<ExtensionMeta[]>([])
  const [projectExtensions, setProjectExtensions] = useState<Record<string, string[]>>({})
  const [extensionInput, setExtensionInput] = useState('')
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const state = await window.cells.extensions.list()
    setExtensions(state.extensions)
    setProjectExtensions(state.projectExtensions)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const isEnabled = (extId: string) => (projectExtensions[projectId ?? ''] ?? []).includes(extId)

  const toggleExtension = async (extId: string) => {
    if (!projectId) return
    const enabled = isEnabled(extId)
    await window.cells.extensions.setEnabled(projectId, extId, !enabled)
    await refresh()
  }

  const handleInstall = async () => {
    const input = extensionInput.trim()
    if (!input) return
    setInstalling(true)
    setError(null)
    try {
      const meta = await window.cells.extensions.install(input)
      setExtensionInput('')
      // Auto-enable for current project
      if (projectId) {
        await window.cells.extensions.setEnabled(projectId, meta.id, true)
      }
      await refresh()
    } catch (err: any) {
      setError(err?.message ?? 'Install failed')
    } finally {
      setInstalling(false)
    }
  }

  const handleUninstall = async (extId: string) => {
    await window.cells.extensions.uninstall(extId)
    await refresh()
  }

  return (
    <SettingsGroup title="Extensions">
      <div className="flex gap-1.5">
        <input
          type="text"
          value={extensionInput}
          onChange={(e) => {
            setExtensionInput(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleInstall()
          }}
          placeholder="Chrome Web Store URL or extension ID"
          className="flex-1 rounded-md border border-border/20 bg-background/40 px-2.5 py-1.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/30 focus:border-border/40"
        />
        <button
          onClick={handleInstall}
          disabled={installing || !extensionInput.trim()}
          className="flex items-center justify-center rounded-md px-2 py-1.5 text-muted-foreground/50 transition-colors hover:text-foreground hover:bg-muted/40 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/50"
        >
          {installing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Download className="h-3 w-3" />
          )}
        </button>
      </div>
      {error && <p className="mt-1 px-0.5 text-[10px] text-red-400/70">{error}</p>}

      <div className="mt-2 space-y-0.5">
        {extensions.map((ext) => (
          <div
            key={ext.id}
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[11px]"
          >
            <Puzzle className="h-3 w-3 shrink-0 text-muted-foreground/30" />
            <span className="flex-1 truncate text-foreground">{ext.name}</span>
            <span className="text-[10px] text-muted-foreground/40">{ext.version}</span>

            {/* Per-project toggle */}
            <button
              onClick={() => toggleExtension(ext.id)}
              className="shrink-0"
              title={isEnabled(ext.id) ? 'Disable for this project' : 'Enable for this project'}
            >
              <div
                className={cn(
                  'relative h-3.5 w-6 rounded-full transition-colors',
                  isEnabled(ext.id) ? 'bg-primary' : 'bg-muted-foreground/25',
                )}
              >
                <div
                  className={cn(
                    'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-background transition-transform',
                    isEnabled(ext.id) ? 'translate-x-3' : 'translate-x-0.5',
                  )}
                />
              </div>
            </button>

            {/* Uninstall */}
            <button
              onClick={() => handleUninstall(ext.id)}
              className="shrink-0 text-muted-foreground/30 transition-colors hover:text-red-400/70"
              title="Uninstall extension"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {extensions.length === 0 && (
          <p className="px-2.5 py-1.5 text-[10px] text-muted-foreground/30">
            No extensions installed. Paste a Chrome Web Store URL above to add one.
          </p>
        )}
      </div>
    </SettingsGroup>
  )
}
