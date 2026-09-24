// Runtime-owned props for the sickness errand. Keeping them out of the
// Creator Hub composite means this feature cannot accidentally overwrite scene
// decor when its branch is merged with main.

import { Animator, AssetLoad, ColliderLayer, engine, Entity, GltfContainer, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { SICKNESS_TABLE_POSITION } from '../shared/sickness'

const TABLE_MODEL = 'assets/Models/PotionTable.glb'
const POTION_MODEL = 'assets/Models/Potion01.glb'
export const POTION_CURE_MODEL = 'assets/Models/PotionCure/PotionCure.glb'

let potionTable: Entity | null = null
let potion: Entity | null = null
let propsPreloaded = false

function preloadSicknessProps(): void {
  if (propsPreloaded) return
  propsPreloaded = true
  // PotionTable is a 1.1 MB GLB. Warm it before the player reaches the
  // Caretaker so its texture/mesh upload cannot interrupt the cure cinematic.
  AssetLoad.create(engine.addEntity(), { assets: [TABLE_MODEL, POTION_MODEL, POTION_CURE_MODEL] })
}

export function getPotionTableEntity(): Entity | null {
  return potionTable && Transform.has(potionTable) ? potionTable : null
}

export function getPotionEntity(): Entity | null {
  return potion && Transform.has(potion) ? potion : null
}

/** Spawn the medicine-table set once, in its authored scene position. The
 * paused `idle` clip is the closed-cage pose exported from Blender. */
export function setupSicknessProps(): void {
  preloadSicknessProps()
  if (!potionTable) {
    potionTable = engine.addEntity()
    Transform.createOrReplace(potionTable, {
      position: Vector3.create(SICKNESS_TABLE_POSITION.x, SICKNESS_TABLE_POSITION.y, SICKNESS_TABLE_POSITION.z),
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
      position: Vector3.create(SICKNESS_TABLE_POSITION.x - 0.02001953125, 1.2277860641479492, SICKNESS_TABLE_POSITION.z - 0.00201416015625),
      scale: Vector3.One()
    })
    GltfContainer.createOrReplace(potion, {
      src: POTION_MODEL,
      visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
      invisibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
    })
  }
}
