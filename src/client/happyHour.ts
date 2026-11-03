import { resolveMushroomPositions, mushroomPlacements } from '../shared/mushroomPlacement'
import { ColliderLayer, engine, GltfContainer, InputAction, MeshCollider, Transform, pointerEventsSystem, VisibilityComponent } from '@dcl/sdk/ecs'
import { HappyHourView, mushroomEventEligible } from '../shared/happyHour'
import { room } from '../shared/messages'
import { clientState, pushToast } from './state'
import { t, onLanguageChanged } from './i18n'
import { createMushroomGlow } from './mushroomGlow'
import { petStage } from '../shared/config'

let view: HappyHourView | null = null
let expires = 0
let receivedAt = 0
// Monotonic elapsed time is independent of the device calendar/timezone.
let elapsed = 0
function serverNow(): number { return (view?.serverNow ?? 0) + (elapsed - receivedAt) * 1000 }

export function receiveHappyHour(value: HappyHourView | null): void {
  view = value
  // Snapshots arrive every three seconds. Hide on lost server connection too.
  receivedAt = elapsed
  expires = elapsed + 10
}
export function happyHourActive(): boolean {
  return !!view && serverNow() < view.endsAt && elapsed < expires &&
    clientState.serverReady && !!clientState.player && !clientState.firstSession &&
    mushroomEventEligible(clientState.player)
}
export function happyHourStatus(): { remaining: number; refresh: number; available: number; endsAt: number } | null {
  if (!happyHourActive() || !view) return null
  const now = serverNow()
  const pending = Object.values(view.respawnsAt).filter(time => time > now && time < view!.endsAt)
  const nextRespawn = pending.length ? Math.min(...pending) : 0
  return { endsAt: view.endsAt, remaining: Math.max(0, view.endsAt - now),
    refresh: nextRespawn ? Math.max(0, nextRespawn - now) : 0,
    available: view.available.length }
}

export function setupHappyHour(): void {
  resolveMushroomPositions()
  const pickups = [...mushroomPlacements].map(([slot, { entity, position }]) => {
    // Keep the Creator Hub GLB, rotation, scale and elevation. A separate,
    // forgiving pointer-only box provides the mobile tap target.
    VisibilityComponent.createOrReplace(entity, { visible: false, propagateToChildren: true })
    const gltf = GltfContainer.getMutableOrNull(entity)
    if (gltf) {
      gltf.visibleMeshesCollisionMask = ColliderLayer.CL_NONE
      gltf.invisibleMeshesCollisionMask = ColliderLayer.CL_NONE
    }
    const hit = engine.addEntity()
    Transform.create(hit, { position: { x: position.x, y: position.y + 0.5, z: position.z },
      scale: { x: 1.5, y: 1.5, z: 1.5 } })
    const pickup = { slot, entity, position, hit, glow: createMushroomGlow(), visible: false }
    const register = () => {
      pointerEventsSystem.removeOnPointerDown(hit)
      pointerEventsSystem.onPointerDown({ entity: hit, opts: {
        button: InputAction.IA_POINTER, hoverText: t('happyHour.pick'), maxDistance: 4
      } }, () => {
        if (!happyHourActive() || !view || !view.available.includes(slot)) return
        const pet = clientState.activePet
        if (!pet) { pushToast(t('happyHour.selectPet')); return }
        if (petStage(pet.size) === 'ADULT') { pushToast(t('happyHour.adult')); return }
        room.send('pickHappyHour', { slot, wave: String(view.wave), petId: pet.id })
      })
    }
    register()
    onLanguageChanged(register)
    return pickup
  })
  engine.addSystem((dt: number) => {
    elapsed += Math.max(0, dt)
    const active = happyHourActive()
    for (const pickup of pickups) {
      const visible = active && !!view?.available.includes(pickup.slot)
      if (visible !== pickup.visible) {
        pickup.visible = visible
        VisibilityComponent.createOrReplace(pickup.entity, { visible, propagateToChildren: true })
        if (visible) MeshCollider.setBox(pickup.hit, ColliderLayer.CL_POINTER)
        else MeshCollider.deleteFrom(pickup.hit)
      }
      pickup.glow.update(dt, visible, pickup.position)
    }
  })
}
