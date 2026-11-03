// Shared rotating rays for tutorial and event mushrooms. Each mushroom owns
// its own effect so five event pickups can animate independently.
import { engine, Entity, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { createStarburst, hideStarburst, removeStarburst, Starburst, updateStarburst } from './starburst'

export function createMushroomGlow() {
  let rays: Starburst | null = null
  let clock = 0
  return {
    update(dt: number, visible: boolean, base: Vector3): void {
      if (!visible) { if (rays) hideStarburst(rays); return }
      if (!rays) rays = createStarburst(1.5)
      clock += dt
      const center = Vector3.create(base.x, base.y + 0.35, base.z)
      let away = Vector3.create(0, 0, 1)
      if (Transform.has(engine.CameraEntity)) {
        const d = Vector3.subtract(center, Transform.get(engine.CameraEntity).position)
        if (Vector3.length(d) > 0.001) away = Vector3.normalize(d)
      }
      updateStarburst(rays, center, away, 0.3, 1, clock)
    },
    dispose(): void {
      if (rays) removeStarburst(rays)
      rays = null
    }
  }
}

const tutorialGlow = createMushroomGlow()
export function showMushroomGlow(dt: number, visible: boolean, _mushroom: Entity, base: Vector3, _baseScale: Vector3): void {
  tutorialGlow.update(dt, visible, base)
}
