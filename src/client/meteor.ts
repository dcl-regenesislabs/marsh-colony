// Daily meteor reward — Mars reskin of the old "spin". A couple of seconds after
// the scene loads a meteor falls from the sky (landing anim) and settles into a
// struck idle. Clicking it cracks it open: the SERVER rolls, applies and persists
// the reward, then answers with `meteorResult` and the reward panel opens.
//
// The claimed day lives on PlayerData (server-owned), so a reload can't farm it.

import {
  engine,
  Transform,
  GltfContainer,
  Animator,
  VisibilityComponent,
  ColliderLayer,
  pointerEventsSystem,
  InputAction
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { dailyClaimable, meteorAvailable } from './sim'
import { showHint } from './state'
import { ui } from './ui'

const MODEL = 'assets/scene/Models/meteor_gold.glb'
const LANDING_CLIP = 'meteorLanding'
const IDLE_CLIP = 'meteorStruckIdle'
const FALL_DELAY = 60 // seconds after the scene loads before it falls
const LANDING_DURATION = 4.9 // seconds — from the GLB (meteorLanding ~4.83s)

// Where the meteor lands. Tune freely (meters; scene is 480x480, base 0,0).
const SPAWN = {
  position: Vector3.create(203.2, 0, 229.8),
  rotationDeg: Vector3.create(0, 0, 0),
  scale: Vector3.create(0.7, 0.7, 0.7)
}

export function setupMeteor(): void {
  // Wait for the first server snapshot before deciding whether to drop it — the
  // claimed day comes from the server, so spawning early could show a meteor
  // that was already collected today.
  const waitForState = (): void => {
    // meteorAvailable() is null until the first snapshot lands — use it only as a
    // "player state is ready" signal, then gate the drop on the daily streak.
    if (meteorAvailable() === null) return
    engine.removeSystem(waitForState)
    if (dailyClaimable()) spawnMeteor()
  }
  engine.addSystem(waitForState)
}

function spawnMeteor(): void {
  const meteor = engine.addEntity()
  Transform.create(meteor, {
    position: SPAWN.position,
    rotation: Quaternion.fromEulerDegrees(SPAWN.rotationDeg.x, SPAWN.rotationDeg.y, SPAWN.rotationDeg.z),
    scale: SPAWN.scale
  })
  GltfContainer.create(meteor, { src: MODEL, visibleMeshesCollisionMask: ColliderLayer.CL_POINTER })

  // Hidden until it starts falling — otherwise it would sit on the ground during
  // the delay before the landing animation kicks in.
  VisibilityComponent.create(meteor, { visible: false })

  Animator.create(meteor, {
    states: [
      { clip: LANDING_CLIP, playing: false, loop: false, shouldReset: true },
      { clip: IDLE_CLIP, playing: false, loop: true }
    ]
  })

  // Timeline: wait -> reveal + fall -> settle into idle, then retire the system.
  let t = 0
  let phase = 0 // 0 = waiting, 1 = falling
  const timeline = (dt: number): void => {
    t += dt
    if (phase === 0 && t >= FALL_DELAY) {
      phase = 1
      t = 0
      VisibilityComponent.getMutable(meteor).visible = true
      Animator.playSingleAnimation(meteor, LANDING_CLIP, true)
    } else if (phase === 1 && t >= LANDING_DURATION) {
      Animator.playSingleAnimation(meteor, IDLE_CLIP, false)
      showHint('meteor', 'Go explore the meteorite for daily rewards and surprises!', 'reward')
      engine.removeSystem(timeline) // settled — nothing left to drive
    }
  }
  engine.addSystem(timeline)

  // Click to crack it open. The server owns the roll, the payout and the daily
  // gate; the panel opens when `meteorResult` comes back.
  let collected = false
  pointerEventsSystem.onPointerDown(
    { entity: meteor, opts: { button: InputAction.IA_POINTER, hoverText: 'Explore', maxDistance: 12 } },
    () => {
      if (collected) return
      collected = true
      ui.openMeteorReward() // opens the daily-reward ladder (client streak)
      engine.removeSystem(timeline)
      engine.removeEntity(meteor)
    }
  )
}
