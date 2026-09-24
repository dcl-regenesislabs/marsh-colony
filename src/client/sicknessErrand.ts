// The second beat of sickness: once the post-Feed dialog has finished, point
// the player to the Caretaker. Reaching them plays the medicine-table scene;
// Pepito steals its opened cure, while the chase itself comes in the next beat.

import { Animator, engine, Entity, InputAction, inputSystem, InputModifier, MainCamera, PointerEventType, Transform, VirtualCamera } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'
import { EntityNames } from '../../assets/scene/entity-names'
import { actions, clientState, pushToast } from './state'
import { hideArrow, showArrowTo } from './pet'
import { openCureDialog } from './ui/dialog'
import { pepitoStealHidesHud, resetStolenPotion, startPepitoSteal, stopCryEmote } from './pepitoSteal'
import { startPepitoChase } from './pepitoChase'
import { getPotionTableEntity } from './sicknessProps'
import { sicknessCinematicOwnsFlow } from './sicknessCinematic'

const CARETAKER_RADIUS = 5
const ENTER_TRANSITION_S = 0.35
const TABLE_ESTABLISH_S = 0.75
const CAGE_OPEN_SPEED = 0.4
const EXIT_FADE_OUT_MS = 160
const EXIT_FADE_HOLD_MS = 250
const EXIT_FADE_IN_MS = 200

let cureRunning = false
let cureClosing = false
let cureCamera: Entity | null = null
let cureTheftRunning = false
let tableIdleApplied = false
let cureDialogPending = false
let replayPending = false // dev replay teleport in flight: keep the real errand from restarting

function caretakerEntity(): Entity | null {
  const entity = engine.getEntityOrNullByName(EntityNames.Caretaker_glb)
  return entity && Transform.has(entity) ? entity : null
}

function tableEntity(): Entity | null {
  return getPotionTableEntity()
}

function playerPosition(): Vector3 | null {
  return Transform.getOrNull(engine.PlayerEntity)?.position ?? null
}

function flatDistance(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/** Start the walk only if this is still the same, currently sick pet. */
export function startSicknessErrand(): void {
  const pet = clientState.activePet
  const caretaker = caretakerEntity()
  if (!pet?.sick || !caretaker || cureRunning) return
  clientState.sicknessErrand = { active: true, petId: pet.id }
  clientState.petPanelOpen = false
  showArrowTo(Transform.get(caretaker).position, 'sickness')
}

export function cancelSicknessErrand(): void {
  if (!clientState.sicknessErrand.active) return
  clientState.sicknessErrand = { active: false, petId: '' }
  hideArrow('sickness')
}

/** `idle` is a zero-duration Blender pose holding the closed cage. It must be
 * marked playing (at speed 0) so the renderer actually applies that pose;
 * merely declaring a stopped clip leaves the GLB's open base transform visible. */
function closePotionCage(): void {
  const table = tableEntity()
  if (!table || !Animator.has(table)) return
  Animator.playSingleAnimation(table, 'idle', true)
  for (const state of Animator.getMutable(table).states) {
    if (state.clip === 'idle') {
      state.playing = true
      state.loop = false
      state.speed = 0
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

/** `preview` (dev replay only) skips the server hand-off and the chase that follows. */
function beginCure(table: Entity, caretaker: Entity, preview = false): void {
  if (cureRunning) return
  cureRunning = true
  cureClosing = false
  cureTheftRunning = false
  cureDialogPending = true
  clientState.screenFade.alpha = 0
  // The server will only honor the final cure after this Care Center hand-off.
  // It independently checks the player's authoritative world position.
  if (!preview) actions.beginSicknessCure()
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
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
  // Let the camera settle on the locked cage before UI covers the shot. This
  // establishes what the player came for instead of jumping straight into the
  // first line as soon as they enter the Caretaker radius.
  let establishElapsed = 0
  const openDialogAfterEstablish = (dt: number): void => {
    if (!cureRunning || cureClosing) {
      engine.removeSystem(openDialogAfterEstablish)
      return
    }
    establishElapsed += dt
    if (establishElapsed < TABLE_ESTABLISH_S) return
    cureDialogPending = false
    openCureDialog(() => {
      cureTheftRunning = startPepitoSteal(() => {
        // Finish the table camera hand-off first. Starting the chase after the
        // blackout has lifted means the Caretaker's rock instruction is never
        // hidden behind it or racing the native camera return.
        finishCure(false, () => {
          if (preview) return
          if (!startPepitoChase()) {
            pushToast('Pepito got away. Speak to the Caretaker and try again.', 'error')
            startSicknessErrand()
          }
        })
      })
      if (!cureTheftRunning) {
        finishCure(false, () => {
          pushToast('The cure setup was interrupted. Please try again.', 'error')
          startSicknessErrand()
        })
      }
    }, (page) => {
      if (page === 1) openPotionCage()
    })
    engine.removeSystem(openDialogAfterEstablish)
  }
  engine.addSystem(openDialogAfterEstablish)
}

/** Return from the medicine beat while fully black. Pepito's theft deliberately
 * leaves the pet sick; the later chase will be the only successful cure. */
function finishCure(showTheftToast = true, afterRelease?: () => void): void {
  if (!cureRunning || cureClosing) return
  cureClosing = true
  cureDialogPending = false
  let stage: 'out' | 'hold' | 'in' = 'out'
  let elapsedMs = 0
  const tick = (dt: number): void => {
    elapsedMs += dt * 1000
    if (stage === 'out') {
      clientState.screenFade.alpha = Math.min(1, elapsedMs / EXIT_FADE_OUT_MS)
      if (elapsedMs < EXIT_FADE_OUT_MS) return
      clientState.screenFade.alpha = 1
      if (MainCamera.has(engine.CameraEntity)) MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
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
    stopCryEmote()
    cureRunning = false
    cureClosing = false
    cureTheftRunning = false
    if (showTheftToast) pushToast('Pepito stole the cure! We need to get it back.', 'error')
    afterRelease?.()
    engine.removeSystem(tick)
  }
  engine.addSystem(tick)
}

export function setupSicknessErrand(): void {
  setupReplayDevKey()
  engine.addSystem(() => {
    // Apply the static closed pose as soon as the composite's Animator exists,
    // not only when the player has already reached the Caretaker.
    const table = tableEntity()
    if (!tableIdleApplied && table && Animator.has(table)) {
      closePotionCage()
      tableIdleApplied = true
    }

    // Safety net: if some future UI path drops the dialog, the camera/freeze
    // still return through the same masked release.
    if (cureRunning && !cureClosing && !cureDialogPending && !cureTheftRunning && !clientState.dialog.open) {
      finishCure(false, () => startSicknessErrand())
    }

    const task = clientState.sicknessErrand
    const pet = clientState.activePet
    const anotherFlowOwnsPlayer =
      clientState.feedGame.active ||
      clientState.bathGame.active ||
      clientState.petting.active ||
      clientState.hatch.active ||
      clientState.fetch.active ||
      clientState.carryEgg.active ||
      clientState.carryPet.active ||
      clientState.breed.active ||
      clientState.feedTask.active ||
      clientState.dialog.open ||
      clientState.screenFade.alpha > 0 ||
      clientState.pepitoChase.active ||
      pepitoStealHidesHud() ||
      sicknessCinematicOwnsFlow()
    // Sickness persists on the server, so its route must resume after reloads,
    // cancelled BACK presses, transient entity-load misses, and interrupted
    // Pepito stages. `startSicknessErrand` safely retries until the Caretaker
    // entity itself is ready.
    if (!task.active && !cureRunning && !replayPending && pet?.sick && !anotherFlowOwnsPlayer) startSicknessErrand()
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

// DEV ONLY: key "4" (IA_ACTION_6) replays the medicine-table scene (cage opens,
// avatar walks up, Pepito steals, avatar cries) as often as you like. It skips
// the server hand-off and the chase, and first drops the avatar back near the
// Caretaker so the walk always plays. Remove once the scene is finished.
const REPLAY_START_DISTANCE = 4.2 // metres from the table, on the Caretaker's side
const REPLAY_TELEPORT_S = 0.5 // give the teleport time to land before the scene starts

function setupReplayDevKey(): void {
  let countdown = -1
  engine.addSystem((dt: number) => {
    if (countdown >= 0) {
      countdown -= dt
      if (countdown > 0) return
      countdown = -1
      replayPending = false
      const table = tableEntity()
      const caretaker = caretakerEntity()
      if (table && caretaker) beginCure(table, caretaker, true)
      return
    }
    if (!inputSystem.isTriggered(InputAction.IA_ACTION_6, PointerEventType.PET_DOWN)) return
    if (cureRunning || clientState.pepitoChase.active || clientState.dialog.open || clientState.screenFade.alpha > 0 || pepitoStealHidesHud()) return
    const table = tableEntity()
    const caretaker = caretakerEntity()
    if (!table || !caretaker) return
    cancelSicknessErrand()
    const tablePos = Transform.get(table).position
    const caretakerPos = Transform.get(caretaker).position
    const flat = Vector3.create(caretakerPos.x - tablePos.x, 0, caretakerPos.z - tablePos.z)
    const side = Vector3.length(flat) > 0.01 ? Vector3.normalize(flat) : Vector3.create(1, 0, 0)
    const start = Vector3.create(tablePos.x + side.x * REPLAY_START_DISTANCE, playerPosition()?.y ?? tablePos.y, tablePos.z + side.z * REPLAY_START_DISTANCE)
    void movePlayerTo({ newRelativePosition: start, cameraTarget: tablePos }).catch(() => {})
    replayPending = true
    countdown = REPLAY_TELEPORT_S
  })
}
