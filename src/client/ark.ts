// The Ark's dome door opens and closes on a loop. ark01.glb ships a single
// "OpenDoor" clip (closed -> open), so "close" is simply that clip played in
// reverse (negative speed) from the held-open pose. The door toggles every
// ARK_CYCLE_S seconds: open, hold, close, hold, repeat.

import { engine, Animator, Entity } from '@dcl/sdk/ecs'
import { EntityNames } from '../../assets/scene/entity-names'

const ARK_DOOR_CLIP = 'OpenDoor'
const ARK_DOOR_SPEED = 1 // playback speed (raise to open/close faster)
const ARK_CYCLE_S = 5 // seconds the door holds each state before toggling

let installed = false
let doorOpen = false
let timer = 0

/** Drive the single OpenDoor clip forward (open) or backward (close). loop:false
 *  freezes it on the last frame it reaches, so the door holds open/closed. */
function playArkDoor(ark: Entity, open: boolean): void {
  const st = Animator.getMutable(ark).states.find((s) => s.clip === ARK_DOOR_CLIP)
  if (!st) return
  st.loop = false
  st.speed = open ? ARK_DOOR_SPEED : -ARK_DOOR_SPEED
  st.shouldReset = open // open: restart from frame 0; close: run backward from the held-open pose
  st.playing = true
}

export function setupArk(): void {
  engine.addSystem((dt: number) => {
    const ark = engine.getEntityOrNullByName(EntityNames.ark01_glb)
    if (!ark) return // composite not loaded yet — try again next frame

    if (!installed) {
      // Attach the Animator to the GLB entity, paused at frame 0 (door closed).
      Animator.createOrReplace(ark, {
        states: [{ clip: ARK_DOOR_CLIP, playing: false, loop: false, speed: ARK_DOOR_SPEED, shouldReset: true }]
      })
      installed = true
      timer = 0
      doorOpen = false
      return
    }

    timer += dt
    if (timer >= ARK_CYCLE_S) {
      timer = 0
      doorOpen = !doorOpen
      playArkDoor(ark, doorOpen)
    }
  })
}
