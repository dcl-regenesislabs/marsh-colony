// Shared private-focus volumes. AvatarModifierArea hides other player avatars
// here; remote pets use the same volumes so the two layers stay in sync.

import { engine, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'

export const PRIVATE_AVATAR_AREAS = [
  // Matches the 9m Feed errand arrival radius.
  { entityName: EntityNames.tree_glb, area: Vector3.create(18, 6, 18) },
  { entityName: EntityNames.HomeDome01_glb, area: Vector3.create(12, 6, 12) }
] as const

/** True when a world position is inside one of the avatar-hide volumes. */
export function isInsidePrivateAvatarArea(position: Vector3): boolean {
  for (const { entityName, area } of PRIVATE_AVATAR_AREAS) {
    const anchor = engine.getEntityOrNullByName(entityName)
    const transform = anchor === null ? null : Transform.getOrNull(anchor)
    if (!transform) continue

    if (
      Math.abs(position.x - transform.position.x) <= area.x / 2 &&
      Math.abs(position.y - transform.position.y) <= area.y / 2 &&
      Math.abs(position.z - transform.position.z) <= area.z / 2
    ) {
      return true
    }
  }
  return false
}
