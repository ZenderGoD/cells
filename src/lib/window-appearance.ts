import type { CSSProperties } from 'react'

export interface WindowAppearanceSettings {
  windowOpacity: number
  windowBlurRadius: number
}

export const DEFAULT_WINDOW_APPEARANCE: WindowAppearanceSettings = {
  windowOpacity: 82,
  windowBlurRadius: 24,
}

const SHELL_SURFACE_OPACITY = 0.82
const CANVAS_SURFACE_OPACITY = 0.33
const CANVAS_GRID_OPACITY = 0.25

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
  const opacityFactor = normalized.windowOpacity / 100

  return {
    '--window-surface-opacity': roundAlpha(SHELL_SURFACE_OPACITY * opacityFactor),
    '--window-backdrop-blur': `${normalized.windowOpacity > 0 ? normalized.windowBlurRadius : 0}px`,
    '--canvas-surface-opacity': roundAlpha(CANVAS_SURFACE_OPACITY * opacityFactor),
    '--canvas-grid-opacity': roundAlpha(CANVAS_GRID_OPACITY * opacityFactor),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function roundAlpha(value: number) {
  return String(Math.round(value * 100) / 100)
}
