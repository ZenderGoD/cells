import type { CSSProperties } from 'react'

export interface WindowAppearanceSettings {
  windowOpacity: number
  windowBlurRadius: number
}

export const DEFAULT_WINDOW_APPEARANCE: WindowAppearanceSettings = {
  windowOpacity: 82,
  windowBlurRadius: 24,
}

const MIN_WINDOW_OPACITY = 0
const MAX_WINDOW_OPACITY = 100
const MIN_WINDOW_BLUR_RADIUS = 0
const MAX_WINDOW_BLUR_RADIUS = 40

export function normalizeWindowAppearance(
  value: Partial<WindowAppearanceSettings> | null | undefined,
): WindowAppearanceSettings {
  return {
    windowOpacity: clamp(
      value?.windowOpacity ?? DEFAULT_WINDOW_APPEARANCE.windowOpacity,
      MIN_WINDOW_OPACITY,
      MAX_WINDOW_OPACITY,
    ),
    windowBlurRadius: clamp(
      value?.windowBlurRadius ?? DEFAULT_WINDOW_APPEARANCE.windowBlurRadius,
      MIN_WINDOW_BLUR_RADIUS,
      MAX_WINDOW_BLUR_RADIUS,
    ),
  }
}

export function buildWindowAppearanceStyle(
  value: WindowAppearanceSettings,
): CSSProperties &
  Record<
    '--window-surface-opacity' | '--window-backdrop-blur' | '--canvas-surface-opacity' | '--canvas-grid-opacity',
    string
  > {
  const normalized = normalizeWindowAppearance(value)
  const isVisible = normalized.windowOpacity > 0

  return {
    '--window-surface-opacity': isVisible ? '0.82' : '0',
    '--window-backdrop-blur': `${isVisible ? normalized.windowBlurRadius : 0}px`,
    '--canvas-surface-opacity': isVisible ? '0.33' : '0',
    '--canvas-grid-opacity': isVisible ? '0.25' : '0',
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)))
}
