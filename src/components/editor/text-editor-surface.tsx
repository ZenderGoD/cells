import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import { initVimMode, type VimAdapterInstance } from 'monaco-vim'
import 'monaco-editor/min/vs/editor/editor.main.css'
import { Loader2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { TextEditorNode } from '@/types'
import { useStore } from '@/lib/store'
import { getActiveAppThemeKey } from '@/lib/app-themes'
import { getTerminalTheme, type TerminalTheme } from '@/lib/terminal-themes'
import { configureMonacoWorkers } from '@/lib/monaco-workers'
import { applyMonacoVimConfig, registerMonacoVimSaveCommand } from '@/lib/editor-vim'
import { getTextEditorTitle, inferEditorLanguage } from '@/lib/text-editor'
import {
  TEXT_EDITOR_RELOAD_EVENT,
  TEXT_EDITOR_SAVE_EVENT,
  type TextEditorWindowEventDetail,
} from '@/lib/text-editor-events'
import { cn } from '@/lib/utils'

const MONACO_THEME_PREFIX = 'cells-editor'
const LSP_MARKER_OWNER = 'cells-lsp'
let monacoLspRegistered = false

const LSP_LANGUAGE_IDS = [
  'typescript',
  'javascript',
  'python',
  'go',
  'rust',
  'css',
  'scss',
  'less',
  'html',
  'json',
  'yaml',
  'shell',
  'lua',
  'ruby',
  'c',
  'cpp',
  'csharp',
  'swift',
  'kotlin',
  'markdown',
  'toml',
]

function stripHash(color: string) {
  return color.replace(/^#/, '')
}

function alphaHex(color: string, alpha: string) {
  const hex = stripHash(color)
  if (hex.length !== 6) return color
  return `#${hex}${alpha}`
}

function monacoThemeName(themeKey: string) {
  return `${MONACO_THEME_PREFIX}-${themeKey}`
}

function defineCellsMonacoTheme(themeKey: string, theme: TerminalTheme) {
  const name = monacoThemeName(themeKey)
  monaco.editor.defineTheme(name, {
    base: theme.scheme === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: stripHash(theme.brightBlack), fontStyle: 'italic' },
      { token: 'keyword', foreground: stripHash(theme.magenta) },
      { token: 'string', foreground: stripHash(theme.green) },
      { token: 'number', foreground: stripHash(theme.yellow) },
      { token: 'type', foreground: stripHash(theme.cyan) },
      { token: 'function', foreground: stripHash(theme.blue) },
      { token: 'variable', foreground: stripHash(theme.foreground) },
      { token: 'invalid', foreground: stripHash(theme.red) },
    ],
    colors: {
      'editor.background': theme.background,
      'editor.foreground': theme.foreground,
      'editorCursor.foreground': theme.cursor,
      'editor.selectionBackground': alphaHex(theme.selectionBackground, 'dd'),
      'editor.inactiveSelectionBackground': alphaHex(theme.selectionBackground, '66'),
      'editor.lineHighlightBackground': alphaHex(theme.selectionBackground, '33'),
      'editorLineNumber.foreground': alphaHex(
        theme.foreground,
        theme.scheme === 'dark' ? '55' : '66',
      ),
      'editorLineNumber.activeForeground': theme.foreground,
      'editorIndentGuide.background1': alphaHex(theme.foreground, '22'),
      'editorIndentGuide.activeBackground1': alphaHex(theme.foreground, '44'),
      'editorWhitespace.foreground': alphaHex(theme.foreground, '22'),
      'editorWidget.background': theme.background,
      'editorWidget.border': alphaHex(theme.foreground, '22'),
      'input.background': theme.background,
      'input.foreground': theme.foreground,
      'dropdown.background': theme.background,
      'dropdown.foreground': theme.foreground,
      'scrollbarSlider.background': alphaHex(theme.foreground, '26'),
      'scrollbarSlider.hoverBackground': alphaHex(theme.foreground, '38'),
      'scrollbarSlider.activeBackground': alphaHex(theme.foreground, '4d'),
    },
  })
  return name
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function configureEditorLanguageDefaults() {
  ;(monaco.languages as any).typescript?.typescriptDefaults?.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  })
  ;(monaco.languages as any).typescript?.javascriptDefaults?.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  })
}

function lspRangeToMonaco(range: any): monaco.IRange {
  const start = range?.start ?? {}
  const end = range?.end ?? start
  return {
    startLineNumber: Math.max(1, (start.line ?? 0) + 1),
    startColumn: Math.max(1, (start.character ?? 0) + 1),
    endLineNumber: Math.max(1, (end.line ?? start.line ?? 0) + 1),
    endColumn: Math.max(1, (end.character ?? start.character ?? 0) + 1),
  }
}

function lspSeverityToMarker(severity: number | undefined): monaco.MarkerSeverity {
  if (severity === 1) return monaco.MarkerSeverity.Error
  if (severity === 2) return monaco.MarkerSeverity.Warning
  if (severity === 3) return monaco.MarkerSeverity.Info
  return monaco.MarkerSeverity.Hint
}

function lspMarkupToMarkdown(value: any): monaco.IMarkdownString[] {
  if (!value) return []
  if (typeof value === 'string') return [{ value }]
  if (Array.isArray(value)) return value.flatMap(lspMarkupToMarkdown)
  if (typeof value.value === 'string') return [{ value: value.value }]
  if (typeof value.language === 'string' && typeof value.value === 'string') {
    return [{ value: `\`\`\`${value.language}\n${value.value}\n\`\`\`` }]
  }
  return []
}

function lspCompletionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  switch (kind) {
    case 2:
      return monaco.languages.CompletionItemKind.Method
    case 3:
      return monaco.languages.CompletionItemKind.Function
    case 4:
      return monaco.languages.CompletionItemKind.Constructor
    case 5:
      return monaco.languages.CompletionItemKind.Field
    case 6:
      return monaco.languages.CompletionItemKind.Variable
    case 7:
      return monaco.languages.CompletionItemKind.Class
    case 8:
      return monaco.languages.CompletionItemKind.Interface
    case 9:
      return monaco.languages.CompletionItemKind.Module
    case 10:
      return monaco.languages.CompletionItemKind.Property
    case 12:
      return monaco.languages.CompletionItemKind.Value
    case 13:
      return monaco.languages.CompletionItemKind.Enum
    case 14:
      return monaco.languages.CompletionItemKind.Keyword
    case 15:
      return monaco.languages.CompletionItemKind.Snippet
    case 16:
      return monaco.languages.CompletionItemKind.Color
    case 17:
      return monaco.languages.CompletionItemKind.File
    case 18:
      return monaco.languages.CompletionItemKind.Reference
    default:
      return monaco.languages.CompletionItemKind.Text
  }
}

function registerMonacoLspProviders() {
  if (monacoLspRegistered) return
  monacoLspRegistered = true
  configureEditorLanguageDefaults()

  monaco.languages.registerCompletionItemProvider(LSP_LANGUAGE_IDS, {
    triggerCharacters: ['.', ':', '/', '"', "'", '<'],
    async provideCompletionItems(model, position) {
      const result: any = await window.cells.editor.lspCompletion(model.uri.toString(), {
        line: position.lineNumber - 1,
        character: position.column - 1,
      })
      const items = Array.isArray(result)
        ? result
        : Array.isArray(result?.items)
          ? result.items
          : []
      const word = model.getWordUntilPosition(position)
      const fallbackRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      }
      return {
        suggestions: items.map((item: any) => ({
          label: item.label,
          kind: lspCompletionKind(item.kind),
          insertText: item.insertText ?? item.textEdit?.newText ?? item.label,
          detail: item.detail,
          documentation: lspMarkupToMarkdown(item.documentation)[0],
          range: item.textEdit?.range ? lspRangeToMonaco(item.textEdit.range) : fallbackRange,
        })),
      }
    },
  })

  monaco.languages.registerHoverProvider(LSP_LANGUAGE_IDS, {
    async provideHover(model, position) {
      const result: any = await window.cells.editor.lspHover(model.uri.toString(), {
        line: position.lineNumber - 1,
        character: position.column - 1,
      })
      const contents = lspMarkupToMarkdown(result?.contents)
      if (contents.length === 0) return null
      return {
        contents,
        range: result?.range ? lspRangeToMonaco(result.range) : undefined,
      }
    },
  })

  monaco.languages.registerDefinitionProvider(LSP_LANGUAGE_IDS, {
    async provideDefinition(model, position) {
      const result: any = await window.cells.editor.lspDefinition(model.uri.toString(), {
        line: position.lineNumber - 1,
        character: position.column - 1,
      })
      const entries = Array.isArray(result) ? result : result ? [result] : []
      return entries
        .map((entry: any) => {
          const targetUri = entry.targetUri ?? entry.uri
          const targetRange = entry.targetSelectionRange ?? entry.targetRange ?? entry.range
          if (!targetUri || !targetRange) return null
          return {
            uri: monaco.Uri.parse(targetUri),
            range: lspRangeToMonaco(targetRange),
          }
        })
        .filter(Boolean) as monaco.languages.Location[]
    },
  })
}

interface TextEditorSurfaceProps {
  editor: TextEditorNode
  className?: string
}

export function TextEditorSurface({ editor, className }: TextEditorSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const vimStatusRef = useRef<HTMLDivElement>(null)
  const monacoRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const ownsModelRef = useRef(false)
  const lspUriRef = useRef<string | null>(null)
  const lspChangeTimerRef = useRef<number | null>(null)
  const vimModeRef = useRef<VimAdapterInstance | null>(null)
  const savedContentRef = useRef(editor.content ?? '')
  const currentEditorIdRef = useRef(editor.id)
  const saveRef = useRef<() => Promise<void>>(async () => {})
  const syncTextEditor = useStore((state) => state.syncTextEditor)
  const activeProjectPath = useStore((state) => state.getActiveProjectPath())
  const {
    colorScheme,
    appDarkTheme,
    appLightTheme,
    fontFamily,
    fontSize,
    editorVimMode,
    editorVimConfig,
  } = useStore(
    useShallow((state) => ({
      colorScheme: state.colorScheme,
      appDarkTheme: state.appDarkTheme,
      appLightTheme: state.appLightTheme,
      fontFamily: state.fontFamily,
      fontSize: state.fontSize,
      editorVimMode: state.editorVimMode,
      editorVimConfig: state.editorVimConfig,
    })),
  )
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const activeThemeKey = getActiveAppThemeKey({ colorScheme, appDarkTheme, appLightTheme })
  const monacoTheme = useMemo(() => {
    return defineCellsMonacoTheme(activeThemeKey, getTerminalTheme(activeThemeKey))
  }, [activeThemeKey])

  const readFile = useCallback(
    async (options?: { force?: boolean }) => {
      if (!editor.filePath) {
        const content = editor.content ?? ''
        savedContentRef.current = content
        syncTextEditor(editor.id, {
          content,
          loaded: true,
          isDirty: false,
          error: null,
          language: editor.language ?? inferEditorLanguage(null, editor.title),
        })
        return
      }

      if (editor.loaded && !options?.force) {
        savedContentRef.current = editor.isDirty ? savedContentRef.current : (editor.content ?? '')
        return
      }

      setLoading(true)
      try {
        const result = await window.cells.editor.readFile(editor.filePath)
        if (currentEditorIdRef.current !== editor.id) return
        savedContentRef.current = result.content
        const model = modelRef.current
        if (model && model.getValue() !== result.content) {
          model.pushEditOperations(
            [],
            [{ range: model.getFullModelRange(), text: result.content }],
            () => null,
          )
        }
        syncTextEditor(editor.id, {
          filePath: result.path,
          title: result.name,
          language: inferEditorLanguage(result.path, result.name),
          content: result.content,
          loaded: true,
          isDirty: false,
          error: null,
          mtimeMs: result.mtimeMs,
          size: result.size,
        })
      } catch (error) {
        syncTextEditor(editor.id, {
          loaded: true,
          error: getErrorMessage(error),
        })
      } finally {
        if (currentEditorIdRef.current === editor.id) setLoading(false)
      }
    },
    [
      editor.content,
      editor.filePath,
      editor.id,
      editor.isDirty,
      editor.language,
      editor.loaded,
      editor.title,
      syncTextEditor,
    ],
  )

  const save = useCallback(async () => {
    const model = modelRef.current
    if (!model) return
    const content = model.getValue()

    setSaving(true)
    try {
      const result = editor.filePath
        ? await window.cells.editor.writeFile(editor.filePath, content)
        : await window.cells.editor.saveFileAs(content, editor.title, activeProjectPath)
      if (!result) return
      savedContentRef.current = content
      syncTextEditor(editor.id, {
        filePath: result.path,
        title: result.name || getTextEditorTitle(result.path),
        language: inferEditorLanguage(result.path, result.name),
        content,
        loaded: true,
        isDirty: false,
        error: null,
        mtimeMs: result.mtimeMs,
        size: result.size,
      })
    } catch (error) {
      syncTextEditor(editor.id, { error: getErrorMessage(error) })
    } finally {
      setSaving(false)
    }
  }, [activeProjectPath, editor.filePath, editor.id, editor.title, syncTextEditor])

  useEffect(() => {
    saveRef.current = save
  }, [save])

  useEffect(() => {
    currentEditorIdRef.current = editor.id
  }, [editor.id])

  useEffect(() => {
    configureMonacoWorkers()
    registerMonacoLspProviders()
    if (!containerRef.current) return

    const language = editor.language ?? inferEditorLanguage(editor.filePath, editor.title)
    const uri = editor.filePath
      ? monaco.Uri.file(editor.filePath)
      : monaco.Uri.parse(`inmemory://cells/${editor.id}/${encodeURIComponent(editor.title)}`)
    let model = monaco.editor.getModel(uri)
    ownsModelRef.current = !model
    if (!model) {
      model = monaco.editor.createModel(editor.content ?? '', language, uri)
    } else {
      monaco.editor.setModelLanguage(model, language)
      if (model.getValue() !== (editor.content ?? '')) {
        model.setValue(editor.content ?? '')
      }
    }
    modelRef.current = model
    savedContentRef.current = editor.isDirty ? savedContentRef.current : (editor.content ?? '')

    const instance = monaco.editor.create(containerRef.current, {
      model,
      theme: monacoTheme,
      automaticLayout: true,
      fontFamily,
      fontSize: Math.max(11, fontSize),
      fontLigatures: true,
      minimap: { enabled: true, autohide: 'mouseover', side: 'right' },
      lineNumbers: 'on',
      renderWhitespace: 'selection',
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'off',
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      padding: { top: 10, bottom: 10 },
      fixedOverflowWidgets: true,
    })
    monacoRef.current = instance

    const contentDisposable = instance.onDidChangeModelContent(() => {
      const value = model.getValue()
      syncTextEditor(editor.id, {
        content: value,
        loaded: true,
        isDirty: value !== savedContentRef.current,
        error: null,
      })
      const lspUri = lspUriRef.current
      if (lspUri) {
        if (lspChangeTimerRef.current) window.clearTimeout(lspChangeTimerRef.current)
        lspChangeTimerRef.current = window.setTimeout(() => {
          lspChangeTimerRef.current = null
          void window.cells.editor.lspChange(lspUri, value, model.getVersionId())
        }, 180)
      }
    })
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveRef.current()
    })

    return () => {
      if (lspChangeTimerRef.current) {
        window.clearTimeout(lspChangeTimerRef.current)
        lspChangeTimerRef.current = null
      }
      if (lspUriRef.current) {
        void window.cells.editor.lspClose(lspUriRef.current)
        monaco.editor.setModelMarkers(model, LSP_MARKER_OWNER, [])
        lspUriRef.current = null
      }
      contentDisposable.dispose()
      instance.dispose()
      if (ownsModelRef.current) model.dispose()
      monacoRef.current = null
      modelRef.current = null
      ownsModelRef.current = false
    }
    // Create the Monaco instance once per editor id. Runtime option changes
    // are applied through the targeted effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.id])

  useEffect(() => {
    monaco.editor.setTheme(monacoTheme)
  }, [monacoTheme])

  useEffect(() => {
    monacoRef.current?.updateOptions({
      fontFamily,
      fontSize: Math.max(11, fontSize),
    })
  }, [fontFamily, fontSize])

  useEffect(() => {
    const instance = monacoRef.current
    if (!instance || !editorVimMode) {
      vimModeRef.current?.dispose()
      vimModeRef.current = null
      return
    }

    applyMonacoVimConfig(editorVimConfig)
    const unregisterSave = registerMonacoVimSaveCommand(instance, () => {
      void saveRef.current()
    })
    const vimMode = initVimMode(instance, vimStatusRef.current)
    vimModeRef.current = vimMode

    return () => {
      unregisterSave()
      vimMode.dispose()
      if (vimModeRef.current === vimMode) vimModeRef.current = null
    }
  }, [editorVimConfig, editorVimMode, editor.id])

  useEffect(() => {
    const model = modelRef.current
    if (!model) return
    const nextLanguage = editor.language ?? inferEditorLanguage(editor.filePath, editor.title)
    const currentLanguage = model.getLanguageId()
    if (nextLanguage && nextLanguage !== currentLanguage) {
      monaco.editor.setModelLanguage(model, nextLanguage)
    }
  }, [editor.filePath, editor.language, editor.title])

  useEffect(() => {
    void readFile()
  }, [readFile])

  useEffect(() => {
    const model = modelRef.current
    if (!model || !editor.filePath) return
    const languageId = editor.language ?? inferEditorLanguage(editor.filePath, editor.title)
    let cancelled = false
    void window.cells.editor
      .lspOpen({
        filePath: editor.filePath,
        languageId,
        content: model.getValue(),
        rootPath: activeProjectPath,
      })
      .then((result) => {
        if (cancelled) return
        lspUriRef.current = result.enabled ? (result.uri ?? model.uri.toString()) : null
      })
      .catch(() => {
        if (!cancelled) lspUriRef.current = null
      })

    return () => {
      cancelled = true
      const uri = lspUriRef.current
      if (uri) {
        void window.cells.editor.lspClose(uri)
        monaco.editor.setModelMarkers(model, LSP_MARKER_OWNER, [])
      }
      lspUriRef.current = null
    }
  }, [activeProjectPath, editor.filePath, editor.language, editor.title, editor.id, editor.loaded])

  useEffect(() => {
    return window.cells.editor.onLspDiagnostics((payload) => {
      const model = modelRef.current
      if (!model || payload.uri !== model.uri.toString()) return
      const markers = (Array.isArray(payload.diagnostics) ? payload.diagnostics : []).map(
        (diagnostic: any) => ({
          ...lspRangeToMonaco(diagnostic.range),
          severity: lspSeverityToMarker(diagnostic.severity),
          message: diagnostic.message ?? 'Language server diagnostic',
          source: diagnostic.source ?? 'LSP',
          code:
            typeof diagnostic.code === 'string' || typeof diagnostic.code === 'number'
              ? String(diagnostic.code)
              : undefined,
        }),
      )
      monaco.editor.setModelMarkers(model, LSP_MARKER_OWNER, markers)
    })
  }, [editor.id])

  useEffect(() => {
    const handleSave = (event: Event) => {
      const detail = (event as CustomEvent<TextEditorWindowEventDetail>).detail
      if (detail?.editorId !== editor.id) return
      void saveRef.current()
    }
    const handleReload = (event: Event) => {
      const detail = (event as CustomEvent<TextEditorWindowEventDetail>).detail
      if (detail?.editorId !== editor.id) return
      void readFile({ force: true })
    }
    window.addEventListener(TEXT_EDITOR_SAVE_EVENT, handleSave)
    window.addEventListener(TEXT_EDITOR_RELOAD_EVENT, handleReload)
    return () => {
      window.removeEventListener(TEXT_EDITOR_SAVE_EVENT, handleSave)
      window.removeEventListener(TEXT_EDITOR_RELOAD_EVENT, handleReload)
    }
  }, [editor.id, readFile])

  return (
    <div className={cn('text-editor-content relative h-full w-full overflow-hidden', className)}>
      <div ref={containerRef} className="h-full w-full" />
      {editorVimMode ? (
        <div
          ref={vimStatusRef}
          className={cn(
            'absolute inset-x-0 bottom-0 z-10 min-h-6 border-t border-border/50 bg-background/92 px-2 py-1 font-mono text-[11px] leading-4 text-muted-foreground shadow-minimal',
            '[&_input]:h-5 [&_input]:min-w-32 [&_input]:rounded-[4px] [&_input]:border [&_input]:border-border/60 [&_input]:bg-background/90 [&_input]:px-1.5 [&_input]:text-foreground [&_input]:outline-none',
            '[&_.vim-notification]:ml-2 [&_.vim-notification]:text-foreground/70',
          )}
        />
      ) : null}
      {(loading || saving) && (
        <div
          className={cn(
            'pointer-events-none absolute right-2 flex items-center gap-1.5 rounded-md border border-border/60 bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-minimal',
            editorVimMode ? 'bottom-8' : 'bottom-2',
          )}
        >
          <Loader2 className="size-3 animate-spin" />
          <span>{saving ? 'Saving' : 'Loading'}</span>
        </div>
      )}
      {editor.error ? (
        <div className="pointer-events-none absolute bottom-2 left-2 right-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
          {editor.error}
        </div>
      ) : null}
    </div>
  )
}
