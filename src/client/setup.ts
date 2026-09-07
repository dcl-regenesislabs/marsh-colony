// Client bootstrap: seed a local player, register server handlers, run the
// local simulation, and request persisted state.
//
// INTENTIONAL: this is NOT playable offline. The loading gate in ui.tsx
// (Root -> LoadingGate, gated on clientState.serverReady) blocks all UI/input
// until the FIRST stateSnapshot answers requestState() below. It stays
// invisible for a normal (fast) connect; if the server never answers, a small
// "Still connecting..." message appears after a few seconds and the player is
// stuck there — there is no local-only fallback anymore. seedLocalPlayer()/
// simTick() still run so the data is ready the instant the gate lifts, but
// nothing is shown or usable before that.

import { engine, InputModifier } from '@dcl/sdk/ecs'
import { room } from '../shared/messages'
import type { LeaderboardEntry, PlayerSnapshot, PresenceEntry, SwapOfferPayload } from '../shared/types'
import { DEV_SKIP_SERVER_GATE, type SpinReward } from '../shared/config'
import { actions, applyPresence, applySnapshot, clientState, markServerAlive, pushToast, resolveMyAddress } from './state'
import { evaluateStreak, seedLocalPlayer, simTick } from './sim'
import { setupUi, ui } from './ui'
import { applyDefaultTouchControls } from './touchControls'
import { openCaretakerIntro } from './ui/dialog'
import { setupInput } from './input'
import { setupPetSystems, startCarryEgg } from './pet'
import { setupPlay } from './play'
import { setupMeteor } from './meteor'
import { setupSkybox } from './skybox'
import { setupMusic } from './music'
import { setupEggShake } from './eggShake'
import { setupPlantSway } from './plantSway'
import { setupCaretaker, startCaretakerIntroLock, endCaretakerIntroLock, isCaretakerIntroLocked } from './caretaker'
import { setupFeedTask } from './feed'
import { setupFruitGame } from './fruitGame'
import { setupPetSpeech } from './speech'
import { setupNav } from './nav'

let introTriggered = false
let firstSnapshotSeen = false // decide the "Choose Location!" modal on the FIRST snapshot only

function showIntro(): void {
  if (introTriggered) return
  introTriggered = true
  clientState.introShown = true
  // First run with no pet: drop the player at the spawn area facing the
  // Caretaker (deterministic every reload, not the native spawn point's
  // random-range + camera-only orientation) and freeze them there while the
  // Caretaker speaks. Once the dialog closes, release the freeze and go
  // straight into adopting — no further teleport, they stay right where they are.
  if (!clientState.activePet) {
    startCaretakerIntroLock()
    openCaretakerIntro(() => {
      endCaretakerIntroLock()
      ui.openAdopt()
    })
  }
}

function registerHandlers(): void {
  room.onMessage('stateSnapshot', (data) => {
    markServerAlive()
    clientState.serverReady = true // lifts the loading gate in ui.tsx (Root)
    try {
      const snap = JSON.parse(data.json) as PlayerSnapshot
      applySnapshot(snap)
      // Decide whether to show the intro on the FIRST snapshot ONLY, and only
      // here — this used to also be guessed from a timer (elapsed >= 2.5s) in case
      // the server was slow, but that guess could fire showIntro() BEFORE this
      // snapshot arrived and then get contradicted by it. Now that the loading
      // gate (clientState.serverReady) already blocks all UI until this snapshot
      // lands, there's no need to guess early — decide once, for real.
      if (!firstSnapshotSeen) {
        firstSnapshotSeen = true
        if (snap.activePet) {
          introTriggered = true // returning player already has a pet -> skip the tutorial
          // No "Choose Location" modal / teleport for returning players — they
          // just land wherever scene.json's spawn point puts them (currently
          // near the Caretaker, not the house; see nav.ts's door-pathing
          // comments if that ever needs to change back).
        } else {
          showIntro()
        }
      }
    } catch (e) {
      console.log('[Client] bad snapshot', e)
    }
  })

  room.onMessage('presence', (data) => {
    markServerAlive()
    try {
      applyPresence(JSON.parse(data.json) as PresenceEntry[])
    } catch (e) {
      console.log('[Client] bad presence', e)
    }
  })

  // Shared colony population — same number for every player.
  room.onMessage('colony', (data) => {
    markServerAlive()
    clientState.colonyPopulation = data.population
  })

  // Coins leaderboard — the response to our requestLeaderboard (panel open).
  room.onMessage('leaderboard', (data) => {
    markServerAlive()
    try {
      clientState.leaderboard = JSON.parse(data.json) as LeaderboardEntry[]
    } catch (e) {
      console.log('[Client] bad leaderboard', e)
    }
  })

  room.onMessage('notify', (data) => {
    markServerAlive()
    pushToast(data.message)
  })

  // Breeding result — the offspring is an egg (server hatchling). Carry it home
  // and hatch it, just like a fresh adoption; the rarity is the surprise inside.
  room.onMessage('breedResult', (data) => {
    markServerAlive()
    pushToast(`You bred a ${data.rarity.toUpperCase()} egg — carry it home!`)
    if (data.species) startCarryEgg(data.species, data.name, true)
  })

  // Incoming pet-swap offer — pop the Accept/Decline modal with the offered pet.
  room.onMessage('swapOffer', (data) => {
    markServerAlive()
    try {
      clientState.incomingSwap = JSON.parse(data.json) as SwapOfferPayload
    } catch (e) {
      console.log('[Client] bad swap offer', e)
    }
  })

  // Outcome of a swap we proposed.
  room.onMessage('swapResult', (data) => {
    markServerAlive()
    pushToast(data.message)
  })

  // Daily meteor: the server rolled and persisted it — show what we got.
  room.onMessage('meteorResult', (data) => {
    markServerAlive()
    try {
      const reward = JSON.parse(data.json) as SpinReward
      clientState.lastSpin = { reward, index: data.index, at: Date.now() }
      ui.openMeteorReward()
    } catch (e) {
      console.log('[Client] bad meteor result', e)
    }
  })

  room.onMessage('spinResult', (data) => {
    markServerAlive()
    try {
      const reward = JSON.parse(data.json) as SpinReward
      clientState.lastSpin = { reward, index: data.index, at: Date.now() }
    } catch (e) {
      console.log('[Client] bad spin result', e)
    }
  })
}

export function setupClient(): void {
  resolveMyAddress()
  seedLocalPlayer() // HUD renders immediately, no waiting on the network
  setupSkybox() // Mars ground + boundary colliders
  setupMusic() // background ambient track (jukebox: HUD button switches / mutes it)
  setupEggShake() // subtle constant tremble on the placed decor eggs
  setupPlantSway() // subtle wind sway on a random subset of the placed plants
  setupCaretaker() // click collider + Idle/Talk animation
  setupMeteor() // meteor reward drop (falls, settles, clickable)
  evaluateStreak() // advance / reset the 7-day login streak
  registerHandlers()
  setupUi()
  applyDefaultTouchControls()
  setupInput()
  setupPetSystems() // renders + simulates remote pets from server `presence`
  setupPlay() // Play action: throw an animated meteorite forward
  setupFruitGame() // fruit pool for the Feed minigame (feed.ts hands off to it on tree click)
  setupFeedTask() // Feed action: guide arrow to the composite tree, auto-starts the feeding game on arrival
  setupPetSpeech() // speech bubble over the pet — asks for what its stats need
  setupNav() // pet navigation: avoid building walls, use doors (WIP: coord capture)

  if (DEV_SKIP_SERVER_GATE) {
    // Bypass the loading gate entirely — no InputModifier freeze, no wait.
    clientState.serverReady = true
  }

  // Freeze the player (movement + camera input) while the loading gate is up —
  // ui.tsx only blocks pointer/UI, InputModifier is what stops the avatar from
  // walking off before the server has answered.
  if (!DEV_SKIP_SERVER_GATE) {
    InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
  }
  let inputFrozen = !DEV_SKIP_SERVER_GATE

  // Try to load persisted state from the server (retry until it answers).
  let sinceReq = 99
  let elapsed = 0
  if (!DEV_SKIP_SERVER_GATE) actions.requestState()
  engine.addSystem((dt: number) => {
    elapsed += dt
    simTick(dt) // local game simulation

    if (inputFrozen && clientState.serverReady) {
      inputFrozen = false
      // Don't unfreeze out from under the Caretaker intro lock — it's started
      // synchronously in the very same stateSnapshot handler that just flipped
      // serverReady, a few lines before this system tick runs.
      if (!isCaretakerIntroLocked()) InputModifier.deleteFrom(engine.PlayerEntity)
    }

    // Keep asking the server for our saved progress for a while.
    if (!DEV_SKIP_SERVER_GATE && elapsed < 30) {
      sinceReq += dt
      if (sinceReq >= 2) {
        sinceReq = 0
        resolveMyAddress()
        actions.requestState()
      }
    }

    // Daily reward is suspended for now — the meteor covers the daily drop.
  })

  console.log('[Client] MyDearPet client ready')
}
