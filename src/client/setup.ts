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

import { AvatarModifierArea, AvatarModifierType, engine, Entity, InputModifier, Transform } from '@dcl/sdk/ecs'
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
import { setupCaretakerPet } from './caretakerPet'
import { setupFeedTask } from './feed'
import { setupFruitGame } from './fruitGame'
import { setupBathGame } from './bathGame'
import { preloadCreatureTextures } from './creatureSkins'
import { preloadUiAssets } from './uiAssets'
import { setupPetEmotes } from './petEmotes'
import { setupNav } from './nav'
import { PRIVATE_AVATAR_AREAS } from './privacyAreas'

let introTriggered = false
let firstSnapshotSeen = false // decide the "Choose Location!" modal on the FIRST snapshot only
let avatarModifierAreasOwner = ''
const nameTagHideAreas = new Map<string, Entity>()

function setupAvatarModifierAreas(): void {
  const owner = resolveMyAddress()
  // Player identity can arrive a few frames after the scene. Do not install the
  // avatar-hide area unfiltered, because that would hide the local avatar too.
  if (!owner || owner === avatarModifierAreasOwner) return

  const avatarModifiers = [AvatarModifierType.AMT_HIDE_AVATARS]
  const nameTagModifiers = [AvatarModifierType.AMT_HIDE_NAMETAGS]
  for (const { entityName, area } of PRIVATE_AVATAR_AREAS) {
    const anchor = engine.getEntityOrNullByName(entityName)
    if (!anchor) continue

    // Keep this player's avatar visible, while a separate overlapping area
    // hides every player's nametag, including the local player's.
    AvatarModifierArea.createOrReplace(anchor, { area, modifiers: avatarModifiers, excludeIds: [owner] })

    const anchorTransform = Transform.getOrNull(anchor)
    if (!anchorTransform) continue
    let nameTagArea = nameTagHideAreas.get(entityName)
    if (!nameTagArea) {
      nameTagArea = engine.addEntity()
      nameTagHideAreas.set(entityName, nameTagArea)
    }
    Transform.createOrReplace(nameTagArea, {
      position: anchorTransform.position,
      rotation: anchorTransform.rotation
    })
    AvatarModifierArea.createOrReplace(nameTagArea, { area, modifiers: nameTagModifiers, excludeIds: [] })
  }

  avatarModifierAreasOwner = owner
}

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
    // Drives petEmotes.ts's heart reaction — no toast here, the floating
    // emote is the feedback.
    if (data.kind === 'treated') {
      clientState.lastTreatedAt = Date.now()
      return
    }
    pushToast(data.message, data.kind)
  })

  // Breeding result — the offspring is an egg (server hatchling). Carry it home
  // and hatch it, just like a fresh adoption; the rarity is the surprise inside.
  room.onMessage('breedResult', (data) => {
    markServerAlive()
    // No toast here — the server's 'breed' note already announced the rarity;
    // this message just kicks off the carry-egg-home flow.
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
  setupCaretakerPet() // Golden Pepito-body/Fluflito-head familiar hovering by the Caretaker
  setupMeteor() // meteor reward drop (falls, settles, clickable)
  evaluateStreak() // advance / reset the 7-day login streak
  registerHandlers()
  preloadUiAssets() // warm panel, icon, and minigame-control textures before the UI can appear
  setupUi()
  applyDefaultTouchControls()
  setupAvatarModifierAreas() // hide other players in the Feed tree and house focus areas
  setupInput()
  preloadCreatureTextures() // warm the creature-skin PNG cache so runtime skins don't pop in
  setupPetSystems() // renders + simulates remote pets from server `presence`
  setupPlay() // Play action: throw an animated meteorite forward
  setupFruitGame() // fruit pool for the Feed minigame (feed.ts hands off to it on tree click)
  setupBathGame() // bubble-bath minigame (pet.ts placePetAtStation hands off to it at the tub)
  setupFeedTask() // Feed action: guide arrow to the composite tree, auto-starts the feeding game on arrival
  setupPetEmotes() // floating PNG emote showing the pet's current need/mood — supersedes the text speech bubble (speech.ts, unwired but kept in case it's needed again) and the 4-icon mood bar
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

    // getPlayer() can be unavailable during initial scene setup. Once its ID
    // resolves, exclude this player from the house and Feed-game hide areas.
    setupAvatarModifierAreas()

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
