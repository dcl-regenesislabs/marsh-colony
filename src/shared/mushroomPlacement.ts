import { engine, Entity, getWorldPosition, Transform } from '@dcl/sdk/ecs'
import { HAPPY_HOUR } from './happyHour'

export const mushroomPlacements = new Map<number, {
  entity: Entity
  position: { x: number; y: number; z: number }
}>()

/** Actual Creator Hub mushrooms, in a stable slot order on server and client.
 * Never invent fallback coordinates or remove the authored model/transform. */
export function resolveMushroomPositions(): void {
  mushroomPlacements.clear()
  for (let slot = 0; slot < HAPPY_HOUR.entityNames.length; slot++) {
    const entity = engine.getEntityOrNullByName(HAPPY_HOUR.entityNames[slot])
    if (entity === null || !Transform.has(entity)) {
      console.log('[Mushroom event] Missing Creator Hub entity:', HAPPY_HOUR.entityNames[slot])
      continue
    }
    const p = getWorldPosition(engine, entity)
    mushroomPlacements.set(slot, { entity, position: { x: p.x, y: p.y, z: p.z } })
  }
}
