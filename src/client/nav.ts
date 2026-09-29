// Pet navigation: keep the pet out of the buildings' walls and make it use the
// doors (so it can follow the player inside). Buildings are modelled as circular
// footprints — the domes are round — with a single angular GAP that is the door.
//
// How movement works (all client-side, local pet only):
//   * zoneOf(p) tells whether a point is inside a building or out in the open.
//   * nextWaypoint() turns "go to finalDest" into the next point to steer at: the
//     destination directly when it's in the same zone, or the door thresholds when
//     a wall has to be crossed (outer point -> inner point, or the reverse to exit).
//   * wallSlide() is the safety net: any step that would cross a footprint boundary
//     anywhere but the door gap is redirected to slide ALONG the ring toward the
//     door, so the pet rounds the dome to its doorway instead of walking through a
//     wall. Movement that stays on one side (inside or outside) is never blocked.
//
// The centres come from the live scene Transforms; radius + door bearing were
// measured in-world with the capture tool below (still available for the Care
// Center, which we haven't dialled in yet).

import { engine, Entity, Transform, inputSystem, InputAction, PointerEventType } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'
import * as C from '../shared/config'
import { objectPosition } from './objects'
import { petMotionStep, stopPetMotion } from './petMotion'
import { pushToast } from './state'

// ---------------------------------------------------------------------------
// Building footprints
// ---------------------------------------------------------------------------
/**
 * A circular property footprint. The pet treats the ring at `radius` as a solid
 * wall EXCEPT inside the door gap: a `doorHalfWidthDeg`-wide arc centred on
 * `doorAngleDeg`. `doorAngleDeg` is the bearing from the centre to the door,
 * measured as atan2(dz, dx) in degrees (the same convention the capture tool
 * prints), so it can be read straight off a recorded doorway point.
 */
export interface Building {
  id: string
  /** Scene entity whose live Transform is the footprint centre. */
  entity: EntityNames
  /** Outer wall radius in metres. */
  radius: number
  /** Bearing centre->door in degrees, atan2(dz, dx). */
  doorAngleDeg: number
  /** Half-width of the door gap in degrees (how wide the opening is). */
  doorHalfWidthDeg: number
}

// Measured in-world (see capture tool). Home: door faces west (ang -179.9°≈180),
// wall at ~6.3 m from centre (200.75, 247.75).
// Care Center is NOT enabled yet — its captured door was d=1.57 ang=17.3, but that
// radius is too small (the CareCentreDome01 model origin sits off its visual
// centre), so it needs re-measuring before we can trust a footprint for it.
export const BUILDINGS: Building[] = [
  { id: 'home', entity: EntityNames.HomeDome01_glb, radius: 6.3, doorAngleDeg: 180, doorHalfWidthDeg: 34 }
]

/** How far outside / inside the wall the door thresholds sit (metres). */
const DOOR_MARGIN = 1.0
/** Tolerance for "am I basically on the wall / at a threshold" (metres). */
const EDGE_EPS = 0.12

// ---------------------------------------------------------------------------
// Small vector / angle helpers (x-z plane, pets live at PET_BASE_Y)
// ---------------------------------------------------------------------------
const DEG = 180 / Math.PI
const RAD = Math.PI / 180

function flat(v: Vector3): Vector3 {
  return Vector3.create(v.x, C.PET_BASE_Y, v.z)
}
function dist(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dz * dz)
}
/** atan2(dz, dx) in degrees — matches Building.doorAngleDeg. */
function bearingDeg(from: Vector3, to: Vector3): number {
  return Math.atan2(to.z - from.z, to.x - from.x) * DEG
}
/** Signed smallest difference a-b, wrapped to [-180, 180] degrees. */
function wrapDeg(a: number): number {
  let x = a % 360
  if (x > 180) x -= 360
  if (x < -180) x += 360
  return x
}

function center(b: Building): Vector3 {
  const p = objectPosition(b.entity)
  return Vector3.create(p.x, C.PET_BASE_Y, p.z)
}
/** Point on the door bearing at radius offset (>0 outside the wall, <0 inside). */
function doorPoint(b: Building, offset: number): Vector3 {
  const c = center(b)
  const a = b.doorAngleDeg * RAD
  const r = b.radius + offset
  return Vector3.create(c.x + Math.cos(a) * r, C.PET_BASE_Y, c.z + Math.sin(a) * r)
}
const doorOutside = (b: Building): Vector3 => doorPoint(b, DOOR_MARGIN)
const doorInside = (b: Building): Vector3 => doorPoint(b, -DOOR_MARGIN)

/** True if the bearing centre->p falls inside the door gap. */
function withinDoor(b: Building, p: Vector3): boolean {
  return Math.abs(wrapDeg(bearingDeg(center(b), p) - b.doorAngleDeg)) <= b.doorHalfWidthDeg
}

// ---------------------------------------------------------------------------
// Zones + queries
// ---------------------------------------------------------------------------
/** The building whose interior contains p, or null if p is out in the open. */
export function zoneOf(p: Vector3): Building | null {
  for (const b of BUILDINGS) if (dist(p, center(b)) < b.radius) return b
  return null
}

// The pet's OWN zone is tracked with hysteresis so it can't flip at exactly the
// wall: once inside it stays inside until clearly (radius + ZONE_HYST) out, and
// vice-versa. Without this the pet oscillates on the threshold — target and
// "am I in or out?" invert every frame — and it vibrates in the doorway.
const ZONE_HYST = 0.7
let petZoneId: string | null = null

function buildingById(id: string | null): Building | null {
  return BUILDINGS.find((b) => b.id === id) ?? null
}

/** Update + return the pet's committed zone (call once per movement frame). */
function updatePetZone(p: Vector3): Building | null {
  const cur = buildingById(petZoneId)
  if (cur && dist(p, center(cur)) > cur.radius + ZONE_HYST) petZoneId = null
  if (petZoneId === null) {
    for (const b of BUILDINGS) {
      if (dist(p, center(b)) < b.radius - ZONE_HYST) {
        petZoneId = b.id
        break
      }
    }
  }
  return buildingById(petZoneId)
}

/** True if p is inside any building footprint (used to keep wander outdoors). */
export function pointInsideAnyBuilding(p: Vector3): boolean {
  return zoneOf(p) !== null
}

/** True if p is within `margin` metres of any building's wall (in or out). Follow
 *  uses this to keep its breadcrumb trail near doorways (for clean crossings) and
 *  only shortcut straight to the player out in the open, away from walls. */
export function nearWall(p: Vector3, margin: number): boolean {
  for (const b of BUILDINGS) if (Math.abs(dist(p, center(b)) - b.radius) < margin) return true
  return false
}

/** Extra clearance kept beyond the wall when relocating a home point outdoors. */
const OUT_MARGIN = 1.0

/**
 * Nudge a "home"/spawn/slot point OUT of any building it landed inside, projecting
 * it radially past the wall (+OUT_MARGIN). The pet lives in the open and only steps
 * inside when it's actually following the player through a door, so its resting
 * spots must never sit within a footprint. A point exactly on a centre (e.g. the
 * spawn, which is the dome origin) is pushed out along that building's door bearing,
 * so it ends up in front of the doorway rather than an arbitrary direction.
 */
export function nudgeOutsideBuildings(p: Vector3): Vector3 {
  let r = flat(p)
  for (const b of BUILDINGS) {
    const c = center(b)
    const d = dist(r, c)
    if (d >= b.radius + OUT_MARGIN) continue
    const dir =
      d > 0.001
        ? Vector3.normalize(Vector3.subtract(r, c))
        : Vector3.create(Math.cos(b.doorAngleDeg * RAD), 0, Math.sin(b.doorAngleDeg * RAD))
    r = Vector3.add(c, Vector3.scale(dir, b.radius + OUT_MARGIN))
  }
  return Vector3.create(r.x, C.PET_BASE_Y, r.z)
}

/** The immediate point to steer at to reach finalDest respecting walls/doors.
 *  `zP` is the pet's COMMITTED (hysteresis) zone, so this can't flip on the wall.
 *
 *  Crossing a wall aims straight at the door threshold on the FAR side (inside when
 *  entering, outside when exiting) — one stable target, no proximity switching.
 *  wallSlide() funnels the pet around the ring to the door gap and lets it through;
 *  once the committed zone flips (the pet is really across), this returns finalDest.
 *  An earlier version switched target by distance-to-doorOutside, and that switch
 *  point landed right on the wall, so the pet flip-flopped in-out on the threshold. */
function nextWaypoint(_petPos: Vector3, finalDest: Vector3, zP: Building | null): Vector3 {
  const zD = zoneOf(finalDest)
  if (zP === zD) return finalDest // same zone (both open, or same interior) -> straight
  if (zP !== null) return doorOutside(zP) // inside a building, dest isn't -> exit through the door
  return doorInside(zD!) // in the open, dest is inside zD -> enter through the door
}

/**
 * Redirect a step so it never crosses a wall except at a door. `cur`->`np` is the
 * intended move; `aim` is the point being steered at this frame (used to pick which
 * way around the ring to slide). Returns the adjusted next position.
 */
function wallSlide(cur: Vector3, np: Vector3, aim: Vector3): Vector3 {
  let result = np
  for (const b of BUILDINGS) {
    const c = center(b)
    const inCur = dist(cur, c) < b.radius
    const inNp = dist(result, c) < b.radius
    if (inCur === inNp) continue // stays on one side (interior or exterior) -> fine
    if (withinDoor(b, result)) continue // crossing through the door gap -> allowed
    // Blocked by a wall: slide along the ring (on cur's side) toward the door/target.
    const rc = Vector3.subtract(cur, c)
    let angCur = Math.atan2(rc.z, rc.x) * DEG
    const targetAng = bearingDeg(c, aim)
    const towardDoor = wrapDeg(b.doorAngleDeg - angCur)
    const towardAim = wrapDeg(targetAng - angCur)
    // Head for the door when we ultimately need to cross it; otherwise take the
    // shorter way around toward wherever we're going.
    const goal = zoneOf(aim) === b || zoneOf(cur) === b ? towardDoor : towardAim
    const radius = inCur ? b.radius - EDGE_EPS : b.radius + EDGE_EPS
    const arc = dist(cur, np) * DEG / Math.max(0.001, radius) // step length as degrees of arc
    const step = Math.min(arc, Math.abs(goal)) * Math.sign(goal || 1)
    angCur += step
    const a = angCur * RAD
    result = Vector3.create(c.x + Math.cos(a) * radius, C.PET_BASE_Y, c.z + Math.sin(a) * radius)
  }
  return result
}

// ---------------------------------------------------------------------------
// The one public mover: step `entity` toward finalDest, obeying walls + doors.
// Returns the distance actually moved this frame (0 if already there).
// ---------------------------------------------------------------------------
export function navStepToward(entity: Entity, finalDest: Vector3, dt: number, yawOffset = 0): number {
  const t = Transform.getMutable(entity)
  const cur = flat(t.position)
  const dest = flat(finalDest)
  const wp = nextWaypoint(cur, dest, updatePetZone(cur))
  const d = dist(cur, wp)
  if (d <= C.PET_ARRIVE_DISTANCE) {
    stopPetMotion(entity)
    return 0
  }
  const dir = Vector3.normalize(Vector3.subtract(wp, cur))
  const stepLen = petMotionStep(entity, d, dt, C.PET_MOVE_SPEED)
  const np = wallSlide(cur, Vector3.add(cur, Vector3.scale(dir, stepLen)), wp)
  t.position = Vector3.create(np.x, C.PET_BASE_Y, np.z)
  // Face the direction actually travelled (so it looks right while rounding a wall).
  const mdx = np.x - cur.x
  const mdz = np.z - cur.z
  if (Math.abs(mdx) > 0.0001 || Math.abs(mdz) > 0.0001) {
    const targetRotation = Quaternion.fromEulerDegrees(0, Math.atan2(mdx, mdz) * DEG + yawOffset, 0)
    t.rotation = Quaternion.rotateTowards(t.rotation, targetRotation, C.PET_TURN_SPEED * dt)
  }
  return dist(cur, np)
}

// ---------------------------------------------------------------------------
// Coordinate capture (debug) — used to record door thresholds + wall radius.
// Stand at a spot and press "3" (IA_ACTION_5): prints the player's (x,z) plus,
// for each building, the distance and bearing from that building's centre.
// ---------------------------------------------------------------------------
// OFF by default — this binds key "3" (which input-panel toggling also uses) and
// toasts raw coords, so it must never ship enabled. Flip to true only while
// measuring a building's door/radius in-world (e.g. to dial in the Care Center).
const NAV_CAPTURE = false

function setupNavCapture(): void {
  engine.addSystem(() => {
    if (!inputSystem.isTriggered(InputAction.IA_ACTION_5, PointerEventType.PET_DOWN)) return
    if (!Transform.has(engine.PlayerEntity)) return
    const p = Transform.get(engine.PlayerEntity).position
    const parts = BUILDINGS.map((b) => {
      const c = center(b)
      const d = dist(Vector3.create(p.x, C.PET_BASE_Y, p.z), c)
      return `${b.id}: d=${d.toFixed(2)} ang=${bearingDeg(c, p).toFixed(1)}`
    })
    const msg = `pos (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) | ${parts.join(' | ')}`
    console.log('[NavCapture]', msg)
    pushToast(msg)
  })
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
export function setupNav(): void {
  if (NAV_CAPTURE) setupNavCapture()
}
