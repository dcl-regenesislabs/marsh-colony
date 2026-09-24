// First beat of the Pepito cure arc. This intentionally stops after the theft:
// Pepito takes the medicine and disappears, while the later chase minigame is
// still to come.

import { Animator, ColliderLayer, engine, Entity, GltfContainer, MainCamera, Transform, VirtualCamera, VisibilityComponent } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { movePlayerTo, stopEmote, triggerEmote, triggerSceneEmote } from '~system/RestrictedActions'
import { EntityNames } from '../../assets/scene/entity-names'
import { SIZE_BASE, clipForSpecies, modelForSpecies, scaleForSpecies, stageScaleFor, yawOffsetForSpecies } from '../shared/config'
import { applyCreatureSkin } from './creatureSkins'
import { getPotionEntity, getPotionTableEntity } from './sicknessProps'

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
const WALK_SPEED = 2 // m/s, only used to pick how long the glide takes
const WALK_MIN_S = 1.4
const WALK_MAX_S = 3.2
const WALK_SETTLE_S = 0.3 // standing at the table this long before Pepito appears
const WALK_SKIP_DISTANCE = 0.3 // already this close: no walk
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
const APPROACH_S = 0.5 // a fast dive: ~10 m/s over the ~5m from the frame edge to the potion
const GRAB_HOLD_S = 0.12
const ESCAPE_S = 1.0

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

/** A shallow flight bow reads as a deliberate dive/swoop instead of a model
 * interpolating between two points in a straight line. */
function curvedFlight(from: Vector3, to: Vector3, t: number, side: number, lift: number): Vector3 {
  const position = Vector3.lerp(from, to, t)
  const dx = to.x - from.x
  const dz = to.z - from.z
  const length = Math.sqrt(dx * dx + dz * dz)
  const arc = Math.sin(Math.PI * t)
  if (length <= 0.001) return Vector3.create(position.x, position.y + lift * arc, position.z)
  return Vector3.create(
    position.x - (dz / length) * side * arc,
    position.y + lift * arc,
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

function focusStealCamera(): void {
  if (!camera || !shotTablePos || !shotPotionPos || !shotCameraSide) return
  const lateral = Vector3.create(-shotCameraSide.z, 0, shotCameraSide.x)
  const cameraPos = Vector3.create(
    shotTablePos.x + shotCameraSide.x * STEAL_TUNING.cameraDistance + lateral.x * STEAL_TUNING.cameraLateral,
    shotTablePos.y + STEAL_TUNING.cameraHeight,
    shotTablePos.z + shotCameraSide.z * STEAL_TUNING.cameraDistance + lateral.z * STEAL_TUNING.cameraLateral
  )
  const look = Vector3.create(shotTablePos.x, shotPotionPos.y + STEAL_TUNING.cameraLookHeight, shotTablePos.z)
  Transform.createOrReplace(camera, { position: cameraPos, rotation: Quaternion.fromLookAt(cameraPos, look) })
  VirtualCamera.createOrReplace(camera, { defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.2) } })
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: camera })
}

export function getPepitoStealTuning(): PepitoStealTuning {
  return STEAL_TUNING
}

function endSteal(): void {
  if (stealSystem) engine.removeSystem(stealSystem)
  stealSystem = null
  active = false
  carried = false
  const potion = potionEntity()
  if (potion) VisibilityComponent.createOrReplace(potion, { visible: false })
  hidePepito()
  const done = completion
  completion = null
  done?.()
}

function tickSteal(dt: number): void {
  elapsed += dt
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
    placePepito(curvedFlight(entry, grab, flightElapsed / APPROACH_S, -0.34, 0.26))
    return
  }
  if (flightElapsed < APPROACH_S + GRAB_HOLD_S) {
    carried = true
    if (!cried) {
      cried = true
      void triggerEmote({ predefinedEmote: CRY_EMOTE }).catch(() => {})
    }
    placePepito(grab)
    return
  }
  const u = Math.min(1, (flightElapsed - APPROACH_S - GRAB_HOLD_S) / ESCAPE_S)
  const position = curvedFlight(grab, escape, u, 0.48, 0.7)
  placePepito(position)
  if (u >= 1) endSteal()
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
  focusStealCamera()

  // Walk the avatar up to the table; Pepito waits until it has arrived.
  revealHold = TABLE_REVEAL_HOLD_S
  cried = false
  reached = false
  const player = Transform.getOrNull(engine.PlayerEntity)?.position
  if (player) {
    const stand = Vector3.create(tablePos.x + cameraSide.x * WALK_STAND_DISTANCE, player.y, tablePos.z + cameraSide.z * WALK_STAND_DISTANCE)
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
