// Feed task (new flow). Feeding no longer sends the pet walking to the bowl:
// pressing Feed starts a small errand for the PLAYER. The same ground arrow the
// egg carry uses (pet.ts showArrowTo/hideArrow) points at the tree placed in the
// Creator Hub composite (assets/scene/main.composite, entity "tree.glb"); walking
// within range of it hands off straight to the feeding mini-game (fruitGame.ts) —
// no click needed, it triggers on arrival.
//
// The errand OWNS the moment while it runs (clientState.feedTask): every other
// care action is gated on it (pet.ts canStartPetInteraction/canQueueCareAction)
// and the player gets a BACK button to drop it (ui.tsx FeedErrandOverlay). That
// pairing is what keeps the guide arrow honest — it can only ever belong to one
// flow, and it goes away the moment this one ends.

import { engine, Entity, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { hideArrow, showArrowTo, canStartPetInteraction, getEggPending } from './pet'
import { EntityNames } from '../../assets/scene/entity-names'
import { clientState, pushToast, hasPendingHatchling } from './state'
import { ui } from './ui'
import { startFruitGame } from './fruitGame'

const TREE_RADIUS = 9 // metres: how close you must be before the minigame auto-starts (fruitGame.ts's own arrival cam covers the last few metres of the walk-in)

/** The tree as placed in the composite — not a duplicate spawned in code. */
function getTree(): Entity | null {
  return engine.getEntityOrNullByName(EntityNames.tree_glb)
}

function playerPos(): Vector3 {
  const t = Transform.getOrNull(engine.PlayerEntity)
  return t ? t.position : Vector3.Zero()
}

function distFlat(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dz * dz)
}

/** Feed pressed: light up the guide arrow and send the player to the tree. */
export function startFeedTask(): void {
  if (!clientState.activePet) {
    pushToast('Adopt a pet first!')
    ui.openAdopt()
    return
  }
  // Checked BEFORE the shared gate: the errand blocks itself through
  // canStartPetInteraction() now, so without this the second press would report
  // a generic "your pet is busy" instead of pointing at the walk in progress.
  if (clientState.feedTask.active) {
    pushToast('Head to the tree — follow the arrow!')
    return
  }
  if (!canStartPetInteraction()) {
    pushToast(
      hasPendingHatchling()
        ? 'Keep or discard your new pet first!'
        : clientState.activePet.sleeping
          ? 'Your pet is asleep!'
          : 'Your pet is busy — wait a moment!'
    )
    return
  }
  const tree = getTree()
  if (!tree) {
    console.log('[Client] feed task: tree not found in scene')
    return
  }
  clientState.feedTask = { active: true, petId: clientState.activePet.id }
  showArrowTo(Transform.get(tree).position, 'feed')
  clientState.petPanelOpen = false // the panel covers the screen; the errand is out in the world
  pushToast('Follow the arrow to the tree!')
}

/** Drop the errand (arrow off). Used by the BACK button and by the guards below. */
export function cancelFeedTask(): void {
  if (!clientState.feedTask.active) return
  clientState.feedTask = { active: false, petId: '' }
  hideArrow('feed')
}

export function feedTaskActive(): boolean {
  return clientState.feedTask.active
}

export function setupFeedTask(): void {
  engine.addSystem(() => {
    const task = clientState.feedTask
    if (!task.active) return
    // Yield the shared guide arrow to a carry flow (egg / bath) or a pending
    // egg pickup: those also drive pet.ts's arrow, so if the player starts Feed
    // then one of those, the errand must bow out instead of fighting for it.
    if (clientState.carryEgg.active || clientState.carryPet.active || getEggPending()) {
      cancelFeedTask()
      return
    }
    // The errand belongs to the pet Feed was pressed for — if that pet is gone
    // or the player swapped to another one, the walk no longer means anything.
    if (!clientState.activePet || clientState.activePet.id !== task.petId) {
      cancelFeedTask()
      return
    }
    const tree = getTree()
    if (!tree) return
    const pos = Transform.get(tree).position
    showArrowTo(pos, 'feed') // re-assert each frame, same as the egg carry does
    if (distFlat(playerPos(), pos) <= TREE_RADIUS) {
      const petId = task.petId
      cancelFeedTask() // errand done — arrow off, the cinematic takes over from here
      startFruitGame(petId)
    }
  })
}
