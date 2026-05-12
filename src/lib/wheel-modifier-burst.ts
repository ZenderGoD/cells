export const WHEEL_MODIFIER_BURST_TIMEOUT_MS = 180

export type WheelModifierBurstState = {
  lastWheelAt: number | null
  startedWithModifier: boolean
}

export function createWheelModifierBurstState(): WheelModifierBurstState {
  return {
    lastWheelAt: null,
    startedWithModifier: false,
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
    state.startedWithModifier = modifierActive
  }

  state.lastWheelAt = now
  return modifierActive && state.startedWithModifier
}
