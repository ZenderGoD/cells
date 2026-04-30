// IMPORTANT: This file must stay as plain CJS (.cjs with require()).
// Do NOT convert to TypeScript or ESM — Electron sandboxed preloads
// need CJS, and vite-plugin-electron cannot reliably compile a second
// preload to CJS when the project has "type": "module". See the comment
// in vite.config.ts for the full explanation.
'use strict'

const { ipcRenderer } = require('electron')

// Detect horizontal overscroll gestures (trackpad swipe at scroll edge)
// and report progress to the main process for Chrome-like back/forward indicators.

const ELEMENT_PICKER_TEXT_LIMIT = 4000
const ELEMENT_PICKER_HTML_LIMIT = 8000
const ELEMENT_PICKER_ATTR_LIMIT = 1000
const ELEMENT_PICKER_Z_INDEX = 2147483647

let elementPickerState = null

function truncatePickerString(value, maxLength) {
  if (typeof value !== 'string') return ''
  return value.length > maxLength ? value.slice(0, maxLength) + '...' : value
}

function normalizePickerText(value, maxLength) {
  return truncatePickerString(
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim(),
    maxLength,
  )
}

function pickerCssEscape(value) {
  if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') {
    return globalThis.CSS.escape(value)
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, function (char) {
    return '\\' + char
  })
}

function pickerAttrEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function pickerSelectorMatches(selector, element) {
  try {
    return document.querySelector(selector) === element
  } catch {
    return false
  }
}

function getPickerSelectorPart(element) {
  var tag = element.tagName.toLowerCase()
  if (!tag) return null

  if (element.id) {
    return tag + '#' + pickerCssEscape(element.id)
  }

  var stableAttrs = ['data-testid', 'data-test', 'data-cy', 'aria-label', 'name', 'title']
  for (var i = 0; i < stableAttrs.length; i++) {
    var attr = stableAttrs[i]
    var attrValue = element.getAttribute(attr)
    if (attrValue) {
      return tag + '[' + attr + '="' + pickerAttrEscape(truncatePickerString(attrValue, 120)) + '"]'
    }
  }

  var classes = Array.from(element.classList || [])
    .filter(function (name) {
      return /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(name)
    })
    .slice(0, 2)
  var part =
    tag +
    classes
      .map(function (name) {
        return '.' + pickerCssEscape(name)
      })
      .join('')

  var parent = element.parentElement
  if (!parent) return part
  var sameTagSiblings = Array.from(parent.children).filter(function (child) {
    return child.tagName === element.tagName
  })
  if (sameTagSiblings.length > 1) {
    part += ':nth-of-type(' + (sameTagSiblings.indexOf(element) + 1) + ')'
  }
  return part
}

function getPickerSelector(element) {
  if (element.id) {
    var idSelector = '#' + pickerCssEscape(element.id)
    if (pickerSelectorMatches(idSelector, element)) return idSelector
  }

  var parts = []
  var current = element
  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
    var part = getPickerSelectorPart(current)
    if (!part) break
    parts.unshift(part)
    var selector = parts.join(' > ')
    if (pickerSelectorMatches(selector, element)) return selector
    if (current === document.documentElement) break
    current = current.parentElement
  }

  return parts.join(' > ')
}

function getPickerElementFromTarget(target) {
  if (target instanceof Element) return target
  if (target instanceof Node && target.parentElement) return target.parentElement
  return null
}

function getPickerEventTarget(event) {
  var path = typeof event.composedPath === 'function' ? event.composedPath() : null
  return path && path.length > 0 ? path[0] : event.target
}

function isPickerChrome(element) {
  return Boolean(element.closest && element.closest('[data-cells-element-picker="true"]'))
}

function getPickerAttributes(element) {
  var attributes = {}
  var count = 0
  for (var i = 0; i < element.attributes.length; i++) {
    var attr = element.attributes[i]
    if (!attr || !attr.name) continue
    var name = attr.name.toLowerCase()
    if (name === 'style' || name === 'value' || name.startsWith('on')) continue
    attributes[name] = truncatePickerString(attr.value || '', ELEMENT_PICKER_ATTR_LIMIT)
    count += 1
    if (count >= 32) break
  }
  return attributes
}

function getPickerElementPayload(element) {
  var rect = element.getBoundingClientRect()
  return {
    url: window.location.href,
    title: document.title || '',
    tagName: element.tagName.toLowerCase(),
    selector: getPickerSelector(element),
    text: normalizePickerText(
      element.innerText || element.textContent || '',
      ELEMENT_PICKER_TEXT_LIMIT,
    ),
    outerHtml: truncatePickerString(element.outerHTML || '', ELEMENT_PICKER_HTML_LIMIT),
    attributes: getPickerAttributes(element),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    href: typeof element.href === 'string' ? element.href : null,
    src: typeof element.src === 'string' ? element.src : null,
    alt: element.getAttribute('alt'),
    role: element.getAttribute('role'),
  }
}

function ensurePickerChrome() {
  if (!elementPickerState) return null
  if (elementPickerState.box && elementPickerState.label) return elementPickerState

  var box = document.createElement('div')
  box.dataset.cellsElementPicker = 'true'
  box.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'width:0',
    'height:0',
    'pointer-events:none',
    'box-sizing:border-box',
    'border:2px solid rgb(125, 211, 252)',
    'border-radius:6px',
    'background:rgba(14, 165, 233, 0.12)',
    'box-shadow:0 0 0 1px rgba(2, 132, 199, 0.45), 0 12px 36px rgba(8, 47, 73, 0.22)',
    'z-index:' + ELEMENT_PICKER_Z_INDEX,
    'display:none',
  ].join(';')

  var label = document.createElement('div')
  label.dataset.cellsElementPicker = 'true'
  label.textContent = 'Click an element to send it to chat. Esc cancels.'
  label.style.cssText = [
    'position:fixed',
    'left:50%',
    'top:12px',
    'transform:translateX(-50%)',
    'pointer-events:none',
    'box-sizing:border-box',
    'max-width:min(520px, calc(100vw - 24px))',
    'border:1px solid rgba(255, 255, 255, 0.16)',
    'border-radius:8px',
    'background:rgba(15, 23, 42, 0.92)',
    'color:white',
    'font:12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    'letter-spacing:0',
    'padding:7px 10px',
    'box-shadow:0 10px 32px rgba(0, 0, 0, 0.26)',
    'z-index:' + ELEMENT_PICKER_Z_INDEX,
  ].join(';')
  ;(document.body || document.documentElement).appendChild(box)
  ;(document.body || document.documentElement).appendChild(label)
  elementPickerState.box = box
  elementPickerState.label = label
  return elementPickerState
}

function updatePickerOverlay(element) {
  if (!elementPickerState) return
  var state = ensurePickerChrome()
  if (!state || !state.box) return
  if (!element || !document.documentElement.contains(element)) {
    state.box.style.display = 'none'
    return
  }

  var rect = element.getBoundingClientRect()
  state.box.style.display = 'block'
  state.box.style.transform =
    'translate(' +
    Math.max(0, Math.round(rect.left)) +
    'px, ' +
    Math.max(0, Math.round(rect.top)) +
    'px)'
  state.box.style.width = Math.max(0, Math.round(rect.width)) + 'px'
  state.box.style.height = Math.max(0, Math.round(rect.height)) + 'px'
}

function absorbPickerEvent(event) {
  event.preventDefault()
  event.stopPropagation()
  if (typeof event.stopImmediatePropagation === 'function') {
    event.stopImmediatePropagation()
  }
}

function setPickerHoverFromTarget(target) {
  if (!elementPickerState) return null
  var element = getPickerElementFromTarget(target)
  if (!element || isPickerChrome(element)) return elementPickerState.hoveredElement
  elementPickerState.hoveredElement = element
  updatePickerOverlay(element)
  return element
}

function onPickerPointerMove(event) {
  setPickerHoverFromTarget(getPickerEventTarget(event))
}

function onPickerPointerDown(event) {
  if (!elementPickerState) return
  setPickerHoverFromTarget(getPickerEventTarget(event))
  absorbPickerEvent(event)
}

function onPickerClick(event) {
  if (!elementPickerState) return
  var element =
    setPickerHoverFromTarget(getPickerEventTarget(event)) || elementPickerState.hoveredElement
  var requestId = elementPickerState.requestId
  absorbPickerEvent(event)
  stopElementPicker(false)
  if (!element) {
    ipcRenderer.send('browser:element-picker-cancelled', requestId)
    return
  }
  ipcRenderer.send('browser:element-picker-selected', {
    requestId: requestId,
    selection: getPickerElementPayload(element),
  })
}

function onPickerKeyDown(event) {
  if (!elementPickerState || event.key !== 'Escape') return
  var requestId = elementPickerState.requestId
  absorbPickerEvent(event)
  stopElementPicker(false)
  ipcRenderer.send('browser:element-picker-cancelled', requestId)
}

function onPickerContextMenu(event) {
  if (!elementPickerState) return
  var requestId = elementPickerState.requestId
  absorbPickerEvent(event)
  stopElementPicker(false)
  ipcRenderer.send('browser:element-picker-cancelled', requestId)
}

function onPickerViewportChanged() {
  if (!elementPickerState) return
  updatePickerOverlay(elementPickerState.hoveredElement)
}

function addPickerListeners() {
  document.addEventListener('pointermove', onPickerPointerMove, true)
  document.addEventListener('mousemove', onPickerPointerMove, true)
  document.addEventListener('pointerdown', onPickerPointerDown, true)
  document.addEventListener('mousedown', onPickerPointerDown, true)
  document.addEventListener('click', onPickerClick, true)
  document.addEventListener('contextmenu', onPickerContextMenu, true)
  document.addEventListener('keydown', onPickerKeyDown, true)
  window.addEventListener('scroll', onPickerViewportChanged, true)
  window.addEventListener('resize', onPickerViewportChanged, true)
}

function removePickerListeners() {
  document.removeEventListener('pointermove', onPickerPointerMove, true)
  document.removeEventListener('mousemove', onPickerPointerMove, true)
  document.removeEventListener('pointerdown', onPickerPointerDown, true)
  document.removeEventListener('mousedown', onPickerPointerDown, true)
  document.removeEventListener('click', onPickerClick, true)
  document.removeEventListener('contextmenu', onPickerContextMenu, true)
  document.removeEventListener('keydown', onPickerKeyDown, true)
  window.removeEventListener('scroll', onPickerViewportChanged, true)
  window.removeEventListener('resize', onPickerViewportChanged, true)
}

function startElementPicker(request) {
  var requestId = request && typeof request.requestId === 'string' ? request.requestId : null
  if (!requestId) return
  stopElementPicker(false)

  elementPickerState = {
    requestId: requestId,
    hoveredElement: null,
    box: null,
    label: null,
    previousCursor: document.documentElement.style.cursor,
    previousUserSelect: document.documentElement.style.userSelect,
  }

  addPickerListeners()
  document.documentElement.style.cursor = 'crosshair'
  document.documentElement.style.userSelect = 'none'
  ensurePickerChrome()

  var initial = document.elementFromPoint(
    Math.max(0, window.innerWidth / 2),
    Math.max(0, window.innerHeight / 2),
  )
  if (initial) setPickerHoverFromTarget(initial)
}

function stopElementPicker(notifyMain) {
  if (!elementPickerState) return
  var requestId = elementPickerState.requestId
  removePickerListeners()
  if (elementPickerState.box) elementPickerState.box.remove()
  if (elementPickerState.label) elementPickerState.label.remove()
  document.documentElement.style.cursor = elementPickerState.previousCursor || ''
  document.documentElement.style.userSelect = elementPickerState.previousUserSelect || ''
  elementPickerState = null
  if (notifyMain) {
    ipcRenderer.send('browser:element-picker-cancelled', requestId)
  }
}

ipcRenderer.on('browser:element-picker-start', function (_event, request) {
  startElementPicker(request)
})

ipcRenderer.on('browser:element-picker-cancel', function () {
  stopElementPicker(false)
})

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
    // Trackpad pinch arrives as Ctrl+wheel in Chromium. Electron's embedded
    // WebContentsView does not apply Chrome-style page zoom for us here, so
    // forward the gesture to main where the browser's page zoom multiplier is
    // kept separate from the canvas zoom multiplier.
    const pageZoomGesture = e.ctrlKey && !e.metaKey
    const canvasZoomGesture = e.metaKey
    const canvasPanGesture = e.shiftKey && !canvasZoomGesture && !pageZoomGesture
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
