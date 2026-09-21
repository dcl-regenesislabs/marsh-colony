// Shared cinematic camera: cut the main camera to a fixed shot and give it back.
//
// Getting IN is a hard cut — a blend between two shots in different places just
// sweeps through the scene and is harder to follow than the cut.
//
// Getting OUT used to be a hard snap too (drop the virtual camera and the
// player's own camera pops back, pointing wherever it happens to point). Now the
// first cut remembers where the player's own camera was, and cinematicReturn()
// blends the virtual camera back to exactly that pose before letting go — so
// the hand-off at the end is seamless. That needs the player to stay put while
// the shot is up (callers keep them frozen until the return completes).
//
// Two virtual-camera entities are alternated, because a VirtualCamera's own
// defaultTransition only blends when the ACTIVE camera switches — moving the
// one that is already active would just snap.
//
// Always finish with cinematicReturn() or cinematicRelease(): they clear
// MainCamera's reference AND delete the VirtualCamera components, so the
// renderer can't keep blending toward a shot that's over (the same teardown
// fruitGame.ts learned the hard way).

import { engine, Entity, Transform, VirtualCamera, MainCamera } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'

const RETURN_BLEND_S = 0.9
const RETURN_HOLD_S = 0.15 // extra beat after the blend ends, before letting go

const cams: Entity[] = []
let next = 0
let active = false
let returnPos: Vector3 | null = null
let returnRot: Quaternion | null = null
// Bumped by every cut and release, so a return still in flight when something
// else takes over the camera (a new shot, a teardown) quietly cancels itself.
let gen = 0

/** Is a scene-driven camera (any VirtualCamera) currently the main camera? */
function virtualCameraActive(): boolean {
  return MainCamera.has(engine.CameraEntity) && MainCamera.get(engine.CameraEntity).virtualCameraEntity !== undefined
}

/** Remember the player's own camera pose — only when it really is the player's
 *  (no virtual camera active) and the renderer has given us a usable transform. */
function capturePlayerCamera(): void {
  returnPos = null
  returnRot = null
  if (virtualCameraActive()) return
  const ct = Transform.getOrNull(engine.CameraEntity)
  if (!ct || Vector3.length(ct.position) < 0.01) return
  returnPos = Vector3.create(ct.position.x, ct.position.y, ct.position.z)
  returnRot = Quaternion.create(ct.rotation.x, ct.rotation.y, ct.rotation.z, ct.rotation.w)
}

function cutToPose(pos: Vector3, rot: Quaternion, transitionS: number): void {
  if (cams.length === 0) cams.push(engine.addEntity(), engine.addEntity())
  const cam = cams[next]
  next = (next + 1) % cams.length
  Transform.createOrReplace(cam, { position: pos, rotation: rot })
  VirtualCamera.createOrReplace(
    cam,
    transitionS > 0 ? { defaultTransition: { transitionMode: VirtualCamera.Transition.Time(transitionS) } } : {}
  )
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: cam })
}

/** Cut to a shot at `pos` looking at `look`. */
export function cinematicCut(pos: Vector3, look: Vector3): void {
  if (!active) capturePlayerCamera()
  active = true
  gen++
  cutToPose(pos, Quaternion.fromLookAt(pos, look), 0)
}

/** Hand the camera back to the player immediately (a hard snap). */
export function cinematicRelease(): void {
  gen++
  active = false
  returnPos = null
  returnRot = null
  if (MainCamera.has(engine.CameraEntity)) MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
  for (const c of cams) if (VirtualCamera.has(c)) VirtualCamera.deleteFrom(c)
}

/** Blend back to where the player's camera was, then release it and call
 *  `onDone`. If the pose wasn't captured (or nothing is active) it just
 *  releases and calls `onDone` right away. The caller keeps the player frozen
 *  until `onDone`, so the pose can't go stale. */
export function cinematicReturn(onDone: () => void): void {
  if (!active || !returnPos || !returnRot) {
    cinematicRelease()
    onDone()
    return
  }
  gen++
  const mine = gen
  cutToPose(returnPos, returnRot, RETURN_BLEND_S)
  let t = 0
  const wait = (dt: number): void => {
    if (gen !== mine) {
      engine.removeSystem(wait) // something else took the camera meanwhile
      return
    }
    t += dt
    if (t < RETURN_BLEND_S + RETURN_HOLD_S) return
    engine.removeSystem(wait)
    cinematicRelease()
    onDone()
  }
  engine.addSystem(wait)
}
