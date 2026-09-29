// First beat of the Pepito cure arc. This intentionally stops after the theft:
// Pepito takes the medicine and disappears, while the later chase minigame is
// still to come.

import { Animator, ColliderLayer, engine, Entity, GltfContainer, InputModifier, MainCamera, Transform, VirtualCamera, VisibilityComponent } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { movePlayerTo, stopEmote, triggerEmote, triggerSceneEmote } from '~system/RestrictedActions'
import { EntityNames } from '../../assets/scene/entity-names'
import { SIZE_BASE, clipForSpecies, modelForSpecies, scaleForSpecies, stageScaleFor, yawOffsetForSpecies } from '../shared/config'
import { applyCreatureSkin } from './creatureSkins'
import { getPotionEntity, getPotionTableEntity } from './sicknessProps'
import { playPetVoice } from './pet'
import { mobile } from './ui/theme'

const PEPITO_SPECIES = 'pepito-original'
const PEPITO_SCALE = stageScaleFor(SIZE_BASE) * scaleForSpecies(PEPITO_SPECIES)
const NO_COLLISION = { visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE }

// Do not rush the one shot that establishes the medicine: even if the player
// advances the Caretaker dialog immediately, the open cage and bottle get a
// readable beat before Pepito arrives.
const TABLE_REVEAL_HOLD_S = 1.15
// The player's avatar walks up to the opened table before Pepito appears, then
// cries when he snatches the potion. movePlayerTo with a duration glides the
// avatar (interpolated) instead of teleporting it.
const WALK_STAND_DISTANCE = 1.0 // metres from the table's center, on the Caretaker's side (the table is ~0.7m wide)
const WALK_SPEED = 1.65 // m/s, deliberately readable in the approach shot
const WALK_MIN_S = 1.8
const WALK_MAX_S = 3.2
const WALK_SETTLE_S = 0.3 // standing at the table this long before Pepito appears
const WALK_SKIP_DISTANCE = 0.3 // already this close: no walk
// A diagonal view of the approach: the old table camera sat behind the avatar,
// so its walk and reaction were invisible despite movePlayerTo running.
const WALK_SHOT_SIDE_DISTANCE = 4.35
const WALK_SHOT_FORWARD_DISTANCE = 1.7
const WALK_SHOT_HEIGHT = 2.15
// Just before Pepito grabs it the avatar reaches for the potion, so the theft reads
// as "about to pick it up, but it's snatched". There is no pick-up emote, so this
// borrows the base scene emote 'buttonFront' (one hand reaches out; picked over
// lever, push and openChest by eye). It reaches with the RIGHT hand, so
// models/button_front_left_emote.glb is a left/right mirror of it (the rig's bone
// tracks reflected across the body's center line); if a client rejects that scene
// emote we fall back to the original. The cry below interrupts it at the grab.
const REACH_EMOTE_FILE = 'models/button_front_left_emote.glb'
const REACH_EMOTE_FALLBACK = 'buttonFront'
// In the emote the hand is at full reach from ~0.2s to ~0.47s, then drops back
// (it ends at 0.83s). The emote starts so Pepito's grab lands this far into it,
// i.e. with the hand fully out; the cry then cuts it off.
const REACH_GRAB_AT_S = 0.35
// The player's reaction to the theft: Decentraland's own looping base emote "cry"
// (off-chain base-emotes collection, Cry_Particles.glb), triggered by bare name
// like 'wave' or 'robot'. If a client ever doesn't resolve the bare name, the full
// form is 'urn:decentraland:off-chain:base-emotes:cry'.
const CRY_EMOTE = 'cry'
const CRY_EMOTE_FALLBACK = 'urn:decentraland:off-chain:base-emotes:cry'
const APPROACH_S = 0.5 // a fast dive: ~10 m/s over the ~5m from the frame edge to the potion
const GRAB_HOLD_S = 0.12
// The escape deliberately has room to breathe: after the hero close-up, the
// player gets a clear 2+ second tracking shot of Pepito flying off with the cure.
const ESCAPE_S = 3.0
// The virtual-camera hand-off is intentionally longer than a regular UI cut.
// It makes the table shot feel like it eases into Pepito's entrance instead of
// snapping over from the Caretaker dialogue.
const STEAL_CAMERA_ENTER_TRANSITION_S = 0.65
// Pepito gets a short hero beat at the grab: the camera pushes in, the yellow
// marker calls it out, then the same camera pulls back to show the escape.
const HERO_HOLD_AFTER_GRAB_S = 0.28
const HERO_CLOSE_UNTIL_S = APPROACH_S + GRAB_HOLD_S + HERO_HOLD_AFTER_GRAB_S
const HERO_ZOOM_OUT_S = 0.65
const HERO_ZOOM_OUT_END_S = HERO_CLOSE_UNTIL_S + HERO_ZOOM_OUT_S
const FLIGHT_CAMERA_DISTANCE_DESKTOP = 5.4
const FLIGHT_CAMERA_DISTANCE_MOBILE = 6.6
const FLIGHT_CAMERA_FOLLOW_HEIGHT_DESKTOP = 1.25
const FLIGHT_CAMERA_FOLLOW_HEIGHT_MOBILE = 1.55
const FLIGHT_CAMERA_LATERAL_DESKTOP = 0.7
const FLIGHT_CAMERA_LATERAL_MOBILE = 1.05
// Move the camera ahead along Pepito's exit line before tracking. The Care
// Center dome is on the caretaker side of the table, so this keeps the camera
// outside its roof rather than passing through it during the pull-out.
const FLIGHT_CAMERA_ESCAPE_LEAD_DESKTOP = 3.6
const FLIGHT_CAMERA_ESCAPE_LEAD_MOBILE = 4.2
const HERO_CAMERA_DISTANCE_DESKTOP = 2.8
const HERO_CAMERA_DISTANCE_MOBILE = 3.45
const HERO_CAMERA_HEIGHT_DESKTOP = 0.82
const HERO_CAMERA_HEIGHT_MOBILE = 1.0
const HERO_CAMERA_ESCAPE_LEAD = 2.15
const HERO_MARKER_MODEL = 'assets/Models/target_arrow.glb'
const HERO_MARKER_HEIGHT = 1.08
const HERO_MARKER_SCALE = 0.46
const HERO_MARKER_BOB_HEIGHT = 0.1
const HERO_MARKER_BOB_PERIOD_S = 0.82
const FLIGHT_GLIDE_BOB_HEIGHT = 0.07
const FLIGHT_GLIDE_BOB_CYCLES = 2.4
const PLAYER_RETURN_CAMERA_S = 0.85
const PLAYER_RETURN_DISTANCE = 3.4
const PLAYER_RETURN_HEIGHT = 1.75

type CameraReturn = { elapsed: number; startPos: Vector3; startLook: Vector3; endPos: Vector3; endLook: Vector3 }

type PepitoStealTuning = {
  cameraDistance: number
  cameraHeight: number
  cameraLateral: number
  cameraLookHeight: number
  potionForward: number
  potionSide: number
  potionDrop: number
}

const STEAL_TUNING: PepitoStealTuning = {
  cameraDistance: 4.6,
  cameraHeight: 2.45,
  cameraLateral: -1.5,
  cameraLookHeight: 1.15,
  potionForward: -0.09,
  potionSide: 0,
  potionDrop: 0.22
}

type PotionHome = { position: Vector3; rotation: Quaternion; scale: Vector3 }

let pepitoPool: Entity | null = null
let pepito: Entity | null = null
let camera: Entity | null = null
let pepitoMarker: Entity | null = null
let potionHome: PotionHome | null = null
let active = false
let carried = false
let elapsed = 0
let entry = Vector3.Zero()
let grab = Vector3.Zero()
let escape = Vector3.Zero()
let lastPos = Vector3.Zero()
let yaw = 0
let completion: (() => void) | null = null
let stealSystem: ((dt: number) => void) | null = null
let shotTablePos: Vector3 | null = null
let shotPotionPos: Vector3 | null = null
let shotCameraSide: Vector3 | null = null
let revealHold = TABLE_REVEAL_HOLD_S // pre-flight time: covers the player's walk
let cried = false
let reached = false
let tableCameraPos = Vector3.Zero()
let tableCameraLook = Vector3.Zero()
let cameraReturn: CameraReturn | null = null

/** A shallow flight bow reads as a deliberate dive/swoop instead of a model
 * interpolating between two points in a straight line. */
function curvedFlight(from: Vector3, to: Vector3, t: number, side: number, lift: number): Vector3 {
  // Ease at both ends so Pepito takes off and glides away rather than moving at
  // a constant speed, then add a very small, tapered airborne sway.
  const eased = smoothStep(t)
  const position = Vector3.lerp(from, to, eased)
  const dx = to.x - from.x
  const dz = to.z - from.z
  const length = Math.sqrt(dx * dx + dz * dz)
  const arc = Math.sin(Math.PI * eased)
  const glide = Math.sin(eased * Math.PI * 2 * FLIGHT_GLIDE_BOB_CYCLES) * FLIGHT_GLIDE_BOB_HEIGHT * arc
  if (length <= 0.001) return Vector3.create(position.x, position.y + lift * arc + glide, position.z)
  return Vector3.create(
    position.x - (dz / length) * side * arc,
    position.y + lift * arc + glide,
    position.z + (dx / length) * side * arc
  )
}

function tableEntity(): Entity | null {
  return getPotionTableEntity()
}

function potionEntity(): Entity | null {
  return getPotionEntity()
}

function rememberPotionHome(): PotionHome | null {
  if (potionHome) return potionHome
  const potion = potionEntity()
  if (!potion) return null
  const transform = Transform.get(potion)
  potionHome = {
    position: Vector3.create(transform.position.x, transform.position.y, transform.position.z),
    rotation: Quaternion.create(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w),
    scale: Vector3.create(transform.scale.x, transform.scale.y, transform.scale.z)
  }
  return potionHome
}

/** Put the cure back for a fresh run. The normal cure scene calls this before
 * showing its closed cage, whereas the theft keeps it hidden once Pepito wins. */
export function resetStolenPotion(): void {
  const potion = potionEntity()
  const home = rememberPotionHome()
  if (!potion || !home) return
  const transform = Transform.getMutable(potion)
  transform.position = Vector3.create(home.position.x, home.position.y, home.position.z)
  transform.rotation = Quaternion.create(home.rotation.x, home.rotation.y, home.rotation.z, home.rotation.w)
  transform.scale = Vector3.create(home.scale.x, home.scale.y, home.scale.z)
  VisibilityComponent.createOrReplace(potion, { visible: true })
}

function createPepito(at: Vector3, visible: boolean): Entity {
  const entity = engine.addEntity()
  Transform.create(entity, { position: at, scale: Vector3.scale(Vector3.One(), PEPITO_SCALE) })
  GltfContainer.createOrReplace(entity, { src: modelForSpecies(PEPITO_SPECIES), ...NO_COLLISION })
  Animator.createOrReplace(entity, {
    states: [{ clip: clipForSpecies(PEPITO_SPECIES, 'walk'), playing: true, loop: true, speed: 1, weight: 1 }]
  })
  applyCreatureSkin(entity, PEPITO_SPECIES, 'common')
  VisibilityComponent.create(entity, { visible })
  pepitoPool = entity
  return entity
}

/** Load Pepito before the player reaches the cure, so the first theft never
 * spends its entrance waiting for the creature GLB to stream in. */
export function setupPepitoSteal(): void {
  if (!pepitoPool) createPepito(Vector3.create(0, -100, 0), false)
}

function spawnPepito(at: Vector3): Entity {
  if (!pepitoPool) return createPepito(at, true)
  Transform.createOrReplace(pepitoPool, { position: at, scale: Vector3.scale(Vector3.One(), PEPITO_SCALE) })
  VisibilityComponent.createOrReplace(pepitoPool, { visible: true })
  return pepitoPool
}

function hidePepito(): void {
  if (pepito) VisibilityComponent.createOrReplace(pepito, { visible: false })
  pepito = null
}

/** Reuse the chase marker in the theft shot so the close-up unmistakably says
 * "this is the thief" before the player is handed the rock controls. */
function syncPepitoMarker(flightElapsed: number): void {
  const visible = !!pepito && flightElapsed >= 0
  if (visible && !pepitoMarker && pepito) {
    pepitoMarker = engine.addEntity()
    Transform.createOrReplace(pepitoMarker, {
      parent: pepito,
      position: Vector3.create(0, HERO_MARKER_HEIGHT, 0),
      scale: Vector3.scale(Vector3.One(), HERO_MARKER_SCALE)
    })
    GltfContainer.createOrReplace(pepitoMarker, { src: HERO_MARKER_MODEL, ...NO_COLLISION })
  }
  if (!pepitoMarker) return
  VisibilityComponent.createOrReplace(pepitoMarker, { visible })
  if (!visible || !pepito) return
  const bob = Math.sin((flightElapsed / HERO_MARKER_BOB_PERIOD_S) * Math.PI * 2) * HERO_MARKER_BOB_HEIGHT
  const transform = Transform.getMutable(pepitoMarker)
  transform.parent = pepito
  transform.position = Vector3.create(0, HERO_MARKER_HEIGHT + bob, 0)
  transform.scale = Vector3.scale(Vector3.One(), HERO_MARKER_SCALE)
}

function hidePepitoMarker(): void {
  if (pepitoMarker) VisibilityComponent.createOrReplace(pepitoMarker, { visible: false })
}

function placePepito(position: Vector3): void {
  if (!pepito) return
  const dx = position.x - lastPos.x
  const dz = position.z - lastPos.z
  if (dx * dx + dz * dz > 0.0001) yaw = (Math.atan2(dx, dz) * 180) / Math.PI
  lastPos = Vector3.create(position.x, position.y, position.z)
  const transform = Transform.getMutable(pepito)
  transform.position = lastPos
  transform.rotation = Quaternion.fromEulerDegrees(0, yaw + yawOffsetForSpecies(PEPITO_SPECIES), 0)

  if (!carried) return
  const potion = potionEntity()
  if (!potion) return
  const radians = (yaw * Math.PI) / 180
  const forward = Vector3.create(Math.sin(radians), 0, Math.cos(radians))
  const right = Vector3.create(Math.cos(radians), 0, -Math.sin(radians))
  Transform.getMutable(potion).position = Vector3.create(
    lastPos.x + forward.x * STEAL_TUNING.potionForward + right.x * STEAL_TUNING.potionSide,
    lastPos.y - STEAL_TUNING.potionDrop,
    lastPos.z + forward.z * STEAL_TUNING.potionForward + right.z * STEAL_TUNING.potionSide
  )
}

/** The cry loops until the player moves, so end it when control is handed back.
 * Guarded like holdEmote.ts: stopEmote isn't callable on every client build. */
export function stopCryEmote(): void {
  if (!cried) return
  cried = false
  if (typeof stopEmote === 'function') void stopEmote({}).catch(() => {})
}

export function pepitoStealHidesHud(): boolean {
  return active
}

/** Some mobile clients don't resolve the short base-emote name; retrying with
 * its canonical urn makes the visible reaction reliable across explorers. */
function startCryEmote(): void {
  const fallback = (): void => void triggerEmote({ predefinedEmote: CRY_EMOTE_FALLBACK }).catch(() => {})
  void triggerEmote({ predefinedEmote: CRY_EMOTE }).catch(fallback)
}

function smoothStep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t))
  return clamped * clamped * (3 - 2 * clamped)
}

/** Keep the avatar's movement locked while still permitting scripted emotes.
 * `disableAll` can swallow scene/base emotes on mobile explorers. */
function lockMovementForTheft(): void {
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({
      disableWalk: true,
      disableJog: true,
      disableRun: true,
      disableJump: true,
      disableDoubleJump: true,
      disableGliding: true
    })
  })
}

function focusStealCamera(stand: Vector3): void {
  if (!camera || !shotTablePos || !shotPotionPos || !shotCameraSide) return
  const lateral = Vector3.create(-shotCameraSide.z, 0, shotCameraSide.x)
  const cameraPos = Vector3.create(
    shotTablePos.x + shotCameraSide.x * WALK_SHOT_FORWARD_DISTANCE + lateral.x * WALK_SHOT_SIDE_DISTANCE,
    shotTablePos.y + WALK_SHOT_HEIGHT,
    shotTablePos.z + shotCameraSide.z * WALK_SHOT_FORWARD_DISTANCE + lateral.z * WALK_SHOT_SIDE_DISTANCE
  )
  // Centre the walk's destination and the open cage; the player crosses this
  // diagonal shot instead of standing behind the camera.
  const look = Vector3.create(
    (stand.x + shotTablePos.x) / 2,
    shotPotionPos.y + STEAL_TUNING.cameraLookHeight,
    (stand.z + shotTablePos.z) / 2
  )
  tableCameraPos = Vector3.create(cameraPos.x, cameraPos.y, cameraPos.z)
  tableCameraLook = Vector3.create(look.x, look.y, look.z)
  Transform.createOrReplace(camera, { position: cameraPos, rotation: Quaternion.fromLookAt(cameraPos, look) })
  VirtualCamera.createOrReplace(camera, { defaultTransition: { transitionMode: VirtualCamera.Transition.Time(STEAL_CAMERA_ENTER_TRANSITION_S) } })
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: camera })
}

/** A wide tracking pose with the same table-relative bearing as the opening
 * shot. It moves with Pepito after the zoom-out, rather than merely panning at
 * an increasingly distant target. */
function flightFollowCameraPosition(subject: Vector3, onMobile: boolean, side: Vector3, lateral: Vector3): Vector3 {
  const distance = onMobile ? FLIGHT_CAMERA_DISTANCE_MOBILE : FLIGHT_CAMERA_DISTANCE_DESKTOP
  const height = onMobile ? FLIGHT_CAMERA_FOLLOW_HEIGHT_MOBILE : FLIGHT_CAMERA_FOLLOW_HEIGHT_DESKTOP
  const lateralOffset = onMobile ? FLIGHT_CAMERA_LATERAL_MOBILE : FLIGHT_CAMERA_LATERAL_DESKTOP
  const escapeLead = onMobile ? FLIGHT_CAMERA_ESCAPE_LEAD_MOBILE : FLIGHT_CAMERA_ESCAPE_LEAD_DESKTOP
  return Vector3.create(
    subject.x + side.x * distance + lateral.x * (lateralOffset + escapeLead),
    subject.y + height,
    subject.z + side.z * distance + lateral.z * (lateralOffset + escapeLead)
  )
}

/**
 * First push into Pepito as it steals the potion, pause just long enough for
 * the yellow marker to read, then pull out to reveal its full climbing escape.
 * Keeping one active camera makes both moves continuous on mobile.
 */
function frameFlightCamera(flightElapsed: number, subject: Vector3): void {
  if (!camera || !shotCameraSide) return
  const lateral = Vector3.create(-shotCameraSide.z, 0, shotCameraSide.x)
  const onMobile = mobile()
  const heroDistance = onMobile ? HERO_CAMERA_DISTANCE_MOBILE : HERO_CAMERA_DISTANCE_DESKTOP
  const heroHeight = onMobile ? HERO_CAMERA_HEIGHT_MOBILE : HERO_CAMERA_HEIGHT_DESKTOP
  const heroCameraPos = Vector3.create(
    subject.x + shotCameraSide.x * heroDistance + lateral.x * HERO_CAMERA_ESCAPE_LEAD,
    subject.y + heroHeight,
    subject.z + shotCameraSide.z * heroDistance + lateral.z * HERO_CAMERA_ESCAPE_LEAD
  )
  const followCameraPos = flightFollowCameraPosition(subject, onMobile, shotCameraSide, lateral)
  const subjectLook = Vector3.create(subject.x, subject.y - 0.12, subject.z)
  let cameraPos: Vector3
  let look: Vector3
  if (flightElapsed < APPROACH_S) {
    const zoomIn = smoothStep(flightElapsed / APPROACH_S)
    cameraPos = Vector3.lerp(tableCameraPos, heroCameraPos, zoomIn)
    look = Vector3.lerp(tableCameraLook, subjectLook, zoomIn)
  } else if (flightElapsed < HERO_CLOSE_UNTIL_S) {
    cameraPos = heroCameraPos
    look = subjectLook
  } else {
    const zoomOut = smoothStep((flightElapsed - HERO_CLOSE_UNTIL_S) / (HERO_ZOOM_OUT_END_S - HERO_CLOSE_UNTIL_S))
    cameraPos = Vector3.lerp(heroCameraPos, followCameraPos, zoomOut)
    look = subjectLook
  }
  const transform = Transform.getMutable(camera)
  transform.position = cameraPos
  transform.rotation = Quaternion.fromLookAt(cameraPos, look)
}

/** Bring the virtual camera back to a natural behind-the-avatar pose before
 * releasing it. The native rig still takes the final hand-off under the fade,
 * but it now receives a camera already facing the player instead of Pepito. */
function startCameraReturn(): void {
  if (!camera || !shotTablePos || !shotCameraSide) {
    endSteal()
    return
  }
  const player = Transform.getOrNull(engine.PlayerEntity)
  if (!player) {
    endSteal()
    return
  }
  const toTable = Vector3.create(shotTablePos.x - player.position.x, 0, shotTablePos.z - player.position.z)
  const forward = Vector3.length(toTable) > 0.01 ? Vector3.normalize(toTable) : Vector3.scale(shotCameraSide, -1)
  const back = Vector3.scale(forward, -1)
  const endPos = Vector3.create(
    player.position.x + back.x * PLAYER_RETURN_DISTANCE,
    player.position.y + PLAYER_RETURN_HEIGHT,
    player.position.z + back.z * PLAYER_RETURN_DISTANCE
  )
  const endLook = Vector3.create(
    player.position.x + forward.x * 0.65,
    player.position.y + 1.05,
    player.position.z + forward.z * 0.65
  )
  const current = Transform.get(camera)
  cameraReturn = {
    elapsed: 0,
    startPos: Vector3.create(current.position.x, current.position.y, current.position.z),
    startLook: Vector3.create(lastPos.x, lastPos.y - 0.12, lastPos.z),
    endPos,
    endLook
  }
}

function tickCameraReturn(dt: number): boolean {
  if (!cameraReturn || !camera) return true
  cameraReturn.elapsed += dt
  const progress = smoothStep(cameraReturn.elapsed / PLAYER_RETURN_CAMERA_S)
  const transform = Transform.getMutable(camera)
  transform.position = Vector3.lerp(cameraReturn.startPos, cameraReturn.endPos, progress)
  transform.rotation = Quaternion.fromLookAt(transform.position, Vector3.lerp(cameraReturn.startLook, cameraReturn.endLook, progress))
  return progress >= 1
}

export function getPepitoStealTuning(): PepitoStealTuning {
  return STEAL_TUNING
}

function endSteal(): void {
  if (stealSystem) engine.removeSystem(stealSystem)
  stealSystem = null
  active = false
  carried = false
  cameraReturn = null
  const potion = potionEntity()
  if (potion) VisibilityComponent.createOrReplace(potion, { visible: false })
  hidePepitoMarker()
  hidePepito()
  const done = completion
  completion = null
  done?.()
}

function tickSteal(dt: number): void {
  elapsed += dt
  if (cameraReturn) {
    if (tickCameraReturn(dt)) endSteal()
    return
  }
  if (!reached && elapsed >= revealHold + APPROACH_S - REACH_GRAB_AT_S) {
    reached = true
    const fallback = (): void => void triggerEmote({ predefinedEmote: REACH_EMOTE_FALLBACK }).catch(() => {})
    triggerSceneEmote({ src: REACH_EMOTE_FILE, loop: false })
      .then((result) => {
        if (!result?.success) fallback()
      })
      .catch(fallback)
  }
  if (elapsed < revealHold) return
  const flightElapsed = elapsed - revealHold
  if (flightElapsed < APPROACH_S) {
    const position = curvedFlight(entry, grab, flightElapsed / APPROACH_S, -0.34, 0.26)
    placePepito(position)
    frameFlightCamera(flightElapsed, position)
    syncPepitoMarker(flightElapsed)
    return
  }
  if (flightElapsed < APPROACH_S + GRAB_HOLD_S) {
    if (!carried) {
      carried = true
      playPetVoice(PEPITO_SPECIES)
    }
    if (!cried) {
      cried = true
      startCryEmote()
    }
    placePepito(grab)
    frameFlightCamera(flightElapsed, grab)
    syncPepitoMarker(flightElapsed)
    return
  }
  const u = Math.min(1, (flightElapsed - APPROACH_S - GRAB_HOLD_S) / ESCAPE_S)
  const position = curvedFlight(grab, escape, u, 0.48, 0.7)
  placePepito(position)
  frameFlightCamera(flightElapsed, position)
  syncPepitoMarker(flightElapsed)
  if (u >= 1) startCameraReturn()
}

/** Take the table camera, fly Pepito through the visible side of the shot, and
 * carry the real Potion01 model out of the scene. `onDone` runs while that
 * camera is still active, so the caller can mask the native-camera return. */
export function startPepitoSteal(onDone: () => void): boolean {
  const table = tableEntity()
  const potion = potionEntity()
  if (!table || !potion || active) return false
  const caretaker = engine.getEntityOrNullByName(EntityNames.Caretaker_glb)
  const tablePos = Transform.get(table).position
  const caretakerPos = caretaker && Transform.has(caretaker) ? Transform.get(caretaker).position : Vector3.create(tablePos.x + 1, tablePos.y, tablePos.z)
  const flat = Vector3.create(caretakerPos.x - tablePos.x, 0, caretakerPos.z - tablePos.z)
  const cameraSide = Vector3.length(flat) > 0.01 ? Vector3.normalize(flat) : Vector3.create(1, 0, 0)
  const lateral = Vector3.create(-cameraSide.z, 0, cameraSide.x)
  const player = Transform.getOrNull(engine.PlayerEntity)?.position
  const stand = Vector3.create(tablePos.x + cameraSide.x * WALK_STAND_DISTANCE, player?.y ?? tablePos.y, tablePos.z + cameraSide.z * WALK_STAND_DISTANCE)

  resetStolenPotion()
  const potionPos = Transform.get(potion).position
  // Enter from the left edge of the camera frame and leave through the right.
  entry = Vector3.create(tablePos.x - lateral.x * 4.2, potionPos.y + 3.1, tablePos.z - lateral.z * 4.2)
  grab = Vector3.create(potionPos.x, potionPos.y + 0.48, potionPos.z)
  escape = Vector3.create(tablePos.x + lateral.x * 5.5, potionPos.y + 5.3, tablePos.z + lateral.z * 5.5)
  lastPos = entry
  yaw = (Math.atan2(grab.x - entry.x, grab.z - entry.z) * 180) / Math.PI
  pepito = spawnPepito(entry)
  Transform.getMutable(pepito).rotation = Quaternion.fromEulerDegrees(0, yaw + yawOffsetForSpecies(PEPITO_SPECIES), 0)
  for (const state of Animator.getMutable(pepito).states) state.speed = 1.9

  if (!camera) camera = engine.addEntity()
  shotTablePos = Vector3.create(tablePos.x, tablePos.y, tablePos.z)
  shotPotionPos = Vector3.create(potionPos.x, potionPos.y, potionPos.z)
  shotCameraSide = Vector3.create(cameraSide.x, cameraSide.y, cameraSide.z)
  // The caretaker dialog uses disableAll. Drop to movement-only now: this
  // keeps the cinematic controlled but lets the approach/reach/cry emotes play
  // on mobile.
  lockMovementForTheft()
  focusStealCamera(stand)

  // Walk the avatar up to the table; Pepito waits until it has arrived.
  revealHold = TABLE_REVEAL_HOLD_S
  cried = false
  reached = false
  cameraReturn = null
  if (player) {
    const distance = Math.hypot(player.x - stand.x, player.z - stand.z)
    if (distance > WALK_SKIP_DISTANCE) {
      const walkS = Math.min(WALK_MAX_S, Math.max(WALK_MIN_S, distance / WALK_SPEED))
      revealHold = Math.max(TABLE_REVEAL_HOLD_S, walkS + WALK_SETTLE_S)
      void movePlayerTo({
        newRelativePosition: stand,
        avatarTarget: Vector3.create(tablePos.x, stand.y, tablePos.z),
        duration: walkS
      }).catch(() => {})
    }
  }

  active = true
  carried = false
  elapsed = 0
  completion = onDone
  stealSystem = tickSteal
  engine.addSystem(tickSteal)
  return true
}
