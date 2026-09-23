// Second beat of the Pepito cure arc. After stealing the medicine, Pepito
// circles nearby with it in tow. A direct hit drops the real Potion01 model;
// the player must then walk to the marked bottle to begin the recovery.

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
  PrimaryPointerInfo,
  ParticleSystem,
  PBParticleSystem_BlendMode,
  Transform,
  VisibilityComponent
} from '@dcl/sdk/ecs'
import { Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
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
import { getPotionEntity, getPotionTableEntity } from './sicknessProps'

const PEPITO_SPECIES = 'pepito-original'
const PEPITO_SCALE = stageScaleFor(SIZE_BASE) * scaleForSpecies(PEPITO_SPECIES)
const PEPITO_CHASE_SCALE = PEPITO_SCALE * 1.45
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
const ROCK_HIT_RADIUS = 1.05
const ROCK_SPIN_SPEED = 540
const THROW_EMOTE = 'models/throw_ball_emote.glb'
const THROW_RELEASE_DELAY_S = 0.2
const THROW_ICON = 'assets/images/throwrockicon.png'
const ROCK_CHARGE_TIME_S = 1.1
const ROCK_MIN_FLIGHT_S = 0.35
const ROCK_MAX_FLIGHT_S = 0.85
const ROCK_MIN_DISTANCE = 8
const ROCK_MAX_DISTANCE = 20
const LOCK_ACQUIRE_DOT = Math.cos((13 * Math.PI) / 180)
const LOCK_RELEASE_DOT = Math.cos((21 * Math.PI) / 180)
const TARGET_ARROW_MODEL = 'assets/Models/target_arrow.glb'
const TARGET_ARROW_HEIGHT = 1.3
const TARGET_ARROW_SCALE = 0.62
const TARGET_ARROW_BOB_HEIGHT = 0.14
const TARGET_ARROW_BOB_PERIOD_S = 1.1
const POTION_TARGET_HEIGHT = 0.9
const POTION_TARGET_SCALE = 0.48
const POTION_TARGET_BOB_HEIGHT = 0.12
const POTION_TARGET_BOB_PERIOD_S = 1.05
const POTION_PICKUP_RADIUS = 1.8
const POTION_DROP_GRAVITY = 14
// Potion01's measured mesh base is only 0.0016m below its pivot. A tiny
// clearance keeps it out of the ground without the visibly floating gap.
const POTION_GROUND_CLEARANCE = 0.01
const PEPITO_FLEE_DURATION_S = 1.4
const PEPITO_FLEE_SPEED = 7
const PEPITO_FLEE_RISE = 3
const PEPITO_HIT_REACTION_S = 0.28
const PEPITO_HIT_RECOIL_HEIGHT = 0.38
const PEPITO_HIT_SCALE = 1.22
// Calibrated in-scene: the Care Center's visual floor is Y=0 while the table
// origin is Y=0.4, so the bottle needs this correction to land on the floor.
const POTION_GROUND_ADJUSTMENT = -0.4

type RockFlight = { entity: Entity; position: Vector3; velocity: Vector3; elapsed: number; spin: number }
type PotionDrop = { position: Vector3; velocity: Vector3 }
type PepitoFlee = { origin: Vector3; direction: Vector3; elapsed: number }

let pepito: Entity | null = null
let pepitoPool: Entity | null = null
let targetArrow: Entity | null = null
let potionTargetArrow: Entity | null = null
let hitFx: Entity | null = null
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
let awaitingCaretakerInstruction = false
let caretakerDialogOpened = false
let potionPickupReady = false
let potionTargetClock = 0
let pepitoHitReaction = 0

function createPepito(at: Vector3, visible: boolean): Entity {
  const entity = engine.addEntity()
  Transform.create(entity, { position: at, scale: Vector3.scale(Vector3.One(), PEPITO_CHASE_SCALE) })
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
  Transform.createOrReplace(pepitoPool, { position: at, scale: Vector3.scale(Vector3.One(), PEPITO_CHASE_SCALE) })
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

  const potion = getPotionEntity()
  if (!potion) return
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
  return getPotionEntity()
}

function potionLandingY(): number {
  return floorY + POTION_GROUND_CLEARANCE + POTION_GROUND_ADJUSTMENT
}

function playPepitoHitFeedback(): void {
  if (!hitFx) {
    hitFx = engine.addEntity()
    Transform.createOrReplace(hitFx, { position: Vector3.Zero() })
  }
  Transform.getMutable(hitFx).position = Vector3.create(pepitoPosition.x, pepitoPosition.y + 0.7, pepitoPosition.z)
  ParticleSystem.createOrReplace(hitFx, {
    active: true,
    loop: false,
    rate: 0,
    lifetime: 0.48,
    maxParticles: 24,
    initialSize: { start: 0.07, end: 0.16 },
    sizeOverTime: { start: 1, end: 0 },
    initialColor: { start: Color4.create(1, 0.86, 0.18, 1), end: Color4.create(1, 0.42, 0.06, 1) },
    colorOverTime: { start: Color4.create(1, 0.86, 0.18, 1), end: Color4.create(1, 0.25, 0, 0) },
    initialVelocitySpeed: { start: 1.8, end: 3.8 },
    gravity: 0.35,
    blendMode: PBParticleSystem_BlendMode.PSB_ADD,
    shape: ParticleSystem.Shape.Sphere({ radius: 0.18 }),
    bursts: { values: [{ time: 0, count: 24, cycles: 1, interval: 0.01, probability: 1 }] }
  })
  pepitoHitReaction = PEPITO_HIT_REACTION_S
  pushToast('Direct hit!', 'success')
}

/** Yellow 3D marker above the bottle once Pepito has dropped it. It is a child
 * of the potion so its hover stays correctly aligned with the actual pickup. */
function showPotionTargetArrow(): void {
  const potion = potionEntity()
  if (!potion) return
  if (!potionTargetArrow) {
    potionTargetArrow = engine.addEntity()
    Transform.createOrReplace(potionTargetArrow, {
      parent: potion,
      position: Vector3.create(0, POTION_TARGET_HEIGHT, 0),
      scale: Vector3.scale(Vector3.One(), POTION_TARGET_SCALE)
    })
    GltfContainer.createOrReplace(potionTargetArrow, { src: TARGET_ARROW_MODEL, ...NO_COLLISION })
    VisibilityComponent.createOrReplace(potionTargetArrow, { visible: false })
  }
  VisibilityComponent.createOrReplace(potionTargetArrow, { visible: true })
}

function hidePotionTargetArrow(): void {
  if (potionTargetArrow) VisibilityComponent.createOrReplace(potionTargetArrow, { visible: false })
}

function preparePotionPickup(): void {
  if (!recoveryStarted || celebrationStarted || potionDrop || pepitoFlee || potionPickupReady) return
  if (!potionEntity()) {
    startRecoveryWhenReady()
    return
  }
  potionPickupReady = true
  potionTargetClock = 0
  showPotionTargetArrow()
  pushToast('Go get the cure on the ground!', 'success')
}

function potionPickupTick(dt: number): void {
  if (!potionPickupReady) return
  const potion = potionEntity()
  const player = Transform.getOrNull(engine.PlayerEntity)
  if (!potion || !player) return

  potionTargetClock += dt
  if (potionTargetArrow && Transform.has(potionTargetArrow)) {
    const bob = Math.sin((potionTargetClock / POTION_TARGET_BOB_PERIOD_S) * TAU) * POTION_TARGET_BOB_HEIGHT
    Transform.getMutable(potionTargetArrow).position = Vector3.create(0, POTION_TARGET_HEIGHT + bob, 0)
  }

  const at = Transform.get(potion).position
  if (Math.hypot(player.position.x - at.x, player.position.z - at.z) > POTION_PICKUP_RADIUS) return
  potionPickupReady = false
  hidePotionTargetArrow()
  VisibilityComponent.createOrReplace(potion, { visible: false })
  startRecoveryWhenReady()
}

function hidePepito(): void {
  if (pepito) VisibilityComponent.createOrReplace(pepito, { visible: false })
  if (targetArrow) VisibilityComponent.createOrReplace(targetArrow, { visible: false })
  pepito = null
}

/** The marker is a child of Pepito, so it follows the orbit without an extra
 * world-space sync. Only its local height changes for the hovering motion. */
function syncTargetArrow(): void {
  const visible = !!pepito && clientState.pepitoChase.active && !awaitingCaretakerInstruction && !recoveryStarted
  if (visible && !targetArrow && pepito) {
    targetArrow = engine.addEntity()
    Transform.createOrReplace(targetArrow, {
      parent: pepito,
      position: Vector3.create(0, TARGET_ARROW_HEIGHT, 0),
      scale: Vector3.scale(Vector3.One(), TARGET_ARROW_SCALE)
    })
    GltfContainer.createOrReplace(targetArrow, { src: TARGET_ARROW_MODEL, ...NO_COLLISION })
  }
  if (!targetArrow) return
  VisibilityComponent.createOrReplace(targetArrow, { visible })
  if (!visible) return
  const bob = Math.sin((orbitClock / TARGET_ARROW_BOB_PERIOD_S) * TAU) * TARGET_ARROW_BOB_HEIGHT
  const pulse = clientState.pepitoChase.targetLocked ? 1.12 + Math.sin(orbitClock * TAU * 2.8) * 0.08 : 1
  const transform = Transform.getMutable(targetArrow)
  transform.position = Vector3.create(0, TARGET_ARROW_HEIGHT + bob, 0)
  transform.scale = Vector3.scale(Vector3.One(), TARGET_ARROW_SCALE * pulse)
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
  if (!mobile() || recoveryStarted || awaitingCaretakerInstruction) {
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

function aimDirection(playerRotation: Quaternion): Vector3 {
  const ray = PrimaryPointerInfo.getOrNull(engine.RootEntity)?.worldRayDirection
  if (ray && Vector3.length(ray) > 0.001) return Vector3.normalize(ray)
  const camera = Transform.getOrNull(engine.CameraEntity)
  if (camera) return Vector3.normalize(Vector3.rotate(Vector3.create(0, 0, 1), camera.rotation))
  return flatForward(playerRotation)
}

function softLockTarget(): boolean {
  if (!pepito) return false
  const player = Transform.getOrNull(engine.PlayerEntity)
  if (!player) return false
  const origin = Transform.getOrNull(engine.CameraEntity)?.position ?? player.position
  const target = Vector3.create(pepitoPosition.x, pepitoPosition.y + 0.5, pepitoPosition.z)
  const toTarget = Vector3.subtract(target, origin)
  if (Vector3.length(toTarget) <= 0.001) return false
  const dot = Vector3.dot(aimDirection(player.rotation), Vector3.normalize(toTarget))
  return dot >= (clientState.pepitoChase.targetLocked ? LOCK_RELEASE_DOT : LOCK_ACQUIRE_DOT)
}

function launchRock(power: number, locked: boolean): void {
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
  // A lock follows Pepito's predicted position; otherwise the rock follows
  // the camera/crosshair ray and behaves as a normal free shot.
  const flightTime = ROCK_MAX_FLIGHT_S + (ROCK_MIN_FLIGHT_S - ROCK_MAX_FLIGHT_S) * power
  const direction = aimDirection(player.rotation)
  const distance = ROCK_MIN_DISTANCE + (ROCK_MAX_DISTANCE - ROCK_MIN_DISTANCE) * power
  const target = locked
    ? Vector3.add(orbitPosition(orbitClock + flightTime), Vector3.create(0, 0.5, 0))
    : Vector3.add(hand, Vector3.scale(direction, distance))
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
  clientState.pepitoChase.targetLocked = softLockTarget()
}

/** Release a held rock and launch it with the selected charge. */
export function releasePepitoRockCharge(): void {
  if (!clientState.pepitoChase.charging) return
  const chase = clientState.pepitoChase
  const power = chase.charge
  const locked = chase.targetLocked
  chase.charging = false
  chase.charge = 0
  chase.targetLocked = false
  throwPepitoRock(power, locked)
}

/** Throw a single visual rock. The hit does not resolve the cure yet. */
function throwPepitoRock(power: number, locked: boolean): void {
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
    launchRock(power, locked)
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
    chase.targetLocked = false
    return
  }
  chase.charge = Math.min(1, chase.charge + dt / ROCK_CHARGE_TIME_S)
  chase.targetLocked = softLockTarget()
}

function pointToSegmentDistance(point: Vector3, from: Vector3, to: Vector3): number {
  const segment = Vector3.subtract(to, from)
  const lengthSquared = Vector3.dot(segment, segment)
  if (lengthSquared <= 0.000001) return Vector3.distance(point, from)
  const projection = Vector3.dot(Vector3.subtract(point, from), segment) / lengthSquared
  const t = Math.max(0, Math.min(1, projection))
  return Vector3.distance(point, Vector3.add(from, Vector3.scale(segment, t)))
}

function rockFlightTick(dt: number): void {
  if (!rock) return
  const previousPosition = rock.position
  rock.elapsed += dt
  rock.spin += ROCK_SPIN_SPEED * dt
  rock.velocity = Vector3.create(rock.velocity.x, rock.velocity.y - ROCK_GRAVITY * dt, rock.velocity.z)
  rock.position = Vector3.add(rock.position, Vector3.scale(rock.velocity, dt))
  const transform = Transform.getMutable(rock.entity)
  transform.position = rock.position
  transform.rotation = Quaternion.fromEulerDegrees(rock.spin, rock.spin * 0.6, 0)

  const target = Vector3.create(pepitoPosition.x, pepitoPosition.y + 0.5, pepitoPosition.z)
  const hit = pepito && pointToSegmentDistance(target, previousPosition, rock.position) <= ROCK_HIT_RADIUS
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
  playPepitoHitFeedback()
  potionDrop = {
    position: Vector3.create(transform.position.x, transform.position.y, transform.position.z),
    velocity: Vector3.create(0, -0.25, 0)
  }
  recoveryStarted = true
  throwWindup = false
  clientState.pepitoChase.charging = false
  clientState.pepitoChase.charge = 0
  clientState.pepitoChase.targetLocked = false
  if (targetArrow) VisibilityComponent.createOrReplace(targetArrow, { visible: false })
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
  if (pepitoHitReaction > 0) {
    pepitoHitReaction = Math.max(0, pepitoHitReaction - dt)
    const t = 1 - pepitoHitReaction / PEPITO_HIT_REACTION_S
    const recoil = Math.sin(t * Math.PI)
    const transform = Transform.getMutable(pepito)
    transform.position = Vector3.create(pepitoPosition.x, pepitoPosition.y + recoil * PEPITO_HIT_RECOIL_HEIGHT, pepitoPosition.z)
    transform.scale = Vector3.scale(Vector3.One(), PEPITO_CHASE_SCALE * (1 + recoil * (PEPITO_HIT_SCALE - 1)))
    return
  }
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
  transform.scale = Vector3.scale(Vector3.One(), PEPITO_CHASE_SCALE * (1 - t))
  if (t < 1) return
  pepitoFlee = null
  hidePepito()
  preparePotionPickup()
}

function finishPotionDrop(): void {
  potionDrop = null
  preparePotionPickup()
}

/** Wait for BOTH readable results of the hit: bottle on ground and Pepito
 * leaving frame. Starting the cure camera earlier would cut the escape off. */
function startRecoveryWhenReady(): void {
  if (!recoveryStarted || celebrationStarted || potionDrop || pepitoFlee || potionPickupReady) return
  celebrationStarted = true
  const potion = potionEntity()
  if (potion) VisibilityComponent.createOrReplace(potion, { visible: false })
  const started = startCureCelebration(stopPepitoChase)
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
  const groundY = potionLandingY()
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
  syncTargetArrow()
  syncHandRock()
  rockFlightTick(dt)
  pepitoFleeTick(dt)
  potionDropTick(dt)
  potionPickupTick(dt)
  showThrowButton()
  if (inputSystem.isTriggered(ROCK_TOUCH_ACTION, PointerEventType.PET_DOWN)) startPepitoRockCharge()
  if (inputSystem.isTriggered(ROCK_TOUCH_ACTION, PointerEventType.PET_UP)) releasePepitoRockCharge()
}

function beginPepitoChase(): boolean {
  if (clientState.pepitoChase.active || !clientState.activePet?.sick) return false
  const player = Transform.getOrNull(engine.PlayerEntity)
  if (!player) return false

  const table = getPotionTableEntity()
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
  potionDrop = null
  pepitoFlee = null
  potionPickupReady = false
  potionTargetClock = 0
  pepitoHitReaction = 0
  hidePotionTargetArrow()
  awaitingCaretakerInstruction = true
  caretakerDialogOpened = false
  resetStolenPotion()
  const first = orbitPosition(orbitClock)
  pepitoPosition = first
  pepito = spawnPepito(first)
  placePepito(first)
  clientState.pepitoChase = { active: true, rockBusy: false, charging: false, charge: 0, targetLocked: false }
  pushToast('Pepito stole the cure!')
  return true
}

/** Begin the free-roam chase state after Pepito's table theft. */
export function startPepitoChase(): boolean {
  return beginPepitoChase()
}

/** Temporary escape hatch while the hit/pickup continuation is still WIP. */
export function stopPepitoChase(): void {
  if (rock) {
    engine.removeEntity(rock.entity)
    rock = null
  }
  potionDrop = null
  pepitoFlee = null
  potionPickupReady = false
  potionTargetClock = 0
  pepitoHitReaction = 0
  hidePotionTargetArrow()
  hidePepito()
  throwWindup = false
  recoveryStarted = false
  celebrationStarted = false
  awaitingCaretakerInstruction = false
  caretakerDialogOpened = false
  clearHandRock()
  hideThrowButton()
  resetStolenPotion()
  clientState.pepitoChase = { active: false, rockBusy: false, charging: false, charge: 0, targetLocked: false }
}

export function setupPepitoChase(): void {
  engine.addSystem(tickPepitoChase)
  engine.addSystem(rockChargeTick)
}
