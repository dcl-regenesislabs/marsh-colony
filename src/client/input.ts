// Clickable scene objects + the care-action QUEUE. Care actions don't fire
// instantly: clicking enqueues them, and the pet performs ONE at a time —
// walk to the object, do the animation for a beat, then a short rest before
// the next. This stops the pet from teleport-spamming between stations.

import { engine, pointerEventsSystem, inputSystem, InputAction, PointerEventType } from '@dcl/sdk/ecs'
import { EntityNames } from '../../assets/scene/entity-names'
import type { CareAction } from '../shared/types'
import { formatLockCountdown, type PetClip } from '../shared/config'
import { actionObjectPosition } from './objects'
import { isBusy, sendPetTo, canQueueCareAction } from './pet'
import { applyCareLocal, canPlayNow, sleepLockLeft } from './sim'
import { startFeedTask } from './feed'
import { startFruitGame } from './fruitGame'
import { actions, clientState, debugGrowAdultLocal, pushToast, hasPendingHatchling } from './state'
import { ui } from './ui'

const ACTION_CLIP: Record<CareAction, PetClip> = {
  feed: 'eat',
  clean: 'gesture-positive',
  sleep: 'idle',
  play: 'dance'
}

const MAX_QUEUE = 4
const REST_AFTER_ACTION_MS = 1500 // pause between consecutive care actions

const queue: CareAction[] = []
let restUntil = 0
let prevBusy = false

export function queueLength(): number {
  return queue.length
}
export function careActive(): boolean {
  return isBusy() || queue.length > 0
}

/** Enqueue a care action (does not run immediately). */
export function triggerCare(action: CareAction): void {
  if (!clientState.activePet) {
    pushToast('Adopt a pet first!')
    ui.openAdopt()
    return
  }
  if (!canQueueCareAction()) {
    const lockLeft = sleepLockLeft()
    pushToast(
      hasPendingHatchling()
        ? 'Keep or discard your new pet first!'
        : lockLeft > 0
          ? `Your pet is fast asleep — ${formatLockCountdown(lockLeft)} left.`
          : clientState.activePet.sleeping
            ? 'Your pet is asleep!'
            : // The Feed errand leaves the player walking the world, so the
              // in-world Bath/Sleep hotspots are still clickable — name the
              // thing that's blocking, and how to get out of it.
              clientState.feedTask.active
              ? 'Finish the tree errand or tap BACK first!'
              : 'Your pet is busy right now!'
    )
    return
  }
  // Play is energy-gated (see config's Play section): refuse the errand up front
  // instead of walking the pet over to do nothing.
  if (action === 'play' && !canPlayNow()) {
    pushToast(`${clientState.activePet.name} is too tired to play — it needs to sleep.`)
    return
  }
  if (queue.length >= MAX_QUEUE) {
    pushToast('Your pet is busy — wait a moment!')
    return
  }
  queue.push(action)
}

function startCare(action: CareAction): void {
  const dest = actionObjectPosition(action)
  const onBed = action === 'sleep'
  sendPetTo(
    dest,
    () => {
      // Optimistic local effect. It can still be refused on arrival (the energy
      // gate / sleep lock may have closed during the walk) — the server applies
      // the same rules, so don't send an action our own mirror just rejected.
      if (applyCareLocal(action, onBed)) actions.care(action, onBed)
    },
    ACTION_CLIP[action]
  )
}

function setupCareQueue(): void {
  engine.addSystem(() => {
    const now = Date.now()
    const busy = isBusy()
    // When an action just finished, enforce a short rest before the next.
    if (prevBusy && !busy) restUntil = now + REST_AFTER_ACTION_MS
    prevBusy = busy

    if (queue.length > 0 && !busy && now >= restUntil) {
      const next = queue.shift()!
      startCare(next)
    }
  })
}

// DEBUG hotkeys. NOTE: DCL exposes only number keys 1-4 (IA_ACTION_3..6);
// there is no key "5".
function setupDebugHotkeys(): void {
  engine.addSystem(() => {
    // "1": toggle the carried-egg hand calibration panel (pet.ts's debugEgg*,
    // issue #178) — only actually shows while an egg is being carried. Used
    // to be the skybox height-teleport shortcut; that's gone now, freeing the
    // key up.
    if (inputSystem.isTriggered(InputAction.IA_ACTION_3, PointerEventType.PET_DOWN)) {
      clientState.eggCalibPanelOpen = !clientState.eggCalibPanelOpen
      pushToast(clientState.eggCalibPanelOpen ? 'DEBUG: egg calib panel ON' : 'DEBUG: egg calib panel OFF')
    }
    // "2": jump straight into the Feed tree minigame, skipping the walk-to-tree
    // errand — for iterating on the minigame itself without the walk each time.
    if (inputSystem.isTriggered(InputAction.IA_ACTION_4, PointerEventType.PET_DOWN)) {
      if (!clientState.activePet) {
        pushToast('DEBUG: no active pet to feed')
        return
      }
      startFruitGame(clientState.activePet.id)
      pushToast('DEBUG: fruit minigame started')
    }
    // "3": toggle the fruit-game camera calibration panel (fruitGame.ts's
    // debugCam*) — shows while the minigame is active, +/- buttons per axis.
    if (inputSystem.isTriggered(InputAction.IA_ACTION_5, PointerEventType.PET_DOWN)) {
      clientState.debugCamPanelOpen = !clientState.debugCamPanelOpen
      pushToast(clientState.debugCamPanelOpen ? 'DEBUG: cam panel ON' : 'DEBUG: cam panel OFF')
    }
    // "4": grow the active pet to Adult + Lv5 (unlock breeding).
    if (inputSystem.isTriggered(InputAction.IA_ACTION_6, PointerEventType.PET_DOWN)) {
      if (!clientState.activePet) {
        pushToast('DEBUG: no active pet to grow')
        return
      }
      debugGrowAdultLocal()
      pushToast('DEBUG: pet grown to Adult (Lv 5) — breeding unlocked')
    }
  })
}

function onClick(name: string, hoverText: string, cb: () => void): void {
  const ent = engine.getEntityOrNullByName(name)
  if (!ent) {
    console.log('[Client] entity not found:', name)
    return
  }
  pointerEventsSystem.onPointerDown({ entity: ent, opts: { button: InputAction.IA_POINTER, hoverText, maxDistance: 16 } }, cb)
}

export function setupInput(): void {
  // Feed is no longer a walk-to-the-bowl care action — it starts the tree errand
  // (client/feed.ts): arrow to the tree, click it there, then the feeding game.
  onClick(EntityNames.PetFeeder_glb, 'Feed', () => startFeedTask())
  onClick(EntityNames.PetPool_glb, 'Bath', () => triggerCare('clean'))
  onClick(EntityNames.PetBed_glb, 'Sleep', () => triggerCare('sleep'))
  // Old play action (pet walks to the ball) is suspended — Play now throws a
  // meteorite forward (see play.ts, wired to the Play button in ui.tsx).
  // onClick(EntityNames.Ball, 'Play', () => triggerCare('play'))
  // Caretaker click is handled in caretaker.ts (click collider, not the raw GLTF).
  // Shop is suspended for now — the object stays in the scene but isn't clickable.
  setupCareQueue()
  setupDebugHotkeys()
}
