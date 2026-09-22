// First beat of the Pepito cure arc. This intentionally stops after the theft:
// Pepito takes the medicine and disappears, while the later chase minigame is
// still to come.

import { Animator, ColliderLayer, engine, Entity, GltfContainer, MainCamera, Transform, VirtualCamera, VisibilityComponent } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'
import { SIZE_BASE, clipForSpecies, modelForSpecies, scaleForSpecies, stageScaleFor, yawOffsetForSpecies } from '../shared/config'
import { applyCreatureSkin } from './creatureSkins'

const PEPITO_SPECIES = 'pepito-original'
const PEPITO_SCALE = stageScaleFor(SIZE_BASE) * scaleForSpecies(PEPITO_SPECIES)
const NO_COLLISION = { visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE }

const APPROACH_S = 1.1
const GRAB_HOLD_S = 0.35
const ESCAPE_S = 1.45
const CARRY_DROP = 0.42
const CARRY_FORWARD = 0.16

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

const smooth = (t: number): number => t * t * (3 - 2 * t)

function tableEntity(): Entity | null {
  const entity = engine.getEntityOrNullByName(EntityNames.PotionTable_glb)
  return entity && Transform.has(entity) ? entity : null
}

function potionEntity(): Entity | null {
  const entity = engine.getEntityOrNullByName(EntityNames.Potion01_glb)
  return entity && Transform.has(entity) ? entity : null
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
  Transform.getMutable(potion).position = Vector3.create(
    lastPos.x + Math.sin(radians) * CARRY_FORWARD,
    lastPos.y - CARRY_DROP,
    lastPos.z + Math.cos(radians) * CARRY_FORWARD
  )
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
  if (elapsed < APPROACH_S) {
    placePepito(Vector3.lerp(entry, grab, smooth(elapsed / APPROACH_S)))
    return
  }
  if (elapsed < APPROACH_S + GRAB_HOLD_S) {
    carried = true
    placePepito(grab)
    return
  }
  const u = Math.min(1, (elapsed - APPROACH_S - GRAB_HOLD_S) / ESCAPE_S)
  const position = Vector3.lerp(grab, escape, smooth(u))
  position.y += Math.sin(u * Math.PI) * 0.8
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
  const potionPos = Transform.get(potion).position

  resetStolenPotion()
  entry = Vector3.create(tablePos.x + lateral.x * 4.2, potionPos.y + 3.1, tablePos.z + lateral.z * 4.2)
  grab = Vector3.create(potionPos.x, potionPos.y + 0.48, potionPos.z)
  escape = Vector3.create(tablePos.x - lateral.x * 5.5, potionPos.y + 5.3, tablePos.z - lateral.z * 5.5)
  lastPos = entry
  yaw = (Math.atan2(grab.x - entry.x, grab.z - entry.z) * 180) / Math.PI
  pepito = spawnPepito(entry)
  Transform.getMutable(pepito).rotation = Quaternion.fromEulerDegrees(0, yaw + yawOffsetForSpecies(PEPITO_SPECIES), 0)

  if (!camera) camera = engine.addEntity()
  const cameraPos = Vector3.create(tablePos.x + cameraSide.x * 4.6, tablePos.y + 2.45, tablePos.z + cameraSide.z * 4.6)
  const look = Vector3.create(tablePos.x, potionPos.y + 1.15, tablePos.z)
  Transform.createOrReplace(camera, { position: cameraPos, rotation: Quaternion.fromLookAt(cameraPos, look) })
  VirtualCamera.createOrReplace(camera, { defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.2) } })
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: camera })

  active = true
  carried = false
  elapsed = 0
  completion = onDone
  stealSystem = tickSteal
  engine.addSystem(tickSteal)
  return true
}
