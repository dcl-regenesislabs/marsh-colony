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

const MODEL = 'assets/Models/newModels/meteor01.glb'
const LANDING_CLIP = 'asteroid_land' // meteor01's fall clip; after it plays we HOLD its last frame
const DISAPPEAR_CLIP = 'asteroid_disappear' // played on click, then the entity is removed
// NB: meteor01's 'asteroid_rest' idle is intentionally unused — its model shows a
// stray green prism, so instead of settling into rest we freeze on the landing pose.
const FALL_DELAY = 10 // seconds after the scene loads before it falls (short for testing)
const LANDING_CLIP_LENGTH = 0.92 // asteroid_land natural length (s), from the GLB
const LANDING_SPEED = 0.4 // playback speed of the fall: < 1 = slower (tune to taste)
const LANDING_DURATION = LANDING_CLIP_LENGTH / LANDING_SPEED // real fall time at that speed
const DISAPPEAR_DURATION = 0.95 // asteroid_disappear length (~0.92s) at speed 1, before removal

// Where the meteor lands. Tune freely (meters; scene is 480x480, base 0,0).
const SPAWN = {
  position: Vector3.create(203.2, 0, 229.8),
  rotationDeg: Vector3.create(0, 0, 0),
  scale: Vector3.create(3.5, 3.5, 3.5) // meteor01 is authored ~5× smaller than the old model
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
      { clip: LANDING_CLIP, playing: false, loop: false, shouldReset: true, speed: LANDING_SPEED },
      { clip: DISAPPEAR_CLIP, playing: false, loop: false, shouldReset: true }
    ]
  })

  // Timeline: wait -> reveal + fall -> HOLD the landing pose (no rest clip), then
  // retire the system. A non-looping clip freezes on its last frame, which is the
  // "landed" look we want (asteroid_rest is unusable — green prism).
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
      showHint('meteor', 'Go explore the meteorite for daily rewards and surprises!', 'reward')
      engine.removeSystem(timeline) // landed & holding its last frame — nothing left to drive
    }
  }
  engine.addSystem(timeline)

  // Click to crack it open: play the disappear animation, then remove the meteor and
  // open the reward panel (opening it AFTER the poof so the panel doesn't cover it).
  let collected = false
  pointerEventsSystem.onPointerDown(
    { entity: meteor, opts: { button: InputAction.IA_POINTER, hoverText: 'Explore', maxDistance: 12 } },
    () => {
      if (collected) return
      collected = true
      engine.removeSystem(timeline) // in case it's clicked before it finishes landing
      Animator.playSingleAnimation(meteor, DISAPPEAR_CLIP, true)
      let poofT = 0
      const finishDisappear = (dt: number): void => {
        poofT += dt
        if (poofT < DISAPPEAR_DURATION) return
        engine.removeSystem(finishDisappear)
        engine.removeEntity(meteor)
        ui.openMeteorReward() // opens the daily-reward ladder (client streak)
      }
      engine.addSystem(finishDisappear)
    }
  )
}
