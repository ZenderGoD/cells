import { useCallback, useEffect, useState } from 'react'

export type VerticalScrollFadeState = {
  top: boolean
  bottom: boolean
}

export function getVerticalScrollFadeMask(
  fade: VerticalScrollFadeState,
  topPx = 16,
  bottomPx = 16,
) {
  if (fade.top && fade.bottom) {
    return `linear-gradient(to bottom, transparent 0, black ${topPx}px, black calc(100% - ${bottomPx}px), transparent 100%)`
  }

  if (fade.top) {
    return `linear-gradient(to bottom, transparent 0, black ${topPx}px, black 100%)`
  }

  if (fade.bottom) {
    return `linear-gradient(to bottom, black 0, black calc(100% - ${bottomPx}px), transparent 100%)`
  }

  return undefined
}

export function useVerticalScrollFades(dependencyKey?: unknown) {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [fade, setFade] = useState<VerticalScrollFadeState>({ top: false, bottom: false })

  const update = useCallback(() => {
    if (!element) return

    const maxScrollTop = element.scrollHeight - element.clientHeight
    const next = {
      top: maxScrollTop > 1 && element.scrollTop > 1,
      bottom: maxScrollTop > 1 && element.scrollTop < maxScrollTop - 1,
    }

    setFade((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next))
  }, [element])

  useEffect(() => {
    if (!element) return

    let frame: number | null = null
    const scheduleUpdate = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        update()
      })
    }

    scheduleUpdate()
    element.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)

    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleUpdate) : null
    observer?.observe(element)
    if (element.firstElementChild instanceof HTMLElement) {
      observer?.observe(element.firstElementChild)
    }

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      element.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
      observer?.disconnect()
    }
  }, [dependencyKey, element, update])

  return [setElement, fade] as const
}
