// First beat of the sickness flow: after a poisoned Feed round has fully
// released its camera, frame the pet in a sad pose while the Caretaker explains
// what happened. The cure errand and persisted `pet.sick` state deliberately
// come in a later step.

import { AvatarModifierArea, AvatarModifierType, engine, Entity, InputModifier, MainCamera, Transform, VirtualCamera } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { clientState } from './state'
import { endSadCinematic, startSadCinematic } from './pet'
import { openSicknessDialog } from './ui/dialog'

const ENTER_TRANSITION_S = 0.35
const EXIT_FADE_OUT_MS = 160
const EXIT_FADE_HOLD_MS = 250
const EXIT_FADE_IN_MS = 200

let queued = false
let running = false
let closing = false
let camera: Entity | null = null
let avatarHideArea: Entity | null = null

/** Queue the Caretaker scene. Feed consumes this under its exit blackout when
 * possible; the system below remains as the safe fallback for standalone use. */
export function queueSicknessCinematic(): void {
  queued = true
}

function canStart(): boolean {
  const s = clientState
  return (
    s.serverReady &&
    !!s.activePet &&
    !s.feedGame.active &&
    !s.bathGame.active &&
    !s.petting.active &&
    !s.hatch.active &&
    !s.carryEgg.active &&
    !s.carryPet.active &&
    !s.fetch.active &&
    !s.dialog.open &&
    s.screenFade.alpha <= 0
  )
}

/** Hide only the local frozen avatar while this close pet shot is active. */
function setAvatarHidden(hidden: boolean): void {
  if (!hidden) {
    if (avatarHideArea && AvatarModifierArea.has(avatarHideArea)) AvatarModifierArea.deleteFrom(avatarHideArea)
    return
  }
  const player = Transform.getOrNull(engine.PlayerEntity)
  if (!player) return
  if (!avatarHideArea) avatarHideArea = engine.addEntity()
  Transform.createOrReplace(avatarHideArea, { position: player.position })
  AvatarModifierArea.createOrReplace(avatarHideArea, {
    area: Vector3.create(2.5, 4, 2.5),
    modifiers: [AvatarModifierType.AMT_HIDE_AVATARS, AvatarModifierType.AMT_HIDE_NAMETAGS],
    excludeIds: []
  })
}

/** Start the scene. When already covered by Feed's blackout, the camera may
 * swap immediately because there is no visible transition to blend. */
function begin(underBlackout = false): boolean {
  const shot = startSadCinematic()
  if (!shot) {
    // This is also reachable from the UI Debug Browser, which may have just
    // swapped in its fixture pet. Keep the request queued until pet.ts has
    // created that local render entity.
    return false
  }

  queued = false
  running = true
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
  setAvatarHidden(true)

  if (!camera) camera = engine.addEntity()
  Transform.createOrReplace(camera, {
    position: shot.camPos,
    rotation: Quaternion.fromLookAt(shot.camPos, shot.look)
  })
  VirtualCamera.createOrReplace(camera, {
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(underBlackout ? 0 : ENTER_TRANSITION_S) }
  })
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: camera })
  openSicknessDialog(finish)
  return true
}

/** Called by Feed while its screen fade is fully opaque. Returning false keeps
 * Feed's normal native-camera release path intact as a fallback. */
export function startSicknessCinematicFromFeedBlackout(): boolean {
  if (!queued || running || closing) return false
  return begin(true)
}

/** Return control only after the native camera takes over behind a brief fade.
 * The reusable VirtualCamera component stays alive; clearing MainCamera's
 * reference is the supported hand-off and avoids a renderer rebuild. */
function finish(): void {
  if (!running || closing) return
  closing = true

  let stage: 'out' | 'hold' | 'in' = 'out'
  let elapsedMs = 0
  const tick = (dt: number): void => {
    elapsedMs += dt * 1000
    if (stage === 'out') {
      clientState.screenFade.alpha = Math.min(1, elapsedMs / EXIT_FADE_OUT_MS)
      if (elapsedMs < EXIT_FADE_OUT_MS) return
      clientState.screenFade.alpha = 1
      if (MainCamera.has(engine.CameraEntity)) MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
      endSadCinematic()
      setAvatarHidden(false)
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
    clientState.screenFade.alpha = 0
    if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
    running = false
    closing = false
    engine.removeSystem(tick)
  }
  engine.addSystem(tick)
}

export function setupSicknessCinematic(): void {
  engine.addSystem((dt: number) => {
    if (queued && !running) {
      if (canStart()) begin()
    }

    // Safety net for any future dialog dismissal path that doesn't invoke its
    // onDone callback: never leave the player frozen on this camera.
    if (running && !closing && !clientState.dialog.open) finish()
  })
}
