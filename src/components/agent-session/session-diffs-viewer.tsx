import { MultiFileDiff, PatchDiff, Virtualizer } from '@pierre/diffs/react'
import type { FileDiffProps } from '@pierre/diffs/react'
import type { ReactNode } from 'react'

import { ScrollArea } from '@/components/ui/scroll-area'
import type { FileDiffStats } from '@/lib/tool-diff-stats'
import { cn } from '@/lib/utils'

type DiffsRenderOptions = NonNullable<FileDiffProps<undefined>['options']>

const DIFFS_RENDER_OPTIONS: DiffsRenderOptions = {
  theme: 'pierre-dark',
  themeType: 'dark',
  diffStyle: 'unified',
  diffIndicators: 'bars',
  hunkSeparators: 'line-info-basic',
  lineDiffType: 'word',
  overflow: 'wrap',
  collapsedContextThreshold: 8,
  expansionLineCount: 16,
  disableFileHeader: true,
  tokenizeMaxLineLength: 800,
  unsafeCSS: `
    :host {
      display: block;
      color-scheme: dark;
      --diffs-font-size: 11px;
      --diffs-line-height: 1.55;
    }
    pre {
      font-family: var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
  `,
}

function DiffsViewerFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ScrollArea
      className={cn(
        'max-h-[min(55vh,520px)] rounded-[6px] border border-border/30 bg-[oklch(0.10_0.004_285)] text-[11px]',
        className,
      )}
      viewportClassName="overscroll-contain"
      maskHeight={16}
    >
      <div className="min-w-0 p-1.5">{children}</div>
    </ScrollArea>
  )
}

export function PierreFileDiffPreview({
  file,
  tableClassName,
}: {
  file: FileDiffStats
  tableClassName?: string
}) {
  return (
    <DiffsViewerFrame className={tableClassName}>
      <Virtualizer>
        <div className="space-y-2">
          {(file.patches ?? []).map((patch, index) => (
            <PatchDiff
              key={`patch-${index}`}
              patch={patch}
              options={DIFFS_RENDER_OPTIONS}
              disableWorkerPool
            />
          ))}
          {file.edits.map((edit, index) => (
            <MultiFileDiff
              key={`${edit.toolId}-${index}`}
              oldFile={{
                name: file.filePath,
                contents: edit.oldString,
                cacheKey: `${edit.toolId}-${index}:old`,
              }}
              newFile={{
                name: file.filePath,
                contents: edit.newString,
                cacheKey: `${edit.toolId}-${index}:new`,
              }}
              options={DIFFS_RENDER_OPTIONS}
              disableWorkerPool
            />
          ))}
        </div>
      </Virtualizer>
    </DiffsViewerFrame>
  )
}
