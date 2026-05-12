export const WHEEL_MODIFIER_BURST_TIMEOUT_MS = 180
export const WHEEL_MODIFIER_AFTER_PLAIN_SCROLL_COOLDOWN_MS = 1500

export type WheelModifierBurstState = {
  lastWheelAt: number | null
  startedWithModifier: boolean
  suppressModifierUntil: number
}

export function createWheelModifierBurstState(): WheelModifierBurstState {
  return {
    lastWheelAt: null,
    startedWithModifier: false,
    suppressModifierUntil: 0,
  }
}

export function shouldHonorWheelModifier(
  state: WheelModifierBurstState,
  modifierActive: boolean,
  now: number,
): boolean {
  const startsNewBurst =
    state.lastWheelAt === null || now - state.lastWheelAt > WHEEL_MODIFIER_BURST_TIMEOUT_MS

  if (startsNewBurst) {
    state.startedWithModifier = modifierActive && now >= state.suppressModifierUntil
  }

  if (!modifierActive || (modifierActive && !state.startedWithModifier)) {
    state.suppressModifierUntil = now + WHEEL_MODIFIER_AFTER_PLAIN_SCROLL_COOLDOWN_MS
  }

  state.lastWheelAt = now
  return modifierActive && state.startedWithModifier
}
