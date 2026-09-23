// Final beat of Pepito's medicine chase. The chase owns the falling potion;
// once it lands, this module owns the short happy-pet reveal and sends the
// server-authoritative cure request.

import { engine, Entity, InputModifier, MainCamera, Transform, VirtualCamera } from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'
import { startCureCinematic, endCureCinematic } from './pet'
import { applyCureLocal } from './sim'
import { actions, clientState, pushToast } from './state'

const HAPPY_HOLD_MS = 2600
const EXIT_FADE_OUT_MS = 160
const EXIT_FADE_HOLD_MS = 220
const EXIT_FADE_IN_MS = 200

let running = false
let camera: Entity | null = null

/**
 * Play the final recovery camera after the physical medicine drop. `preview`
 * is only for the local Pepito tuning panel: it shows the exact animation but
 * never changes sickness, rewards, or server state.
 */
export function startCureCelebration(preview: boolean, onDone: () => void): boolean {
  if (running || (!preview && !clientState.activePet?.sick)) return false
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

  if (!preview) {
    // The happy cinematic is the feedback for this win. Do not cover it with
    // the usual purple XP / orange coin chips right after the stone hits.
    clientState.reward = null
    applyCureLocal(false)
    actions.cureSickness()
    pushToast(`${clientState.activePet?.name ?? 'Your pet'} is healthy again!`, 'success')
  }

  let stage: 'happy' | 'out' | 'hold' | 'in' = 'happy'
  let elapsedMs = 0
  const finish = (): void => {
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
  const tick = (dt: number): void => {
    elapsedMs += dt * 1000
    if (stage === 'happy') {
      if (elapsedMs < HAPPY_HOLD_MS) return
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
