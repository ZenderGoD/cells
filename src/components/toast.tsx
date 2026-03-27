import { useEffect, useState, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { hapticError } from '@/lib/haptics'

// ---------- Toast store (vanilla, no deps) ----------

interface Toast {
  id: number
  message: string
  type: 'error' | 'info'
}

let nextId = 0
let toasts: Toast[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

export function showToast(message: string, type: 'error' | 'info' = 'error') {
  const id = ++nextId
  toasts = [...toasts, { id, message, type }]
  emit()
  if (type === 'error') hapticError()
  setTimeout(() => dismissToast(id), 5000)
}

function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

function useToasts() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => toasts,
  )
}

// ---------- Component ----------

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
  }, [])

  return (
    <button
      type="button"
      onClick={onDismiss}
      className={cn(
        'pointer-events-auto max-w-sm rounded-md border px-3 py-2 text-xs shadow-lg backdrop-blur-sm transition-all duration-200 text-left',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2',
        toast.type === 'error'
          ? 'border-red-500/30 bg-red-950/80 text-red-200'
          : 'border-border bg-popover/80 text-popover-foreground',
      )}
    >
      {toast.message}
    </button>
  )
}

export function Toaster() {
  const items = useToasts()
  if (items.length === 0) return null

  return (
    <div className="fixed bottom-10 left-1/2 z-[200] -translate-x-1/2 flex flex-col-reverse items-center gap-2 pointer-events-none">
      {items.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismissToast(t.id)} />
      ))}
    </div>
  )
}
