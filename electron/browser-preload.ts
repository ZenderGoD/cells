import { ipcRenderer } from 'electron'

// Detect horizontal overscroll gestures (trackpad swipe at scroll edge)
// and report progress to the main process for Chrome-like back/forward indicators.

let accDelta = 0
let direction: 'back' | 'forward' | null = null
let gesturePhase: 'idle' | 'scrolling' | 'overscrolling' | 'committed' = 'idle'
let resetTimer: ReturnType<typeof setTimeout> | null = null
let modifierBurstLastWheelAt: number | null = null
let modifierBurstStartedWithModifier = false
let suppressModifierWheelUntil = 0

function isAtLeftEdge(): boolean {
  const el = document.scrollingElement || document.documentElement
  return el.scrollLeft <= 0
}

function isAtRightEdge(): boolean {
  const el = document.scrollingElement || document.documentElement
  return el.scrollLeft + window.innerWidth >= el.scrollWidth - 1
}

function resetGesture() {
  if (gesturePhase === 'overscrolling' || gesturePhase === 'committed') {
    ipcRenderer.send('browser:overscroll-update', 0, null)
  }
  accDelta = 0
  direction = null
  gesturePhase = 'idle'
}

function shouldHonorModifierWheel(modifierActive: boolean): boolean {
  const now = Date.now()
  const startsNewBurst = modifierBurstLastWheelAt === null || now - modifierBurstLastWheelAt > 180
  if (startsNewBurst) {
    modifierBurstStartedWithModifier = modifierActive && now >= suppressModifierWheelUntil
  }
  if (!modifierActive || (modifierActive && !modifierBurstStartedWithModifier)) {
    suppressModifierWheelUntil = now + 1500
  }
  modifierBurstLastWheelAt = now
  return modifierActive && modifierBurstStartedWithModifier
}

const THRESHOLD = 220 // px of accumulated delta to trigger navigation

window.addEventListener(
  'wheel',
  (e) => {
    // Trackpad pinch arrives as Ctrl+wheel in Chromium. Electron's embedded
    // WebContentsView does not apply Chrome-style page zoom for us here, so
    // forward the gesture to main where the browser's page zoom multiplier is
    // kept separate from the canvas zoom multiplier.
    const requestedPageZoomGesture = e.ctrlKey && !e.metaKey
    const requestedCanvasZoomGesture = e.metaKey
    const requestedModifierWheel =
      requestedPageZoomGesture || requestedCanvasZoomGesture || e.shiftKey
    const honorModifierWheel = shouldHonorModifierWheel(requestedModifierWheel)
    const pageZoomGesture = requestedPageZoomGesture && honorModifierWheel
    const canvasZoomGesture = requestedCanvasZoomGesture && honorModifierWheel
    const canvasPanGesture =
      e.shiftKey && honorModifierWheel && !canvasZoomGesture && !pageZoomGesture
    if (requestedModifierWheel && !honorModifierWheel) {
      if (resetTimer) clearTimeout(resetTimer)
      if (gesturePhase === 'overscrolling') resetGesture()
      e.preventDefault()
      return
    }

    if (pageZoomGesture) {
      if (resetTimer) clearTimeout(resetTimer)
      if (gesturePhase === 'overscrolling') resetGesture()
      e.preventDefault()
      ipcRenderer.send('browser:page-zoom-wheel', {
        deltaY: e.deltaY,
      })
      return
    }

    if (canvasZoomGesture || canvasPanGesture) {
      if (resetTimer) clearTimeout(resetTimer)
      if (gesturePhase === 'overscrolling') resetGesture()
      e.preventDefault()
      ipcRenderer.send('browser:canvas-wheel', {
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        clientX: e.clientX,
        clientY: e.clientY,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
      })
      return
    }

    // Already committed — absorb remaining momentum and reset shortly
    if (gesturePhase === 'committed') {
      if (resetTimer) clearTimeout(resetTimer)
      resetTimer = setTimeout(resetGesture, 60)
      return
    }

    // Only care about horizontal-dominant gestures
    if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.5 && gesturePhase !== 'overscrolling') {
      return
    }

    if (resetTimer) clearTimeout(resetTimer)

    const atLeft = isAtLeftEdge()
    const atRight = isAtRightEdge()

    // Swipe right (deltaX < 0) at left edge → go back
    // Swipe left (deltaX > 0) at right edge → go forward
    if (atLeft && e.deltaX < 0) {
      // Once overscrolling in the forward direction, ignore opposite events —
      // these are rubber-band bounce-back artifacts from scrollBounce on pages
      // where both edges are detected simultaneously (no horizontal overflow).
      if (direction === 'forward' && gesturePhase === 'overscrolling') return
      if (direction === 'forward') resetGesture()
      direction = 'back'
      gesturePhase = 'overscrolling'
      accDelta = Math.min(accDelta + Math.abs(e.deltaX), THRESHOLD * 1.3)
    } else if (atRight && e.deltaX > 0) {
      if (direction === 'back' && gesturePhase === 'overscrolling') return
      if (direction === 'back') resetGesture()
      direction = 'forward'
      gesturePhase = 'overscrolling'
      accDelta = Math.min(accDelta + Math.abs(e.deltaX), THRESHOLD * 1.3)
    } else if (gesturePhase === 'overscrolling') {
      // Gesture was active but user scrolled away from edge — decay
      accDelta = Math.max(0, accDelta - Math.abs(e.deltaX) * 2)
      if (accDelta <= 0) {
        resetGesture()
        return
      }
    } else {
      gesturePhase = 'scrolling'
      return
    }

    const progress = accDelta / THRESHOLD
    ipcRenderer.send('browser:overscroll-update', progress, direction)

    // When swipe ends (no more wheel events), commit or cancel
    resetTimer = setTimeout(() => {
      if (gesturePhase !== 'overscrolling') return
      if (progress >= 1 && direction) {
        ipcRenderer.send('browser:overscroll-navigate', direction)
        gesturePhase = 'committed'
        resetTimer = setTimeout(resetGesture, 80)
      } else {
        resetGesture()
      }
    }, 80)
  },
  { passive: false },
)
