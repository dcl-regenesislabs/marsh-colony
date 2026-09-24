// Reusable "spinning light rays" highlight: a camera-facing plane with the
// starburst texture that turns slowly and breathes a little. Used behind the
// cure bottle (cureFx.ts) and behind a newly hatched pet (pet.ts).
//
// assets/images/starburst.png is very faint (max alpha ~20%), so
// starburst_glow.png is a whiter, ~3x more opaque copy of it; BURST_TINT colors it.
// It is a billboarded parent with the plane as a spinning child, so the rays
// always face the camera and the spin happens in the screen plane.

import { Billboard, BillboardMode, engine, Entity, Material, MaterialTransparencyMode, MeshRenderer, Transform } from '@dcl/sdk/ecs'
import { Color3, Color4, Quaternion, Vector3 } from '@dcl/sdk/math'

const BURST_TEXTURE = 'assets/images/starburst_glow.png'
const BURST_ASPECT = 835 / 658 // image width / height
const BURST_SPIN_DEG_PER_S = 55
const BURST_PULSE = 0.06
const BURST_TINT = Color3.create(0.85, 1, 0.55)

export type Starburst = { root: Entity; plane: Entity }

/** Create a hidden starburst whose plane is `size` metres tall. */
export function createStarburst(size: number): Starburst {
  const root = engine.addEntity()
  const plane = engine.addEntity()
  const texture = Material.Texture.Common({ src: BURST_TEXTURE })
  Transform.createOrReplace(root, { position: Vector3.Zero(), scale: Vector3.Zero() })
  Billboard.createOrReplace(root, { billboardMode: BillboardMode.BM_ALL })
  Transform.createOrReplace(plane, { parent: root, scale: Vector3.create(size * BURST_ASPECT, size, 1) })
  MeshRenderer.setPlane(plane)
  Material.setPbrMaterial(plane, {
    texture,
    alphaTexture: texture,
    emissiveTexture: texture,
    emissiveColor: BURST_TINT,
    emissiveIntensity: 1.4,
    albedoColor: Color4.create(BURST_TINT.r, BURST_TINT.g, BURST_TINT.b, 1),
    roughness: 1,
    metallic: 0,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND
  })
  return { root, plane }
}

/** Place and animate the rays. `grow` is 0..1 (0 = hidden, already eased and
 * including any fade-out by the caller); `clock` is the caller's running time in
 * seconds, which drives the spin and pulse. The rays sit `behind` metres from
 * `center` along `away` (a unit vector from the camera towards the subject), so
 * the subject stays in front of them. */
export function updateStarburst(burst: Starburst, center: Vector3, away: Vector3, behind: number, grow: number, clock: number): void {
  const root = Transform.getMutable(burst.root)
  root.position = Vector3.create(center.x + away.x * behind, center.y + away.y * behind, center.z + away.z * behind)
  root.scale = Vector3.scale(Vector3.One(), Math.max(0, grow) * (1 + BURST_PULSE * Math.sin(clock * 3)))
  Transform.getMutable(burst.plane).rotation = Quaternion.fromEulerDegrees(0, 0, clock * BURST_SPIN_DEG_PER_S)
}

export function hideStarburst(burst: Starburst): void {
  Transform.getMutable(burst.root).scale = Vector3.Zero()
}

/** Remove the entities entirely (for one-off users that don't keep it around). */
export function removeStarburst(burst: Starburst): void {
  engine.removeEntity(burst.plane)
  engine.removeEntity(burst.root)
}
