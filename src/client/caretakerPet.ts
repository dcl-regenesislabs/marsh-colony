// The Caretaker's own companion: a Legendary (Golden) cross with a PEPITO body
// and a FLUFLITO head, hovering beside the Caretaker like a familiar. Purely
// decorative — no server state, no roster. It floats, plays its walk cycle and
// sways so it reads as the Caretaker's pet, and taps open a teaser dialog.

import { engine, Transform, GltfContainer, Animator, ColliderLayer, pointerEventsSystem, InputAction, type Entity } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'
import { clipForSpecies, modelForSpecies } from '../shared/config'
import { applyCreatureSkin } from './creatureSkins'
import { clientState } from './state'
import { canStartPetInteraction } from './pet'
import { openLegendaryCreatureDialog } from './ui/dialog'

// pepito_fluflito.glb = PepitoArmature body + Fluflito head (see creatureSkins
// SKIN_NODES). Its clips ride the Pepito rig (Pepito_Idle, Pepito_Walk, …).
const SPECIES = 'pepito_fluflito'
const RARITY = 'legendary' as const // -> basecolorGold skin (the "Golden" look)

// Placement is RELATIVE to the Caretaker's live transform (read once it loads),
// so it tracks the Caretaker if that's ever repositioned in Creator Hub instead
// of silently drifting off a hardcoded copy of its composite coords. OFFSET is in
// world space: 1 m up and 1.75 m to the Caretaker's side; the familiar inherits
// the Caretaker's facing.
const OFFSET = Vector3.create(0, 1.0, -1.75)
const SCALE = 2.24 // adult size: ADULT stage 1.4 × family scaleForSpecies 1.6
const WING_SPEED = 1 // walk-clip playback speed (lower = calmer motion)

const BOB_AMPLITUDE = 0.14 // metres up/down
const BOB_PERIOD_S = 2.6 // one full bob cycle
const SWAY_DEG = 16 // gentle yaw sway amplitude
const SWAY_PERIOD_S = 5.0
const TAU = Math.PI * 2

function spawnFamiliar(anchor: Vector3, baseRot: Quaternion): Entity {
  const e = engine.addEntity()
  Transform.create(e, { position: Vector3.create(anchor.x, anchor.y, anchor.z), scale: Vector3.create(SCALE, SCALE, SCALE), rotation: baseRot })
  // POINTER-only collider: clickable (opens the teaser dialog) but it never blocks
  // the player's movement.
  GltfContainer.createOrReplace(e, { src: modelForSpecies(SPECIES), visibleMeshesCollisionMask: ColliderLayer.CL_POINTER, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
  pointerEventsSystem.onPointerDown(
    { entity: e, opts: { button: InputAction.IA_POINTER, hoverText: 'Examine', maxDistance: 16, showHighlight: true } },
    () => {
      // GUARD: never open over another dialog or interaction. In particular the
      // first-boot intro dialog owns an onDone that unfreezes the player + opens
      // Adopt; openDialog replaces clientState.dialog wholesale, so opening ours
      // on top would drop that onDone and soft-lock the frozen, pet-less player.
      // dialog.open blocks that; canStartPetInteraction() also keeps it from
      // popping over feed/bath/petting/fetch/carry/sleep (mirrors world clicks).
      if (clientState.dialog.open || !canStartPetInteraction()) return
      openLegendaryCreatureDialog()
    }
  )
  // Play WALK, not idle: it's the liveliest clip (idle is nearly static), so the
  // creature reads as animated while it hovers. NB the rig is a ground walk cycle
  // (Head/Neck/Arms/Legs/Tail — there are no wing bones); played in the air over
  // the bob below, the limb motion passes for a hovering flutter. ONE state only:
  // listing every clip at weight 1 let the non-playing clips' bind pose bleed in
  // and fight the walk, which looked like the animation restarting.
  const flap = clipForSpecies(SPECIES, 'walk')
  Animator.createOrReplace(e, { states: [{ clip: flap, playing: true, loop: true, speed: WING_SPEED, weight: 1 }] })
  applyCreatureSkin(e, SPECIES, RARITY) // gold
  return e
}

export function setupCaretakerPet(): void {
  let e: Entity | null = null
  let anchor = Vector3.Zero()
  let baseRot = Quaternion.Identity()
  let t = 0
  engine.addSystem((dt: number) => {
    if (e === null) {
      // Wait for the Caretaker to load, then anchor to its live transform (once).
      const c = engine.getEntityOrNullByName(EntityNames.Caretaker_glb)
      if (!c || !Transform.has(c)) return
      const ct = Transform.get(c)
      anchor = Vector3.add(ct.position, OFFSET)
      baseRot = ct.rotation
      e = spawnFamiliar(anchor, baseRot)
      return
    }
    // Float + gentle sway (the walk clip animates the body; this adds the drift).
    t += dt
    const tr = Transform.getMutable(e)
    tr.position.y = anchor.y + Math.sin((t / BOB_PERIOD_S) * TAU) * BOB_AMPLITUDE
    tr.rotation = Quaternion.multiply(baseRot, Quaternion.fromEulerDegrees(0, Math.sin((t / SWAY_PERIOD_S) * TAU) * SWAY_DEG, 0))
  })
}
