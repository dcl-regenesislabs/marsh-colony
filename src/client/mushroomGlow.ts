// First session: make the grow mushroom easy to spot in the woods.
// - a soft light beam rising from it, visible over the trees from afar
//   (it fades out as you get close so it never blocks the view);
// - the same spinning light rays used behind the cure bottle and new hatchlings;
// - a warm point light that pulses on the ground around it;
// - the mushroom itself breathes a little.
// firstSession.ts drives it: showMushroomGlow() while the mushroom is out.

import { engine, Entity, LightSource, Material, MaterialTransparencyMode, MeshRenderer, Transform } from '@dcl/sdk/ecs'
import { Color3, Color4, Vector3 } from '@dcl/sdk/math'
import { createStarburst, hideStarburst, Starburst, updateStarburst } from './starburst'

const GLOW_TINT = Color3.create(0.85, 1, 0.55) // same lime as the cure/hatch rays
const RAYS_SIZE = 1.5
const RAYS_HEIGHT = 0.35 // centre of the rays above the mushroom's base
const RAYS_BEHIND = 0.3
const BEAM_HEIGHT = 12
const BEAM_RADIUS = 0.35
const BEAM_ALPHA = 0.28
/** The beam is fully visible beyond FAR and gone within NEAR (metres, flat). */
const BEAM_FADE_FAR = 9
const BEAM_FADE_NEAR = 4
const LIGHT_INTENSITY = 900
const LIGHT_RANGE = 5
const BREATHE = 0.06

let rays: Starburst | null = null
let beam: Entity | null = null
let light: Entity | null = null
let clock = 0
let shown = false
let beamAlpha = -1

function beamMaterial(alpha: number): void {
  if (beam === null) return
  Material.setPbrMaterial(beam, {
    albedoColor: Color4.create(GLOW_TINT.r, GLOW_TINT.g, GLOW_TINT.b, alpha),
    emissiveColor: GLOW_TINT,
    emissiveIntensity: 1.2 * (alpha / BEAM_ALPHA),
    roughness: 1,
    metallic: 0,
    castShadows: false,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND
  })
}

function ensure(): void {
  if (rays === null) rays = createStarburst(RAYS_SIZE)
  if (beam === null) {
    beam = engine.addEntity()
    Transform.create(beam, { scale: Vector3.Zero() })
    MeshRenderer.setCylinder(beam, BEAM_RADIUS, BEAM_RADIUS * 0.4) // tapers upward
    beamMaterial(BEAM_ALPHA)
    beamAlpha = BEAM_ALPHA
  }
  if (light === null) {
    light = engine.addEntity()
    Transform.create(light, { position: Vector3.Zero() })
    LightSource.create(light, {
      type: LightSource.Type.Point({}),
      color: GLOW_TINT,
      intensity: LIGHT_INTENSITY,
      range: LIGHT_RANGE,
      shadow: false,
      active: false
    })
  }
}

/** Glow around the mushroom at `base` (its ground position), or hide it.
 *  `mushroom` gets the breathing scale on top of its `baseScale`. */
export function showMushroomGlow(dt: number, visible: boolean, mushroom: Entity, base: Vector3, baseScale: Vector3): void {
  if (!visible) {
    if (shown) {
      shown = false
      if (rays) hideStarburst(rays)
      if (beam !== null) Transform.getMutable(beam).scale = Vector3.Zero()
      if (light !== null) LightSource.getMutable(light).active = false
    }
    return
  }
  ensure()
  shown = true
  clock += dt
  const pulse = 0.5 + 0.5 * Math.sin(clock * 2.6)

  // Rays behind the mushroom, facing the camera.
  const center = Vector3.create(base.x, base.y + RAYS_HEIGHT, base.z)
  let away = Vector3.create(0, 0, 1)
  let flatDist = Infinity
  if (Transform.has(engine.CameraEntity)) {
    const cam = Transform.get(engine.CameraEntity).position
    const d = Vector3.subtract(center, cam)
    if (Vector3.length(d) > 0.001) away = Vector3.normalize(d)
  }
  if (Transform.has(engine.PlayerEntity)) {
    const pp = Transform.get(engine.PlayerEntity).position
    flatDist = Math.hypot(pp.x - base.x, pp.z - base.z)
  }
  if (rays) updateStarburst(rays, center, away, RAYS_BEHIND, 1, clock)

  // Beam: a beacon from afar, fades out up close.
  if (beam !== null) {
    const t = Math.max(0, Math.min(1, (flatDist - BEAM_FADE_NEAR) / (BEAM_FADE_FAR - BEAM_FADE_NEAR)))
    const alpha = Math.round(BEAM_ALPHA * t * (0.8 + 0.2 * pulse) * 50) / 50 // quantised: fewer material writes
    const bt = Transform.getMutable(beam)
    bt.position = Vector3.create(base.x, base.y + BEAM_HEIGHT / 2, base.z)
    bt.scale = alpha > 0 ? Vector3.create(1, BEAM_HEIGHT, 1) : Vector3.Zero()
    if (alpha !== beamAlpha && alpha > 0) {
      beamAlpha = alpha
      beamMaterial(alpha)
    }
  }

  // Warm light pooling on the ground around it.
  if (light !== null) {
    Transform.getMutable(light).position = Vector3.create(base.x, base.y + 0.6, base.z)
    const l = LightSource.getMutable(light)
    l.active = true
    l.intensity = LIGHT_INTENSITY * (0.6 + 0.4 * pulse)
  }

  // The mushroom breathes.
  Transform.getMutable(mushroom).scale = Vector3.scale(baseScale, 1 + BREATHE * Math.sin(clock * 2.6))
}
