// The Caretaker's own companion: a Legendary (Golden) cross with a PEPITO body
// and a FLUFLITO head, hovering beside the Caretaker like a familiar. Purely
// decorative — no interaction, no server state, no roster. It just floats, idles
// and sways so it reads as the Caretaker's flying pet.

import { engine, Transform, GltfContainer, Animator, ColliderLayer, pointerEventsSystem, InputAction } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { clipForSpecies, modelForSpecies } from '../shared/config'
import { applyCreatureSkin } from './creatureSkins'
import { openLegendaryCreatureDialog } from './ui/dialog'

// pepito_fluflito.glb = PepitoArmature body + Fluflito head (see creatureSkins
// SKIN_NODES). Its clips ride the Pepito rig (Pepito_Idle, …).
const SPECIES = 'pepito_fluflito'
const RARITY = 'legendary' as const // -> basecolorGold skin (the "Golden" look)

// Hover anchor: on the Caretaker's own line (same x=153.5) and off to its side
// (offset along z), ~1 m off the floor (y=0.5) so it clearly floats — so it reads
// as standing beside the Caretaker rather than in front of it.
const ANCHOR = Vector3.create(153.5, 1.5, 246.0)
const BASE_YAW = 90 // face the same way as the Caretaker (toward the player)
const SCALE = 2.24 // adult size: ADULT stage 1.4 × family scaleForSpecies 1.6
const WING_SPEED = 1 // wing-flap playback speed (lower = slower, calmer flap)

const BOB_AMPLITUDE = 0.14 // metres up/down
const BOB_PERIOD_S = 2.6 // one full bob cycle
const SWAY_DEG = 16 // gentle yaw sway amplitude
const SWAY_PERIOD_S = 5.0

export function setupCaretakerPet(): void {
  const e = engine.addEntity()
  Transform.create(e, { position: Vector3.create(ANCHOR.x, ANCHOR.y, ANCHOR.z), scale: Vector3.create(SCALE, SCALE, SCALE), rotation: Quaternion.fromEulerDegrees(0, BASE_YAW, 0) })
  // POINTER-only collider: clickable (opens the Caretaker's tease dialog) but it
  // never blocks the player's movement.
  GltfContainer.createOrReplace(e, { src: modelForSpecies(SPECIES), visibleMeshesCollisionMask: ColliderLayer.CL_POINTER, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
  pointerEventsSystem.onPointerDown(
    { entity: e, opts: { button: InputAction.IA_POINTER, hoverText: 'Examine', maxDistance: 16, showHighlight: true } },
    () => openLegendaryCreatureDialog()
  )
  // Play WALK, not idle: for this winged cross the walk clip is what flaps the
  // wings — so it reads as hovering/flying in place (it stays put; only the bob +
  // sway below move it). ONE state only: listing every clip (each at weight 1)
  // let the non-playing clips' bind pose bleed in and fight the flap, which looked
  // like the animation restarting. A single looping state plays clean.
  const flap = clipForSpecies(SPECIES, 'walk')
  Animator.createOrReplace(e, { states: [{ clip: flap, playing: true, loop: true, speed: WING_SPEED, weight: 1 }] })
  applyCreatureSkin(e, SPECIES, RARITY) // gold

  // Float + sway (the wing-flap clip animates the body; this adds the drift).
  let t = 0
  engine.addSystem((dt: number) => {
    t += dt
    const tr = Transform.getMutable(e)
    tr.position.y = ANCHOR.y + Math.sin((t / BOB_PERIOD_S) * Math.PI * 2) * BOB_AMPLITUDE
    const yaw = BASE_YAW + Math.sin((t / SWAY_PERIOD_S) * Math.PI * 2) * SWAY_DEG
    tr.rotation = Quaternion.fromEulerDegrees(0, yaw, 0)
  })
}
