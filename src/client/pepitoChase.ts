// Pepito chase minigame (issue #148) — the second half of the sickness cure
// flow (see sicknessErrand.ts for the first half). Reached when the player,
// walking to the cure on the potion table with a sick pet, gets within range of
// it (before actually reaching it) — or by talking to the Caretaker again after
// cancelling:
//
//  1. Steal cinematic: the camera cuts to the potion table (potionTable.ts), the
//     cage lowers, and Pepito swoops in, grabs the cure and carries it up to its
//     flight path. Then the Caretaker's dialog explains what just happened.
//  2. Circling: Pepito flies a fixed circle high above the Care Center (fixed on
//     the MAP, not around the player) with the cure hanging from it. The player
//     is free to move; a charge-and-release throw (play.ts's Fetch input) lobs a
//     rock along the camera's aim — look at Pepito and throw.
//  3. Hit: the cure drops from the sky and Pepito flies off and vanishes. The
//     potion lands, the pet is cured, and a results card closes the flow.
//
// Pepito is a plain, common, junior pepito-original pet — the same rig every
// player's pet uses, so it has no flight animation; it fakes flying by playing
// its walk clip while hovering (same trick as the Caretaker's familiar in
// caretakerPet.ts) plus a sine bob.

import {
  engine,
  Entity,
  Transform,
  GltfContainer,
  ColliderLayer,
  Animator,
  VisibilityComponent,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  InputModifier,
  AvatarAttach,
  AvatarAnchorPointType,
  AvatarMask,
  inputSystem,
  PointerEventType
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color3, Color4 } from '@dcl/sdk/math'
import { triggerSceneEmote } from '~system/RestrictedActions'
import { EntityNames } from '../../assets/scene/entity-names'
import { clipForSpecies, modelForSpecies, scaleForSpecies, stageScaleFor, yawOffsetForSpecies, SIZE_BASE } from '../shared/config'
import { applyCreatureSkin } from './creatureSkins'
import { clientState, actions, pushToast } from './state'
import { openPepitoStoleDialog } from './ui/dialog'
import { applyCureLocal } from './sim'
import { mobile } from './ui/theme'
import { flatForward, flatRight } from './play'
import { hideArrow, showArrowTo } from './pet'
import { cinematicReturn } from './cinematicCam'
import { ROCK_TOUCH_ACTION, showRockTouchButton, hideRockTouchButton } from './touchControls'
import {
  closeCage,
  focusPotionTable,
  getPotion,
  getPotionTable,
  openCage,
  potionHomeTransform,
  releasePotionTableCamera,
  resetPotion,
  tableCameraSide
} from './potionTable'

const PEPITO_SPECIES = 'pepito-original'
const PEPITO_RARITY = 'common' as const
const PEPITO_SCALE = stageScaleFor(SIZE_BASE) * scaleForSpecies(PEPITO_SPECIES) // a plain junior
const PEPITO_WALK_SPEED = 1
const PEPITO_CENTER_LIFT = 0.5 // hit/aim target sits at the body, not the feet the entity's pivot is on

// Flight path: a circle fixed in the world, high above the player. Its centre is
// the midpoint between the Caretaker and the potion table, shifted by
// offsetX/offsetZ. These are the shipped defaults (tuned in-game with
// pepitoDebug.ts's panel); `orbitTune` is the live copy that panel edits, so the
// circle can be moved while playing.
export const ORBIT_DEFAULTS = {
  offsetX: 19.5, // metres, added to the circle's centre (world X)
  offsetZ: 0, // metres, added to the circle's centre (world Z)
  height: 8.5, // above the table's floor level
  radius: 8,
  period: 11 // seconds per lap
}
export const orbitTune = { ...ORBIT_DEFAULTS }
const TAU = Math.PI * 2
// Bob math copied from caretakerPet.ts's familiar (no flight rig).
const BOB_AMPLITUDE = 0.14
const BOB_PERIOD_S = 2.6

// The stolen cure hangs just under Pepito while it's carried.
const CARRY_DROP = 0.42
const CARRY_FORWARD = 0.15

// Steal cinematic timeline (seconds since the camera cut). The camera's own
// blend-in takes ~0.8 s, the cage needs ~1 s to lower, and Pepito shouldn't
// reach the potion before the cage is down.
const STEAL_OPEN_AT = 1.0
const STEAL_SPAWN_AT = 1.2
const STEAL_GRAB_AT = 2.6
const STEAL_TAKEOFF_AT = 3.0
const STEAL_END_AT = 5.0
const ENTRY_SIDE = 3.2 // metres to the side of the table Pepito flies in from
const ENTRY_HEIGHT = 4.6 // ... and this far above the potion
const TAKEOFF_BUMP = 1.2 // extra arc height on the way up to the flight path
const CAGE_RECLOSE_AT_U = 0.3 // how far into the takeoff (0..1) the cage shuts again

// Rock throw — same charge/release input as play.ts's Fetch throw, but aimed
// along the camera (see planThrow) since the target is a moving bird high above
// the player, not a spot on the ground. Charge sets the throw speed.
const ROCK_MODEL = 'assets/Models/rock-08.glb'
const ROCK_SCALE = 0.16 // rock-08.glb is ~0.6-0.7m native — this brings it down to a throwable, fist-sized stone
const HAND_ROCK_X = 0.07
const HAND_ROCK_Y = 0.07
const HAND_ROCK_Z = -0.01
const HAND_FORWARD_OFFSET = 0.17
const HAND_RIGHT_OFFSET = 0.26
const HAND_HEIGHT = 1.68
const CHARGE_TIME = 1.0
const MIN_ROCK_SPEED = 16
const MAX_ROCK_SPEED = 26
const ROCK_GRAVITY = 12
const ROCK_MAX_LIFE_S = 2.5
const SPIN_SPEED = 480 // deg/sec tumble while flying
// Soft aim assist: if Pepito is within this many metres of the line the camera
// is looking along, the throw is aimed at where it WILL be when the rock gets
// there (its path is a pure function of time, so the lead is exact). Anywhere
// else the rock just flies where the crosshair points.
const AIM_ASSIST_RADIUS = 2.6
const AIM_FAR = 60
const HIT_RADIUS = 1.5 // generous: DCL's imprecise aim + a small, moving, overhead target
const ROCK_LINGER_MS = 500 // a miss rests on the ground briefly before clearing, ready for another throw
// Reuses Fetch's own throw wind-up + native touch icon — a second, unrelated
// throw context earning its own art isn't worth it for one minigame.
const THROW_EMOTE = 'models/throw_ball_emote.glb'
const THROW_RELEASE_DELAY = 0.2
const THROW_ICON = 'assets/images/throwicon.png'

// After a hit: Pepito flies off along its direction of travel, climbing and
// shrinking until it's gone, while the cure falls from the sky.
const FLEE_S = 1.4
const FLEE_SPEED = 7
const FLEE_RISE = 3
const POTION_GRAVITY = 14
// The landed cure hovers (and spins) just above the ground over a pulsing floor
// ring; walking within PICKUP_RADIUS of it collects it.
const POTION_HOVER = 0.3
const POTION_HOVER_BOB = 0.08
const PICKUP_RADIUS = 1.6
const COLLECT_S = 0.35
const MARKER_TEXTURE = 'assets/images/circle_01.png' // same soft circle the feed minigame's catch burst uses
const MARKER_TINT = Color4.create(0.5, 1, 0.8, 1)
const MARKER_EMISSIVE = Color3.create(0.5, 1, 0.8)
const MARKER_RING_SCALE = 2.0

const NO_COLLISION = { visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE }

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const smooth = (u: number): number => u * u * (3 - 2 * u)

function playerPos(): Vector3 {
  const t = Transform.getOrNull(engine.PlayerEntity)
  return t ? t.position : Vector3.Zero()
}

// ---------------------------------------------------------------------------
// Pepito
// ---------------------------------------------------------------------------
let pepito: Entity | null = null
let pepitoPos = Vector3.Zero() // where we last put it (world)
let pepitoYaw = 0 // degrees, follows its direction of travel
let potionCarried = false
let orbitBase = Vector3.Zero() // midpoint of the table and the Caretaker, at the table's floor height
let orbitTablePos = Vector3.Zero() // the table, which the takeoff leaves from (see orbitStartAngle)

/** The circle's live centre: the base midpoint plus the tuned offsets. */
export function orbitCenterNow(): Vector3 {
  return Vector3.create(orbitBase.x + orbitTune.offsetX, orbitBase.y, orbitBase.z + orbitTune.offsetZ)
}

function orbitOmega(): number {
  return TAU / orbitTune.period
}

/** Recompute the base midpoint + start angle from the composite's table and
 *  Caretaker (falls back to the player if the table isn't there). */
export function refreshOrbitBase(): void {
  const table = getPotionTable()
  const caretaker = engine.getEntityOrNullByName(EntityNames.Caretaker_glb)
  const tablePos = table ? Transform.get(table).position : playerPos()
  const caretakerPos = caretaker && Transform.has(caretaker) ? Transform.get(caretaker).position : tablePos
  orbitBase = Vector3.create((tablePos.x + caretakerPos.x) / 2, tablePos.y, (tablePos.z + caretakerPos.z) / 2)
  orbitTablePos = Vector3.create(tablePos.x, tablePos.y, tablePos.z)
}

/** Where on the circle the takeoff joins it: the point nearest the table, so
 *  Pepito doesn't have to cross the whole circle however far it's been shifted. */
function orbitStartAngle(): number {
  const c = orbitCenterNow()
  return Math.atan2(orbitTablePos.z - c.z, orbitTablePos.x - c.x)
}

/** A point on the flight circle at `angle` radians (no bob) — for drawing it. */
export function orbitRingPoint(angle: number): Vector3 {
  const c = orbitCenterNow()
  return Vector3.create(c.x + Math.cos(angle) * orbitTune.radius, c.y + orbitTune.height, c.z + Math.sin(angle) * orbitTune.radius)
}
let chaseClock = 0 // seconds on the flight path; 0 at the moment the takeoff joins it
let groundY = 0 // floor height for falling props, taken from the player at chase start

// The one Pepito entity, created on first use and then only hidden/shown —
// never removed. It carries GltfNodeModifiers material overrides (its skin),
// and destroying an entity that has them was the suspect behind a burst of
// "[ResetMaterialSystem]" errors from the Unity explorer right when Pepito
// flew off.
let pepitoPool: Entity | null = null

function spawnPepito(at: Vector3): Entity {
  if (pepitoPool) {
    Transform.createOrReplace(pepitoPool, { position: at, scale: Vector3.scale(Vector3.One(), PEPITO_SCALE) })
    VisibilityComponent.createOrReplace(pepitoPool, { visible: true })
    return pepitoPool
  }
  const e = engine.addEntity()
  Transform.create(e, { position: at, scale: Vector3.scale(Vector3.One(), PEPITO_SCALE) })
  GltfContainer.createOrReplace(e, { src: modelForSpecies(PEPITO_SPECIES), ...NO_COLLISION })
  const flap = clipForSpecies(PEPITO_SPECIES, 'walk')
  Animator.createOrReplace(e, { states: [{ clip: flap, playing: true, loop: true, speed: PEPITO_WALK_SPEED, weight: 1 }] })
  applyCreatureSkin(e, PEPITO_SPECIES, PEPITO_RARITY)
  VisibilityComponent.create(e, { visible: true })
  pepitoPool = e
  return e
}

/** Pepito is gone for now: hide it (see pepitoPool) instead of removing it. */
function despawnPepito(): void {
  if (!pepito) return
  VisibilityComponent.createOrReplace(pepito, { visible: false })
  pepito = null
}

function pepitoOrbitPos(t: number): Vector3 {
  const a = orbitStartAngle() + t * orbitOmega()
  const bob = Math.sin((t / BOB_PERIOD_S) * TAU) * BOB_AMPLITUDE
  const c = orbitCenterNow()
  return Vector3.create(c.x + Math.cos(a) * orbitTune.radius, c.y + orbitTune.height + bob, c.z + Math.sin(a) * orbitTune.radius)
}

function withCenterLift(p: Vector3): Vector3 {
  return Vector3.create(p.x, p.y + PEPITO_CENTER_LIFT, p.z)
}

/** Move Pepito (and the cure, if it's carrying it), facing its direction of travel. */
function placePepito(pos: Vector3): void {
  if (!pepito) return
  const dx = pos.x - pepitoPos.x
  const dz = pos.z - pepitoPos.z
  if (dx * dx + dz * dz > 1e-6) pepitoYaw = (Math.atan2(dx, dz) * 180) / Math.PI
  pepitoPos = Vector3.create(pos.x, pos.y, pos.z)
  const tr = Transform.getMutable(pepito)
  tr.position = pepitoPos
  tr.rotation = Quaternion.fromEulerDegrees(0, pepitoYaw + yawOffsetForSpecies(PEPITO_SPECIES), 0)
  if (potionCarried) {
    const potion = getPotion()
    if (potion) {
      const yawRad = (pepitoYaw * Math.PI) / 180
      Transform.getMutable(potion).position = Vector3.create(
        pepitoPos.x + Math.sin(yawRad) * CARRY_FORWARD,
        pepitoPos.y - CARRY_DROP,
        pepitoPos.z + Math.cos(yawRad) * CARRY_FORWARD
      )
    }
  }
}

function circlingTick(dt: number): void {
  chaseClock += dt
  placePepito(pepitoOrbitPos(chaseClock))
}

// ---------------------------------------------------------------------------
// Steal cinematic
// ---------------------------------------------------------------------------
type StealStage = 'sequence' | 'returning' | 'dialog'
let stealStage: StealStage = 'sequence'
let stealT = 0
let cageOpened = false
let cageReclosed = false // shut again once the cure is out of it (see stealTick)
let stealEntry = Vector3.Zero()
let stealGrab = Vector3.Zero()

function stealTick(dt: number): void {
  stealT += dt
  if (!cageOpened && stealT >= STEAL_OPEN_AT) {
    openCage()
    cageOpened = true
  }
  if (stealT < STEAL_SPAWN_AT) return
  if (!pepito) {
    pepito = spawnPepito(stealEntry)
    pepitoPos = stealEntry
    pepitoYaw = (Math.atan2(stealGrab.x - stealEntry.x, stealGrab.z - stealEntry.z) * 180) / Math.PI
  }
  const start = pepitoOrbitPos(0)
  if (stealT < STEAL_GRAB_AT) {
    placePepito(Vector3.lerp(stealEntry, stealGrab, smooth((stealT - STEAL_SPAWN_AT) / (STEAL_GRAB_AT - STEAL_SPAWN_AT))))
  } else if (stealT < STEAL_TAKEOFF_AT) {
    potionCarried = true // it has the cure now
    placePepito(stealGrab)
  } else {
    const u = Math.min(1, (stealT - STEAL_TAKEOFF_AT) / (STEAL_END_AT - STEAL_TAKEOFF_AT))
    // The cure is gone: shut the cage once Pepito has cleared it (a beat into
    // the takeoff, so the cage doesn't pop up around the bird), leaving the
    // table closed and empty for the rest of the chase.
    if (!cageReclosed && u >= CAGE_RECLOSE_AT_U) {
      closeCage()
      cageReclosed = true
    }
    const p = Vector3.lerp(stealGrab, start, smooth(u))
    p.y += Math.sin(u * Math.PI) * TAKEOFF_BUMP
    placePepito(p)
  }
  if (stealT >= STEAL_END_AT) endSteal()
}

/** Sequence over: blend the camera back to the player's own, then let the
 *  Caretaker explain. Pepito keeps flying its circle meanwhile, and the player
 *  stays frozen (through the blend and the dialog) so the pose the camera is
 *  blending back to can't go stale. */
function endSteal(): void {
  console.log('[Client] pepito chase: steal cinematic done, camera returning to the player')
  stealStage = 'returning'
  chaseClock = 0
  placePepito(pepitoOrbitPos(0))
  cinematicReturn(() => {
    if (!clientState.pepitoChase.active) return // torn down while the camera was coming back
    console.log('[Client] pepito chase: camera back, dialog')
    stealStage = 'dialog'
    openPepitoStoleDialog(beginCircling)
  })
}

/** The Caretaker's line is done: unfreeze the player and start the throwing.
 *  Also called by the system as a safety net if the dialog vanishes without
 *  calling onDone (something else opened/closed a dialog over it), so the
 *  player can never be left frozen with the chase stuck on 'steal'. */
function beginCircling(): void {
  const st = clientState.pepitoChase
  if (!st.active || st.phase !== 'steal') return
  console.log('[Client] pepito chase: dialog done, player can throw')
  if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
  st.phase = 'circling'
}

// ---------------------------------------------------------------------------
// Rock: held in hand (mirrors play.ts's carryBallSystem), charge/release, and a
// scripted ballistic flight that hit-tests against Pepito's LIVE position.
// ---------------------------------------------------------------------------
type Rock = { entity: Entity; pos: Vector3; vel: Vector3; t: number; spin: number; landedAt: number }
let rock: Rock | null = null
let rockHandAnchor: Entity | null = null
let rockHandModel: Entity | null = null

function applyRockModel(e: Entity): void {
  GltfContainer.createOrReplace(e, { src: ROCK_MODEL, ...NO_COLLISION })
}

export function startRockCharge(): void {
  const st = clientState.pepitoChase
  if (st.phase !== 'circling' || st.busy || st.charging || rock) return
  st.charging = true
  st.charge = 0
}

export function releaseRockCharge(): void {
  const st = clientState.pepitoChase
  if (!st.charging) return
  const power = st.charge
  st.charging = false
  st.charge = 0
  beginRockThrow(power)
}

function chargeSystem(dt: number): void {
  const st = clientState.pepitoChase
  if (!st.charging) return
  st.charge = Math.min(1, st.charge + dt / CHARGE_TIME)
}

function beginRockThrow(power: number): void {
  if (rock || clientState.pepitoChase.phase !== 'circling') return
  clientState.pepitoChase.busy = true
  void triggerSceneEmote({ src: THROW_EMOTE, loop: false, mask: mobile() ? undefined : AvatarMask.AM_UPPER_BODY }).catch(() => {})
  let t = 0
  const fire = (dt: number): void => {
    t += dt
    if (t >= THROW_RELEASE_DELAY) {
      launchRock(power)
      engine.removeSystem(fire)
    }
  }
  engine.addSystem(fire)
}

/** Where the camera is looking (its position + forward), or null if the
 *  renderer hasn't given us a usable camera transform yet. */
function cameraRay(): { origin: Vector3; dir: Vector3 } | null {
  const ct = Transform.getOrNull(engine.CameraEntity)
  if (!ct || Vector3.length(ct.position) < 0.01) return null
  return { origin: ct.position, dir: Vector3.normalize(Vector3.rotate(Vector3.create(0, 0, 1), ct.rotation)) }
}

/** Initial velocity for a throw released at `hand`. */
function planThrow(hand: Vector3, speed: number, fallbackDir: Vector3): Vector3 {
  const ray = cameraRay()
  const dir = ray ? ray.dir : fallbackDir
  const origin = ray ? ray.origin : hand
  if (pepito && clientState.pepitoChase.phase === 'circling') {
    // Is the player looking at Pepito (where it is NOW)?
    const now = withCenterLift(pepitoOrbitPos(chaseClock))
    const along = Vector3.dot(Vector3.subtract(now, origin), dir)
    if (along > 0) {
      const closest = Vector3.add(origin, Vector3.scale(dir, along))
      if (Vector3.distance(now, closest) <= AIM_ASSIST_RADIUS) {
        // Aim at where it will be when the rock arrives (two refinement steps).
        let tau = Vector3.distance(now, hand) / speed
        let target = withCenterLift(pepitoOrbitPos(chaseClock + tau))
        tau = Vector3.distance(target, hand) / speed
        target = withCenterLift(pepitoOrbitPos(chaseClock + tau))
        // Ballistic launch velocity that passes through `target` after `tau`.
        const flat = Vector3.scale(Vector3.subtract(target, hand), 1 / tau)
        return Vector3.create(flat.x, flat.y + 0.5 * ROCK_GRAVITY * tau, flat.z)
      }
    }
  }
  // Not looking at it: the rock flies where the crosshair points.
  const far = Vector3.add(origin, Vector3.scale(dir, AIM_FAR))
  return Vector3.scale(Vector3.normalize(Vector3.subtract(far, hand)), speed)
}

function launchRock(power: number): void {
  if (rock) return
  const pt = Transform.getOrNull(engine.PlayerEntity)
  if (!pt) return
  const dir = flatForward(pt.rotation)
  const right = flatRight(pt.rotation)
  const hand = Vector3.create(
    pt.position.x + dir.x * HAND_FORWARD_OFFSET + right.x * HAND_RIGHT_OFFSET,
    pt.position.y + HAND_HEIGHT,
    pt.position.z + dir.z * HAND_FORWARD_OFFSET + right.z * HAND_RIGHT_OFFSET
  )
  const vel = planThrow(hand, lerp(MIN_ROCK_SPEED, MAX_ROCK_SPEED, power), dir)
  const entity = engine.addEntity()
  Transform.createOrReplace(entity, { position: hand, scale: Vector3.scale(Vector3.One(), ROCK_SCALE) })
  applyRockModel(entity)
  rock = { entity, pos: hand, vel, t: 0, spin: 0, landedAt: 0 }
}

function rockFlightSystem(dt: number): void {
  if (!rock) return
  if (rock.landedAt > 0) {
    if (Date.now() - rock.landedAt >= ROCK_LINGER_MS) {
      engine.removeEntity(rock.entity)
      rock = null
      clientState.pepitoChase.busy = false
    }
    return
  }
  rock.t += dt
  rock.spin += SPIN_SPEED * dt
  rock.vel = Vector3.create(rock.vel.x, rock.vel.y - ROCK_GRAVITY * dt, rock.vel.z)
  rock.pos = Vector3.add(rock.pos, Vector3.scale(rock.vel, dt))
  const tr = Transform.getMutable(rock.entity)
  tr.position = rock.pos
  tr.rotation = Quaternion.fromEulerDegrees(rock.spin, rock.spin * 0.6, 0)
  if (pepito && clientState.pepitoChase.phase === 'circling' && Vector3.distance(rock.pos, withCenterLift(pepitoPos)) <= HIT_RADIUS) {
    resolveHit()
    return
  }
  if (rock.pos.y <= groundY + 0.05 || rock.t >= ROCK_MAX_LIFE_S) {
    tr.position = Vector3.create(rock.pos.x, Math.max(rock.pos.y, groundY + 0.05), rock.pos.z)
    rock.landedAt = Date.now()
  }
}

/** Keeps a rock visibly in the player's right hand while circling and no rock
 *  is currently in flight — same AvatarAttach approach play.ts uses for Fetch. */
function rockHandSystem(): void {
  const wantAnchor = clientState.pepitoChase.active && clientState.pepitoChase.phase === 'circling'
  if (wantAnchor && !rockHandAnchor) {
    rockHandAnchor = engine.addEntity()
    Transform.createOrReplace(rockHandAnchor, {})
    AvatarAttach.createOrReplace(rockHandAnchor, { anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND })
  } else if (!wantAnchor && rockHandAnchor) {
    if (rockHandModel) {
      engine.removeEntity(rockHandModel)
      rockHandModel = null
    }
    engine.removeEntity(rockHandAnchor)
    rockHandAnchor = null
  }

  const wantRock = wantAnchor && !rock
  if (wantRock && !rockHandModel && rockHandAnchor) {
    rockHandModel = engine.addEntity()
    Transform.createOrReplace(rockHandModel, {
      parent: rockHandAnchor,
      position: Vector3.create(HAND_ROCK_X, HAND_ROCK_Y, HAND_ROCK_Z),
      scale: Vector3.scale(Vector3.One(), ROCK_SCALE)
    })
    applyRockModel(rockHandModel)
  } else if (!wantRock && rockHandModel) {
    engine.removeEntity(rockHandModel)
    rockHandModel = null
  }
}

let rockTouchButtonShown = false
function rockTouchInputSystem(): void {
  const st = clientState.pepitoChase
  const wantButton = st.active && st.phase === 'circling'
  if (wantButton) {
    if (!rockTouchButtonShown) {
      showRockTouchButton(THROW_ICON)
      rockTouchButtonShown = true
    }
    if (inputSystem.isTriggered(ROCK_TOUCH_ACTION, PointerEventType.PET_DOWN)) startRockCharge()
    if (inputSystem.isTriggered(ROCK_TOUCH_ACTION, PointerEventType.PET_UP)) releaseRockCharge()
  } else if (rockTouchButtonShown) {
    hideRockTouchButton()
    rockTouchButtonShown = false
  }
}

// ---------------------------------------------------------------------------
// Hit: Pepito flees, the cure falls straight down from where it was hit, and
// the player walks over to pick it up (floor marker + guide arrow)
// ---------------------------------------------------------------------------
let fleeT = 0
let fleeStart = Vector3.Zero()
let fleeDir = Vector3.Zero()
let potionFalling = false
let potionVy = 0
let potionSpin = 0
let landX = 0 // where the cure falls / rests (world XZ) — under the spot Pepito was hit
let landZ = 0
let pickupT = 0
let collecting = false
let collectT = 0
let collectFrom = Vector3.Zero()

// Floor marker for the fallen cure: a pulsing ring on the ground. Created once
// and only hidden/shown — like Pepito, never removed (see pepitoPool).
let markerRing: Entity | null = null

function ensureMarkers(): void {
  if (markerRing) return
  const tex = Material.Texture.Common({ src: MARKER_TEXTURE })
  markerRing = engine.addEntity()
  Transform.create(markerRing, {
    position: Vector3.create(0, -100, 0),
    rotation: Quaternion.fromEulerDegrees(-90, 0, 0), // lying flat on the ground
    scale: Vector3.scale(Vector3.One(), MARKER_RING_SCALE)
  })
  MeshRenderer.setPlane(markerRing)
  Material.setPbrMaterial(markerRing, {
    texture: tex,
    alphaTexture: tex,
    emissiveTexture: tex,
    emissiveColor: MARKER_EMISSIVE,
    emissiveIntensity: 2.4,
    albedoColor: MARKER_TINT,
    roughness: 1,
    metallic: 0,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND
  })
  VisibilityComponent.create(markerRing, { visible: false })
}

/** Put the floor ring under (x, z). */
function placeMarkers(x: number, z: number): void {
  ensureMarkers()
  if (!markerRing) return
  Transform.getMutable(markerRing).position = Vector3.create(x, groundY + 0.05, z)
  VisibilityComponent.createOrReplace(markerRing, { visible: true })
}

function hideMarkers(): void {
  if (markerRing) VisibilityComponent.createOrReplace(markerRing, { visible: false })
}

function resolveHit(): void {
  if (!rock) return
  console.log('[Client] pepito chase: hit')
  engine.removeEntity(rock.entity)
  rock = null
  const st = clientState.pepitoChase
  st.busy = false
  st.charging = false
  st.charge = 0
  st.phase = 'hit'
  // Pepito keeps going the way it was flying; the cure lets go and drops.
  const a = orbitStartAngle() + chaseClock * orbitOmega()
  fleeDir = Vector3.create(-Math.sin(a), 0, Math.cos(a))
  fleeStart = Vector3.create(pepitoPos.x, pepitoPos.y, pepitoPos.z)
  fleeT = 0
  // The cure falls from exactly where the bird was hit, straight down.
  const potion = getPotion()
  const at = potion ? Transform.get(potion).position : pepitoPos
  landX = at.x
  landZ = at.z
  // The floor under the hit may be lower than where the chase started (the
  // circle can sit outside the dome), so never land above where the player is.
  groundY = Math.min(groundY, playerPos().y)
  placeMarkers(landX, landZ) // shows where it will land while it's still falling
  potionCarried = false
  potionFalling = true
  potionVy = 0
  potionSpin = 0
  collecting = false
}

/** Pepito flying off after the hit: keeps going the way it was flying, climbing
 *  and shrinking until it's gone. Runs alongside the fall and the pickup. */
function fleeTick(dt: number): void {
  if (!pepito) return
  fleeT += dt
  const u = Math.min(1, fleeT / FLEE_S)
  placePepito(
    Vector3.create(
      fleeStart.x + fleeDir.x * FLEE_SPEED * fleeT,
      fleeStart.y + FLEE_RISE * fleeT,
      fleeStart.z + fleeDir.z * FLEE_SPEED * fleeT
    )
  )
  Transform.getMutable(pepito).scale = Vector3.scale(Vector3.One(), PEPITO_SCALE * (1 - u))
  if (u >= 1) despawnPepito()
}

function potionFallTick(dt: number): void {
  const potion = getPotion()
  if (!potion) {
    enterPickup() // nothing to drop (entity missing) — don't wait on it forever
    return
  }
  const t = Transform.getMutable(potion)
  potionVy -= POTION_GRAVITY * dt
  const y = t.position.y + potionVy * dt
  potionSpin += 360 * dt
  const restY = groundY + POTION_HOVER
  if (y <= restY) {
    t.position = Vector3.create(landX, restY, landZ)
    enterPickup()
  } else {
    t.position = Vector3.create(landX, y, landZ)
    t.rotation = Quaternion.fromEulerDegrees(potionSpin, 0, potionSpin * 0.4)
  }
}

/** The cure has landed: light up the spot and send the player to it. */
function enterPickup(): void {
  console.log('[Client] pepito chase: cure landed, waiting for pickup')
  potionFalling = false
  clientState.pepitoChase.phase = 'pickup'
  pickupT = 0
  collecting = false
  placeMarkers(landX, landZ)
}

function distFlat(a: Vector3, x: number, z: number): number {
  const dx = a.x - x
  const dz = a.z - z
  return Math.sqrt(dx * dx + dz * dz)
}

function pickupTick(dt: number): void {
  const potion = getPotion()
  if (!potion) {
    finalizeCure()
    return
  }
  const pt = Transform.getMutable(potion)
  if (collecting) {
    // Flies into the player's hands, shrinking, then the cure is applied.
    collectT += dt
    const u = Math.min(1, collectT / COLLECT_S)
    const p = playerPos()
    pt.position = Vector3.lerp(collectFrom, Vector3.create(p.x, p.y + 1.0, p.z), smooth(u))
    const home = potionHomeTransform()
    const s = home ? home.scale : Vector3.One()
    pt.scale = Vector3.scale(s, 1 - 0.8 * u)
    if (u >= 1) {
      VisibilityComponent.createOrReplace(potion, { visible: false })
      finalizeCure()
    }
    return
  }
  // Waiting to be picked up: hover + spin, pulsing ring, arrow toward it.
  pickupT += dt
  pt.position = Vector3.create(landX, groundY + POTION_HOVER + Math.sin(pickupT * 3) * POTION_HOVER_BOB, landZ)
  pt.rotation = Quaternion.fromEulerDegrees(0, pickupT * 120, 0)
  if (markerRing) Transform.getMutable(markerRing).scale = Vector3.scale(Vector3.One(), MARKER_RING_SCALE + Math.sin(pickupT * 4) * 0.25)
  showArrowTo(Vector3.create(landX, groundY, landZ), 'sickness') // re-asserted every frame, like the other errands
  if (distFlat(playerPos(), landX, landZ) <= PICKUP_RADIUS) {
    collecting = true
    collectT = 0
    collectFrom = Vector3.create(pt.position.x, pt.position.y, pt.position.z)
    hideArrow('sickness')
    hideMarkers()
  }
}

function finalizeCure(): void {
  console.log('[Client] pepito chase: cure applied')
  applyCureLocal() // optimistic local effect
  actions.cureSickness() // tell the server (it corrects via snapshot)
  clientState.pepitoChase.phase = 'results'
}

// ---------------------------------------------------------------------------
// Phase machine entry points
// ---------------------------------------------------------------------------

/** Hand-off from sicknessErrand.ts once the player reaches the Caretaker (or
 *  a retry via caretaker.ts's click handler while the pet is still sick). */
export function startPepitoChase(): void {
  if (clientState.pepitoChase.active) return
  if (!clientState.activePet?.sick) return
  clientState.pepitoChase = { active: true, phase: 'steal', charging: false, charge: 0, busy: false }
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })

  groundY = playerPos().y
  const table = getPotionTable()
  refreshOrbitBase()

  chaseClock = 0
  stealT = 0
  stealStage = 'sequence'
  cageOpened = false
  cageReclosed = false
  potionCarried = false
  despawnPepito()
  console.log('[Client] pepito chase: started')

  const home = potionHomeTransform()
  if (table && home) {
    const side = tableCameraSide()
    const right = Vector3.create(-side.z, 0, side.x)
    stealEntry = Vector3.create(
      home.position.x + side.x * 1.0 + right.x * ENTRY_SIDE,
      home.position.y + ENTRY_HEIGHT,
      home.position.z + side.z * 1.0 + right.z * ENTRY_SIDE
    )
    // Feet just above the potion, so it hangs (see CARRY_DROP) right where it stood.
    stealGrab = Vector3.create(home.position.x, home.position.y + CARRY_DROP, home.position.z)
    focusPotionTable()
  } else {
    // No table in the scene: skip the sequence and go straight to the dialog.
    console.log('[Client] pepito chase: potion table not found in scene — skipping steal cinematic')
    pepito = spawnPepito(pepitoOrbitPos(0))
    pepitoPos = pepitoOrbitPos(0)
    endSteal()
  }
}

function teardown(): void {
  clientState.pepitoChase = { active: false, phase: 'steal', charging: false, charge: 0, busy: false }
  if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
  releasePotionTableCamera()
  despawnPepito()
  console.log('[Client] pepito chase: torn down')
  if (rock) {
    engine.removeEntity(rock.entity)
    rock = null
  }
  if (rockHandModel) {
    engine.removeEntity(rockHandModel)
    rockHandModel = null
  }
  if (rockHandAnchor) {
    engine.removeEntity(rockHandAnchor)
    rockHandAnchor = null
  }
  // Back on the table, cage shut, ready for the next time a pet gets sick.
  potionCarried = false
  potionFalling = false
  collecting = false
  hideMarkers()
  hideArrow('sickness')
  resetPotion()
  closeCage()
  if (rockTouchButtonShown) {
    hideRockTouchButton()
    rockTouchButtonShown = false
  }
  chaseClock = 0
}

/** BACK button during 'circling' or 'pickup' — bails without curing. The pet
 *  stays sick; clicking the Caretaker again (caretaker.ts) restarts the chase. */
export function cancelPepitoChase(): void {
  const phase = clientState.pepitoChase.phase
  if (!clientState.pepitoChase.active || (phase !== 'circling' && phase !== 'pickup')) return
  teardown()
  pushToast('Cure attempt cancelled — talk to the Caretaker again when ready.')
}

/** Exit button on the results card. */
export function exitPepitoChaseResults(): void {
  if (clientState.pepitoChase.phase !== 'results') return
  teardown()
}

export function setupPepitoChase(): void {
  engine.addSystem((dt: number) => {
    const st = clientState.pepitoChase
    if (!st.active) return
    chargeSystem(dt)
    rockHandSystem()
    rockFlightSystem(dt)
    rockTouchInputSystem()
    if (st.phase === 'steal') {
      if (stealStage === 'sequence') {
        stealTick(dt)
      } else if (stealStage === 'returning') {
        circlingTick(dt) // Pepito keeps flying while the camera comes back
      } else {
        circlingTick(dt)
        if (!clientState.dialog.open) beginCircling() // safety net, see beginCircling
      }
    } else if (st.phase === 'circling') {
      circlingTick(dt)
    } else if (st.phase === 'hit') {
      fleeTick(dt)
      potionFallTick(dt)
    } else if (st.phase === 'pickup') {
      fleeTick(dt)
      pickupTick(dt)
    }
  })
}
