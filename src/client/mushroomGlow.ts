// First session: make the grow mushroom easy to spot once you are near it,
// with the same spinning light rays used behind the cure bottle and new
// hatchlings. firstSession.ts drives it: showMushroomGlow() while the
// mushroom is out.

import { engine, Entity, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { createStarburst, hideStarburst, Starburst, updateStarburst } from './starburst'

const RAYS_SIZE = 1.5
const RAYS_HEIGHT = 0.35 // centre of the rays above the mushroom's base
const RAYS_BEHIND = 0.3

let rays: Starburst | null = null
let clock = 0
let shown = false

/** Rays behind the mushroom at `base` (its ground position), or hide them. */
export function showMushroomGlow(dt: number, visible: boolean, _mushroom: Entity, base: Vector3, _baseScale: Vector3): void {
  if (!visible) {
    if (shown) {
      shown = false
      if (rays) hideStarburst(rays)
    }
    return
  }
  if (rays === null) rays = createStarburst(RAYS_SIZE)
  shown = true
  clock += dt
  const center = Vector3.create(base.x, base.y + RAYS_HEIGHT, base.z)
  let away = Vector3.create(0, 0, 1)
  if (Transform.has(engine.CameraEntity)) {
    const d = Vector3.subtract(center, Transform.get(engine.CameraEntity).position)
    if (Vector3.length(d) > 0.001) away = Vector3.normalize(d)
  }
  updateStarburst(rays, center, away, RAYS_BEHIND, 1, clock)
}
