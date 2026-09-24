// The pen's fence door swings open when the player walks up to it and closes
// again once they step back. Fencedoor01.glb ships a single "OpenDoor" clip
// (closed -> open), so "close" is that clip played in reverse — same trick as
// the Ark's dome door (see ark.ts). The door sits nested under Creator Hub's
// "penArea"/"penFenceArea" group entities, so its own Transform.position is
// local, not where it actually is in the scene — getWorldPosition resolves
// the full parent chain for us.

import { engine, Animator, Entity, Transform, getWorldPosition } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'

const DOOR_CLIP = 'OpenDoor'
const DOOR_SPEED = 1 // playback speed (raise to open/close faster)
// Hysteresis so the door doesn't flicker open/closed right at the edge of range.
const OPEN_RADIUS = 3.5 // metres: walk this close and it swings open
const CLOSE_RADIUS = 4.5 // metres: must back off this far before it closes again

let installed = false
let doorOpen = false
let doorWorldPos: Vector3 | null = null

function playerPos(): Vector3 {
  const t = Transform.getOrNull(engine.PlayerEntity)
  return t ? t.position : Vector3.Zero()
}

function distFlat(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dz * dz)
}

/** Drive the single OpenDoor clip forward (open) or backward (close). loop:false
 *  freezes it on the last frame it reaches, so the door holds open/closed. */
function playDoor(door: Entity, open: boolean): void {
  const st = Animator.getMutable(door).states.find((s) => s.clip === DOOR_CLIP)
  if (!st) return
  st.loop = false
  st.speed = open ? DOOR_SPEED : -DOOR_SPEED
  st.shouldReset = open // open: restart from frame 0; close: run backward from the held-open pose
  st.playing = true
}

export function setupPenDoor(): void {
  engine.addSystem(() => {
    const door = engine.getEntityOrNullByName(EntityNames.Fencedoor01_glb)
    if (!door || !Transform.has(door)) return // composite not loaded yet — try again next frame

    if (!installed) {
      Animator.createOrReplace(door, {
        states: [{ clip: DOOR_CLIP, playing: false, loop: false, speed: DOOR_SPEED, shouldReset: true }]
      })
      doorWorldPos = getWorldPosition(engine, door)
      installed = true
      doorOpen = false
      return
    }

    if (!doorWorldPos) return
    const dist = distFlat(playerPos(), doorWorldPos)
    if (!doorOpen && dist <= OPEN_RADIUS) {
      doorOpen = true
      playDoor(door, true)
    } else if (doorOpen && dist >= CLOSE_RADIUS) {
      doorOpen = false
      playDoor(door, false)
    }
  })
}
