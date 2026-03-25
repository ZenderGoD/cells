import { ipcRenderer } from 'electron'

// Detect horizontal overscroll gestures (trackpad swipe at scroll edge)
// and report progress to the main process for Chrome-like back/forward indicators.

let accDelta = 0
let direction: 'back' | 'forward' | null = null
let gesturePhase: 'idle' | 'scrolling' | 'overscrolling' = 'idle'
let resetTimer: ReturnType<typeof setTimeout> | null = null

function isAtLeftEdge(): boolean {
  const el = document.scrollingElement || document.documentElement
  return el.scrollLeft <= 0
}

function isAtRightEdge(): boolean {
  const el = document.scrollingElement || document.documentElement
  return el.scrollLeft + window.innerWidth >= el.scrollWidth - 1
}

function resetGesture() {
  if (gesturePhase === 'overscrolling') {
    ipcRenderer.send('browser:overscroll-update', 0, null)
  }
  accDelta = 0
  direction = null
  gesturePhase = 'idle'
}

const THRESHOLD = 150 // px of accumulated delta to trigger navigation

window.addEventListener(
  'wheel',
  (e) => {
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
      if (direction === 'forward') resetGesture()
      direction = 'back'
      gesturePhase = 'overscrolling'
      accDelta = Math.min(accDelta + Math.abs(e.deltaX), THRESHOLD * 1.3)
    } else if (atRight && e.deltaX > 0) {
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

    const progress = Math.min(accDelta / THRESHOLD, 1)
    ipcRenderer.send('browser:overscroll-update', progress, direction)

    // After momentum stops, either commit navigation or cancel
    resetTimer = setTimeout(() => {
      if (gesturePhase !== 'overscrolling') return
      if (progress >= 1 && direction) {
        ipcRenderer.send('browser:overscroll-navigate', direction)
      }
      resetGesture()
    }, 180)
  },
  { passive: true },
)
