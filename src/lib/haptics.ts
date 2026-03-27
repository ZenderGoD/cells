import { WebHaptics } from 'web-haptics'

const haptics = new WebHaptics()

/** Light tap for selections, toggles, navigation */
export function hapticNudge() {
  haptics.trigger('nudge').catch(() => {})
}

/** Double-tap for confirmations, successful actions */
export function hapticSuccess() {
  haptics.trigger('success').catch(() => {})
}

/** Triple-tap for errors, destructive actions */
export function hapticError() {
  haptics.trigger('error').catch(() => {})
}

/** Short buzz for mode changes */
export function hapticBuzz() {
  haptics.trigger(40).catch(() => {})
}
