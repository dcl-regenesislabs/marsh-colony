// Shared private-focus volumes. AvatarModifierArea hides other player avatars
// here; remote pets use the same volumes so the two layers stay in sync.

import { engine, Entity, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'

export const PRIVATE_AVATAR_AREAS = [
  // Matches the 9m Feed errand arrival radius.
  { entityName: EntityNames.tree_glb, area: Vector3.create(18, 6, 18) },
  { entityName: EntityNames.HomeDome01_glb, area: Vector3.create(12, 6, 12) }
] as const

const cachedAreaAnchors = new Map<EntityNames, Entity>()

/** Resolve a static composite anchor once it has been created by the scene. */
export function getPrivateAvatarAreaAnchor(entityName: EntityNames): Entity | null {
  const cached = cachedAreaAnchors.get(entityName)
  if (cached !== undefined) return cached

  const anchor = engine.getEntityOrNullByName(entityName)
  if (anchor !== null) cachedAreaAnchors.set(entityName, anchor)
  return anchor
}

/** True when a world position is inside one of the avatar-hide volumes. */
export function isInsidePrivateAvatarArea(position: Vector3): boolean {
  for (const { entityName, area } of PRIVATE_AVATAR_AREAS) {
    const anchor = getPrivateAvatarAreaAnchor(entityName)
    const transform = anchor === null ? null : Transform.getOrNull(anchor)
    if (!transform) continue

    // AvatarModifierArea rotates its box with its anchor. Rotate the world
    // point by the inverse anchor rotation before testing the local box.
    const relative = Vector3.create(position.x - transform.position.x, position.y - transform.position.y, position.z - transform.position.z)
    const local = Vector3.rotate(relative, {
      x: -transform.rotation.x,
      y: -transform.rotation.y,
      z: -transform.rotation.z,
      w: transform.rotation.w
    })
    if (
      Math.abs(local.x) <= area.x / 2 &&
      Math.abs(local.y) <= area.y / 2 &&
      Math.abs(local.z) <= area.z / 2
    ) {
      return true
    }
  }
  return false
}
