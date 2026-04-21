import * as React from 'react'
import { cn } from '@/lib/utils'

// Copied verbatim from Craft Agents OSS:
// ../craft-agents-oss/packages/ui/src/components/ui/LoadingIndicator.tsx
// CSS (`.spinner` / `.spinner-cube` / `.animate-shimmer`) lives in globals.css.

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

export interface SpinnerProps {
  className?: string
}

export function Spinner({ className }: SpinnerProps) {
  return (
    <span className={cn('spinner', className)} role="status" aria-label="Loading">
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
    </span>
  )
}

export interface LoadingIndicatorProps {
  label?: string
  animated?: boolean
  showSpinner?: boolean
  showElapsed?: boolean | number
  className?: string
  spinnerClassName?: string
}

export function LoadingIndicator({
  label,
  animated = true,
  showSpinner = true,
  showElapsed = false,
  className,
  spinnerClassName,
}: LoadingIndicatorProps) {
  const [elapsed, setElapsed] = React.useState(0)
  const startTimeRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    if (!showElapsed) return

    if (typeof showElapsed === 'number') {
      startTimeRef.current = showElapsed
    } else if (!startTimeRef.current) {
      startTimeRef.current = Date.now()
    }

    const interval = setInterval(() => {
      if (startTimeRef.current) {
        setElapsed(Date.now() - startTimeRef.current)
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [showElapsed])

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {showSpinner ? (
        animated ? (
          <Spinner className={spinnerClassName} />
        ) : (
          <span className="inline-flex items-center justify-center w-[1em] h-[1em]">●</span>
        )
      ) : null}
      {label && <span className="text-muted-foreground">{label}</span>}
      {showElapsed && elapsed >= 1000 && (
        <span className="text-muted-foreground/60 tabular-nums">({formatDuration(elapsed)})</span>
      )}
    </span>
  )
}
