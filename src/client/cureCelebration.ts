// Final beat of Pepito's medicine chase. The chase owns the falling potion;
// once it is picked up, this module owns the cure scene and sends the
// server-authoritative cure request: the sad pet, the opened PotionCure bottle
// hovering over it and tipping, green drops landing on the pet (which turns it
// from sad to dancing), then a heart. Visuals live in cureFx.ts.

import { engine, Entity, InputModifier, MainCamera, Transform, VirtualCamera } from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'
import { startCureCinematic, endCureCinematic, setCureCinematicPose } from './pet'
import { emitDrop, pourBoost, setBottle, startCureFx, stopCureFx, tickDrops } from './cureFx'
import { actions, clientState, pushToast } from './state'

// Scene timeline, in seconds from the camera cut. Each beat starts where the
// previous one ends; tweak the durations, not the derived times.
const SAD_ESTABLISH_S = 0.9 // the sad pet alone, so the change reads
const BOTTLE_APPEAR_S = 0.9 // the bouncy entrance
const BOTTLE_HOVER_S = 0.35 // floats over the pet before tipping
const BOTTLE_TILT_S = 0.8
const POUR_S = 2.0 // drops keep falling this long once the bottle is tipped
const DROP_INTERVAL_S = 0.1
const SHAKE_POUR_BOOST = 1.5 // drops come out up to 2.5x as fast at the peak of a shake
const POUR_STARTS_AT_TILT = 0.6 // first drop leaves the mouth this far into the tip
const BOTTLE_LEAVE_S = 0.6 // untips and shrinks away
const HEART_HOLD_S = 1.8
const CURE_REACTION_DELAY_S = 0.5 // the medicine needs a moment to work before the dance starts
const CURE_FALLBACK_AFTER_POUR_S = 1.5 // cure anyway if no drop is ever seen landing

const APPEAR_AT_S = SAD_ESTABLISH_S
const TILT_AT_S = APPEAR_AT_S + BOTTLE_APPEAR_S + BOTTLE_HOVER_S
const POUR_AT_S = TILT_AT_S + BOTTLE_TILT_S * POUR_STARTS_AT_TILT
const POUR_END_S = TILT_AT_S + BOTTLE_TILT_S + POUR_S
const LEAVE_AT_S = POUR_END_S
const HEART_AT_S = LEAVE_AT_S + BOTTLE_LEAVE_S
const SCENE_END_S = HEART_AT_S + HEART_HOLD_S
const EXIT_FADE_OUT_MS = 160
const EXIT_FADE_HOLD_MS = 220
const EXIT_FADE_IN_MS = 200

let running = false
let camera: Entity | null = null

/**
 * Play the final recovery scene after the physical medicine drop.
 */
export function startCureCelebration(onDone: () => void): boolean {
  if (running || !clientState.activePet?.sick) return false
  const shot = startCureCinematic()
  if (!shot) return false

  running = true
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
  if (!camera) camera = engine.addEntity()
  Transform.createOrReplace(camera, {
    position: shot.camPos,
    rotation: Quaternion.fromLookAt(shot.camPos, shot.look)
  })
  VirtualCamera.createOrReplace(camera, {
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.25) }
  })
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: camera })

  startCureFx(shot.hoverPos, shot.camPos, shot.hitY)

  let cured = false
  // The cure takes hold a beat after the first drop touches the pet (or, failing
  // that, shortly after the pour ends) so a hiccup can never leave the pet sick.
  const cure = (): void => {
    if (cured) return
    cured = true
    setCureCinematicPose('dance', null)
    actions.cureSickness()
    pushToast(`${clientState.activePet?.name ?? 'Your pet'} is healthy again!`, 'success')
  }
  let sceneT = 0
  let nextDropAt = POUR_AT_S
  let heartShown = false
  let firstLandingAt = -1

  let stage: 'scene' | 'out' | 'hold' | 'in' = 'scene'
  let elapsedMs = 0
  const finish = (): void => {
    stopCureFx()
    if (MainCamera.getOrNull(engine.CameraEntity)?.virtualCameraEntity === camera) {
      MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
    }
    endCureCinematic()
    if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
    clientState.screenFade.alpha = 0
    running = false
    onDone()
    engine.removeSystem(tick)
  }
  const playScene = (dt: number): void => {
    const appear = Math.min(1, Math.max(0, (sceneT - APPEAR_AT_S) / BOTTLE_APPEAR_S))
    const leave = Math.min(1, Math.max(0, (sceneT - LEAVE_AT_S) / BOTTLE_LEAVE_S))
    const tipping = Math.min(1, Math.max(0, (sceneT - TILT_AT_S) / BOTTLE_TILT_S))
    // Tips over, then rights itself and shrinks away as it leaves.
    setBottle(appear, tipping * (1 - leave), leave, dt)
    while (sceneT >= nextDropAt && nextDropAt < POUR_END_S) {
      emitDrop()
      // Shaking the bottle knocks the drops out faster.
      nextDropAt += DROP_INTERVAL_S / (1 + SHAKE_POUR_BOOST * pourBoost())
    }
    if (tickDrops(dt) > 0 && firstLandingAt < 0) firstLandingAt = sceneT
    if (firstLandingAt >= 0 && sceneT >= firstLandingAt + CURE_REACTION_DELAY_S) cure()
    if (sceneT >= POUR_END_S + CURE_FALLBACK_AFTER_POUR_S) cure()
    if (!heartShown && sceneT >= HEART_AT_S) {
      heartShown = true
      cure()
      setCureCinematicPose('dance', 'heart')
    }
  }
  const tick = (dt: number): void => {
    elapsedMs += dt * 1000
    if (stage === 'scene') {
      sceneT += dt
      playScene(dt)
      if (sceneT < SCENE_END_S) return
      stage = 'out'
      elapsedMs = 0
      return
    }
    if (stage === 'out') {
      clientState.screenFade.alpha = Math.min(1, elapsedMs / EXIT_FADE_OUT_MS)
      if (elapsedMs < EXIT_FADE_OUT_MS) return
      clientState.screenFade.alpha = 1
      if (MainCamera.getOrNull(engine.CameraEntity)?.virtualCameraEntity === camera) {
        MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
      }
      endCureCinematic()
      stage = 'hold'
      elapsedMs = 0
      return
    }
    if (stage === 'hold') {
      if (elapsedMs < EXIT_FADE_HOLD_MS) return
      stage = 'in'
      elapsedMs = 0
      return
    }
    clientState.screenFade.alpha = Math.max(0, 1 - elapsedMs / EXIT_FADE_IN_MS)
    if (elapsedMs < EXIT_FADE_IN_MS) return
    finish()
  }
  engine.addSystem(tick)
  return true
}
