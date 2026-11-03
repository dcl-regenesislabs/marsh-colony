import { engine, Entity, getWorldPosition, Transform } from '@dcl/sdk/ecs'
import { HAPPY_HOUR } from './happyHour'

export const mushroomPlacements = new Map<number, {
  entity: Entity
  position: { x: number; y: number; z: number }
}>()

const missing = new Set<string>()

/** Actual Creator Hub mushrooms, in a stable slot order on server and client.
 * Never invent fallback coordinates or remove the authored model/transform. */
export function resolveMushroomPositions(): boolean {
  for (let slot = 0; slot < HAPPY_HOUR.entityNames.length; slot++) {
    const entity = engine.getEntityOrNullByName(HAPPY_HOUR.entityNames[slot])
    if (entity === null || !Transform.has(entity)) {
      const name = HAPPY_HOUR.entityNames[slot]
      if (!missing.has(name)) console.log('[Mushroom event] Missing Creator Hub entity; will retry:', name)
      missing.add(name)
      mushroomPlacements.delete(slot)
      continue
    }
    missing.delete(HAPPY_HOUR.entityNames[slot])
    const p = getWorldPosition(engine, entity)
    mushroomPlacements.set(slot, { entity, position: { x: p.x, y: p.y, z: p.z } })
  }
  return mushroomPlacements.size === HAPPY_HOUR.entityNames.length
}
