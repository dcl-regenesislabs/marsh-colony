// The second beat of sickness: once the post-Feed dialog has finished, point
// the player to the Caretaker. Reaching them plays the medicine-table scene;
// there is intentionally no Pepito/chase hand-off in this slice.

import { Animator, AvatarModifierArea, AvatarModifierType, engine, Entity, InputModifier, MainCamera, Transform, VirtualCamera } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'
import { applyCureLocal } from './sim'
import { actions, clientState, pushToast } from './state'
import { hideArrow, showArrowTo } from './pet'
import { openCureDialog } from './ui/dialog'

const CARETAKER_RADIUS = 5
const ENTER_TRANSITION_S = 0.35
const CAGE_OPEN_SPEED = 0.4
const EXIT_FADE_OUT_MS = 160
const EXIT_FADE_HOLD_MS = 250
const EXIT_FADE_IN_MS = 200

let cureRunning = false
let cureClosing = false
let cureCamera: Entity | null = null
let avatarHideArea: Entity | null = null
let tableReset = false

function caretakerEntity(): Entity | null {
  const entity = engine.getEntityOrNullByName(EntityNames.Caretaker_glb)
  return entity && Transform.has(entity) ? entity : null
}

function tableEntity(): Entity | null {
  const entity = engine.getEntityOrNullByName(EntityNames.PotionTable_glb)
  return entity && Transform.has(entity) ? entity : null
}

function playerPosition(): Vector3 | null {
  return Transform.getOrNull(engine.PlayerEntity)?.position ?? null
}

function flatDistance(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

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

/** Start the walk only if this is still the same, currently sick pet. */
export function startSicknessErrand(): void {
  const pet = clientState.activePet
  const caretaker = caretakerEntity()
  if (!pet?.sick || !caretaker || cureRunning) return
  clientState.sicknessErrand = { active: true, petId: pet.id }
  clientState.petPanelOpen = false
  showArrowTo(Transform.get(caretaker).position, 'sickness')
  pushToast('Follow the arrow to the Caretaker!')
}

export function cancelSicknessErrand(): void {
  if (!clientState.sicknessErrand.active) return
  clientState.sicknessErrand = { active: false, petId: '' }
  hideArrow('sickness')
}

/** PotionTable's authored base mesh is the high, closed cage. Always return
 * there explicitly; this keeps each cure deterministic and avoids a hidden
 * runtime frame selection. */
function resetPotionCage(): void {
  const table = tableEntity()
  if (!table || !Animator.has(table)) return
  Animator.stopAllAnimations(table, true)
}

function openPotionCage(): void {
  const table = tableEntity()
  if (!table || !Animator.has(table)) return
  // Start at the authored closed pose every time, then play the reveal.
  Animator.playSingleAnimation(table, 'TableOpen', true)
  for (const state of Animator.getMutable(table).states) {
    if (state.clip === 'TableOpen') state.speed = CAGE_OPEN_SPEED
  }
}

/** The camera sits on the Caretaker side of the table, looking across its cage
 * towards the potion. That puts the arriving avatar behind camera, not in shot. */
function tableShot(table: Entity, caretaker: Entity): { position: Vector3; look: Vector3 } {
  const t = Transform.get(table).position
  const c = Transform.get(caretaker).position
  const side = Vector3.normalize(Vector3.create(c.x - t.x, 0, c.z - t.z))
  return {
    position: Vector3.create(t.x + side.x * 3, t.y + 1.6, t.z + side.z * 3),
    look: Vector3.create(t.x, t.y + 0.95, t.z)
  }
}

function beginCure(table: Entity, caretaker: Entity): void {
  if (cureRunning) return
  cureRunning = true
  cureClosing = false
  clientState.screenFade.alpha = 0
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
  setAvatarHidden(true)
  resetPotionCage()

  const shot = tableShot(table, caretaker)
  if (!cureCamera) cureCamera = engine.addEntity()
  Transform.createOrReplace(cureCamera, {
    position: shot.position,
    rotation: Quaternion.fromLookAt(shot.position, shot.look)
  })
  VirtualCamera.createOrReplace(cureCamera, {
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(ENTER_TRANSITION_S) }
  })
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: cureCamera })
  // TableOpen's initial frame is the closed cage. It remains frozen there for
  // the first Caretaker line, then the page-2 reveal plays the one-shot clip.
  openCureDialog(finishCure, (page) => {
    if (page === 1) openPotionCage()
  })
}

/** Clear sick state while fully black, so the native camera return and bubble
 * change cannot flash through the cure shot. The server remains the authority. */
function finishCure(): void {
  if (!cureRunning || cureClosing) return
  cureClosing = true
  let stage: 'out' | 'hold' | 'in' = 'out'
  let elapsedMs = 0
  const tick = (dt: number): void => {
    elapsedMs += dt * 1000
    if (stage === 'out') {
      clientState.screenFade.alpha = Math.min(1, elapsedMs / EXIT_FADE_OUT_MS)
      if (elapsedMs < EXIT_FADE_OUT_MS) return
      clientState.screenFade.alpha = 1
      if (MainCamera.has(engine.CameraEntity)) MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
      setAvatarHidden(false)
      applyCureLocal()
      actions.cureSickness()
      // Put the table back at the authored closed pose while the screen is
      // black, ready for the next cure without a visible snap.
      resetPotionCage()
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
    cureRunning = false
    cureClosing = false
    engine.removeSystem(tick)
  }
  engine.addSystem(tick)
}

export function setupSicknessErrand(): void {
  engine.addSystem(() => {
    const table = tableEntity()
    if (!tableReset && table && Animator.has(table)) {
      resetPotionCage()
      tableReset = true
    }

    // Safety net: if some future UI path drops the dialog, the camera/freeze
    // still return through the same masked release.
    if (cureRunning && !cureClosing && !clientState.dialog.open) finishCure()

    const task = clientState.sicknessErrand
    if (!task.active || cureRunning) return
    if (clientState.carryEgg.active || clientState.carryPet.active || !clientState.activePet?.sick || clientState.activePet.id !== task.petId) {
      cancelSicknessErrand()
      return
    }
    const caretaker = caretakerEntity()
    const position = playerPosition()
    if (!caretaker || !position) return
    const target = Transform.get(caretaker).position
    showArrowTo(target, 'sickness')
    if (flatDistance(position, target) > CARETAKER_RADIUS) return
    cancelSicknessErrand()
    if (table) beginCure(table, caretaker)
  })
}
