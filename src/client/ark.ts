// The Ark ship itself: its dome door, the shared "X / 100 pets aboard" counter
// floating above it, and the placeholder lift-off used by the launch cinematic.
// The sequencing (who walks where, cameras, UI) lives in arkCinematics.ts.
//
// ark01.glb ships a single "OpenDoor" clip (closed -> open), so "close" is that
// clip played in reverse (negative speed) from the held-open pose. The door now
// stays closed and only opens for a pet boarding the ship.

import { engine, Animator, Billboard, BillboardMode, Entity, TextShape, Transform, VisibilityComponent } from '@dcl/sdk/ecs'
import { Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'
import { clientState } from './state'

const ARK_DOOR_CLIP = 'OpenDoor'
const ARK_DOOR_SPEED = 1 // playback speed (raise to open/close faster)

// Counter above the dome. The dome tops out ~13 m above the ship's pivot.
const COUNTER_HEIGHT = 15.5
const COUNTER_FONT_SIZE = 3 // in-world TextShape size (see scoreboard.ts — not metres)
const COUNTER_SCALE = 3 // blown up so it reads from the Captain and the plaza

let ark: Entity | null = null
let home: { position: Vector3; rotation: Quaternion } | null = null
let counter: Entity | null = null
let counterHidden = false
let doorOpen = false

/** Drive the single OpenDoor clip forward (open) or backward (close). loop:false
 *  freezes it on the last frame it reaches, so the door holds open/closed. */
function playArkDoor(e: Entity, open: boolean): void {
  const st = Animator.getMutable(e).states.find((s) => s.clip === ARK_DOOR_CLIP)
  if (!st) return
  st.loop = false
  st.speed = open ? ARK_DOOR_SPEED : -ARK_DOOR_SPEED
  st.shouldReset = open // open: restart from frame 0; close: run backward from the held-open pose
  st.playing = true
}

/** Open or close the dome door (no-op if it's already in that state). */
export function setArkDoor(open: boolean): void {
  if (!ark || doorOpen === open) return
  doorOpen = open
  playArkDoor(ark, open)
}

/** Where the ship rests in the composite (null until it has loaded). */
export function arkHome(): Vector3 | null {
  return home ? Vector3.clone(home.position) : null
}

/** Placeholder lift-off: raise the ship `lift` metres with a `shake` jitter.
 *  Swap for the ship's own launch clip once the GLB ships one. */
export function setArkLift(lift: number, shake: number): void {
  if (!ark || !home) return
  const jitter = (): number => (Math.random() * 2 - 1) * shake
  Transform.getMutable(ark).position = Vector3.create(home.position.x + jitter(), home.position.y + lift, home.position.z + jitter())
}

export function setArkVisible(visible: boolean): void {
  if (!ark) return
  VisibilityComponent.createOrReplace(ark, { visible })
}

/** Put the ship back on its pad, door closed — the next Ark, ready to fill. */
export function resetArk(): void {
  if (!ark || !home) return
  const t = Transform.getMutable(ark)
  t.position = Vector3.clone(home.position)
  t.rotation = Quaternion.create(home.rotation.x, home.rotation.y, home.rotation.z, home.rotation.w)
  setArkVisible(true)
  setArkDoor(false)
}

export function setArkCounterHidden(hidden: boolean): void {
  counterHidden = hidden
}

function makeCounter(at: Vector3): Entity {
  const e = engine.addEntity()
  Transform.create(e, { position: Vector3.create(at.x, at.y + COUNTER_HEIGHT, at.z), scale: Vector3.create(COUNTER_SCALE, COUNTER_SCALE, COUNTER_SCALE) })
  Billboard.create(e, { billboardMode: BillboardMode.BM_Y })
  TextShape.create(e, {
    text: '',
    fontSize: COUNTER_FONT_SIZE,
    textColor: Color4.create(1, 0.92, 0.55, 1),
    outlineColor: Color4.create(0.12, 0.08, 0.25, 1),
    outlineWidth: 0.2
  })
  return e
}

export function setupArk(): void {
  engine.addSystem(() => {
    if (!ark) {
      const e = engine.getEntityOrNullByName(EntityNames.ark01_glb)
      if (!e || !Transform.has(e)) return // composite not loaded yet — try again next frame
      ark = e
      const t = Transform.get(e)
      home = { position: Vector3.clone(t.position), rotation: Quaternion.create(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w) }
      // Attach the Animator to the GLB entity, paused at frame 0 (door closed).
      Animator.createOrReplace(e, {
        states: [{ clip: ARK_DOOR_CLIP, playing: false, loop: false, speed: ARK_DOOR_SPEED, shouldReset: true }]
      })
      counter = makeCounter(home.position)
    }

    if (counter) {
      const s = clientState.ark.status
      const text = counterHidden ? '' : `${s.donated} / ${s.goal}\nPETS ABOARD`
      if (TextShape.get(counter).text !== text) TextShape.getMutable(counter).text = text
    }
  })
}
