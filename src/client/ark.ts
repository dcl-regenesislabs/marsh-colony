// The Ark ship itself: its dome door, the shared "5/100" pets-aboard counter on
// the sign above the door, and the placeholder lift-off used by the launch cinematic.
// The sequencing (who walks where, cameras, UI) lives in arkCinematics.ts.
//
// ark01.glb ships a single "OpenDoor" clip (closed -> open, 0.5 s). A STOPPED
// clip shows the door open in the explorer, so the clip is never stopped: it is
// always playing, frozen on its first frame (closed) by a near-zero speed. To
// open it runs forward and holds its last frame; to close it runs backward,
// then is re-pinned to frame 0. The door only opens for a pet boarding the ship.

import { engine, Animator, Entity, TextShape, Transform, VisibilityComponent } from '@dcl/sdk/ecs'
import { Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'
import { clientState } from './state'

const ARK_DOOR_CLIP = 'OpenDoor'
const ARK_DOOR_SPEED = 1 // playback speed (raise to open/close faster)
const ARK_DOOR_CLIP_S = 0.5 // OpenDoor's length in ark01.glb
const ARK_DOOR_SETTLE_S = 0.15 // slack after the reverse play before pinning it closed
// Freezes the clip while keeping it "playing". Not exactly 0 so no explorer can
// read it as "unset"; at this rate the door would take days to creep open.
const ARK_DOOR_HOLD_SPEED = 0.000001

// The counter sits on `textshape_base`, an unrendered plane placed in Creator
// Hub above the door: its position + rotation anchor the text, its scale is the
// area the text has to fit in (so it is NOT inherited — that would squash it).
const COUNTER_FONT_SIZE = 5 // in-world TextShape size (see scoreboard.ts — not metres)
const COUNTER_FACE_OUT = 0.03 // metres off the plane, so it never z-fights a surface behind it
const COUNTER_DROP = 0.07 // metres below the plane's centre: the glyphs sit high in their line box
// A TextShape shows through from both sides and reads correctly from its own -Z
// side (mirrored from +Z). The plane's +Z points out of the ship, so the text is
// turned 180° to read from there.

let ark: Entity | null = null
let home: { position: Vector3; rotation: Quaternion } | null = null
let counter: Entity | null = null
let counterHidden = false
let doorOpen = false
let closingLeft = 0 // seconds until a closing door is pinned shut (0 = not closing)
let repinNextFrame = false // second half of pinArkDoorClosed's stop -> play edge

function doorState(e: Entity) {
  return Animator.getMutable(e).states.find((s) => s.clip === ARK_DOOR_CLIP)
}

/** Run the clip forward (open) or backward (close) from where it is. loop:false
 *  holds the last frame it reaches, so an open door stays open. */
function playArkDoor(e: Entity, open: boolean): void {
  const st = doorState(e)
  if (!st) return
  st.loop = false
  st.shouldReset = false // already playing (pinned at frame 0 / held open): just change direction
  st.speed = open ? ARK_DOOR_SPEED : -ARK_DOOR_SPEED
  st.playing = true
  repinNextFrame = false
  closingLeft = open ? 0 : ARK_DOOR_CLIP_S / ARK_DOOR_SPEED + ARK_DOOR_SETTLE_S
}

/** Snap the door to the clip's first frame (closed) and freeze it there. A reset
 *  only happens on a stopped -> playing edge, so this stops the clip now and
 *  the system restarts it, frozen, on the next frame. */
function pinArkDoorClosed(e: Entity): void {
  const st = doorState(e)
  if (!st) return
  st.playing = false
  repinNextFrame = true
}

function finishPinArkDoorClosed(e: Entity): void {
  repinNextFrame = false
  const st = doorState(e)
  if (!st) return
  st.loop = false
  st.speed = ARK_DOOR_HOLD_SPEED
  st.shouldReset = true
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

/** Build the counter on the Creator Hub anchor (null until it has loaded). */
function makeCounter(): Entity | null {
  const base = engine.getEntityOrNullByName(EntityNames.textshape_base)
  if (!base || !Transform.has(base)) return null
  const t = Transform.get(base)
  const rotation = Quaternion.multiply(t.rotation, Quaternion.fromEulerDegrees(0, 180, 0))
  const out = Vector3.rotate(Vector3.create(0, -COUNTER_DROP, COUNTER_FACE_OUT), t.rotation)
  const e = engine.addEntity()
  Transform.create(e, { position: Vector3.add(t.position, out), rotation })
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
  engine.addSystem((dt: number) => {
    if (!ark) {
      const e = engine.getEntityOrNullByName(EntityNames.ark01_glb)
      if (!e || !Transform.has(e)) return // composite not loaded yet — try again next frame
      ark = e
      const t = Transform.get(e)
      home = { position: Vector3.clone(t.position), rotation: Quaternion.create(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w) }
      // Attach the Animator to the GLB entity, playing but frozen on frame 0 (door closed).
      Animator.createOrReplace(e, {
        states: [{ clip: ARK_DOOR_CLIP, playing: true, loop: false, speed: ARK_DOOR_HOLD_SPEED, shouldReset: true }]
      })
    }
    if (!counter) counter = makeCounter()

    if (repinNextFrame) {
      finishPinArkDoorClosed(ark)
    } else if (closingLeft > 0) {
      closingLeft -= dt
      if (closingLeft <= 0 && !doorOpen) pinArkDoorClosed(ark)
    }

    if (counter) {
      const s = clientState.ark.status
      const text = counterHidden ? '' : `${s.donated}/${s.goal}`
      if (TextShape.get(counter).text !== text) TextShape.getMutable(counter).text = text
    }
  })
}
