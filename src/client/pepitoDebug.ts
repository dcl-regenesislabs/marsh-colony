// DEBUG (issue #148): live tuning of the circle Pepito flies in the cure chase.
//
// Draws the flight circle in the world (a ring of yellow dots plus a magenta
// pillar at its centre) and backs the on-screen panel in ui/pepitoDebug.tsx,
// whose +/- buttons edit pepitoChase.ts's `orbitTune` — so the circle can be
// moved, resized and raised while looking at it, with or without a chase running
// (Pepito follows the tuned values live during one). "Print" logs the numbers to
// paste back into ORBIT_DEFAULTS.
//
// NOT for production: flip PEPITO_DEBUG to false (or drop the setupPepitoDebug()
// call in setup.ts) to ship without the ring and the panel.

import { engine, Entity, Transform, MeshRenderer, Material, VisibilityComponent } from '@dcl/sdk/ecs'
import { Vector3, Color3, Color4 } from '@dcl/sdk/math'
import { clientState, pushToast } from './state'
import { ORBIT_DEFAULTS, orbitTune, orbitCenterNow, orbitRingPoint, refreshOrbitBase, startPepitoChase } from './pepitoChase'

export const PEPITO_DEBUG = false // flip to true to bring the flight-circle ring and tuning panel back

export const pepitoDebug = { showPath: true }

export type TuneKey = keyof typeof ORBIT_DEFAULTS
const MIN_VALUE: Record<TuneKey, number> = { offsetX: -100, offsetZ: -100, height: 1, radius: 1, period: 2 }

export function adjustOrbit(key: TuneKey, delta: number): void {
  orbitTune[key] = Math.max(MIN_VALUE[key], Math.round((orbitTune[key] + delta) * 100) / 100)
}

export function resetOrbit(): void {
  Object.assign(orbitTune, ORBIT_DEFAULTS)
}

export function printOrbit(): void {
  const c = orbitCenterNow()
  const line =
    `[Client] pepito orbit: offsetX=${orbitTune.offsetX} offsetZ=${orbitTune.offsetZ} height=${orbitTune.height} ` +
    `radius=${orbitTune.radius} period=${orbitTune.period} | centre world x=${c.x.toFixed(2)} z=${c.z.toFixed(2)}`
  console.log(line)
  pushToast('Pepito orbit printed to the console')
}

/** Skip the feed minigame: mark the active pet sick locally and start the chase. */
export function debugStartChase(): void {
  const s = clientState
  if (!s.activePet) {
    pushToast('DEBUG: no active pet')
    return
  }
  if (s.pepitoChase.active || s.sicknessErrand.active || s.feedGame.active || s.bathGame.active || s.fetch.active || s.dialog.open) {
    pushToast('DEBUG: finish what is running first')
    return
  }
  s.activePet.sick = true
  startPepitoChase()
}

const RING_DOTS = 40
const RING_DOT_SCALE = 0.22
const ring: Entity[] = []
let pillar: Entity | null = null
let ringVisible = false

function glow(e: Entity, r: number, g: number, b: number): void {
  Material.setPbrMaterial(e, {
    albedoColor: Color4.create(r, g, b, 1),
    emissiveColor: Color3.create(r, g, b),
    emissiveIntensity: 2
  })
}

function setRingVisible(visible: boolean): void {
  if (visible === ringVisible) return
  ringVisible = visible
  for (const e of ring) VisibilityComponent.createOrReplace(e, { visible })
  if (pillar) VisibilityComponent.createOrReplace(pillar, { visible })
}

export function setupPepitoDebug(): void {
  if (!PEPITO_DEBUG) return
  for (let i = 0; i < RING_DOTS; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: Vector3.create(0, -100, 0), scale: Vector3.create(RING_DOT_SCALE, RING_DOT_SCALE, RING_DOT_SCALE) })
    MeshRenderer.setSphere(e)
    glow(e, 1, 0.85, 0.1)
    VisibilityComponent.create(e, { visible: false })
    ring.push(e)
  }
  pillar = engine.addEntity()
  Transform.create(pillar, { position: Vector3.create(0, -100, 0), scale: Vector3.create(0.12, 1, 0.12) })
  MeshRenderer.setBox(pillar)
  glow(pillar, 1, 0.2, 0.9)
  VisibilityComponent.create(pillar, { visible: false })

  engine.addSystem(() => {
    if (!clientState.serverReady || !pepitoDebug.showPath) {
      setRingVisible(false)
      return
    }
    // The base midpoint is only refreshed by a running chase, so keep it current
    // while idle — the ring should sit where the next chase's circle will.
    if (!clientState.pepitoChase.active) refreshOrbitBase()
    for (let i = 0; i < RING_DOTS; i++) Transform.getMutable(ring[i]).position = orbitRingPoint((i / RING_DOTS) * Math.PI * 2)
    if (pillar) {
      const c = orbitCenterNow()
      const t = Transform.getMutable(pillar)
      t.position = Vector3.create(c.x, c.y + orbitTune.height / 2, c.z)
      t.scale = Vector3.create(0.12, orbitTune.height, 0.12)
    }
    setRingVisible(true)
  })
}
