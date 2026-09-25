// DEBUG cheat asset: a small glowing totem in the care area. Clicking it runs the
// grow-to-Adult hack that used to live on the "4" key — it maxes the active pet's
// size + level so breeding can be tested (see state.ts debugGrowAdultLocal, which
// mirrors optimistically then tells the authoritative server).
//
// NOT for production: the totem is a plain box visible to everyone. Remove the
// setupDebugGrow() call in setup.ts (or this module) to ship without it.

import { engine, Transform, MeshRenderer, MeshCollider, Material, TextShape, Billboard, BillboardMode, ColliderLayer, pointerEventsSystem, InputAction } from '@dcl/sdk/ecs'
import { Vector3, Color3, Color4 } from '@dcl/sdk/math'
import { clientState, debugGrowAdultLocal, pushToast } from './state'

// Near the spawn, in the camera's initial forward view, so it's easy to find.
const POS = Vector3.create(172, 1.5, 240)

export function setupDebugGrow(): void {
  const e = engine.addEntity()
  Transform.create(e, { position: POS, scale: Vector3.create(0.8, 0.8, 0.8) })
  MeshRenderer.setBox(e)
  MeshCollider.setBox(e, ColliderLayer.CL_POINTER) // clickable, never blocks movement
  Material.setPbrMaterial(e, {
    albedoColor: Color4.create(0.55, 0.2, 0.95, 1),
    emissiveColor: Color3.create(0.5, 0.15, 0.95),
    emissiveIntensity: 2
  })

  // Floating caption so it's findable as the cheat.
  const label = engine.addEntity()
  Transform.create(label, { position: Vector3.create(POS.x, POS.y + 0.55, POS.z) })
  TextShape.create(label, { text: 'GROW\n(cheat)', fontSize: 2, textColor: Color4.White(), outlineColor: Color4.Black(), outlineWidth: 0.2 })
  Billboard.create(label, { billboardMode: BillboardMode.BM_Y })

  pointerEventsSystem.onPointerDown(
    { entity: e, opts: { button: InputAction.IA_POINTER, hoverText: 'DEBUG: Grow to Adult', maxDistance: 16 } },
    () => {
      if (!clientState.activePet) {
        pushToast('DEBUG: no active pet to grow')
        return
      }
      debugGrowAdultLocal()
      pushToast('DEBUG: pet grown to Adult (Lv 5) — breeding unlocked')
    }
  )
}
