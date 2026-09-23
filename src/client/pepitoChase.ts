// Second beat of the Pepito cure arc. After stealing the medicine, Pepito
// circles nearby with it in tow. A direct hit drops the real Potion01 model,
// then hands off to the short happy-pet recovery cinematic.

import {
  Animator,
  AvatarAnchorPointType,
  AvatarAttach,
  AvatarMask,
  ColliderLayer,
  engine,
  Entity,
  GltfContainer,
  inputSystem,
  PointerEventType,
  Transform,
  VisibilityComponent
} from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { triggerSceneEmote } from '~system/RestrictedActions'
import { EntityNames } from '../../assets/scene/entity-names'
import { SIZE_BASE, clipForSpecies, modelForSpecies, scaleForSpecies, stageScaleFor, yawOffsetForSpecies } from '../shared/config'
import { applyCreatureSkin } from './creatureSkins'
import { startCureCelebration } from './cureCelebration'
import { getPepitoStealTuning, resetStolenPotion } from './pepitoSteal'
import { flatForward, flatRight } from './play'
import { clientState, pushToast } from './state'
import { ROCK_TOUCH_ACTION, hideRockTouchButton, showRockTouchButton } from './touchControls'
import { openPepitoStoleDialog } from './ui/dialog'
import { mobile } from './ui/theme'

const PEPITO_SPECIES = 'pepito-original'
const PEPITO_SCALE = stageScaleFor(SIZE_BASE) * scaleForSpecies(PEPITO_SPECIES)
const NO_COLLISION = { visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE }

// Restored from the V2 chase: this is a world-fixed orbit, not a circle around
// wherever the player happened to be standing when the theft finished.
const ORBIT_CENTER_OFFSET_X = 19.5
const ORBIT_CENTER_OFFSET_Z = 0
const ORBIT_RADIUS = 8
const ORBIT_HEIGHT = 8.5
const ORBIT_MOBILE_HEIGHT = 5.6
const ORBIT_PERIOD_S = 11
const BOB_HEIGHT = 0.18
const BOB_PERIOD_S = 2.2
const TAU = Math.PI * 2

const ROCK_MODEL = 'assets/Models/rock-08.glb'
const ROCK_SCALE = 0.16
const HAND_ROCK_X = 0.07
const HAND_ROCK_Y = 0.07
const HAND_ROCK_Z = -0.01
const HAND_FORWARD_OFFSET = 0.17
const HAND_RIGHT_OFFSET = 0.26
const HAND_HEIGHT = 1.68
const ROCK_GRAVITY = 12
const ROCK_MAX_LIFE_S = 1.8
const ROCK_HIT_RADIUS = 1.3
const ROCK_SPIN_SPEED = 540
const THROW_EMOTE = 'models/throw_ball_emote.glb'
const THROW_RELEASE_DELAY_S = 0.2
const THROW_ICON = 'assets/images/throwrockicon.png'
const ROCK_CHARGE_TIME_S = 1.1
const ROCK_MIN_FLIGHT_S = 0.35
const ROCK_MAX_FLIGHT_S = 0.85
const POTION_DROP_GRAVITY = 14
const POTION_GROUND_CLEARANCE = 0.12
const PEPITO_FLEE_DURATION_S = 1.4
const PEPITO_FLEE_SPEED = 7
const PEPITO_FLEE_RISE = 3

type RockFlight = { entity: Entity; position: Vector3; velocity: Vector3; elapsed: number; spin: number }
type PotionDrop = { position: Vector3; velocity: Vector3 }
type PepitoFlee = { origin: Vector3; direction: Vector3; elapsed: number }

let pepito: Entity | null = null
let pepitoPool: Entity | null = null
let pepitoPosition = Vector3.Zero()
let pepitoYaw = 0
let orbitCenter = Vector3.Zero()
let orbitStartAngle = -Math.PI * 0.6
let orbitClock = 0
let floorY = 0
let rock: RockFlight | null = null
let potionDrop: PotionDrop | null = null
let pepitoFlee: PepitoFlee | null = null
let throwWindup = false
let handAnchor: Entity | null = null
let handRock: Entity | null = null
let touchButtonShown = false
let recoveryStarted = false
let celebrationStarted = false
let previewRun = false
let awaitingCaretakerInstruction = false
let caretakerDialogOpened = false

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

function spawnPepito(at: Vector3): Entity {
  if (!pepitoPool) return createPepito(at, true)
  Transform.createOrReplace(pepitoPool, { position: at, scale: Vector3.scale(Vector3.One(), PEPITO_SCALE) })
  VisibilityComponent.createOrReplace(pepitoPool, { visible: true })
  return pepitoPool
}

function orbitPosition(at: number): Vector3 {
  const angle = orbitStartAngle + (at / ORBIT_PERIOD_S) * TAU
  const bob = Math.sin((at / BOB_PERIOD_S) * TAU) * BOB_HEIGHT
  const height = mobile() ? ORBIT_MOBILE_HEIGHT : ORBIT_HEIGHT
  return Vector3.create(
    orbitCenter.x + Math.cos(angle) * ORBIT_RADIUS,
    orbitCenter.y + height + bob,
    orbitCenter.z + Math.sin(angle) * ORBIT_RADIUS
  )
}

function placePepito(position: Vector3): void {
  if (!pepito) return
  const dx = position.x - pepitoPosition.x
  const dz = position.z - pepitoPosition.z
  if (dx * dx + dz * dz > 0.0001) pepitoYaw = (Math.atan2(dx, dz) * 180) / Math.PI
  pepitoPosition = Vector3.create(position.x, position.y, position.z)
  const transform = Transform.getMutable(pepito)
  transform.position = pepitoPosition
  transform.rotation = Quaternion.fromEulerDegrees(0, pepitoYaw + yawOffsetForSpecies(PEPITO_SPECIES), 0)

  const potion = engine.getEntityOrNullByName(EntityNames.Potion01_glb)
  if (!potion || !Transform.has(potion)) return
  const tuning = getPepitoStealTuning()
  const radians = (pepitoYaw * Math.PI) / 180
  const forward = Vector3.create(Math.sin(radians), 0, Math.cos(radians))
  const right = Vector3.create(Math.cos(radians), 0, -Math.sin(radians))
  Transform.getMutable(potion).position = Vector3.create(
    pepitoPosition.x + forward.x * tuning.potionForward + right.x * tuning.potionSide,
    pepitoPosition.y - tuning.potionDrop,
    pepitoPosition.z + forward.z * tuning.potionForward + right.z * tuning.potionSide
  )
  VisibilityComponent.createOrReplace(potion, { visible: true })
}

function potionEntity(): Entity | null {
  const potion = engine.getEntityOrNullByName(EntityNames.Potion01_glb)
  return potion && Transform.has(potion) ? potion : null
}

function hidePepito(): void {
  if (pepito) VisibilityComponent.createOrReplace(pepito, { visible: false })
  pepito = null
}

function clearHandRock(): void {
  if (handRock) {
    engine.removeEntity(handRock)
    handRock = null
  }
  if (handAnchor) {
    engine.removeEntity(handAnchor)
    handAnchor = null
  }
}

function syncHandRock(): void {
  const wantHandRock = clientState.pepitoChase.active && !rock && !recoveryStarted && !awaitingCaretakerInstruction
  if (wantHandRock && !handAnchor) {
    handAnchor = engine.addEntity()
    Transform.createOrReplace(handAnchor, {})
    AvatarAttach.createOrReplace(handAnchor, { anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND })
  }
  if (wantHandRock && !handRock && handAnchor) {
    handRock = engine.addEntity()
    Transform.createOrReplace(handRock, {
      parent: handAnchor,
      position: Vector3.create(HAND_ROCK_X, HAND_ROCK_Y, HAND_ROCK_Z),
      scale: Vector3.scale(Vector3.One(), ROCK_SCALE)
    })
    GltfContainer.createOrReplace(handRock, { src: ROCK_MODEL, ...NO_COLLISION })
  }
  if (!wantHandRock) clearHandRock()
}

function showThrowButton(): void {
  if (recoveryStarted || awaitingCaretakerInstruction) {
    hideThrowButton()
    return
  }
  if (touchButtonShown) return
  showRockTouchButton(THROW_ICON)
  touchButtonShown = true
}

function hideThrowButton(): void {
  if (!touchButtonShown) return
  hideRockTouchButton()
  touchButtonShown = false
}

function launchRock(power: number): void {
  const player = Transform.getOrNull(engine.PlayerEntity)
  if (!player || !pepito) {
    clientState.pepitoChase.rockBusy = false
    throwWindup = false
    return
  }
  const forward = flatForward(player.rotation)
  const right = flatRight(player.rotation)
  const hand = Vector3.create(
    player.position.x + forward.x * HAND_FORWARD_OFFSET + right.x * HAND_RIGHT_OFFSET,
    player.position.y + HAND_HEIGHT,
    player.position.z + forward.z * HAND_FORWARD_OFFSET + right.z * HAND_RIGHT_OFFSET
  )
  // Predict Pepito's orbit by the charged flight time, so every charge level
  // still lands on the moving target.
  const flightTime = ROCK_MAX_FLIGHT_S + (ROCK_MIN_FLIGHT_S - ROCK_MAX_FLIGHT_S) * power
  const target = orbitPosition(orbitClock + flightTime)
  const flatVelocity = Vector3.scale(Vector3.subtract(target, hand), 1 / flightTime)
  const velocity = Vector3.create(flatVelocity.x, flatVelocity.y + 0.5 * ROCK_GRAVITY * flightTime, flatVelocity.z)
  const entity = engine.addEntity()
  Transform.createOrReplace(entity, { position: hand, scale: Vector3.scale(Vector3.One(), ROCK_SCALE) })
  GltfContainer.createOrReplace(entity, { src: ROCK_MODEL, ...NO_COLLISION })
  rock = { entity, position: hand, velocity, elapsed: 0, spin: 0 }
  throwWindup = false
}

function canChargeRock(): boolean {
  return clientState.pepitoChase.active && !awaitingCaretakerInstruction && !clientState.pepitoChase.rockBusy && !rock && !throwWindup && !recoveryStarted
}

/** Begin holding the rock. Releasing chooses the throw strength. */
export function startPepitoRockCharge(): void {
  if (!canChargeRock() || clientState.pepitoChase.charging) return
  clientState.pepitoChase.charging = true
  clientState.pepitoChase.charge = 0
}

/** Release a held rock and launch it with the selected charge. */
export function releasePepitoRockCharge(): void {
  if (!clientState.pepitoChase.charging) return
  const power = clientState.pepitoChase.charge
  clientState.pepitoChase.charging = false
  clientState.pepitoChase.charge = 0
  throwPepitoRock(power)
}

/** Throw a single visual rock. The hit does not resolve the cure yet. */
function throwPepitoRock(power: number): void {
  if (!canChargeRock()) return
  clientState.pepitoChase.rockBusy = true
  throwWindup = true
  // Desktop supports a stable upper-body mask; mobile needs the unmasked
  // emote, matching the Fetch throw path in play.ts.
  void triggerSceneEmote({ src: THROW_EMOTE, loop: false, mask: mobile() ? undefined : AvatarMask.AM_UPPER_BODY }).catch(() => {})
  let elapsed = 0
  const release = (dt: number): void => {
    elapsed += dt
    if (elapsed < THROW_RELEASE_DELAY_S) return
    launchRock(power)
    engine.removeSystem(release)
  }
  engine.addSystem(release)
}

function rockChargeTick(dt: number): void {
  const chase = clientState.pepitoChase
  if (!chase.charging) return
  if (!canChargeRock()) {
    chase.charging = false
    chase.charge = 0
    return
  }
  chase.charge = Math.min(1, chase.charge + dt / ROCK_CHARGE_TIME_S)
}

function rockFlightTick(dt: number): void {
  if (!rock) return
  rock.elapsed += dt
  rock.spin += ROCK_SPIN_SPEED * dt
  rock.velocity = Vector3.create(rock.velocity.x, rock.velocity.y - ROCK_GRAVITY * dt, rock.velocity.z)
  rock.position = Vector3.add(rock.position, Vector3.scale(rock.velocity, dt))
  const transform = Transform.getMutable(rock.entity)
  transform.position = rock.position
  transform.rotation = Quaternion.fromEulerDegrees(rock.spin, rock.spin * 0.6, 0)

  const hit = pepito && Vector3.distance(rock.position, Vector3.create(pepitoPosition.x, pepitoPosition.y + 0.5, pepitoPosition.z)) <= ROCK_HIT_RADIUS
  if (!hit && rock.elapsed < ROCK_MAX_LIFE_S && rock.position.y > floorY) return

  engine.removeEntity(rock.entity)
  rock = null
  if (hit) beginPotionDrop()
  else clientState.pepitoChase.rockBusy = false
}

/** Pepito is hit at flight height, so use the actual shared Potion01 transform
 * as the initial point and animate it all the way down to the local ground. */
function beginPotionDrop(): void {
  const potion = potionEntity()
  if (!potion) {
    stopPepitoChase()
    return
  }
  const transform = Transform.get(potion)
  potionDrop = {
    position: Vector3.create(transform.position.x, transform.position.y, transform.position.z),
    velocity: Vector3.create(0, -0.25, 0)
  }
  recoveryStarted = true
  throwWindup = false
  clientState.pepitoChase.charging = false
  clientState.pepitoChase.charge = 0
  clearHandRock()
  hideThrowButton()
  VisibilityComponent.createOrReplace(potion, { visible: true })
  beginPepitoFlee()
}

/** The rock only makes Pepito drop the bottle. He keeps flying away from the
 * player until he is well outside the visible play space, then despawns. */
function beginPepitoFlee(): void {
  if (!pepito) return
  // V2's escape followed the tangent of its fixed circle, rather than turning
  // abruptly away from the player. It reads as Pepito continuing its flight.
  const angle = orbitStartAngle + (orbitClock / ORBIT_PERIOD_S) * TAU
  const direction = Vector3.create(-Math.sin(angle), 0, Math.cos(angle))
  pepitoFlee = {
    origin: Vector3.create(pepitoPosition.x, pepitoPosition.y, pepitoPosition.z),
    direction,
    elapsed: 0
  }
}

function pepitoFleeTick(dt: number): void {
  if (!pepitoFlee || !pepito) return
  pepitoFlee.elapsed += dt
  const t = Math.min(1, pepitoFlee.elapsed / PEPITO_FLEE_DURATION_S)
  const distance = PEPITO_FLEE_SPEED * pepitoFlee.elapsed
  const height = PEPITO_FLEE_RISE * pepitoFlee.elapsed
  const position = Vector3.create(
    pepitoFlee.origin.x + pepitoFlee.direction.x * distance,
    pepitoFlee.origin.y + height,
    pepitoFlee.origin.z + pepitoFlee.direction.z * distance
  )
  pepitoPosition = position
  pepitoYaw = (Math.atan2(pepitoFlee.direction.x, pepitoFlee.direction.z) * 180) / Math.PI
  const transform = Transform.getMutable(pepito)
  transform.position = position
  transform.rotation = Quaternion.fromEulerDegrees(0, pepitoYaw + yawOffsetForSpecies(PEPITO_SPECIES), 0)
  transform.scale = Vector3.scale(Vector3.One(), PEPITO_SCALE * (1 - t))
  if (t < 1) return
  pepitoFlee = null
  hidePepito()
  startRecoveryWhenReady()
}

function finishPotionDrop(): void {
  potionDrop = null
  startRecoveryWhenReady()
}

/** Wait for BOTH readable results of the hit: bottle on ground and Pepito
 * leaving frame. Starting the cure camera earlier would cut the escape off. */
function startRecoveryWhenReady(): void {
  if (!recoveryStarted || celebrationStarted || potionDrop || pepitoFlee) return
  celebrationStarted = true
  const potion = potionEntity()
  if (potion) VisibilityComponent.createOrReplace(potion, { visible: false })
  const started = startCureCelebration(previewRun, stopPepitoChase)
  // A missing local pet should never soft-lock the chase. Normal gameplay has
  // one; this fallback is only for a mid-load interruption.
  if (!started) stopPepitoChase()
}

function potionDropTick(dt: number): void {
  if (!potionDrop) return
  const potion = potionEntity()
  if (!potion) {
    finishPotionDrop()
    return
  }
  potionDrop.velocity = Vector3.create(
    potionDrop.velocity.x,
    potionDrop.velocity.y - POTION_DROP_GRAVITY * dt,
    potionDrop.velocity.z
  )
  potionDrop.position = Vector3.add(potionDrop.position, Vector3.scale(potionDrop.velocity, dt))
  const groundY = floorY + POTION_GROUND_CLEARANCE
  if (potionDrop.position.y <= groundY) {
    potionDrop.position = Vector3.create(potionDrop.position.x, groundY, potionDrop.position.z)
    Transform.getMutable(potion).position = potionDrop.position
    finishPotionDrop()
    return
  }
  Transform.getMutable(potion).position = potionDrop.position
}

function tickPepitoChase(dt: number): void {
  if (!clientState.pepitoChase.active) return
  if (awaitingCaretakerInstruction && !caretakerDialogOpened && clientState.screenFade.alpha <= 0.001) {
    caretakerDialogOpened = true
    openPepitoStoleDialog(() => {
      awaitingCaretakerInstruction = false
      pushToast('Aim at Pepito and throw a rock to bring the cure down.')
    })
  }
  // Safety net if another UI flow dismisses the dialog instead of invoking its
  // completion callback: never leave Pepito circling with no available throw.
  if (awaitingCaretakerInstruction && caretakerDialogOpened && !clientState.dialog.open) awaitingCaretakerInstruction = false
  if (!recoveryStarted) {
    orbitClock += dt
    placePepito(orbitPosition(orbitClock))
  }
  syncHandRock()
  rockFlightTick(dt)
  pepitoFleeTick(dt)
  potionDropTick(dt)
  showThrowButton()
  if (inputSystem.isTriggered(ROCK_TOUCH_ACTION, PointerEventType.PET_DOWN)) startPepitoRockCharge()
  if (inputSystem.isTriggered(ROCK_TOUCH_ACTION, PointerEventType.PET_UP)) releasePepitoRockCharge()
}

function beginPepitoChase(requireSickPet: boolean): boolean {
  if (clientState.pepitoChase.active || (requireSickPet && !clientState.activePet?.sick)) return false
  const player = Transform.getOrNull(engine.PlayerEntity)
  if (!player) return false

  const table = engine.getEntityOrNullByName(EntityNames.PotionTable_glb)
  const caretaker = engine.getEntityOrNullByName(EntityNames.Caretaker_glb)
  const tablePos = table && Transform.has(table) ? Transform.get(table).position : player.position
  const caretakerPos = caretaker && Transform.has(caretaker) ? Transform.get(caretaker).position : tablePos
  const base = Vector3.create((tablePos.x + caretakerPos.x) / 2, tablePos.y, (tablePos.z + caretakerPos.z) / 2)
  orbitCenter = Vector3.create(base.x + ORBIT_CENTER_OFFSET_X, base.y, base.z + ORBIT_CENTER_OFFSET_Z)
  orbitStartAngle = Math.atan2(tablePos.z - orbitCenter.z, tablePos.x - orbitCenter.x)
  floorY = Math.min(player.position.y, tablePos.y)
  orbitClock = 0
  recoveryStarted = false
  celebrationStarted = false
  previewRun = !requireSickPet
  potionDrop = null
  pepitoFlee = null
  awaitingCaretakerInstruction = true
  caretakerDialogOpened = false
  resetStolenPotion()
  const first = orbitPosition(orbitClock)
  pepitoPosition = first
  pepito = spawnPepito(first)
  placePepito(first)
  clientState.pepitoChase = { active: true, rockBusy: false, charging: false, charge: 0 }
  pushToast('Pepito stole the cure!')
  return true
}

/** Begin the free-roam chase state after Pepito's table theft. */
export function startPepitoChase(): boolean {
  return beginPepitoChase(true)
}

/** Temporary escape hatch while the hit/pickup continuation is still WIP. */
export function stopPepitoChase(): void {
  if (rock) {
    engine.removeEntity(rock.entity)
    rock = null
  }
  potionDrop = null
  pepitoFlee = null
  hidePepito()
  throwWindup = false
  recoveryStarted = false
  celebrationStarted = false
  previewRun = false
  awaitingCaretakerInstruction = false
  caretakerDialogOpened = false
  clearHandRock()
  hideThrowButton()
  resetStolenPotion()
  clientState.pepitoChase = { active: false, rockBusy: false, charging: false, charge: 0 }
}

export function setupPepitoChase(): void {
  engine.addSystem(tickPepitoChase)
  engine.addSystem(rockChargeTick)
}
