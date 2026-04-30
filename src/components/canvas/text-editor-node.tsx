import {
  memo,
  useCallback,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { ArrowUpRight, FolderOpen, MoreHorizontal, Save, XCircle } from 'lucide-react'
import type { TextEditorNode as TextEditorNodeType } from '@/types'
import { useStore } from '@/lib/store'
import { hasPrimaryModifier } from '@/lib/keyboard-shortcuts'
import { cn } from '@/lib/utils'
import { TextEditorSurface } from '@/components/editor/text-editor-surface'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TEXT_EDITOR_SAVE_EVENT } from '@/lib/text-editor-events'
import { hapticBuzz } from '@/lib/haptics'

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const MIN_W = 460
const MIN_H = 320
const HANDLE = 6

interface TextEditorNodeProps {
  editor: TextEditorNodeType
  scale: number
  selectionMode: boolean
  isSelected: boolean
  isFocused: boolean
  showFocusRing: boolean
  onDragStart: (
    id: string,
    kind: 'terminal' | 'browser' | 'agent' | 'editor',
    startX: number,
    startY: number,
  ) => void
}

export const TextEditorNode = memo(function TextEditorNode({
  editor,
  scale,
  selectionMode,
  isSelected,
  isFocused,
  showFocusRing,
  onDragStart,
}: TextEditorNodeProps) {
  const moveTextEditor = useStore((state) => state.moveTextEditor)
  const resizeTextEditor = useStore((state) => state.resizeTextEditor)
  const focusTextEditor = useStore((state) => state.focusTextEditor)
  const bringTextEditorToFront = useStore((state) => state.bringTextEditorToFront)
  const requestCloseWindow = useStore((state) => state.requestCloseWindow)
  const togglePin = useStore((state) => state.togglePin)
  const arrangeAnimating = useStore((state) => state.arrangeAnimating)
  const [isResizing, setIsResizing] = useState(false)
  const z = editor.zIndex ?? 1
  const title = editor.title || editor.filePath || 'Untitled'

  const handleSave = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent(TEXT_EDITOR_SAVE_EVENT, { detail: { editorId: editor.id } }),
    )
  }, [editor.id])

  const focusNode = useCallback(() => {
    focusTextEditor(editor.id)
    if (!isFocused) bringTextEditorToFront(editor.id)
  }, [bringTextEditorToFront, editor.id, focusTextEditor, isFocused])

  const handleHeaderMouseDown = useCallback(
    (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest('button')) return
      const modifierDrag = hasPrimaryModifier(event)
      if (!selectionMode && !modifierDrag) {
        focusNode()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      onDragStart(editor.id, 'editor', event.clientX, event.clientY)
    },
    [editor.id, focusNode, onDragStart, selectionMode],
  )

  const handleNodeMouseDown = useCallback(
    (event: MouseEvent) => {
      const modifierDrag = hasPrimaryModifier(event)
      if (!selectionMode && !modifierDrag) {
        focusNode()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      onDragStart(editor.id, 'editor', event.clientX, event.clientY)
    },
    [editor.id, focusNode, onDragStart, selectionMode],
  )

  const handleEdgeMouseDown = useCallback(
    (edge: Edge, event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      setIsResizing(true)

      const startX = event.clientX
      const startY = event.clientY
      const startW = editor.width
      const startH = editor.height
      const startPx = editor.x
      const startPy = editor.y
      const movesLeft = edge.includes('w')
      const movesRight = edge.includes('e')
      const movesTop = edge.includes('n')
      const movesBottom = edge.includes('s')

      const onMove = (moveEvent: globalThis.MouseEvent) => {
        const dx = (moveEvent.clientX - startX) / scale
        const dy = (moveEvent.clientY - startY) / scale
        let width = startW
        let height = startH
        let x = startPx
        let y = startPy

        if (movesRight) width = Math.max(MIN_W, startW + dx)
        if (movesBottom) height = Math.max(MIN_H, startH + dy)
        if (movesLeft) {
          width = Math.max(MIN_W, startW - dx)
          x = startPx + (startW - width)
        }
        if (movesTop) {
          height = Math.max(MIN_H, startH - dy)
          y = startPy + (startH - height)
        }

        resizeTextEditor(editor.id, width, height)
        if (movesLeft || movesTop) moveTextEditor(editor.id, x, y)
      }

      const onUp = () => {
        setIsResizing(false)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [
      editor.height,
      editor.id,
      editor.width,
      editor.x,
      editor.y,
      moveTextEditor,
      resizeTextEditor,
      scale,
    ],
  )

  const handleTogglePin = () => {
    hapticBuzz()
    togglePin(editor.id, 'editor')
  }
  const handleClose = () => {
    void requestCloseWindow({ id: editor.id, type: 'editor' })
  }
  const focusRingStyle: CSSProperties | undefined =
    isFocused && showFocusRing
      ? {
          boxShadow: `0 0 0 ${Math.min(8, Math.max(2, Math.round(2 / Math.max(scale, 0.2))))}px var(--color-primary)`,
        }
      : undefined

  return (
    <div
      data-focused={isFocused ? 'true' : 'false'}
      className={cn(
        'text-editor-node group absolute overflow-hidden rounded-lg border bg-background/75 backdrop-blur-xl transition-[box-shadow,border-color,transform] duration-150',
        isFocused ? 'border-foreground/15 shadow-elevated' : 'border-border/50 shadow-middle',
        isSelected && 'ring-2 ring-primary/35',
        isResizing && 'select-none',
        arrangeAnimating && 'transition-all duration-300',
      )}
      style={
        {
          left: editor.x,
          top: editor.y,
          width: editor.width,
          height: editor.height,
          zIndex: z,
          ...focusRingStyle,
        } as CSSProperties
      }
      onMouseDown={handleNodeMouseDown}
    >
      <div
        className="absolute inset-x-0 top-0 z-10 h-2 cursor-grab active:cursor-grabbing"
        onMouseDown={handleHeaderMouseDown}
      />

      <div
        className={cn(
          'absolute right-1.5 top-1.5 z-20 flex items-center gap-1 opacity-0 transition-opacity',
          isFocused && 'opacity-100',
          'group-hover:opacity-100',
        )}
      >
        <button
          type="button"
          aria-label="Save editor"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            handleSave()
          }}
          className="flex size-6 items-center justify-center rounded-[6px] text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
          title="Save"
        >
          <Save className="size-3.5" />
        </button>
        <Popover>
          <PopoverTrigger
            onMouseDown={(event) => event.stopPropagation()}
            className="flex size-6 items-center justify-center rounded-[6px] text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
            aria-label="Editor menu"
            title="Editor menu"
          >
            <MoreHorizontal className="size-3.5" />
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-44 p-1"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <MenuItem icon={<Save className="size-3.5" />} label="Save" onSelect={handleSave} />
            <MenuItem
              icon={<FolderOpen className="size-3.5" />}
              label="Reveal in Finder"
              disabled={!editor.filePath}
              onSelect={() => {
                if (editor.filePath) void window.cells.app.revealPath(editor.filePath)
              }}
            />
            <MenuItem
              icon={<ArrowUpRight className="size-3.5" />}
              label={editor.pinned ? 'Pop back in' : 'Pop out to window'}
              onSelect={handleTogglePin}
            />
            <div className="my-1 h-px bg-border/40" />
            <MenuItem
              icon={<XCircle className="size-3.5" />}
              label="Close editor"
              onSelect={handleClose}
              tone="danger"
            />
          </PopoverContent>
        </Popover>
        <button
          type="button"
          aria-label="Close editor"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            handleClose()
          }}
          className="flex size-6 items-center justify-center rounded-[6px] text-muted-foreground/70 transition-colors hover:bg-red-500/10 hover:text-red-200"
          title="Close"
        >
          <XCircle className="size-3.5" />
        </button>
      </div>

      {editor.pinned ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background/92 px-6 text-center">
          <div className="text-xs font-medium text-foreground/80">Popped out editor</div>
          <div className="max-w-52 text-[11px] leading-5 text-muted-foreground/60">{title}</div>
          <button
            type="button"
            onClick={handleTogglePin}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/70 px-2.5 py-1.5 text-[11px] text-foreground transition-colors hover:bg-muted/40"
          >
            <ArrowUpRight className="h-3 w-3 rotate-180" />
            Pop back in
          </button>
        </div>
      ) : (
        <TextEditorSurface editor={editor} className="h-full" />
      )}

      {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as Edge[]).map((edge) => (
        <div
          key={edge}
          onMouseDown={(event) => handleEdgeMouseDown(edge, event)}
          className="absolute z-20"
          style={getResizeHandleStyle(edge)}
        />
      ))}

      {isResizing ? (
        <div className="pointer-events-none absolute inset-0 z-30 bg-primary/5" />
      ) : null}
    </div>
  )
})

interface MenuItemProps {
  icon: ReactNode
  label: string
  onSelect: () => void
  disabled?: boolean
  tone?: 'default' | 'danger'
}

function MenuItem({ icon, label, onSelect, disabled, tone = 'default' }: MenuItemProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12.5px] transition-colors',
        disabled
          ? 'cursor-not-allowed text-muted-foreground/40'
          : tone === 'danger'
            ? 'text-red-300 hover:bg-red-500/10 hover:text-red-200'
            : 'text-foreground/90 hover:bg-foreground/5',
      )}
    >
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center',
          tone === 'danger' ? 'text-red-300' : 'text-muted-foreground/70',
        )}
      >
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </button>
  )
}

function getResizeHandleStyle(edge: Edge): CSSProperties {
  const common: CSSProperties = {}
  if (edge.includes('n')) common.top = 0
  if (edge.includes('s')) common.bottom = 0
  if (edge.includes('w')) common.left = 0
  if (edge.includes('e')) common.right = 0

  if (edge === 'n' || edge === 's') {
    return { ...common, left: HANDLE, right: HANDLE, height: HANDLE, cursor: 'ns-resize' }
  }
  if (edge === 'e' || edge === 'w') {
    return { ...common, top: HANDLE, bottom: HANDLE, width: HANDLE, cursor: 'ew-resize' }
  }
  return {
    ...common,
    width: HANDLE * 2,
    height: HANDLE * 2,
    cursor: edge === 'ne' || edge === 'sw' ? 'nesw-resize' : 'nwse-resize',
  }
}
