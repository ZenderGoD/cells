// IMPORTANT: This file must stay as plain CJS (.cjs with require()).
// Do NOT convert to TypeScript or ESM — Electron sandboxed preloads
// need CJS, and vite-plugin-electron cannot reliably compile a second
// preload to CJS when the project has "type": "module". See the comment
// in vite.config.ts for the full explanation.
'use strict'

const { ipcRenderer } = require('electron')

// Detect horizontal overscroll gestures (trackpad swipe at scroll edge)
// and report progress to the main process for Chrome-like back/forward indicators.

let accDelta = 0
let direction = null
let gesturePhase = 'idle'
let resetTimer = null
let cooldownUntil = 0 // ignore wheel events until this timestamp (post-navigation)

function isAtLeftEdge() {
  const el = document.scrollingElement || document.documentElement
  return el.scrollLeft <= 0
}

function isAtRightEdge() {
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
  function (e) {
    const canvasZoomGesture = e.ctrlKey || e.metaKey
    const canvasPanGesture = e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)
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

    // Ignore momentum events still arriving after a navigation was committed
    if (Date.now() < cooldownUntil) return

    // Only care about horizontal-dominant gestures
    if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.5 && gesturePhase !== 'overscrolling') {
      return
    }

    if (resetTimer) clearTimeout(resetTimer)

    var atLeft = isAtLeftEdge()
    var atRight = isAtRightEdge()

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

    var progress = Math.min(accDelta / THRESHOLD, 1)
    ipcRenderer.send('browser:overscroll-update', progress, direction)

    // Navigate immediately once the threshold is reached — no waiting
    if (progress >= 1 && direction) {
      ipcRenderer.send('browser:overscroll-navigate', direction)
      resetGesture()
      cooldownUntil = Date.now() + 400 // ignore momentum events after navigating
      return
    }

    // If threshold not reached, cancel after momentum stops
    resetTimer = setTimeout(function () {
      if (gesturePhase !== 'overscrolling') return
      resetGesture()
    }, 120)
  },
  { passive: false },
)
