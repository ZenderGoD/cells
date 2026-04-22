interface ModifierState {
  metaKey: boolean
  ctrlKey: boolean
}

function detectPlatform() {
  if (typeof navigator === 'undefined') return ''
  const userAgentPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform
  if (typeof userAgentPlatform === 'string' && userAgentPlatform.length > 0) {
    return userAgentPlatform
  }
  return navigator.platform ?? ''
}

export function isMacPlatform(platform = detectPlatform()) {
  const normalized = platform.trim().toLowerCase()
  return (
    normalized.includes('mac') ||
    normalized.includes('iphone') ||
    normalized.includes('ipad') ||
    normalized.includes('ipod')
  )
}

export function hasPrimaryModifier(event: ModifierState, platform = detectPlatform()) {
  return isMacPlatform(platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export function isPrimaryModifierKey(key: string, platform = detectPlatform()) {
  return key === (isMacPlatform(platform) ? 'Meta' : 'Control')
}

export function getPrimaryModifierLabel(platform = detectPlatform()) {
  return isMacPlatform(platform) ? '⌘' : 'Ctrl'
}

export function getAltModifierLabel(platform = detectPlatform()) {
  return isMacPlatform(platform) ? '⌥' : 'Alt'
}
