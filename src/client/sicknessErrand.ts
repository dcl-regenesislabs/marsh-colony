// The second beat of sickness: once the post-Feed dialog has finished, point
// the player to the Caretaker. Reaching them plays the medicine-table scene;
// Pepito steals its opened cure, while the chase itself comes in the next beat.

import { Animator, AvatarModifierArea, AvatarModifierType, engine, Entity, InputModifier, MainCamera, Transform, VirtualCamera } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'
import { applyCureLocal } from './sim'
import { actions, clientState, pushToast } from './state'
import { hideArrow, showArrowTo } from './pet'
import { openCureDialog } from './ui/dialog'
import { resetStolenPotion, startPepitoSteal } from './pepitoSteal'

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
let cureTheftRunning = false

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

/** `idle` supplies the Blender-authored closed-cage pose, paused at frame
 * zero so the renderer cannot autoplay either embedded clip. */
function closePotionCage(): void {
  const table = tableEntity()
  if (!table || !Animator.has(table)) return
  Animator.stopAllAnimations(table, true)
  for (const state of Animator.getMutable(table).states) {
    if (state.clip === 'idle') {
      state.playing = false
      state.loop = false
      state.speed = 1
      state.weight = 1
      state.shouldReset = true
    }
    if (state.clip === 'TableOpen') {
      state.playing = false
      state.loop = false
      state.speed = 1
      state.weight = 1
      state.shouldReset = true
    }
  }
}

function openPotionCage(): void {
  const table = tableEntity()
  if (!table || !Animator.has(table)) return
  Animator.playSingleAnimation(table, 'TableOpen', true)
  for (const state of Animator.getMutable(table).states) {
    if (state.clip === 'TableOpen') {
      state.loop = false
      state.speed = CAGE_OPEN_SPEED
      state.weight = 1
      state.shouldReset = true
    }
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
  cureTheftRunning = false
  clientState.screenFade.alpha = 0
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
  setAvatarHidden(true)
  resetStolenPotion()
  closePotionCage()

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
  // The closed-cage idle stays paused through the first Caretaker line. On
  // page two it switches to the single non-looping reveal clip.
  openCureDialog(() => {
    cureTheftRunning = startPepitoSteal(() => finishCure(false))
    if (!cureTheftRunning) finishCure()
  }, (page) => {
    if (page === 1) openPotionCage()
  })
}

/** Return from the medicine beat while fully black. Pepito's theft deliberately
 * leaves the pet sick; the later chase will be the only successful cure. */
function finishCure(cured = true): void {
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
      if (cured) {
        applyCureLocal()
        actions.cureSickness()
      }
      // Return to Blender's authored closed base pose under the fade.
      closePotionCage()
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
    cureTheftRunning = false
    if (!cured) pushToast('Pepito stole the cure! We need to get it back.', 'error')
    engine.removeSystem(tick)
  }
  engine.addSystem(tick)
}

export function setupSicknessErrand(): void {
  engine.addSystem(() => {
    // Safety net: if some future UI path drops the dialog, the camera/freeze
    // still return through the same masked release.
    if (cureRunning && !cureClosing && !cureTheftRunning && !clientState.dialog.open) finishCure()

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
    const table = tableEntity()
    if (table) beginCure(table, caretaker)
  })
}
