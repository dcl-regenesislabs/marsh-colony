// Runtime-owned props for the sickness errand. Keeping them out of the
// Creator Hub composite means this feature cannot accidentally overwrite scene
// decor when its branch is merged with main.

import { Animator, ColliderLayer, engine, Entity, GltfContainer, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

const TABLE_MODEL = 'assets/Models/PotionTable.glb'
const POTION_MODEL = 'assets/Models/Potion01.glb'

let potionTable: Entity | null = null
let potion: Entity | null = null

export function getPotionTableEntity(): Entity | null {
  return potionTable && Transform.has(potionTable) ? potionTable : null
}

export function getPotionEntity(): Entity | null {
  return potion && Transform.has(potion) ? potion : null
}

/** Spawn the medicine-table set once, in its authored scene position. The
 * paused `idle` clip is the closed-cage pose exported from Blender. */
export function setupSicknessProps(): void {
  if (!potionTable) {
    potionTable = engine.addEntity()
    Transform.createOrReplace(potionTable, {
      position: Vector3.create(159.75, 0.4, 251.25),
      scale: Vector3.One()
    })
    GltfContainer.createOrReplace(potionTable, {
      src: TABLE_MODEL,
      visibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER,
      invisibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
    })
    Animator.createOrReplace(potionTable, {
      states: [
        { clip: 'idle', playing: true, weight: 1, speed: 0, loop: false, shouldReset: true },
        { clip: 'TableOpen', playing: false, weight: 1, speed: 1, loop: false, shouldReset: true }
      ]
    })
  }

  if (!potion) {
    potion = engine.addEntity()
    Transform.createOrReplace(potion, {
      position: Vector3.create(159.72998046875, 1.2277860641479492, 251.24798583984375),
      scale: Vector3.One()
    })
    GltfContainer.createOrReplace(potion, {
      src: POTION_MODEL,
      visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
      invisibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
    })
  }
}
