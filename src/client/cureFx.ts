// Visuals for the cure scene (cureCelebration.ts owns the timeline): the opened
// PotionCure bottle hovering over the pet, tipping over, and green drops falling
// from its mouth. Drops are pooled native spheres, NOT a ParticleSystem — the
// mobile explorer ignores that component, and spheres also let us know exactly
// when a drop touches the pet.

import { Billboard, BillboardMode, ColliderLayer, engine, Entity, GltfContainer, Material, MaterialTransparencyMode, MeshRenderer, Transform, VisibilityComponent } from '@dcl/sdk/ecs'
import { Color3, Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { POTION_CURE_MODEL } from './sicknessProps'

const NO_COLLISION = { visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE }

// PotionCure.glb is only ~0.28m tall with its pivot at the base, so it is scaled
// up to read from the camera and parented under an anchor placed at its middle:
// tipping it then pivots around its center instead of swinging it off the pet.
const BOTTLE_SCALE = 2.4
const BOTTLE_CENTER_Y = 0.1035 // model space: base at -0.039, mouth at 0.246
const BOTTLE_MOUTH_Y = 0.1427 // mouth height above that center
const BOTTLE_TILT_DEG = -115 // negative = leans to screen-left (positive leans right)
// The bottle sits this far to screen-right of the pet's center, so that once it
// leans left its mouth (and the drops' leftward drift) ends up over the pet.
const BOTTLE_SHIFT_RIGHT = 0.6
// While pouring it doesn't hold still: it rocks between slightly different angles
// (two out-of-phase sines, so it never repeats exactly) and every so often gives
// a quick shake, as if tapping out the last drops.
const POUR_ROCK = 0.09 // fraction of the full tilt it swings either way
const POUR_ROCK_SPEED = 3.3 // rad/s
const POUR_SHAKE_DEG = 5
const POUR_SHAKE_FREQ = 42 // rad/s of the rattle itself
const POUR_SHAKE_PERIOD = 5.5 // rad/s: how often a shake burst comes round (~1.1s)
const POUR_SHAKE_LIFT = 0.03 // little hop on each burst, metres
const BOTTLE_BOB_HEIGHT = 0.04
const BOTTLE_BOB_SPEED = 2.4
// Cartoon entrance: it drops in from above and bounces, spins once, wobbles as
// it settles, and its scale overshoots with squash-and-stretch.
const APPEAR_DROP_IN = 0.9 // starts this far above its hover point
const APPEAR_SPIN_DEG = 360
const APPEAR_WOBBLE_DEG = 16
const APPEAR_WOBBLE_CYCLES = 3
const APPEAR_STRETCH = 0.5 // how much the elastic overshoot stretches it tall / squeezes it thin

// Spinning light rays behind the bottle to make it pop. assets/images/starburst.png
// is very faint (max alpha ~20%), so starburst_glow.png is a whiter, ~3x more opaque
// copy of it; the tint below colors it.
const BURST_TEXTURE = 'assets/images/starburst_glow.png'
const BURST_ASPECT = 835 / 658 // image width / height
const BURST_SIZE = 1.6 // world height of the plane, metres
const BURST_SPIN_DEG_PER_S = 55
const BURST_LEAVE_SPEEDUP = 2.5 // the rays shrink this many times faster than the bottle, so they vanish first
const BURST_PULSE = 0.06
const BURST_BEHIND = 0.25 // pushed this far away from the camera so the bottle stays in front
const BURST_TINT = Color3.create(0.85, 1, 0.55)

const DROP_POOL_SIZE = 18
const DROP_GRAVITY = 9
const DROP_SIZE_MIN = 0.05
const DROP_SIZE_MAX = 0.09
const DROP_STRETCH = 1.5 // taller than wide, so a falling drop reads as a drop
const DROP_SPLASH_S = 0.16
const DROP_SPLASH_SPREAD = 1.9
const DROP_COLOR = Color4.create(0.3, 0.95, 0.4, 0.92)
const DROP_GLOW = Color3.create(0.15, 1, 0.35)

type Drop = { entity: Entity; active: boolean; pos: Vector3; vel: Vector3; size: number; splashT: number }

let anchor: Entity | null = null
let bottle: Entity | null = null
let burst: Entity | null = null // billboarded parent, follows the bottle
let burstPlane: Entity | null = null // its spinning child
let burstAway = Vector3.Zero() // unit vector from the camera towards the bottle
let burstTexture: ReturnType<typeof Material.Texture.Common> | null = null
let drops: Drop[] = []
let hoverPos = Vector3.Zero()
let faceRotation = Quaternion.Identity()
let sideDir = Vector3.create(1, 0, 0)
let hitY = 0
let bottleClock = 0

function easeOutBack(t: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

/** 0..1 envelope of the current shake burst (0 between bursts). */
function shakeEnvelope(): number {
  return Math.pow(Math.max(0, Math.sin(bottleClock * POUR_SHAKE_PERIOD)), 3)
}

/** How hard the bottle is shaking right now, 0..1 — the pour speeds up with it. */
export function pourBoost(): number {
  return shakeEnvelope()
}

function easeOutElastic(t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1
}

function easeOutBounce(t: number): number {
  const n = 7.5625
  const d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

function ensureEntities(): void {
  if (!anchor) {
    anchor = engine.addEntity()
    bottle = engine.addEntity()
    Transform.createOrReplace(anchor, { position: Vector3.Zero(), scale: Vector3.Zero() })
    Transform.createOrReplace(bottle, { parent: anchor, position: Vector3.create(0, -BOTTLE_CENTER_Y, 0) })
    GltfContainer.createOrReplace(bottle, { src: POTION_CURE_MODEL, ...NO_COLLISION })
    VisibilityComponent.createOrReplace(anchor, { visible: false })
  }
  if (!burst) {
    burst = engine.addEntity()
    burstPlane = engine.addEntity()
    burstTexture = Material.Texture.Common({ src: BURST_TEXTURE })
    Transform.createOrReplace(burst, { position: Vector3.Zero(), scale: Vector3.Zero() })
    Billboard.createOrReplace(burst, { billboardMode: BillboardMode.BM_ALL })
    Transform.createOrReplace(burstPlane, { parent: burst, scale: Vector3.create(BURST_SIZE * BURST_ASPECT, BURST_SIZE, 1) })
    MeshRenderer.setPlane(burstPlane)
    Material.setPbrMaterial(burstPlane, {
      texture: burstTexture,
      alphaTexture: burstTexture,
      emissiveTexture: burstTexture,
      emissiveColor: BURST_TINT,
      emissiveIntensity: 1.4,
      albedoColor: Color4.create(BURST_TINT.r, BURST_TINT.g, BURST_TINT.b, 1),
      roughness: 1,
      metallic: 0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND
    })
  }
  while (drops.length < DROP_POOL_SIZE) {
    const entity = engine.addEntity()
    Transform.createOrReplace(entity, { position: Vector3.Zero(), scale: Vector3.Zero() })
    MeshRenderer.setSphere(entity)
    Material.setPbrMaterial(entity, {
      albedoColor: DROP_COLOR,
      emissiveColor: DROP_GLOW,
      emissiveIntensity: 1.6,
      roughness: 0.2,
      metallic: 0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND
    })
    VisibilityComponent.createOrReplace(entity, { visible: false })
    drops.push({ entity, active: false, pos: Vector3.Zero(), vel: Vector3.Zero(), size: 0, splashT: -1 })
  }
}

/** Prepare the scene: `hover` is where the bottle floats, `camPos` is the shot
 * camera (the bottle faces it so its tip reads side-on), `dropHitY` is the world
 * height at which a drop counts as touching the pet. */
export function startCureFx(hover: Vector3, camPos: Vector3, dropHitY: number): void {
  ensureEntities()
  // Screen-right of the shot (up x view direction), so the shift follows the camera.
  const view = Vector3.normalize(Vector3.create(hover.x - camPos.x, 0, hover.z - camPos.z))
  hoverPos = Vector3.create(hover.x + view.z * BOTTLE_SHIFT_RIGHT, hover.y, hover.z - view.x * BOTTLE_SHIFT_RIGHT)
  hitY = dropHitY
  bottleClock = 0
  burstAway = view
  faceRotation = Quaternion.fromLookAt(hoverPos, camPos)
  // Which way the bottle leans: the mouth's horizontal offset at full tilt.
  const mouth = Vector3.rotate(Vector3.create(0, BOTTLE_MOUTH_Y * BOTTLE_SCALE, 0), tiltRotation(1))
  const flat = Vector3.create(mouth.x, 0, mouth.z)
  sideDir = Vector3.length(flat) > 0.001 ? Vector3.normalize(flat) : Vector3.create(1, 0, 0)
  setBottle(0, 0)
}

function tiltRotation(tilt: number): Quaternion {
  return Quaternion.multiply(faceRotation, Quaternion.fromEulerDegrees(0, 0, BOTTLE_TILT_DEG * tilt))
}

/** All three are 0..1. `appear` plays the bouncy entrance, `tilt` leans it from
 * upright to pouring, `leave` shrinks it away at the end. */
export function setBottle(appear: number, tilt: number, leave = 0, dt = 0): void {
  if (!anchor) return
  bottleClock += dt
  const a = Math.min(1, Math.max(0, appear))
  const l = Math.min(1, Math.max(0, leave))
  const visible = a > 0.001 && l < 0.999
  VisibilityComponent.getMutable(anchor).visible = visible
  const t = Transform.getMutable(anchor)
  if (!visible) {
    t.scale = Vector3.Zero()
    if (burst) Transform.getMutable(burst).scale = Vector3.Zero()
    return
  }
  const bob = Math.sin(bottleClock * BOTTLE_BOB_SPEED) * BOTTLE_BOB_HEIGHT
  const dropIn = (1 - easeOutBounce(a)) * APPEAR_DROP_IN
  const spin = APPEAR_SPIN_DEG * (1 - easeOutCubic(a))
  const wobble = APPEAR_WOBBLE_DEG * (1 - a) * Math.sin(a * APPEAR_WOBBLE_CYCLES * 2 * Math.PI)

  // Tips over with a little overshoot (only on the way in), then keeps moving
  // while it pours. `pouring` fades the rock and shake in and out with the tilt.
  const base = Math.min(1, Math.max(0, tilt))
  const tipped = l > 0 ? base : easeOutBack(base)
  const pouring = Math.min(1, Math.max(0, (base - 0.6) / 0.4))
  const rock = (Math.sin(bottleClock * POUR_ROCK_SPEED) * 0.6 + Math.sin(bottleClock * POUR_ROCK_SPEED * 1.9 + 1) * 0.4) * POUR_ROCK
  const shake = shakeEnvelope() * pouring
  const shakeDeg = Math.sin(bottleClock * POUR_SHAKE_FREQ) * POUR_SHAKE_DEG * shake
  const tiltDeg = BOTTLE_TILT_DEG * (tipped + rock * pouring) + shakeDeg
  t.position = Vector3.create(hoverPos.x, hoverPos.y + bob + dropIn + shake * POUR_SHAKE_LIFT, hoverPos.z)
  t.rotation = Quaternion.multiply(
    Quaternion.multiply(faceRotation, Quaternion.fromEulerDegrees(0, spin, wobble)),
    Quaternion.fromEulerDegrees(0, 0, tiltDeg)
  )

  // Elastic overshoot; the deviation from 1 stretches it tall while it is over-size
  // and squeezes it fat while it is under, like a rubber toy.
  const grow = easeOutElastic(a)
  const dev = grow - 1
  const shrink = 1 - l * l
  const tall = Math.max(0, 1 + dev * APPEAR_STRETCH)
  const wide = Math.max(0, 1 - dev * APPEAR_STRETCH * 0.6)
  t.scale = Vector3.scale(Vector3.create(wide, tall, wide), BOTTLE_SCALE * Math.max(0, grow) * shrink)
  updateBurst(t.position, a, l)
}

/** The rays fade in a beat after the bottle lands its first bounce, spin,
 * breathe a little, and shrink away quicker than the bottle does. */
function updateBurst(bottlePos: Vector3, appear: number, leave: number): void {
  if (!burst || !burstPlane) return
  const grow = easeOutCubic(Math.min(1, Math.max(0, (appear - 0.3) / 0.7)))
  const pulse = 1 + BURST_PULSE * Math.sin(bottleClock * 3)
  const gone = Math.min(1, leave * BURST_LEAVE_SPEEDUP)
  const scale = grow * (1 - gone) * (1 - gone) * pulse
  const b = Transform.getMutable(burst)
  b.position = Vector3.create(bottlePos.x + burstAway.x * BURST_BEHIND, bottlePos.y + burstAway.y * BURST_BEHIND, bottlePos.z + burstAway.z * BURST_BEHIND)
  b.scale = Vector3.scale(Vector3.One(), scale)
  Transform.getMutable(burstPlane).rotation = Quaternion.fromEulerDegrees(0, 0, bottleClock * BURST_SPIN_DEG_PER_S)
}

/** Spawn one drop at the bottle's mouth, in the bottle's current pose. */
export function emitDrop(): void {
  if (!anchor) return
  const drop = drops.find((d) => !d.active)
  if (!drop) return
  const t = Transform.get(anchor)
  const mouth = Vector3.add(t.position, Vector3.rotate(Vector3.create(0, BOTTLE_MOUTH_Y * BOTTLE_SCALE, 0), t.rotation))
  const jitter = (): number => (Math.random() - 0.5) * 0.18
  drop.active = true
  drop.splashT = -1
  drop.size = DROP_SIZE_MIN + Math.random() * (DROP_SIZE_MAX - DROP_SIZE_MIN)
  drop.pos = Vector3.create(mouth.x + jitter() * 0.6, mouth.y, mouth.z + jitter() * 0.6)
  // Pours downhill (the way the bottle leans) with a little scatter.
  drop.vel = Vector3.create(
    sideDir.x * (0.35 + Math.random() * 0.3) + jitter(),
    -0.4,
    sideDir.z * (0.35 + Math.random() * 0.3) + jitter()
  )
  VisibilityComponent.getMutable(drop.entity).visible = true
}

/** Advance the drops. Returns how many touched the pet this frame. */
export function tickDrops(dt: number): number {
  let landed = 0
  for (const drop of drops) {
    if (!drop.active) continue
    const t = Transform.getMutable(drop.entity)
    if (drop.splashT >= 0) {
      // Squash flat and spread where it touched, then vanish.
      drop.splashT += dt
      const k = Math.min(1, drop.splashT / DROP_SPLASH_S)
      t.scale = Vector3.create(drop.size * (1 + (DROP_SPLASH_SPREAD - 1) * k), drop.size * (1 - k) * 0.6, drop.size * (1 + (DROP_SPLASH_SPREAD - 1) * k))
      if (k >= 1) hideDrop(drop)
      continue
    }
    drop.vel = Vector3.create(drop.vel.x, drop.vel.y - DROP_GRAVITY * dt, drop.vel.z)
    drop.pos = Vector3.add(drop.pos, Vector3.scale(drop.vel, dt))
    if (drop.pos.y <= hitY) {
      drop.pos = Vector3.create(drop.pos.x, hitY, drop.pos.z)
      drop.splashT = 0
      landed++
    }
    t.position = drop.pos
    t.scale = Vector3.create(drop.size, drop.size * DROP_STRETCH, drop.size)
  }
  return landed
}

function hideDrop(drop: Drop): void {
  drop.active = false
  drop.splashT = -1
  Transform.getMutable(drop.entity).scale = Vector3.Zero()
  VisibilityComponent.getMutable(drop.entity).visible = false
}

/** Put everything away. Entities are kept and reused by the next play. */
export function stopCureFx(): void {
  if (anchor) {
    VisibilityComponent.getMutable(anchor).visible = false
    Transform.getMutable(anchor).scale = Vector3.Zero()
  }
  if (burst) Transform.getMutable(burst).scale = Vector3.Zero()
  for (const drop of drops) hideDrop(drop)
}
