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
  const windowSurfaceOpacity = normalized.windowOpacity / 100
  const effectiveBlurRadius = Math.round(normalized.windowBlurRadius * windowSurfaceOpacity)

  return {
    '--window-surface-opacity': String(windowSurfaceOpacity),
    '--window-backdrop-blur': `${effectiveBlurRadius}px`,
    '--canvas-surface-opacity': roundAlpha(windowSurfaceOpacity * 0.4),
    '--canvas-grid-opacity': roundAlpha(windowSurfaceOpacity * 0.3),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function roundAlpha(value: number) {
  return String(Math.round(value * 100) / 100)
}
