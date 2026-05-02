import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { AlertCircle, FileText, Loader2, Search, X } from 'lucide-react'

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import type { ProjectFileSearchResult } from '@/types'

const PREVIEW_MAX_BYTES = 1024 * 1024
const PREVIEW_MAX_LINES = 260

type PreviewState =
  | { status: 'idle'; content: string }
  | { status: 'loading'; content: string }
  | { status: 'ready'; content: string; truncated: boolean }
  | { status: 'error'; message: string }

type PreviewResult =
  | { path: string; status: 'ready'; content: string; truncated: boolean }
  | { path: string; status: 'error'; message: string }

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function splitPreview(content: string) {
  const lines = content.split(/\r?\n/)
  return {
    lines: lines.slice(0, PREVIEW_MAX_LINES),
    truncated: lines.length > PREVIEW_MAX_LINES,
  }
}

export function OpenFileDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const activeProject = useStore((state) =>
    state.projects.find((project) => project.id === state.activeProjectId),
  )
  const setOverlayOpen = useStore((state) => state.setOverlayOpen)
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<ProjectFileSearchResult[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const selectedRowRef = useRef<HTMLButtonElement | null>(null)
  const rootPath = activeProject?.path ?? null

  const selectedFile = files[selectedIndex] ?? null

  useEffect(() => {
    setOverlayOpen('open-file-dialog', open)
    return () => setOverlayOpen('open-file-dialog', false)
  }, [open, setOverlayOpen])

  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  useEffect(() => {
    if (!open || !rootPath) return

    let cancelled = false
    const timeout = window.setTimeout(
      () => {
        setLoading(true)
        setError(null)
        window.cells.app
          .searchProjectFiles(rootPath, query)
          .then((nextFiles) => {
            if (cancelled) return
            setFiles(nextFiles)
            setSelectedIndex(0)
          })
          .catch((err) => {
            if (cancelled) return
            setFiles([])
            setError(err instanceof Error ? err.message : 'Could not search project files')
          })
          .finally(() => {
            if (!cancelled) setLoading(false)
          })
      },
      query.trim() ? 120 : 0,
    )

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [open, query, rootPath])

  useEffect(() => {
    if (!selectedFile || selectedFile.size > PREVIEW_MAX_BYTES) return

    let cancelled = false
    window.cells.editor
      .readFile(selectedFile.path)
      .then((snapshot) => {
        if (cancelled) return
        const next = splitPreview(snapshot.content)
        setPreviewResult({
          path: selectedFile.path,
          status: 'ready',
          content: next.lines.join('\n'),
          truncated: next.truncated,
        })
      })
      .catch((err) => {
        if (cancelled) return
        setPreviewResult({
          path: selectedFile.path,
          status: 'error',
          message: err instanceof Error ? err.message : 'Preview unavailable',
        })
      })

    return () => {
      cancelled = true
    }
  }, [selectedFile])

  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const openSelectedFile = useCallback(
    (file: ProjectFileSearchResult | null = selectedFile) => {
      if (!file) return
      const state = useStore.getState()
      state.openTextEditorForPath(file.path, state.activeProjectId)
      onOpenChange(false)
    },
    [onOpenChange, selectedFile],
  )

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (files.length === 0) return
        setSelectedIndex((index) => Math.min(files.length - 1, index + 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (files.length === 0) return
        setSelectedIndex((index) => Math.max(0, index - 1))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        openSelectedFile()
      }
    },
    [files.length, openSelectedFile],
  )

  const preview = useMemo<PreviewState>(() => {
    if (!selectedFile) return { status: 'idle', content: '' }
    if (selectedFile.size > PREVIEW_MAX_BYTES) {
      return {
        status: 'error',
        message: `Preview skipped for ${formatSize(selectedFile.size)} file`,
      }
    }
    if (!previewResult || previewResult.path !== selectedFile.path) {
      return { status: 'loading', content: '' }
    }
    if (previewResult.status === 'error') {
      return { status: 'error', message: previewResult.message }
    }
    return {
      status: 'ready',
      content: previewResult.content,
      truncated: previewResult.truncated,
    }
  }, [previewResult, selectedFile])

  const previewLines = useMemo(() => {
    if (preview.status !== 'ready') return []
    return preview.content.split('\n')
  }, [preview])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(720px,calc(100vh-48px))] w-[min(1120px,calc(100vw-48px))] max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0"
        onWheelCapture={(event) => event.stopPropagation()}
      >
        <DialogTitle className="sr-only">Open file</DialogTitle>
        <DialogDescription className="sr-only">
          Search project files and open the selected file in the editor.
        </DialogDescription>

        <div className="flex h-12 items-center gap-2 border-b border-border/40 px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={rootPath ? 'Search files...' : 'No active project'}
            disabled={!rootPath}
            className="h-9 border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
          />
          {loading ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : null}
          <button
            type="button"
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(320px,0.42fr)_minmax(0,0.58fr)]">
          <div className="min-h-0 border-r border-border/40">
            <div className="flex h-8 items-center justify-between px-3 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
              <span>{activeProject?.name ?? 'Project'}</span>
              <span className="font-mono tracking-normal">{files.length}</span>
            </div>
            <div className="h-[calc(100%-2rem)] overflow-y-auto overscroll-contain px-1.5 pb-1.5">
              {!rootPath ? (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                  Open a project to search files.
                </div>
              ) : error ? (
                <div className="flex h-full items-center justify-center gap-2 px-6 text-sm text-destructive">
                  <AlertCircle className="size-4 shrink-0" />
                  <span>{error}</span>
                </div>
              ) : files.length === 0 && loading ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Searching...
                </div>
              ) : files.length === 0 ? (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                  No matching files.
                </div>
              ) : (
                files.map((file, index) => {
                  const selected = index === selectedIndex
                  return (
                    <button
                      key={file.path}
                      ref={selected ? selectedRowRef : undefined}
                      type="button"
                      className={cn(
                        'flex h-12 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left outline-none',
                        selected
                          ? 'bg-accent text-accent-foreground'
                          : 'text-foreground hover:bg-muted/60',
                      )}
                      onMouseEnter={() => setSelectedIndex(index)}
                      onClick={() => setSelectedIndex(index)}
                      onDoubleClick={() => openSelectedFile(file)}
                    >
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{file.name}</span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {file.directory || '.'}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
                        {formatSize(file.size)}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col">
            <div className="flex h-8 min-w-0 items-center gap-2 border-b border-border/30 px-3">
              <span className="truncate font-mono text-[12px] text-muted-foreground">
                {selectedFile?.relativePath ?? 'Preview'}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto overscroll-contain bg-background/40">
              {preview.status === 'loading' ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Loading preview...
                </div>
              ) : preview.status === 'error' ? (
                <div className="flex h-full items-center justify-center gap-2 px-6 text-sm text-muted-foreground">
                  <AlertCircle className="size-4 shrink-0" />
                  <span>{preview.message}</span>
                </div>
              ) : preview.status === 'ready' ? (
                <div className="min-w-max py-2 font-mono text-[12px] leading-5">
                  {previewLines.map((line, index) => (
                    <div key={index} className="flex min-h-5">
                      <span className="w-12 shrink-0 select-none pr-3 text-right text-muted-foreground/45">
                        {index + 1}
                      </span>
                      <span className="whitespace-pre pr-6 text-foreground/85">{line || ' '}</span>
                    </div>
                  ))}
                  {preview.truncated ? (
                    <div className="px-12 pt-2 text-[11px] text-muted-foreground">
                      Preview truncated.
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Select a file.
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
