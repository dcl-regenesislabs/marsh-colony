// The Care Center's potion table (issue #148): PotionTable.glb (a cage that
// lowers into the table via its "TableOpen" clip) with Potion01.glb standing
// inside it. Both are placed in main.composite, so they're only referenced here
// by name — never spawned. This module owns the shared bits the two halves of
// the cure flow need: the fixed camera shot on the table (the sickness
// explainer in sicknessErrand.ts and the steal cinematic in pepitoChase.ts),
// opening/closing the cage, and putting the potion back after Pepito carries it
// off.
//
// The cage is CLOSED at rest: the GLB's morph weights start at [0,0,0] (the
// base mesh) and TableOpen animates them through Open01..Open03, ending with
// the cage sunk into the table. Playing it therefore opens it, and stopping
// with a cursor reset (Animator.stopAllAnimations(_, true)) closes it again.

import { engine, Entity, Transform, Animator, VisibilityComponent } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'
import { cinematicCut, cinematicRelease } from './cinematicCam'

const CLIP_OPEN = 'TableOpen'
const CAM_DIST = 3.0 // metres from the table, toward the Caretaker's side
const CAM_HEIGHT = 1.6 // above the table's origin
const LOOK_LIFT = 0.95 // where on the table the shot aims (cage + potion), above its origin

export function getPotionTable(): Entity | null {
  const e = engine.getEntityOrNullByName(EntityNames.PotionTable_glb)
  return e && Transform.has(e) ? e : null
}

export function getPotion(): Entity | null {
  const e = engine.getEntityOrNullByName(EntityNames.Potion01_glb)
  return e && Transform.has(e) ? e : null
}

type Home = { position: Vector3; rotation: Quaternion; scale: Vector3 }
let potionHome: Home | null = null

/** The potion's composite-placed transform, captured once (while it's still
 *  standing on the table) so resetPotion() can put it back after a chase. */
export function potionHomeTransform(): Home | null {
  if (potionHome) return potionHome
  const potion = getPotion()
  if (!potion) return null
  const t = Transform.get(potion)
  potionHome = {
    position: Vector3.create(t.position.x, t.position.y, t.position.z),
    rotation: Quaternion.create(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w),
    scale: Vector3.create(t.scale.x, t.scale.y, t.scale.z)
  }
  return potionHome
}

/** Put the potion back on the table exactly where the composite placed it
 *  (and visible again, in case the chase hid it once it was collected). */
export function resetPotion(): void {
  const potion = getPotion()
  const home = potionHomeTransform()
  if (!potion || !home) return
  VisibilityComponent.createOrReplace(potion, { visible: true })
  const t = Transform.getMutable(potion)
  t.position = Vector3.create(home.position.x, home.position.y, home.position.z)
  t.rotation = Quaternion.create(home.rotation.x, home.rotation.y, home.rotation.z, home.rotation.w)
  t.scale = Vector3.create(home.scale.x, home.scale.y, home.scale.z)
}

let cageOpen = false

/** Whether the cage has been opened (and not closed again since). */
export function isCageOpen(): boolean {
  return cageOpen
}

/** Play TableOpen once (from its start) — the cage lowers into the table.
 *  `speed` scales the clip's ~1 s length (0.4 = a slow, ~2.5 s reveal). No-op
 *  if it's already open, so a second call can't snap it shut and replay it. */
export function openCage(speed = 1): void {
  if (cageOpen) return
  const table = getPotionTable()
  if (!table || !Animator.has(table)) return
  Animator.playSingleAnimation(table, CLIP_OPEN, true)
  for (const s of Animator.getMutable(table).states) if (s.clip === CLIP_OPEN) s.speed = speed
  cageOpen = true
}

/** Back to the closed rest pose (clip stopped, cursor reset to frame 0). */
export function closeCage(): void {
  cageOpen = false
  const table = getPotionTable()
  if (table && Animator.has(table)) Animator.stopAllAnimations(table, true)
}

// ---------------------------------------------------------------------------
// Camera shot on the table
// ---------------------------------------------------------------------------
let camSide = Vector3.create(-1, 0, 0) // unit vector, table -> camera, on the ground plane

/** Unit ground-plane vector from the table toward where the camera sits, so
 *  the steal cinematic can bring Pepito in from a side the camera can see. */
export function tableCameraSide(): Vector3 {
  return camSide
}

/** Hard cut to a fixed shot of the table + cage. */
export function focusPotionTable(): void {
  const table = getPotionTable()
  if (!table) return
  const t = Transform.get(table).position
  const caretaker = engine.getEntityOrNullByName(EntityNames.Caretaker_glb)
  if (caretaker && Transform.has(caretaker)) {
    const c = Transform.get(caretaker).position
    const flat = Vector3.create(c.x - t.x, 0, c.z - t.z)
    if (Vector3.length(flat) > 0.01) camSide = Vector3.normalize(flat)
  }
  const camPos = Vector3.create(t.x + camSide.x * CAM_DIST, t.y + CAM_HEIGHT, t.z + camSide.z * CAM_DIST)
  const look = Vector3.create(t.x, t.y + LOOK_LIFT, t.z)
  cinematicCut(camPos, look)
}

/** Hand the camera back to the player (see cinematicRelease). */
export function releasePotionTableCamera(): void {
  cinematicRelease()
}

/** Once, as soon as the composite entities exist: remember the potion's home
 *  and make sure the cage starts closed. */
export function setupPotionTable(): void {
  let done = false
  engine.addSystem(() => {
    if (done) return
    if (!getPotionTable() || !getPotion()) return
    potionHomeTransform()
    closeCage()
    done = true
  })
}
