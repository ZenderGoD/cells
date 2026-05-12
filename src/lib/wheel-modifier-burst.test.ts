import assert from 'node:assert/strict'
import test from 'node:test'

const { createWheelModifierBurstState, shouldHonorWheelModifier } = await import(
  new URL('./wheel-modifier-burst.ts', import.meta.url).href
)

test('shouldHonorWheelModifier rejects modifiers pressed during an existing wheel burst', () => {
  const state = createWheelModifierBurstState()

  assert.equal(shouldHonorWheelModifier(state, false, 1000), false)
  assert.equal(shouldHonorWheelModifier(state, true, 1050), false)
  assert.equal(shouldHonorWheelModifier(state, true, 1179), false)
})

test('shouldHonorWheelModifier rejects modifiers pressed during a scroll tail after idle gaps', () => {
  const state = createWheelModifierBurstState()

  assert.equal(shouldHonorWheelModifier(state, false, 1000), false)
  assert.equal(shouldHonorWheelModifier(state, true, 2200), false)
  assert.equal(shouldHonorWheelModifier(state, true, 3500), false)
})

test('shouldHonorWheelModifier accepts wheel bursts that start with a modifier', () => {
  const state = createWheelModifierBurstState()

  assert.equal(shouldHonorWheelModifier(state, true, 1000), true)
  assert.equal(shouldHonorWheelModifier(state, true, 1050), true)
})

test('shouldHonorWheelModifier starts a fresh burst after the timeout', () => {
  const state = createWheelModifierBurstState()

  assert.equal(shouldHonorWheelModifier(state, false, 1000), false)
  assert.equal(shouldHonorWheelModifier(state, true, 2501), true)
})
