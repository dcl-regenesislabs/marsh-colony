// Mobile-first HUD + panels for MyDearPet, modeled on the cozy-farm IO layout:
//  - TOP: player profile bar (Caretaker level + XP) -> taps to Goals
//  - TOP (when a pet is selected): pet stat bars + care actions
//  - BOTTOM: 3 big nav buttons (Pets / Inventory / Goals)
//  - SIDES: Spin + Shop (right), Whistle (left)
// Reads the client mirror of authoritative server state.

import ReactEcs, { ReactEcsRenderer, Label, ScreenInsetArea, UiEntity, Input } from '@dcl/sdk/react-ecs'
import { engine, InputAction } from '@dcl/sdk/ecs'
import * as Cfg from '../shared/config'
import type { CareAction, Rarity } from '../shared/types'
import { actions, clientState, discardHatchling, keepHatchling, pushToast, serverConnected, switchActivePet, hasPendingHatchling } from './state'
import {
  setFollow,
  startPetting,
  cancelPetting,
  petTap,
  hatchTap,
  startCarryEgg,
  beginHatchFromCarry,
  startCarryPet,
  placePetAtStation,
  cancelCarryPet,
  canStartPetInteraction
} from './pet'
import { startCharge, releaseCharge } from './play'
import { musicState, playSong, setMusicVolume, SONGS, type SongId, toggleMute } from './music'
import { triggerCare, careActive, queueLength } from './input'
import { cancelFeedTask, startFeedTask } from './feed'
import {
  cancelFruitGame,
  exitFeedResults,
  startCatchingCountdown,
  COUNTDOWN_S,
  DebugCamKey,
  debugCamAvailableKeys,
  debugCamLabel,
  debugCamValue,
  debugCamAdjust,
  debugCamToggleClosePreview,
  debugCamIsClosePreview,
  debugCamPrint
} from './fruitGame'
import { getBubbles, popBubble, startBathCountdown, exitBathResults, cancelBathGame, BUBBLE_GOAL, BATH_COUNTDOWN_S, type Bubble } from './bathGame'
import { buyItemLocal, buyPotionLocal, buySlotLocal, canPlayNow, claimStreak, dailyClaimable, dailyLadderDay, sleepLockLeft, spinLocal, streakClaimable, streakWeekDay, useItemLocal } from './sim'
import { sway, startAnimSystem, attentionPulse, fetchHintAlpha, fetchHintVisible } from './ui/anim'
import { C, Color, getUiRendererConfig, mobile, OutlineLabel, PanelShell, resolveRuntimePlatform, S, Sbtn, TactileButton } from './ui/theme'
import { DialogBox, openCaretakerIntro, openCaretakerTips, playerName } from './ui/dialog'
import { endCaretakerIntroLock } from './caretaker'
import { DebugBrowserBar, UI_DEBUG_MODE } from './ui/debugBrowser'

export type Panel = 'none' | 'adopt' | 'shop' | 'roster' | 'inventory' | 'spin' | 'goals' | 'daily' | 'meteor' | 'breedName' | 'jukebox' | 'leaderboard'
export type ShopTabId = 'food' | 'slots'

const uiState = {
  panel: 'none' as Panel,
  shopTab: 'food' as ShopTabId,
  adoptStep: 'pick' as 'pick' | 'name',
  adoptSpecies: Cfg.SPECIES[0],
  adoptName: '',
  // Breeding: partner pet chosen to cross with, and the name the player types for
  // the offspring (the server prefixes it "Gen-N ").
  breedPartnerId: '',
  breedName: '',
  // Spend a rarity potion on this breed? Reset every time the panel opens.
  breedUsePotion: false,
  // Roster page being viewed. Pet slots are unlimited, so the grid can hold more
  // cards than the modal fits and has to page through them.
  rosterPage: 0
}

export const ui = {
  openAdopt(): void {
    // One hatchling at a time: finish (keep/discard) the current one first.
    if (hasPendingHatchling()) {
      pushToast('Place or discard your current pet first.')
      return
    }
    uiState.panel = 'adopt'
    uiState.adoptStep = 'pick'
  },
  openShop(): void {
    uiState.panel = 'shop'
  },
  openRoster(): void {
    uiState.panel = 'roster'
    uiState.rosterPage = 0
  },
  openInventory(): void {
    uiState.panel = 'inventory'
  },
  openSpin(): void {
    uiState.panel = 'spin'
  },
  openGoals(): void {
    uiState.panel = 'goals'
  },
  openDaily(): void {
    uiState.panel = 'daily'
  },
  openMeteorReward(): void {
    uiState.panel = 'meteor'
  },
  openJukebox(): void {
    uiState.panel = 'jukebox'
  },
  openLeaderboard(): void {
    uiState.panel = 'leaderboard'
    actions.requestLeaderboard() // fetch fresh standings each time it opens
  },
  // Auto-open the daily reward only when the screen is idle (no clashing popup).
  tryAutoOpenDaily(): void {
    if (uiState.panel === 'none' && !clientState.dialog.open) uiState.panel = 'daily'
  },
  openCaretaker(): void {
    const p = clientState.player
    const hasFreeSlot = !!p && p.pets.length < p.petSlots
    if (!clientState.activePet) {
      // First adoption: intro dialog, then the picker — no teleport, the
      // player stays put (same as the automatic first-boot intro in setup.ts).
      // endCaretakerIntroLock() is a no-op if the intro-lock isn't active, so
      // this is also the escape hatch if this click ever races the lock.
      openCaretakerIntro(() => {
        endCaretakerIntroLock()
        ui.openAdopt()
      })
    } else if (hasFreeSlot) {
      // Already have a pet + a free unlocked slot: go straight to the picker.
      ui.openAdopt()
    } else {
      // Have a pet but no room: just the caretaker tips.
      openCaretakerTips()
    }
  },
  close(): void {
    uiState.panel = 'none'
    uiState.adoptName = '' // don't carry a half-typed name into the next adoption
  }
}

// DEBUG bridge for ui/debugBrowser.tsx — lets it force any panel/uiState field
// directly, bypassing ui.openX()'s guard conditions (e.g. openAdopt() blocks if
// a hatchling already exists). Not part of the public `ui` API above.
export function debugForcePanel(panel: Panel): void {
  uiState.panel = panel
}
export function debugSetUiState(patch: Partial<{ shopTab: ShopTabId; adoptStep: 'pick' | 'name'; breedUsePotion: boolean; rosterPage: number }>): void {
  Object.assign(uiState, patch)
}

// ---------------------------------------------------------------------------
// Top HUD bars — name+level, coins, colony pets count. Three separate pills
// using the hud.png sprites, laid out in a row. Tapping the name/level bar
// still opens Goals (same as the old combined ProfileBar).
// ---------------------------------------------------------------------------
function NameLevelBar(props: { height: number }) {
  const h = props.height
  const w = Math.round(h * BAR_NAME_ASPECT)
  const p = clientState.player
  if (!p) return <UiEntity uiTransform={{ width: w, height: h }} />
  const lvl = p.caretakerLevel
  const base = Cfg.xpForLevel(lvl)
  const next = Cfg.xpForLevel(lvl + 1)
  const frac = next > base ? Math.max(0, Math.min(1, (p.caretakerXp - base) / (next - base))) : 1
  // Level number sits directly over the sprite's own black circle (no extra
  // badge shape drawn on top of it) — box measured from the sheet, relative
  // to BAR_NAME_BOX's crop.
  const circleLeft = Math.round(w * 0.0474)
  const circleTop = Math.round(h * 0.1333)
  const circleW = Math.round(w * 0.1541)
  const circleH = Math.round(h * 0.6933)
  const textW = w - circleLeft - circleW - S(10)
  return (
    <UiEntity
      uiTransform={{ width: w, height: h, pointerFilter: 'block' }}
      uiBackground={{ texture: { src: HUD_SHEET }, textureMode: 'stretch', uvs: BAR_NAME_UVS }}
      onMouseDown={() => ui.openGoals()}
    >
      <Label
        value={`${lvl}`}
        fontSize={Math.round(Math.min(circleW, circleH) * 0.6)}
        color={PET_UI.white}
        textAlign="middle-center"
        uiTransform={{ positionType: 'absolute', position: { left: circleLeft, top: circleTop }, width: circleW, height: circleH }}
      />
      <UiEntity uiTransform={{ positionType: 'absolute', position: { left: circleLeft + circleW + S(10), top: 0 }, width: textW, height: h, flexDirection: 'column', justifyContent: 'center' }}>
        <Label value={`${playerName()}  ·  Lv ${lvl}`} fontSize={S(15)} color={PET_UI.ink} textAlign="middle-left" textWrap="nowrap" uiTransform={{ width: textW, height: S(18) }} />
        <UiEntity uiTransform={{ width: Math.round(textW * 0.55), height: S(10), borderRadius: S(5), margin: { top: S(3) } }} uiBackground={{ color: LOC.tile }}>
          <UiEntity uiTransform={{ width: `${Math.round(frac * 100)}%`, height: '100%', borderRadius: S(5) }} uiBackground={{ color: C.gold }} />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

function CoinsBar(props: { height: number }) {
  const h = props.height
  const w = Math.round(h * BAR_COIN_ASPECT)
  const p = clientState.player
  if (!p) return <UiEntity uiTransform={{ width: w, height: h }} />
  return (
    <UiEntity uiTransform={{ width: w, height: h }} uiBackground={{ texture: { src: HUD_SHEET }, textureMode: 'stretch', uvs: BAR_COIN_UVS }}>
      <Label
        value={`${Math.floor(p.currency)}`}
        fontSize={S(24)}
        color={PET_UI.ink}
        textAlign="middle-right"
        uiTransform={{ positionType: 'absolute', position: { right: S(14), top: 0 }, width: Math.round(w * 0.5), height: h }}
      />
    </UiEntity>
  )
}

// The shared Mars population and the milestone we're all building toward.
// Broadcast by the server, so every player sees the same number.
function PetsCountBar(props: { height: number }) {
  const h = props.height
  const w = Math.round(h * BAR_PETS_ASPECT)
  const pop = clientState.colonyPopulation
  const goal = Cfg.COLONY_GOAL
  return (
    <UiEntity uiTransform={{ width: w, height: h }} uiBackground={{ texture: { src: HUD_SHEET }, textureMode: 'stretch', uvs: BAR_PETS_UVS }}>
      <Label
        value={`${pop} / ${goal} pets`}
        fontSize={S(22)}
        color={PET_UI.ink}
        textAlign="middle-right"
        uiTransform={{ positionType: 'absolute', position: { right: S(16), top: 0 }, width: Math.round(w * 0.65), height: h }}
      />
    </UiEntity>
  )
}

function TopBars() {
  const h = S(58)
  const gap = S(10)
  const w1 = Math.round(h * BAR_NAME_ASPECT)
  const w2 = Math.round(h * BAR_COIN_ASPECT)
  const w3 = Math.round(h * BAR_PETS_ASPECT)
  const iconSize = h // music/trophy badges are square (1:1) in the sheet
  // Same gate the old floating Music/Leaderboard buttons enforced (and
  // BottomNav still enforces today): hidden during full-screen flows that own
  // the whole screen and while a dialog is open, so tapping them can't stack
  // the Jukebox/Leaderboard panel on top of an active fetch/NPC dialog/etc.
  const showIcons =
    !clientState.dialog.open &&
    !clientState.fetch.active &&
    !clientState.carryEgg.active &&
    !clientState.carryPet.active &&
    !clientState.hatch.active
  const iconsW = gap + iconSize + gap + iconSize
  const totalW = w1 + gap + w2 + gap + w3 + (showIcons ? iconsW : 0)
  const rightShift = S(40) // nudged off-center — plenty of clearance either side of this row
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: mobile() ? S(46) : S(10), left: '50%' }, margin: { left: -totalW / 2 + rightShift }, width: totalW, height: h, flexDirection: 'row', alignItems: 'center', pointerFilter: 'none' }}>
      <NameLevelBar height={h} />
      <UiEntity uiTransform={{ width: gap, height: h }} />
      <CoinsBar height={h} />
      <UiEntity uiTransform={{ width: gap, height: h }} />
      <PetsCountBar height={h} />
      {showIcons ? (
        <UiEntity uiTransform={{ width: iconsW, height: h, flexDirection: 'row', alignItems: 'center' }}>
          <UiEntity uiTransform={{ width: gap, height: h }} />
          <TactileButton id="hud_music" label="" texture={HUD_SHEET} uvs={HUD_MUSIC_UVS} width={iconSize} height={iconSize} onClick={() => ui.openJukebox()} />
          <UiEntity uiTransform={{ width: gap, height: h }} />
          <TactileButton id="hud_leaderboard" label="" texture={HUD_SHEET} uvs={HUD_TROPHY_UVS} width={iconSize} height={iconSize} onClick={() => ui.openLeaderboard()} />
        </UiEntity>
      ) : null}
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Selected-pet panel (top): stats + care actions
// ---------------------------------------------------------------------------
// One stat row: label + a light track with a colored fill (flat, no art).
function StatRow(props: { label: string; value: number; color: Color; width: number }) {
  const v = Math.max(0, Math.min(100, props.value))
  const labelW = S(80)
  const trackW = props.width - labelW - S(10)
  return (
    <UiEntity uiTransform={{ width: props.width, height: S(32), flexDirection: 'row', alignItems: 'center', margin: { bottom: S(8) } }}>
      <Label value={props.label} fontSize={S(15)} color={LOC.body} textAlign="middle-left" uiTransform={{ width: labelW, height: S(24) }} />
      <UiEntity uiTransform={{ width: trackW, height: S(16), borderRadius: S(8) }} uiBackground={{ color: LOC.neutral }}>
        <UiEntity uiTransform={{ width: `${v}%`, height: '100%', borderRadius: S(8) }} uiBackground={{ color: props.color }} />
      </UiEntity>
    </UiEntity>
  )
}

// Growth progress bar — one continuous line that fills (in the pet's rarity color)
// with the pet's overall growth from newborn to Adult, with the three stage names
// placed along the path at their real positions (Junior at the start, Teenager at
// its threshold, Adult at the end) and a marker dot at each. Shows both how grown
// the pet is AND how far each stage sits (#153). On every pet passport.
const GROWTH_MARKS: { key: Cfg.PetStage; label: string; pos: number }[] = [
  { key: 'JUNIOR', label: 'Junior', pos: 0 },
  { key: 'TEENAGER', label: 'Teenager', pos: Cfg.PET_STAGE_TEEN_FRACTION },
  { key: 'ADULT', label: 'Adult', pos: 1 }
]
function StageProgress(props: { size: number; color: Color }) {
  const overall = Cfg.petGrowthFraction(props.size) // 0..1 across the whole range
  const cur = Cfg.petStage(props.size)
  const inactive = LOC.dim // visible on the light-pink card (LOC.neutral was near-invisible)
  const barH = S(8)
  const node = S(13)
  const labelW = S(80)
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: S(6), bottom: S(2) } }}>
      {/* the bar: grey track + rarity fill + a marker dot per stage */}
      <UiEntity uiTransform={{ width: '100%', height: node, justifyContent: 'center' }}>
        <UiEntity uiTransform={{ positionType: 'absolute', position: { left: 0, top: (node - barH) / 2 }, width: '100%', height: barH, borderRadius: barH / 2 }} uiBackground={{ color: inactive }} />
        <UiEntity uiTransform={{ positionType: 'absolute', position: { left: 0, top: (node - barH) / 2 }, width: `${Math.round(overall * 100)}%`, height: barH, borderRadius: barH / 2 }} uiBackground={{ color: props.color }} />
        {GROWTH_MARKS.map((m) => (
          <UiEntity
            key={`gm-${m.key}`}
            uiTransform={{ positionType: 'absolute', position: { left: `${m.pos * 100}%`, top: 0 }, margin: { left: m.pos === 0 ? 0 : m.pos === 1 ? -node : -node / 2 }, width: node, height: node, borderRadius: node / 2 }}
            uiBackground={{ color: overall + 0.0005 >= m.pos ? props.color : inactive }}
          />
        ))}
      </UiEntity>
      {/* stage names along the path, under their markers */}
      <UiEntity uiTransform={{ width: '100%', height: S(18), margin: { top: S(3) } }}>
        {GROWTH_MARKS.map((m) => (
          <Label
            key={`gl-${m.key}`}
            value={m.label}
            fontSize={S(13)}
            color={m.key === cur ? props.color : inactive}
            textAlign={m.pos === 0 ? 'middle-left' : m.pos === 1 ? 'middle-right' : 'middle-center'}
            textWrap="nowrap"
            uiTransform={
              m.pos === 1
                ? { positionType: 'absolute', position: { right: 0, top: 0 }, width: labelW, height: S(18) }
                : { positionType: 'absolute', position: { left: `${m.pos * 100}%`, top: 0 }, margin: { left: m.pos === 0 ? 0 : -labelW / 2 }, width: labelW, height: S(18) }
            }
          />
        ))}
      </UiEntity>
    </UiEntity>
  )
}

// Snapshot + rarity + growth stage — shared by the owner's PetPanel and the
// read-only RemotePetPanel so both "passports" look consistent. `name`/`level`
// are optional: PetPanel passes them to show its header inline (the hud2 card has
// no separate title bar); RemotePetPanel leaves them off since its LightModal
// title already shows the name/level.
function PetIdentityRow(props: { species: string; rarity: Rarity; size: number; width: number; name?: string; level?: number }) {
  const img = Cfg.speciesImage(props.species)
  const rc = Cfg.RARITY_COLOR[props.rarity] ?? Cfg.RARITY_COLOR.common
  const rarityColor: Color = { r: rc.r, g: rc.g, b: rc.b, a: 1 }
  const discSize = S(84)
  const textW = props.width - discSize - S(14)
  return (
    <UiEntity uiTransform={{ width: props.width, flexDirection: 'row', alignItems: 'center', margin: { bottom: S(10) } }}>
      <UiEntity
        uiTransform={{ width: discSize, height: discSize, borderRadius: discSize / 2, margin: { right: S(14) } }}
        uiBackground={img ? { texture: { src: img }, textureMode: 'stretch' } : { color: speciesColor(props.species) }}
      />
      <UiEntity uiTransform={{ width: textW, flexDirection: 'column', justifyContent: 'center' }}>
        {props.name !== undefined && (
          <Label value={`${props.name}  ·  Lv ${props.level}`} fontSize={S(20)} color={PET_UI.ink} textAlign="middle-left" textWrap="nowrap" uiTransform={{ width: '100%', height: S(26) }} />
        )}
        <Label value={Cfg.rarityLabel(props.rarity).toUpperCase()} fontSize={S(18)} color={rarityColor} textAlign="middle-left" uiTransform={{ width: '100%', height: S(24) }} />
        <StageProgress size={props.size} color={rarityColor} />
      </UiEntity>
    </UiEntity>
  )
}

function PetPanel() {
  const pet = clientState.activePet
  // Never show the actions panel while a hatchling is still pending Keep/Discard —
  // its actions would run on a pet that isn't accepted into a slot yet (bug). The
  // Keep/Discard modal owns this moment.
  if (!pet || !clientState.petPanelOpen || hasPendingHatchling()) return <UiEntity />

  const care = (a: CareAction) => triggerCare(a)
  const contentW = S(700) - S(30) * 2 // LightModal inner width (card minus padding)
  const chipW = Math.floor((contentW - S(30)) / 4) // 4 care buttons across, with slack
  const chipH = S(60)
  const halfW = Math.round((contentW - S(8)) / 2)
  const unlocked = Cfg.petStage(pet.size) === 'ADULT'
  const otherPets = clientState.player?.pets.filter((x) => x.id !== pet.id) ?? []
  const partner = otherPets.find((x) => Cfg.petStage(x.size) === 'ADULT')
  // Interactions are mutually exclusive: a moment already in progress (carry-
  // to-bathe, petting, fetch, hatching, or a queued care action) blocks
  // starting another, and being asleep blocks everything except waking up.
  const busy = !canStartPetInteraction() && !pet.sleeping
  const locked = pet.sleeping || busy
  // Sleep lock: for the first few minutes of a nap the pet can't be woken at
  // all (SLEEP_LOCK_MS) — the Wake button shows the countdown instead.
  const lockLeft = sleepLockLeft()
  // Energy gate: below PLAY_MIN_ENERGY the pet refuses to play until it sleeps.
  const tired = !canPlayNow()
  // Why the panel is locked, phrased as something the player can act on. The
  // Feed errand is the only lock with its own on-screen exit (the BACK button
  // over the world), so it gets named instead of the generic "busy".
  const busyMessage = () =>
    lockLeft > 0
      ? `${pet.name} is fast asleep — ${Cfg.formatLockCountdown(lockLeft)} left.`
      : clientState.feedTask.active
        ? 'Finish the tree errand or tap BACK first!'
        : 'Your pet is busy right now!'
  const guard = (fn: () => void) => () => {
    if (locked) {
      pushToast(busyMessage())
      return
    }
    fn()
  }

  return (
    <PetHudCard width={S(700)} height={S(480)} onClose={() => (clientState.petPanelOpen = false)}>
      <PetIdentityRow species={pet.species} rarity={pet.rarity} size={pet.size} width={contentW} name={pet.name} level={pet.petLevel} />
      {careActive() && (
        <Label value={`Busy${queueLength() > 0 ? ` +${queueLength()}` : ''}`} fontSize={S(14)} color={LOC.dim} textAlign="middle-center" uiTransform={{ width: '100%', height: S(20), margin: { bottom: S(6) } }} />
      )}
      {/* Stats */}
      <UiEntity uiTransform={{ width: contentW, flexDirection: 'column', margin: { top: S(4) } }}>
        <StatRow label="Hunger" value={pet.hunger} color={C.hunger} width={contentW} />
        <StatRow label="Hygiene" value={pet.hygiene} color={C.hygiene} width={contentW} />
        <StatRow label="Energy" value={pet.energy} color={C.energy} width={contentW} />
        <StatRow label="Happy" value={pet.happiness} color={C.happy} width={contentW} />
      </UiEntity>
      {/* Care actions (flat, colored per stat) */}
      <UiEntity uiTransform={{ width: contentW, flexDirection: 'row', justifyContent: 'center', margin: { top: S(12) } }}>
        <TactileButton id="care_feed" label="Feed" width={chipW} height={chipH} bg={C.hunger} textColor={C.outline} fontSize={S(16)} radius={S(14)} disabled={locked} margin={{ left: S(3), right: S(3) }} onClick={guard(() => startFeedTask())} />
        <TactileButton
          id="care_bath"
          label="Bath"
          width={chipW}
          height={chipH}
          bg={C.hygiene}
          textColor={C.outline}
          fontSize={S(16)}
          radius={S(14)}
          disabled={locked}
          margin={{ left: S(3), right: S(3) }}
          onClick={guard(() => {
            // Pick the pet up and carry it to the tub (place it there to bathe).
            startCarryPet()
            clientState.petPanelOpen = false
          })}
        />
        <TactileButton
          id="care_sleep"
          label={pet.sleeping ? (lockLeft > 0 ? Cfg.formatLockCountdown(lockLeft) : 'Wake') : 'Sleep'}
          width={chipW}
          height={chipH}
          bg={lockLeft > 0 ? LOC.neutral : C.energy}
          textColor={lockLeft > 0 ? LOC.dim : C.outline}
          fontSize={S(16)}
          radius={S(14)}
          disabled={!pet.sleeping && busy}
          pulse={!pet.sleeping && tired && !busy}
          margin={{ left: S(3), right: S(3) }}
          onClick={() => {
            // A nap can't be interrupted for its first few minutes — that lock
            // is what makes the play energy gate mean something.
            if (lockLeft > 0) {
              pushToast(`${pet.name} is fast asleep — ${Cfg.formatLockCountdown(lockLeft)} left.`)
              return
            }
            // Waking is instant once the lock is up — no walk back to the bed.
            if (pet.sleeping) {
              pet.sleeping = false
              pet.sleepLockUntil = 0
              actions.care('sleep', true)
              return
            }
            if (busy) {
              pushToast(busyMessage())
              return
            }
            care('sleep')
          }}
        />
        <TactileButton
          id="care_play"
          label={tired ? 'Play  ·  Tired' : 'Play'}
          width={chipW}
          height={chipH}
          bg={tired ? LOC.neutral : C.happy}
          textColor={tired ? LOC.dim : C.outline}
          fontSize={S(16)}
          radius={S(14)}
          disabled={locked}
          margin={{ left: S(3), right: S(3) }}
          onClick={guard(() => {
            // Out of energy: playing is what drains it, so the way back is bed.
            if (tired) {
              pushToast(`${pet.name} is too tired to play — send it to sleep.`)
              return
            }
            // Enter Fetch mode: hide the panel and show the centered Fetch button.
            clientState.fetch.active = true
            clientState.petPanelOpen = false
          })}
        />
      </UiEntity>
      {/* Pet + Breed, side by side and equal size. */}
      <UiEntity uiTransform={{ width: contentW, flexDirection: 'row', justifyContent: 'center', margin: { top: S(12) } }}>
        <TactileButton id="pet_gesture" label="Pet  ·  +Happy" width={halfW} height={S(54)} bg={C.happy} textColor={C.outline} fontSize={S(16)} radius={S(16)} disabled={locked} margin={{ right: S(4) }} onClick={guard(() => startPetting())} />
        <TactileButton
          id="breed_teaser"
          label={unlocked ? 'Breed' : 'Breed  ·  Adult'}
          width={halfW}
          height={S(54)}
          bg={unlocked ? LOC.blue : LOC.neutral}
          textColor={unlocked ? LOC.white : LOC.dim}
          fontSize={S(16)}
          radius={S(16)}
          margin={{ left: S(4) }}
          pulse={unlocked}
          onClick={() => {
            if (!unlocked) {
              pushToast('Grow your pet to Adult to unlock breeding!')
              return
            }
            if (otherPets.length === 0) {
              pushToast('You need a second pet to breed with.')
              return
            }
            if (!partner) {
              pushToast('You need a second Adult pet to breed with.')
              return
            }
            // Name the offspring first (like adoption), then breed on confirm.
            uiState.breedPartnerId = partner.id
            uiState.breedName = ''
            uiState.breedUsePotion = false
            uiState.panel = 'breedName'
            clientState.petPanelOpen = false
          }}
        />
      </UiEntity>
    </PetHudCard>
  )
}

// Read-only "passport" for another player's pet — opened by clicking their
// pet in-world. Shows the same identity info as the owner's panel (snapshot,
// rarity, size/stage) plus overall mood, but no care actions: the only thing
// a non-owner can do here is give it a treat.
function RemotePetPanel() {
  const addr = clientState.viewingPetAddress
  if (!addr) return <UiEntity />
  const entry = clientState.presence.find((p) => p.address.toLowerCase() === addr.toLowerCase())
  if (!entry) return <UiEntity />
  const contentW = S(560) - S(30) * 2
  return (
    <LightModal title={`${entry.name}  ·  Lv ${entry.level}`} width={S(560)} height={S(470)} onClose={() => (clientState.viewingPetAddress = null)}>
      <PetIdentityRow species={entry.species} rarity={entry.rarity} size={entry.size} width={contentW} />
      <UiEntity uiTransform={{ width: contentW, flexDirection: 'column', margin: { top: S(4) } }}>
        <StatRow label="Mood" value={entry.mood} color={C.happy} width={contentW} />
      </UiEntity>
      <TactileButton
        id="give_treat"
        label="Give a treat"
        width={contentW}
        height={S(56)}
        bg={C.happy}
        textColor={LOC.white}
        fontSize={S(18)}
        radius={S(16)}
        margin={{ top: S(16) }}
        onClick={() => {
          // The server drops petOther silently while on cooldown (no notify),
          // so a fast second click would otherwise look like nothing happened.
          if (Date.now() - clientState.lastTreatSentAt < Cfg.PET_OTHER_COOLDOWN_MS) {
            pushToast('Still settling down from the last treat...')
            return
          }
          clientState.lastTreatSentAt = Date.now()
          actions.petOther(entry.address)
        }}
      />
      <TactileButton
        id="propose_swap"
        label={`Propose Swap  ·  ${clientState.activePet ? clientState.activePet.name : '—'}`}
        width={contentW}
        height={S(56)}
        bg={LOC.violet}
        textColor={LOC.white}
        fontSize={S(18)}
        radius={S(16)}
        margin={{ top: S(10) }}
        onClick={() => {
          // Offer YOUR active pet for theirs; the server forwards it for approval.
          if (!clientState.activePet || hasPendingHatchling()) {
            pushToast('Select one of your pets first to offer it.')
            return
          }
          actions.proposeSwap(entry.address, playerName())
          clientState.viewingPetAddress = null
        }}
      />
    </LightModal>
  )
}

// Incoming pet-swap offer — another player wants to trade their pet for yours.
// Shows the offered pet's full profile; Accept swaps both rosters, Decline drops it.
function SwapOfferPanel() {
  const offer = clientState.incomingSwap
  if (!offer) return <UiEntity />
  const contentW = S(600) - S(30) * 2
  const p = offer.offeredPet
  const respond = (accept: boolean) => {
    actions.respondSwap(accept)
    clientState.incomingSwap = null
  }
  return (
    <LightModal title="Swap Offer!" width={S(600)} height={S(560)} onClose={() => respond(false)}>
      <Label
        value={`${offer.fromName} offers their pet for your ${offer.wantedPetName}`}
        fontSize={S(17)}
        color={LOC.dim}
        textAlign="middle-center"
        uiTransform={{ width: contentW, height: S(44), margin: { bottom: S(6) } }}
      />
      <OutlineLabel value={p.name} fontSize={S(24)} color={LOC.title} outlineColor={LOC.titleOutline} width={contentW} height={S(32)} textAlign="middle-center" />
      <PetIdentityRow species={p.species} rarity={p.rarity} size={p.size} width={contentW} />
      <UiEntity uiTransform={{ width: contentW, flexDirection: 'column' }}>
        <StatRow label="Hunger" value={p.hunger} color={C.hunger} width={contentW} />
        <StatRow label="Hygiene" value={p.hygiene} color={C.hygiene} width={contentW} />
        <StatRow label="Energy" value={p.energy} color={C.energy} width={contentW} />
        <StatRow label="Happy" value={p.happiness} color={C.happy} width={contentW} />
      </UiEntity>
      <UiEntity uiTransform={{ width: contentW, flexDirection: 'row', justifyContent: 'center', margin: { top: S(14) } }}>
        <TactileButton id="swap_decline" label="Decline" width={S(200)} height={S(64)} bg={LOC.rose} textColor={LOC.white} fontSize={S(22)} radius={S(18)} margin={{ right: S(10) }} onClick={() => respond(false)} />
        <TactileButton id="swap_accept" label="Accept" width={S(200)} height={S(64)} bg={LOC.green} textColor={LOC.white} fontSize={S(22)} radius={S(18)} pulse margin={{ left: S(10) }} onClick={() => respond(true)} />
      </UiEntity>
    </LightModal>
  )
}

// Keep/Discard button art (source is 443x336) — sized off this ratio wherever
// they're used instead of the old text-pill's own width/height, so the art
// never gets stretched.
const KEEP_BUTTON_ICON = 'assets/images/revamp/keepbutton.png'
const DISCARD_BUTTON_ICON = 'assets/images/revamp/discardbutton.png'
const KEEP_DISCARD_ASPECT = 443 / 336

// ---------------------------------------------------------------------------
// Bottom nav: 3 big buttons (cozy-farm style)
// ---------------------------------------------------------------------------
function BottomNav() {
  const p = clientState.player
  // Hidden while a dialog is open — the dialog sits where these buttons are.
  // Also hidden in Fetch mode, while carrying an egg or the pet, and during the
  // hatch animation (so Keep/Discard only appears once the newborn has emerged).
  if (!p || clientState.dialog.open || clientState.fetch.active || clientState.carryEgg.active || clientState.carryPet.active || clientState.hatch.active) return <UiEntity />
  const bh = Sbtn(72)

  // Just hatched: a new pet is waiting on a Keep/Discard decision. It takes over
  // the nav bar — Keep places it (nav returns), Discard sends it to the Care
  // Center (nothing kept). Until then the 3 nav buttons stay hidden.
  if (p.hatchling) {
    const kdH = Math.round(bh * 1.15)
    const kdW = Math.round(kdH * KEEP_DISCARD_ASPECT)
    return (
      <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: S(50), left: 0 }, width: '100%', height: bh, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}>
        <TactileButton id="nav_keep" label="" texture={KEEP_BUTTON_ICON} width={kdW} height={kdH} margin={{ left: S(8), right: S(8) }} pulse onClick={() => keepHatchling()} />
        <TactileButton id="nav_discard" label="" texture={DISCARD_BUTTON_ICON} width={kdW} height={kdH} margin={{ left: S(8), right: S(8) }} onClick={() => discardHatchling()} />
      </UiEntity>
    )
  }

  // The nav buttons only appear once you actually own a pet (kept at least one).
  if (p.pets.length === 0) return <UiEntity />

  // Icon-only squares (paw / backpack / star) from hud.png. A colored plate
  // shows behind the icon when its panel is open — the icon art itself has no
  // separate "selected" variant.
  const navSize = Sbtn(92)
  const plateSize = navSize + S(10)
  const nav = (id: string, uvs: number[], panel: Panel, onClick: () => void) => {
    const sel = uiState.panel === panel
    return (
      <UiEntity
        uiTransform={{ width: plateSize, height: plateSize, alignItems: 'center', justifyContent: 'center', margin: { left: S(6), right: S(6) }, borderRadius: S(18) }}
        uiBackground={sel ? { color: LOC.blue } : undefined}
      >
        <TactileButton id={id} label="" texture={HUD_SHEET} uvs={uvs} width={navSize} height={navSize} onClick={onClick} />
      </UiEntity>
    )
  }
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: mobile() ? S(70) : S(18), left: 0 }, width: '100%', height: bh, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}>
      {nav('nav_pets', NAV_PAW_UVS, 'roster', () => ui.openRoster())}
      {nav('nav_inv', NAV_INV_UVS, 'inventory', () => ui.openInventory())}
      {nav('nav_goals', NAV_GOALS_UVS, 'goals', () => ui.openGoals())}
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Side buttons: Spin + Shop (right), Whistle (left)
// ---------------------------------------------------------------------------
// Spin and Stay/Whistle are suspended until they get revamped — the logic
// (ui.openSpin(), setFollow()) stays wired, just not reachable from the HUD.
function SideButtons() {
  return <UiEntity />
}

// Jukebox + Leaderboard entry points now live as icon buttons in the top HUD
// row (TopBars, next to the pets counter) instead of floating mid-right
// placeholders.

// Column widths shared by the header + rows so they line up. name is fixed (not
// flex) so Creatures sits centered in the middle and Coins on the right, evenly
// spread across the row instead of both bunching up at the right edge.
const LB_ROW_W = S(556)
const LB_RANK_W = S(44)
const LB_NAME_W = S(196)
const LB_COINS_W = S(150)

function LeaderboardRow(props: { key?: string; rank: number; name: string; coins: number; creatures: number; isMe: boolean }) {
  const ink = props.isMe ? LOC.white : PET_UI.ink
  const iconS = S(22)
  return (
    <UiEntity
      uiTransform={{ width: LB_ROW_W, height: S(36), flexDirection: 'row', alignItems: 'center', margin: { bottom: S(3) }, padding: { left: S(12), right: S(14) }, borderRadius: S(12) }}
      uiBackground={{ color: props.isMe ? LOC.blue : LOC.tile }}
    >
      <Label value={`${props.rank}`} fontSize={S(17)} color={ink} textAlign="middle-center" uiTransform={{ width: LB_RANK_W, height: S(24) }} />
      <Label value={props.name} fontSize={S(16)} color={ink} textAlign="middle-left" textWrap="nowrap" uiTransform={{ width: LB_NAME_W, height: S(24) }} />
      {/* Creatures: paw icon + count, centered in the middle. */}
      <UiEntity uiTransform={{ flex: 1, height: S(26), flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
        <UiEntity uiTransform={{ width: iconS, height: iconS }} uiBackground={{ texture: { src: HUD_SHEET }, textureMode: 'stretch', uvs: NAV_PAW_UVS }} />
        <Label value={`${props.creatures}`} fontSize={S(16)} color={ink} textAlign="middle-left" uiTransform={{ width: S(40), height: S(24), margin: { left: S(6) } }} />
      </UiEntity>
      {/* Coins: transparent golden coin icon (cut from the top-HUD coin) + amount,
          right-anchored under the Coins header. The number label is sized to its
          digits so the group stays tight (no gap) and never clips a big amount. */}
      <UiEntity uiTransform={{ width: LB_COINS_W, height: S(26), flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}>
        <UiEntity uiTransform={{ width: iconS, height: iconS }} uiBackground={{ texture: { src: 'assets/images/coin_icon.png' }, textureMode: 'stretch' }} />
        <Label value={`${props.coins}`} fontSize={S(16)} color={ink} textAlign="middle-left" uiTransform={{ width: S(10 + `${props.coins}`.length * 10), height: S(24), margin: { left: S(6) } }} />
      </UiEntity>
    </UiEntity>
  )
}

function LeaderboardHeader() {
  return (
    <UiEntity uiTransform={{ width: LB_ROW_W, height: S(24), flexDirection: 'row', alignItems: 'center', margin: { bottom: S(6) }, padding: { left: S(12), right: S(14) } }}>
      <UiEntity uiTransform={{ width: LB_RANK_W, height: S(20) }} />
      <Label value="Player" fontSize={S(13)} color={LOC.dim} textAlign="middle-left" uiTransform={{ width: LB_NAME_W, height: S(20) }} />
      <Label value="Creatures" fontSize={S(13)} color={LOC.dim} textAlign="middle-center" uiTransform={{ flex: 1, height: S(20) }} />
      <Label value="Coins" fontSize={S(13)} color={LOC.dim} textAlign="middle-right" uiTransform={{ width: LB_COINS_W, height: S(20) }} />
    </UiEntity>
  )
}

function LeaderboardPanel() {
  const rows = clientState.leaderboard
  const me = clientState.myAddress.toLowerCase()
  return (
    <PetHudModal title="Leaderboard" subtitle="Top settlers by coins across the colony." width={S(640)} height={S(560)} onClose={() => ui.close()}>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
        {rows.length === 0 ? (
          <Label value="Loading standings…" fontSize={S(18)} color={LOC.dim} textAlign="middle-center" uiTransform={{ width: '100%', height: S(40), margin: { top: S(20) } }} />
        ) : (
          <LeaderboardHeader />
        )}
        {rows.map((e, i) => (
          <LeaderboardRow key={e.address} rank={i + 1} name={e.name} coins={e.coins} creatures={e.creatures} isMe={e.address.toLowerCase() === me} />
        ))}
      </UiEntity>
    </PetHudModal>
  )
}

function CoinIcon(props: { accent?: Color; size?: number }) {
  const d = props.size ?? S(26)
  return (
    <UiEntity uiTransform={{ width: d, height: d, borderRadius: d / 2, alignItems: 'center', justifyContent: 'center' }} uiBackground={{ color: props.accent ?? C.gold }}>
      <Label value="C" fontSize={Math.round(d * 0.55)} color={C.outline} textAlign="middle-center" uiTransform={{ width: d, height: d }} />
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Adoption (stepped wizard: pick -> name -> confirm)
// ---------------------------------------------------------------------------
const SPECIES_COLORS: Color[] = [C.hunger, C.hygiene, C.energy, C.happy, C.green, C.gold, C.pink, C.blue, C.greenDark, C.cardAlt, C.pink]
function speciesColor(s: string): Color {
  const i = Cfg.SPECIES.indexOf(s)
  return SPECIES_COLORS[(i < 0 ? 0 : i) % SPECIES_COLORS.length]
}

function SpeciesCard(props: { key?: string; species: string }) {
  const selected = uiState.adoptSpecies === props.species
  const cardW = S(180)
  const cardH = Math.round(cardW / PET_CARD_ASPECT)
  const disc = S(78)
  const img = Cfg.speciesImage(props.species)
  return (
    <PetGridCard
      selected={selected}
      width={cardW}
      height={cardH}
      onClick={() => {
        uiState.adoptSpecies = props.species
      }}
    >
      <UiEntity
        uiTransform={{ width: disc, height: disc, borderRadius: disc / 2, margin: { bottom: S(10) } }}
        uiBackground={img ? { texture: { src: img }, textureMode: 'stretch' } : { color: speciesColor(props.species) }}
      />
      <Label value={Cfg.speciesLabel(props.species)} fontSize={S(18)} color={selected ? C.greenDark : PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: S(24) }} />
      <Label value={selected ? 'Selected' : 'Tap to choose'} fontSize={S(13)} color={selected ? C.greenDark : PET_UI.muted} textAlign="middle-center" uiTransform={{ width: '100%', height: S(18), margin: { top: S(2) } }} />
    </PetGridCard>
  )
}

function AdoptPanel() {
  const p = clientState.player
  const slotsFree = p ? p.pets.length < p.petSlots : true
  const nextSlotPrice = Cfg.slotPrice(p ? p.petSlots : Cfg.STARTING_SLOTS)
  const sp = uiState.adoptSpecies

  if (uiState.adoptStep === 'pick') {
    const modalW = S(520)
    const modalH = Math.round(S(620) / PET_MODAL_ASPECT)
    const nextW = S(150)
    const nextH = Math.round(nextW / PET_NEXT_ASPECT)
    return (
      <PetHudModal title="Choose a Pet" subtitle="Tap a friend to choose your next colony companion." width={modalW} height={modalH} onClose={() => ui.close()}>
        <UiEntity uiTransform={{ width: '100%', height: '100%', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between' }}>
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignContent: 'flex-start' }}>
            {Cfg.SPECIES.map((s) => (
              <SpeciesCard key={s} species={s} />
            ))}
          </UiEntity>
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center', margin: { top: S(6) } }}>
            <TactileButton id="adopt_next" label="Next" texture={PET_NEXT_TEXTURE} width={nextW} height={nextH} pulse onClick={() => (uiState.adoptStep = 'name')} />
          </UiEntity>
        </UiEntity>
      </PetHudModal>
    )
  }

  // Name + confirm step
  const disc = S(120)
  const modalW = S(560)
  const modalH = Math.round(modalW / PET_MODAL_ASPECT)
  const img = Cfg.speciesImage(sp)
  // A name is REQUIRED — the Adopt button stays disabled until one is typed, so
  // players can't skip past the input (many missed it and got stuck wondering why
  // nothing happened).
  const named = uiState.adoptName.trim().length > 0
  return (
    <PetHudModal title="Name your Pet" subtitle="Pick a name before you carry the egg home." width={modalW} height={modalH} onClose={() => ui.close()}>
      <UiEntity uiTransform={{ width: '100%', height: '100%', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between' }}>
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
          <UiEntity uiTransform={{ width: disc, height: disc, borderRadius: disc / 2, margin: { top: S(8), bottom: S(10) } }} uiBackground={img ? { texture: { src: img }, textureMode: 'stretch' } : { color: speciesColor(sp) }} />
          <Label value={Cfg.speciesLabel(sp)} fontSize={S(24)} color={PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: S(32) }} />
        <Input
          placeholder="Type a name..."
          fontSize={S(20)}
          color={PET_UI.ink}
          placeholderColor={PET_UI.muted}
          uiTransform={{ width: S(360), height: S(56), margin: { top: S(14), bottom: S(10) } }}
          uiBackground={{ color: LOC.tile }}
          onChange={(v) => {
            uiState.adoptName = v
          }}
        />
        {!slotsFree && <Label value="No free pet slots. Buy one first." fontSize={S(16)} color={LOC.red} textAlign="middle-center" uiTransform={{ width: '100%', height: S(24) }} />}
        {slotsFree && !named && <Label value="Give your pet a name to continue." fontSize={S(16)} color={LOC.orange} textAlign="middle-center" uiTransform={{ width: '100%', height: S(24) }} />}
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center', margin: { top: S(10) } }}>
        <TactileButton id="adopt_back" label="Back" width={S(130)} height={S(56)} bg={LOC.neutral} textColor={PET_UI.ink} fontSize={S(18)} radius={S(18)} margin={{ right: S(10) }} onClick={() => { uiState.adoptName = ''; uiState.adoptStep = 'pick' }} />
        {slotsFree ? (
          <TactileButton
            id="adopt_confirm"
            label="Adopt!"
            width={S(200)}
            height={S(56)}
            bg={LOC.violet}
            textColor={LOC.white}
            fontSize={S(24)}
            radius={S(18)}
            pulse
            disabled={!named}
            onClick={() => {
              // Adoption gives an egg to carry home; you hatch it there (rub/tap).
              startCarryEgg(sp, uiState.adoptName.trim())
              uiState.adoptName = ''
              ui.close()
            }}
          />
        ) : (
          <TactileButton
            id="adopt_buyslot"
            label={`Buy Slot ${nextSlotPrice}`}
            width={S(220)}
            height={S(56)}
            bg={LOC.orange}
            textColor={LOC.white}
            fontSize={S(20)}
            radius={S(18)}
            onClick={() => {
              buySlotLocal() // optimistic slot bump; the server sends the single confirming/failure toast
              actions.buySlot()
            }}
          />
        )}
      </UiEntity>
      </UiEntity>
    </PetHudModal>
  )
}

// Breeding: name the offspring before crossing. The species + rarity are the
// server's surprise inside the egg; the name is prefixed "Gen-N" server-side.
// A rarity potion (bought in the Shop) can be spent on this roll to tilt the
// odds toward rare/legendary — it is consumed server-side by this breed only.
function BreedNamePanel() {
  if (uiState.panel !== 'breedName') return <UiEntity />
  const potions = clientState.player?.inventory.rarityPotions ?? 0
  const hasPotion = potions > 0
  const usingPotion = hasPotion && uiState.breedUsePotion
  return (
    <LightModal title="Name your Offspring" width={S(680)} height={S(660)} onClose={() => ui.close()}>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
        <Label value="🥚" fontSize={S(90)} textAlign="middle-center" uiTransform={{ width: '100%', height: S(120), margin: { top: S(6) } }} />
        <Label value="Cross your two Adults — the species and rarity are a surprise inside the egg!" fontSize={S(17)} color={LOC.dim} textAlign="middle-center" uiTransform={{ width: S(520), height: S(48) }} />
        <Input
          placeholder="Type a name..."
          fontSize={S(20)}
          color={LOC.body}
          placeholderColor={LOC.dim}
          uiTransform={{ width: S(440), height: S(60), margin: { top: S(14), bottom: S(6) } }}
          uiBackground={{ color: LOC.tile }}
          onChange={(v) => {
            uiState.breedName = v
          }}
        />
        <Label value="It hatches named  Gen-1  +  your name." fontSize={S(14)} color={LOC.dim} textAlign="middle-center" uiTransform={{ width: '100%', height: S(22) }} />
        <TactileButton
          id="breed_potion"
          label={`${usingPotion ? '✓ ' : ''}${Cfg.RARITY_POTION_LABEL}  x${potions}`}
          width={S(400)}
          height={S(60)}
          bg={usingPotion ? LOC.violet : LOC.neutral}
          textColor={usingPotion ? LOC.white : LOC.body}
          fontSize={S(19)}
          radius={S(18)}
          disabled={!hasPotion}
          margin={{ top: S(10) }}
          onClick={() => {
            uiState.breedUsePotion = !uiState.breedUsePotion
          }}
        />
        <Label
          value={hasPotion ? 'Tap to spend one potion on this roll — better rare/legendary odds.' : 'No potions — buy one in your Inventory to boost your rare/legendary odds.'}
          fontSize={S(14)}
          color={LOC.dim}
          textAlign="middle-center"
          uiTransform={{ width: S(520), height: S(22), margin: { top: S(4) } }}
        />
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center', margin: { top: S(6) } }}>
        <TactileButton id="breed_back" label="< Back" width={S(160)} height={S(66)} bg={LOC.neutral} textColor={LOC.body} fontSize={S(20)} radius={S(18)} margin={{ right: S(12) }} onClick={() => ui.close()} />
        <TactileButton
          id="breed_confirm"
          label="Breed!"
          width={S(260)}
          height={S(66)}
          bg={LOC.green}
          textColor={LOC.white}
          fontSize={S(26)}
          radius={S(18)}
          pulse
          onClick={() => {
            actions.breed(uiState.breedPartnerId, uiState.breedName, usingPotion)
            uiState.breedName = ''
            uiState.breedUsePotion = false
            ui.close()
          }}
        />
      </UiEntity>
    </LightModal>
  )
}

// ---------------------------------------------------------------------------
// Shop (tabbed: Food / Pet Slots / Potions)
// ---------------------------------------------------------------------------
function ShopTab(props: { id: ShopTabId; label: string }) {
  const active = uiState.shopTab === props.id
  return (
    <TactileButton
      id={`shoptab_${props.id}`}
      label={props.label}
      width={S(150)}
      height={S(50)}
      bg={active ? C.green : C.card}
      textColor={active ? C.outline : C.text}
      fontSize={S(17)}
      radius={S(14)}
      margin={{ left: S(6), right: S(6) }}
      onClick={() => {
        uiState.shopTab = props.id
      }}
    />
  )
}

// One product card in the shop grid.
function ShopCard(props: { key?: string; title: string; desc: string; price: number; color: Color; onBuy: () => void; id: string; disabled?: boolean }) {
  const cardW = S(296)
  const icon = S(64)
  return (
    <UiEntity uiTransform={{ width: cardW, height: S(196), flexDirection: 'column', alignItems: 'center', margin: S(6), padding: S(12), borderRadius: S(16) }} uiBackground={{ color: C.card }}>
      <UiEntity uiTransform={{ width: icon, height: icon, borderRadius: S(14), margin: { top: S(4), bottom: S(8) } }} uiBackground={{ color: props.color }} />
      <Label value={props.title} fontSize={S(17)} color={C.text} textAlign="middle-center" uiTransform={{ width: '100%', height: S(24) }} />
      <Label value={props.desc} fontSize={S(13)} color={C.dim} textAlign="middle-center" uiTransform={{ width: '100%', height: S(34) }} />
      <TactileButton id={props.id} label={`Buy  ${props.price}`} width={S(170)} height={S(48)} bg={props.disabled ? C.cardAlt : C.greenDark} fontSize={S(16)} disabled={props.disabled} margin={{ top: S(6) }} onClick={props.onBuy} />
    </UiEntity>
  )
}

function ShopPanel() {
  const p = clientState.player
  // No slot cap any more — the shop always sells the NEXT slot, just at a price
  // that steps up with every one already owned.
  const slots = p ? p.petSlots : Cfg.STARTING_SLOTS
  return (
    <PanelShell title="Shop" width={S(700)} onClose={() => ui.close()}>
      <UiEntity uiTransform={{ width: '100%', height: S(34), flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', margin: { bottom: S(8) } }}>
        <CoinIcon />
        <Label value={`${p ? Math.floor(p.currency) : 0}`} fontSize={S(18)} color={C.gold} textAlign="middle-left" uiTransform={{ width: S(90), height: S(34), margin: { left: S(6) } }} />
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center', margin: { bottom: S(12) } }}>
        <ShopTab id="food" label="Food" />
        <ShopTab id="slots" label="Pet Slots" />
      </UiEntity>

      {uiState.shopTab === 'food' && (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' }}>
          {Cfg.SHOP_ITEMS.map((item) => (
            <ShopCard
              key={`shop-${item.tier}`}
              id={`buy_${item.tier}`}
              title={item.label}
              desc={`+${item.hunger} hunger${item.happiness ? `, +${item.happiness} happy` : ''}`}
              price={item.price}
              color={item.tier === 2 ? C.happy : C.hunger}
              onBuy={() => {
                if (buyItemLocal(item.tier)) pushToast(`Bought ${item.label}`)
                else pushToast('Not enough coins')
                actions.buyItem(item.tier)
              }}
            />
          ))}
        </UiEntity>
      )}

      {uiState.shopTab === 'slots' && (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
          <Label value={`Pet slots used: ${p ? p.pets.length : 0} / ${p ? p.petSlots : Cfg.STARTING_SLOTS}`} fontSize={S(16)} color={C.text} uiTransform={{ width: '100%', height: S(34), margin: { bottom: S(12) } }} textAlign="middle-center" />
          <ShopCard
            id="buy_slot"
            title={`Pet Slot ${slots + 1}`}
            desc={`Room for one more pet · next: ${Cfg.slotPrice(slots + 1)}`}
            price={Cfg.slotPrice(slots)}
            color={C.gold}
            onBuy={() => {
              buySlotLocal() // optimistic slot bump; the server sends the single confirming/failure toast
              actions.buySlot()
            }}
          />
        </UiEntity>
      )}
    </PanelShell>
  )
}

// ---------------------------------------------------------------------------
// Inventory (use food on the active pet)
// ---------------------------------------------------------------------------
// One slot in the inventory grid — hud3's card template (baked count badge
// slot + green/gray "Use" button) with the matching food-bowl icon dropped in.
// One card, two uses: food is TAPPED to use (enabled while count > 0), the potion
// is TAPPED to buy (enabled while affordable). Same art/size for all three so the
// row stays uniform — the potion reuses the Magic Kibble bowl image as a stand-in.
// Narrow enough that three fit inside the original inventory modal.
function InvCard(props: { key?: string; id: string; title: string; bowlUvs?: number[]; bowlSrc?: string; bowlAspect: number; bowlScale?: number; bowlTop?: number; count: number; enabled: boolean; onClick: () => void }) {
  const cardW = S(180)
  const cardH = Math.round(cardW / INV_CARD_ASPECT)
  // bowlScale = art width as a fraction of the card; bowlTop = its vertical spot.
  // Defaults match the food bowls; the potion overrides them (bigger + higher).
  const bowlW = Math.round(cardW * (props.bowlScale ?? 0.46))
  const bowlH = Math.round(bowlW / props.bowlAspect)
  const bowlTop = Math.round(cardH * (props.bowlTop ?? 0.3))
  return (
    <UiEntity uiTransform={{ width: cardW, height: cardH, margin: S(6), pointerFilter: props.enabled ? 'block' : 'none' }} onMouseDown={props.enabled ? props.onClick : undefined}>
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: cardW, height: cardH }}
        uiBackground={{ texture: { src: INV_SHEET }, textureMode: 'stretch', uvs: props.enabled ? INV_CARD_ENABLED_UVS : INV_CARD_DISABLED_UVS }}
      />
      <Label
        value={`x${props.count}`}
        fontSize={S(14)}
        color={PET_UI.white}
        textAlign="middle-center"
        uiTransform={{ positionType: 'absolute', position: { left: Math.round(cardW * 0.726), top: Math.round(cardH * 0.066) }, width: Math.round(cardW * 0.19), height: Math.round(cardH * 0.104) }}
      />
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { left: Math.round((cardW - bowlW) / 2), top: bowlTop }, width: bowlW, height: bowlH }}
        uiBackground={
          // A standalone icon (potion.png) uses the whole image; a food bowl is a
          // cropped region of the shared HUD spritesheet.
          props.bowlSrc
            ? { texture: { src: props.bowlSrc }, textureMode: 'stretch' }
            : { texture: { src: INV_SHEET }, textureMode: 'stretch', uvs: props.bowlUvs }
        }
      />
      <Label
        value={props.title}
        fontSize={S(16)}
        color={PET_UI.ink}
        textAlign="middle-center"
        uiTransform={{ positionType: 'absolute', position: { left: 0, top: Math.round(cardH * 0.62) }, width: cardW, height: Math.round(cardH * 0.1) }}
      />
    </UiEntity>
  )
}

function InventoryPanel() {
  const p = clientState.player
  const t1 = p?.inventory.tier1 ?? 0
  const t2 = p?.inventory.tier2 ?? 0
  const potions = p?.inventory.rarityPotions ?? 0
  // The Rarity Potion is the only way to buy the breeding consumable while the
  // Shop is suspended (SideButtons() is empty). It's TAPPED to buy (150 coins) —
  // it's spent later by the breed that toggles it on, not "used" from here.
  const canAffordPotion = (p?.currency ?? 0) >= Cfg.RARITY_POTION_PRICE
  return (
    <PetHudModal title="Inventory" subtitle="Tap food to feed your pet, or tap the potion to buy one for breeding." width={S(660)} height={S(500)} onClose={() => ui.close()}>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center' }}>
        <InvCard key="inv-1" id="use_1" title={Cfg.SHOP_ITEMS[0].label} bowlUvs={INV_BOWL1_UVS} bowlAspect={INV_BOWL1_ASPECT} count={t1} enabled={t1 > 0} onClick={() => { if (useItemLocal(1)) pushToast('Fed your pet!'); actions.useItem(1) }} />
        <InvCard key="inv-2" id="use_2" title={Cfg.SHOP_ITEMS[1].label} bowlUvs={INV_BOWL2_UVS} bowlAspect={INV_BOWL2_ASPECT} count={t2} enabled={t2 > 0} onClick={() => { if (useItemLocal(2)) pushToast('Fed your pet!'); actions.useItem(2) }} />
        <InvCard key="inv-potion" id="buy_potion" title={`${Cfg.RARITY_POTION_LABEL}  ${Cfg.RARITY_POTION_PRICE}`} bowlSrc="assets/images/revamp/potion.png" bowlAspect={1} bowlScale={0.56} bowlTop={0.18} count={potions} enabled={canAffordPotion} onClick={() => { if (buyPotionLocal()) { pushToast('Bought a Rarity Potion!'); actions.buyPotion() } else pushToast('Not enough coins!') }} />
      </UiEntity>
    </PetHudModal>
  )
}

// ---------------------------------------------------------------------------
// Roster (Pets) — selection system
// ---------------------------------------------------------------------------
function RosterSlotCard(props: { key?: number; index: number }) {
  const p = clientState.player
  if (!p) return <UiEntity />

  const cardW = S(180)
  const cardH = Math.round(cardW / PET_CARD_ASPECT)
  const disc = S(78)
  const unlocked = props.index < p.petSlots
  const pet = p.pets[props.index]

  if (!unlocked) {
    // Slots are unlimited, and the grid only ever renders ONE locked card: the
    // next one up. Its price is the one for the slot count the player is at.
    const canUnlock = props.index === p.petSlots
    return (
      <PetGridCard
        selected={false}
        width={cardW}
        height={cardH}
        onClick={
          canUnlock
            ? () => {
                buySlotLocal() // optimistic slot bump; the server sends the single confirming/failure toast
                actions.buySlot()
              }
            : undefined
        }
      >
        <UiEntity uiTransform={{ width: S(42), height: S(42), borderRadius: S(21), alignItems: 'center', justifyContent: 'center', margin: { bottom: S(10) } }} uiBackground={{ color: canUnlock ? PET_UI.badge : PET_UI.lock }}>
          <Label value={canUnlock ? '+' : 'x'} fontSize={S(26)} color={PET_UI.white} textAlign="middle-center" uiTransform={{ width: S(42), height: S(42) }} />
        </UiEntity>
        <Label value={canUnlock ? 'Unlock' : 'Locked'} fontSize={S(18)} color={PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: S(24) }} />
        <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: { top: S(4) } }}>
          <PriceDot />
          <Label value={`${Cfg.slotPrice(props.index)}`} fontSize={S(16)} color={PET_UI.muted} textAlign="middle-center" uiTransform={{ width: S(54), height: S(20), margin: { left: S(6) } }} />
        </UiEntity>
      </PetGridCard>
    )
  }

  if (!pet) {
    const isFirstEmpty = props.index === p.pets.length
    const hatch = p.hatchling
    if (isFirstEmpty && hatch) {
      const img = Cfg.speciesImage(hatch.species)
      return (
        <PetGridCard selected={false} width={cardW} height={cardH}>
          <UiEntity uiTransform={{ width: S(70), height: S(70), borderRadius: S(35), margin: { bottom: S(6) } }} uiBackground={img ? { texture: { src: img }, textureMode: 'stretch' } : { color: speciesColor(hatch.species) }} />
          <Label value={`${hatch.name} hatched!`} fontSize={S(14)} color={PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: S(20) }} />
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center', margin: { top: S(6) } }}>
            <TactileButton id="hatch_keep" label="" texture={KEEP_BUTTON_ICON} width={S(70)} height={Math.round(S(70) / KEEP_DISCARD_ASPECT)} margin={{ right: S(4) }} pulse onClick={() => keepHatchling()} />
            <TactileButton id="hatch_discard" label="" texture={DISCARD_BUTTON_ICON} width={S(70)} height={Math.round(S(70) / KEEP_DISCARD_ASPECT)} margin={{ left: S(4) }} onClick={() => discardHatchling()} />
          </UiEntity>
        </PetGridCard>
      )
    }

    return (
      <PetGridCard selected={false} width={cardW} height={cardH} onClick={() => pushToast('Go to the Care Center to adopt a pet!')}>
        <UiEntity uiTransform={{ width: S(42), height: S(42), borderRadius: S(21), alignItems: 'center', justifyContent: 'center', margin: { bottom: S(10) } }} uiBackground={{ color: PET_UI.badge }}>
          <Label value="+" fontSize={S(28)} color={PET_UI.white} textAlign="middle-center" uiTransform={{ width: S(42), height: S(42) }} />
        </UiEntity>
        <Label value="Adopt" fontSize={S(18)} color={PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: S(24) }} />
        <Label value="Go to Care Center" fontSize={S(13)} color={PET_UI.muted} textAlign="middle-center" uiTransform={{ width: '100%', height: S(18), margin: { top: S(2) } }} />
      </PetGridCard>
    )
  }

  const isActive = pet.id === p.activePetId
  const img = Cfg.speciesImage(pet.species)
  return (
    <PetGridCard selected={isActive} width={cardW} height={cardH} onClick={() => switchActivePet(pet.id)}>
      <UiEntity uiTransform={{ width: disc, height: disc, borderRadius: disc / 2, margin: { bottom: S(8) } }} uiBackground={img ? { texture: { src: img }, textureMode: 'stretch' } : { color: speciesColor(pet.species) }} />
      <Label value={pet.name} fontSize={S(17)} color={isActive ? C.greenDark : PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: S(22) }} />
      <Label value={`Lv ${pet.petLevel}`} fontSize={S(13)} color={isActive ? C.greenDark : PET_UI.muted} textAlign="middle-center" uiTransform={{ width: '100%', height: S(18), margin: { top: S(2) } }} />
    </PetGridCard>
  )
}

// The roster grid used to be a fixed [0,1,2,3] because slots were capped at 4.
// They're unlimited now, so it pages: 2x2 is what the hud modal body fits.
const ROSTER_PAGE_SIZE = 4

function RosterPanel() {
  const p = clientState.player
  // Every unlocked slot, plus ONE trailing card to buy the next one.
  const total = (p ? p.petSlots : Cfg.STARTING_SLOTS) + 1
  const pageCount = Math.max(1, Math.ceil(total / ROSTER_PAGE_SIZE))
  // Clamp rather than trust the stored cursor: a server snapshot can shrink the
  // roster under the page we were on.
  const page = Math.min(Math.max(0, uiState.rosterPage), pageCount - 1)
  uiState.rosterPage = page
  const start = page * ROSTER_PAGE_SIZE
  const indices: number[] = []
  for (let i = start; i < Math.min(total, start + ROSTER_PAGE_SIZE); i++) indices.push(i)

  return (
    <PetHudModal title="My Pets" subtitle="Your colony. Tap a pet to select it and unlock slots to grow." width={S(620)} height={Math.round(S(620) / PET_MODAL_ASPECT)} onClose={() => ui.close()}>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignContent: 'flex-start' }}>
        {indices.map((i) => (
          <RosterSlotCard key={i} index={i} />
        ))}
      </UiEntity>
      {pageCount > 1 && (
        <UiEntity uiTransform={{ width: '100%', height: S(48), flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
          <TactileButton
            id="roster_prev"
            label="<"
            width={S(60)}
            height={S(40)}
            bg={LOC.neutral}
            textColor={PET_UI.ink}
            fontSize={S(20)}
            radius={S(12)}
            disabled={page === 0}
            onClick={() => (uiState.rosterPage = page - 1)}
          />
          <Label value={`${page + 1} / ${pageCount}`} fontSize={S(16)} color={PET_UI.muted} textAlign="middle-center" uiTransform={{ width: S(90), height: S(40) }} />
          <TactileButton
            id="roster_next"
            label=">"
            width={S(60)}
            height={S(40)}
            bg={LOC.neutral}
            textColor={PET_UI.ink}
            fontSize={S(20)}
            radius={S(12)}
            disabled={page >= pageCount - 1}
            onClick={() => (uiState.rosterPage = page + 1)}
          />
        </UiEntity>
      )}
    </PetHudModal>
  )
}

// ---------------------------------------------------------------------------
// Spin
// ---------------------------------------------------------------------------
function SpinPanel() {
  const p = clientState.player
  const last = clientState.lastSpin
  return (
    <PanelShell title="Spin Wheel" width={S(640)} onClose={() => ui.close()}>
      <Label value={`Spin tickets: ${p?.spinTickets ?? 0}`} fontSize={S(18)} color={C.gold} uiTransform={{ width: '100%', height: S(30) }} />
      <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', margin: { top: S(6) } }}>
        {Cfg.SPIN_REWARDS.map((r, i) => (
          <UiEntity
            key={`spin-${i}`}
            uiTransform={{ width: '100%', height: S(38), flexDirection: 'row', alignItems: 'center', padding: { left: S(14) }, margin: { bottom: S(5) }, borderRadius: S(10) }}
            uiBackground={{ color: r.rarity === 'jackpot' ? { r: 0.4, g: 0.2, b: 0.34, a: 1 } : r.rarity === 'rare' ? { r: 0.34, g: 0.3, b: 0.16, a: 1 } : C.card }}
          >
            <Label value={`${r.rarity.toUpperCase()}  -  ${r.label}`} fontSize={S(15)} color={r.rarity === 'jackpot' ? C.happy : r.rarity === 'rare' ? C.energy : C.dim} textAlign="middle-left" uiTransform={{ width: '100%', height: S(32) }} />
          </UiEntity>
        ))}
      </UiEntity>
      {last && <Label value={`You won: ${last.reward.label}!`} fontSize={S(20)} color={C.green} uiTransform={{ width: '100%', height: S(32) }} textAlign="middle-center" />}
      <UiEntity uiTransform={{ width: '100%', justifyContent: 'center', margin: { top: S(6) } }}>
        <TactileButton
          id="do_spin"
          label="SPIN!"
          width={S(300)}
          height={S(64)}
          bg={C.pink}
          textColor={C.outline}
          fontSize={S(26)}
          disabled={(p?.spinTickets ?? 0) <= 0}
          pulse={(p?.spinTickets ?? 0) > 0}
          onClick={() => {
            const res = spinLocal()
            if (res) {
              clientState.lastSpin = { reward: res.reward, index: res.index, at: Date.now() }
              pushToast(`Spin: ${res.reward.label}!`)
            }
            actions.spin()
          }}
        />
      </UiEntity>
    </PanelShell>
  )
}

// ---------------------------------------------------------------------------
// Server connection indicator — dev/debug. Green while the authoritative server
// is answering; a red warning when it goes quiet (we're on local sim only, so
// nothing persists).
// ---------------------------------------------------------------------------
const WARN_RED: Color = { r: 0.9, g: 0.26, b: 0.2, a: 1 }

function ServerStatus() {
  const ok = serverConnected()
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { bottom: S(10), right: S(12) },
        height: S(30),
        flexDirection: 'row',
        alignItems: 'center',
        padding: { left: S(8), right: S(12) },
        borderRadius: S(15),
        pointerFilter: 'none'
      }}
      uiBackground={{ color: ok ? C.panelBg : WARN_RED }}
    >
      <UiEntity
        uiTransform={{ width: S(10), height: S(10), borderRadius: S(5), margin: { right: S(7) } }}
        uiBackground={{ color: ok ? C.green : C.text }}
      />
      <Label
        value={ok ? 'Server' : 'Server offline — not saving'}
        fontSize={S(12)}
        color={C.text}
        textAlign="middle-left"
        textWrap="nowrap"
        uiTransform={{ height: S(20) }}
      />
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Daily reward — a login-streak ladder shown when you crack open the meteor.
// TODAY is claimable; the following days preview what you'd get if you keep
// coming back. Claim! gives the reward; Watch Ad grants 2x (ad is a stub).
// ---------------------------------------------------------------------------
function DailyDayCard(props: { key?: string; day: number; state: 'claimed' | 'today' | 'future' }) {
  const r = Cfg.STREAK_WEEK_REWARDS[props.day - 1]
  const today = props.state === 'today'
  const future = props.state === 'future'
  const cardW = S(106) // sized so all 7 ladder days fit one row
  return (
    <UiEntity
      uiTransform={{ width: cardW, height: S(168), flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', margin: S(4), padding: S(8), borderRadius: S(16) }}
      uiBackground={{ color: today ? LOC.blue : LOC.tile }}
    >
      <Label value={today ? 'TODAY' : `DAY ${props.day}`} fontSize={S(18)} color={today ? LOC.white : future ? LOC.dim : LOC.body} textAlign="middle-center" uiTransform={{ width: '100%', height: S(22) }} />
      <UiEntity uiTransform={{ width: cardW - S(22), height: S(84), alignItems: 'center', justifyContent: 'center', margin: { top: S(4), bottom: S(4) }, borderRadius: S(12) }} uiBackground={{ color: today ? LOC.white : LOC.card }}>
        <Label value={props.state === 'claimed' ? '✅' : '💰'} fontSize={S(44)} color={LOC.body} textAlign="middle-center" uiTransform={{ width: cardW - S(22), height: S(84) }} />
      </UiEntity>
      <UiEntity uiTransform={{ width: cardW - S(14), height: S(30), alignItems: 'center', justifyContent: 'center', borderRadius: S(10) }} uiBackground={{ color: today ? LOC.white : future ? LOC.neutral : LOC.green }}>
        <Label value={`$${r.currency}`} fontSize={S(18)} color={today ? LOC.blue : future ? LOC.dim : LOC.white} textAlign="middle-center" uiTransform={{ width: '100%', height: S(24) }} />
      </UiEntity>
    </UiEntity>
  )
}

function MeteorRewardPanel() {
  const weekDay = dailyLadderDay() // server-derived (from streakCount)
  const claimable = dailyClaimable() // server-derived (meteorDay gate)
  const days = [1, 2, 3, 4, 5, 6, 7].map((d) => {
    let state: 'claimed' | 'today' | 'future' = 'future'
    if (d < weekDay) state = 'claimed'
    else if (d === weekDay) state = claimable ? 'today' : 'claimed'
    return { d, state }
  })
  return (
    <LightModal title="Daily Rewards" width={S(920)} height={S(440)} onClose={() => ui.close()}>
      <Label value="Play every day to get better prizes!" fontSize={S(20)} color={LOC.body} textAlign="middle-center" uiTransform={{ width: '100%', height: S(28), margin: { bottom: S(6) } }} />
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center' }}>
        {days.map((c) => (
          <DailyDayCard key={`dd-${c.d}`} day={c.d} state={c.state} />
        ))}
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', margin: { top: S(14) } }}>
        {claimable ? (
          <TactileButton
            id="daily_claim"
            label="Claim!"
            width={S(300)}
            height={S(70)}
            bg={LOC.green}
            textColor={LOC.white}
            fontSize={S(26)}
            radius={S(18)}
            pulse
            onClick={() => {
              actions.claimDaily() // server grants + persists; toast comes back from it
              ui.close()
            }}
          />
        ) : (
          <TactileButton id="daily_done" label="Come back tomorrow!" width={S(360)} height={S(70)} bg={LOC.neutral} textColor={LOC.body} fontSize={S(22)} radius={S(18)} disabled onClick={() => {}} />
        )}
      </UiEntity>
    </LightModal>
  )
}

// ---------------------------------------------------------------------------
// Goals / achievements
// ---------------------------------------------------------------------------
function GoalsPanel() {
  const p = clientState.player
  return (
    <PetHudModal title="Goals" subtitle="Check your goals & achievements!" width={S(680)} height={Math.round(S(680) / PET_MODAL_ASPECT)} onClose={() => ui.close()}>
      <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', overflow: 'hidden' }}>
        {Cfg.ACHIEVEMENTS.map((a) => {
          const done = (p?.achievements.indexOf(a.id) ?? -1) !== -1
          const prog = Math.min(p?.counters[a.counter] ?? 0, a.goal)
          const pct = Math.round((prog / a.goal) * 100)
          return (
            <UiEntity key={a.id} uiTransform={{ width: '100%', height: S(66), flexDirection: 'column', margin: { bottom: S(6) }, padding: S(8), borderRadius: S(12) }} uiBackground={{ color: LOC.tile }}>
              <Label value={`${done ? '[done] ' : ''}${a.label}`} fontSize={S(16)} color={done ? LOC.green : LOC.body} textAlign="middle-left" uiTransform={{ width: '100%', height: S(22) }} />
              <UiEntity uiTransform={{ width: '100%', height: S(10), borderRadius: S(5), margin: { top: S(4), bottom: S(2) } }} uiBackground={{ color: LOC.neutral }}>
                <UiEntity uiTransform={{ width: `${pct}%`, height: '100%', borderRadius: S(5) }} uiBackground={{ color: done ? LOC.green : LOC.orange }} />
              </UiEntity>
              <Label value={`${a.description}  (${prog}/${a.goal})`} fontSize={S(13)} color={LOC.dim} textAlign="middle-left" uiTransform={{ width: '100%', height: S(18) }} />
            </UiEntity>
          )
        })}
      </UiEntity>
    </PetHudModal>
  )
}

// ---------------------------------------------------------------------------
// Daily reward — 7-day login streak calendar
// ---------------------------------------------------------------------------
function StreakCell(props: { key?: string; day: number; state: 'claimed' | 'today' | 'future' }) {
  const r = Cfg.STREAK_WEEK_REWARDS[props.day - 1]
  const jackpot = props.day === 7
  const cellW = jackpot ? S(150) : S(96)
  const bg = props.state === 'today' ? C.gold : props.state === 'claimed' ? C.greenDark : C.card
  const disc = jackpot ? C.pink : C.gold
  return (
    <UiEntity
      uiTransform={{ width: cellW, height: S(132), flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', margin: S(5), padding: S(8), borderRadius: S(14) }}
      uiBackground={{ color: bg }}
    >
      <Label value={jackpot ? 'DAY 7' : `Day ${props.day}`} fontSize={S(13)} color={props.state === 'future' ? C.dim : C.outline} textAlign="middle-center" uiTransform={{ width: '100%', height: S(18) }} />
      <UiEntity uiTransform={{ width: S(40), height: S(40), borderRadius: S(20), margin: { top: S(6), bottom: S(4) }, alignItems: 'center', justifyContent: 'center' }} uiBackground={{ color: disc }}>
        <Label value={props.state === 'claimed' ? 'OK' : 'C'} fontSize={S(16)} color={C.outline} textAlign="middle-center" uiTransform={{ width: S(40), height: S(40) }} />
      </UiEntity>
      <Label value={`${r.currency}`} fontSize={S(14)} color={props.state === 'future' ? C.dim : C.text} textAlign="middle-center" uiTransform={{ width: '100%', height: S(18) }} />
      {r.spins > 0 && <Label value={`+${r.spins} spin`} fontSize={S(11)} color={props.state === 'future' ? C.dim : C.pink} textAlign="middle-center" uiTransform={{ width: '100%', height: S(16) }} />}
    </UiEntity>
  )
}

function DailyRewardPanel() {
  const weekDay = streakWeekDay()
  const claimable = streakClaimable()
  const cells = [1, 2, 3, 4, 5, 6, 7].map((d) => {
    let state: 'claimed' | 'today' | 'future' = 'future'
    if (d < weekDay) state = 'claimed'
    else if (d === weekDay) state = claimable ? 'today' : 'claimed'
    return { d, state }
  })
  return (
    <PanelShell title="Daily Rewards" width={S(720)} height={S(520)} onClose={() => ui.close()}>
      <Label value={`Day ${clientState.streak.count} streak — log in daily, don't break it!`} fontSize={S(16)} color={C.dim} uiTransform={{ width: '100%', height: S(28), margin: { bottom: S(10) } }} textAlign="middle-center" />
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center' }}>
        {cells.map((c) => (
          <StreakCell key={`sc-${c.d}`} day={c.d} state={c.state} />
        ))}
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', justifyContent: 'center', margin: { top: S(12) } }}>
        {claimable ? (
          <TactileButton
            id="streak_claim"
            label={`Claim Day ${weekDay}`}
            width={S(320)}
            height={S(64)}
            bg={C.green}
            textColor={C.outline}
            fontSize={S(24)}
            pulse
            onClick={() => {
              const r = claimStreak()
              if (r) pushToast(`Day ${r.day} reward: +${r.currency} coins${r.spins ? ` +${r.spins} spins` : ''}!`)
            }}
          />
        ) : (
          <TactileButton id="streak_done" label="Come back tomorrow!" width={S(320)} height={S(64)} bg={C.cardAlt} fontSize={S(20)} disabled onClick={() => {}} />
        )}
      </UiEntity>
    </PanelShell>
  )
}

// ---------------------------------------------------------------------------
// Jukebox — ambient track picker (ported from the cozy-farm jukebox)
// ---------------------------------------------------------------------------
// Purely client-side: switching a track, muting or changing the volume never
// touches the authoritative server (see music.ts). The volume ladder is 5 steps
// instead of cozy-farm's 10 — this panel is roughly half as wide, so 10 buttons
// would land below a comfortable touch target on mobile.
const VOLUME_STEPS = [20, 40, 60, 80, 100]
// NOT module-level consts: S() reads the async-resolved platform, so anything
// computed at import time would be frozen at desktop scale.
const songRowH = () => S(62)
const songRowGap = () => S(8)

function SongRow(props: { key?: string; id: SongId; label: string; playing: boolean }) {
  return (
    <UiEntity
      uiTransform={{ width: '100%', height: songRowH(), flexDirection: 'row', alignItems: 'center', padding: { left: S(12), right: S(12) }, margin: { bottom: songRowGap() }, borderRadius: S(12), pointerFilter: 'block' }}
      uiBackground={{ color: props.playing ? LOC.blue : LOC.tile }}
      onMouseDown={() => {
        if (!props.playing) playSong(props.id)
      }}
    >
      <UiEntity
        uiTransform={{ width: S(40), height: S(40), borderRadius: S(20), margin: { right: S(12) }, alignItems: 'center', justifyContent: 'center' }}
        uiBackground={{ color: props.playing ? LOC.white : LOC.neutral }}
      >
        <Label value="♪" fontSize={S(20)} color={props.playing ? LOC.blue : LOC.dim} textAlign="middle-center" uiTransform={{ width: S(40), height: S(40) }} />
      </UiEntity>
      <UiEntity uiTransform={{ flex: 1, height: '100%', flexDirection: 'column', justifyContent: 'center' }}>
        <Label value={props.label} fontSize={S(18)} color={props.playing ? LOC.white : LOC.body} textAlign="middle-left" textWrap="nowrap" uiTransform={{ width: '100%', height: S(24) }} />
        {props.playing && (
          <Label
            value={musicState.muted ? 'Muted' : 'Now playing'}
            fontSize={S(13)}
            color={musicState.muted ? LOC.neutral : LOC.white}
            textAlign="middle-left"
            textWrap="nowrap"
            uiTransform={{ width: '100%', height: S(18) }}
          />
        )}
      </UiEntity>
    </UiEntity>
  )
}

function VolumeStep(props: { key?: string; pct: number; active: boolean; width: number }) {
  return (
    <UiEntity
      uiTransform={{ width: props.width, height: S(44), margin: { left: S(3), right: S(3) }, alignItems: 'center', justifyContent: 'center', borderRadius: S(10), pointerFilter: 'block' }}
      uiBackground={{ color: props.active ? LOC.orange : LOC.tile }}
      onMouseDown={() => {
        if (!props.active) setMusicVolume(props.pct / 100)
      }}
    >
      <Label value={`${props.pct}%`} fontSize={S(14)} color={props.active ? LOC.white : LOC.dim} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: S(20) }} />
    </UiEntity>
  )
}

function JukeboxPanel() {
  const modalW = S(620)
  const modalH = Math.round(modalW / PET_MODAL_ASPECT)
  const muted = musicState.muted
  // Snap the live volume to the nearest ladder step so exactly one button reads
  // as selected even when the value isn't on the ladder (the 42% default isn't).
  const volPct = musicState.volume * 100
  const activeStep = VOLUME_STEPS.reduce((best, pct) => (Math.abs(pct - volPct) < Math.abs(best - volPct) ? pct : best))
  const stepW = Math.round((modalW - S(60)) / VOLUME_STEPS.length) - S(6)
  return (
    <PetHudModal title="Jukebox" subtitle="Pick the colony's ambient track." width={modalW} height={modalH} onClose={() => ui.close()}>
      <UiEntity uiTransform={{ width: '100%', height: SONGS.length * (songRowH() + songRowGap()), flexDirection: 'column' }}>
        {SONGS.map((song) => (
          <SongRow key={song.id} id={song.id} label={song.label} playing={song.id === musicState.currentSongId} />
        ))}
      </UiEntity>

      <Label value="Volume" fontSize={S(15)} color={PET_UI.muted} textAlign="middle-center" uiTransform={{ width: '100%', height: S(24), margin: { top: S(6) } }} />
      <UiEntity uiTransform={{ width: '100%', height: S(44), flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}>
        {VOLUME_STEPS.map((pct) => (
          <VolumeStep key={`vol-${pct}`} pct={pct} active={pct === activeStep} width={stepW} />
        ))}
      </UiEntity>

      <UiEntity uiTransform={{ flex: 1, width: '100%', justifyContent: 'center', alignItems: 'flex-end', margin: { top: S(10) } }}>
        <TactileButton
          id="jukebox_mute"
          label={muted ? 'Unmute music' : 'Mute music'}
          width={S(280)}
          height={S(56)}
          bg={muted ? LOC.red : LOC.neutral}
          textColor={muted ? LOC.white : LOC.body}
          fontSize={S(19)}
          radius={S(14)}
          onClick={() => toggleMute()}
        />
      </UiEntity>
    </PetHudModal>
  )
}

// ---------------------------------------------------------------------------
// Toasts (screen center, slide in/out from the right)
// ---------------------------------------------------------------------------
// Shows one toast at a time from clientState.toasts (a queue) — advances to the
// next message once the current one expires, instead of stacking every pushed
// toast on screen at once. It deploys from the right edge into the middle of the
// screen (the one region with no HUD), holds, then retracts back to the right —
// so it never covers the top coin bar, the right-rail buttons, or a modal. The
// server `notify` kind picks the accent color (error/reward/progress/info).
const TOAST_ENTER_MS = 240 // slide-in from the right
const TOAST_HOLD_MS = 3100 // fully-shown dwell
const TOAST_EXIT_MS = 300 // retract back to the right
const TOAST_TOTAL_MS = TOAST_ENTER_MS + TOAST_HOLD_MS + TOAST_EXIT_MS
// Notification pill, drawn in code (no image): a cream fill inside a brown border,
// both fully rounded. TOAST_BORDER is pre-S (applied with S() at render).
const TOAST_BORDER = 5 // border thickness (pre-S)
const TOAST_BORDER_COLOR: Color = { r: 0.525, g: 0.318, b: 0.173, a: 1 } // #86512C brown
const TOAST_CREAM: Color = { r: 0.969, g: 0.941, b: 0.871, a: 1 } // #F7F0DE cream

const withAlpha = (c: Color, a: number): Color => ({ r: c.r, g: c.g, b: c.b, a: c.a * a })
const easeOutCubic = (p: number): number => 1 - Math.pow(1 - p, 3)

function Toasts() {
  const now = Date.now()
  // Hold the queue while a panel/modal/dialog owns the screen, so a toast can't
  // paint over open UI (the #186 overlap complaint). Nothing is shifted or shown
  // until they close, then the queue resumes.
  const overlayOpen =
    uiState.panel !== 'none' ||
    clientState.dialog.open ||
    clientState.petPanelOpen ||
    clientState.viewingPetAddress !== null ||
    clientState.incomingSwap !== null
  if (overlayOpen) return <UiEntity />
  if ((!clientState.currentToast || clientState.currentToast.until <= now) && clientState.toasts.length > 0) {
    const next = clientState.toasts.shift()!
    clientState.currentToast = { message: next.message, kind: next.kind, shownAt: now, until: now + TOAST_TOTAL_MS }
  }
  const t = clientState.currentToast
  if (!t || t.until <= now) return <UiEntity />

  // Slide in from the LEFT edge + fade, resting anchored top-left just below where
  // the BACK button sits (top ~25% + its S(90) height), so it never covers it.
  // Enter: from off-screen left -> rest. Exit: retract back off the left + fade.
  const elapsed = now - t.shownAt
  const remaining = t.until - now
  const w = S(500)
  const h = S(92)
  // Left inset: flush on desktop, nudged in on mobile so the native explorer's
  // corner HUD doesn't clip the left edge (the point of #213). NOT as far in as the
  // BackButton's S(210) — that reads too central for a notification; this is a
  // middle ground. Bump it up if it collides with the native corner UI on device,
  // down if it still feels too central. offMax must clear the resting inset + width.
  const leftInset = mobile() ? S(96) : S(16)
  const offMax = leftInset + w + S(20) // far enough left to sit fully off-screen while hidden
  let slide = 0
  let alpha = 1
  if (elapsed < TOAST_ENTER_MS) {
    const e = easeOutCubic(elapsed / TOAST_ENTER_MS)
    slide = -offMax * (1 - e)
    alpha = e
  } else if (remaining < TOAST_EXIT_MS) {
    const p = remaining / TOAST_EXIT_MS // 1 -> 0
    slide = -offMax * (1 - p)
    alpha = p
  }

  // NOT wrapped in ScreenInsetArea: it sits in the same (non-inset) coordinate
  // space as the BackButton and the rest of the HUD (getUiRendererConfig's
  // screenInset:'none'), so the two use one frame of reference and the vertical
  // gap to the BACK button is a constant S(104), not inset-dependent. The mobile
  // leftInset + the 25% top already keep it clear of notches/rounded corners.
  const border = S(TOAST_BORDER)
  return (
    // Top-left, below the BACK button, slide-in from the left. Same coordinate space
    // as the BackButton / rest of the HUD (no ScreenInsetArea). The pill is drawn in
    // code: a brown border (outer) wrapping a cream fill (inner), both fully rounded.
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { top: '25%', left: leftInset },
          margin: { top: S(104), left: slide }, // top: clear the BACK button (S(90) + gap); left: slide-in offset
          width: w,
          height: h,
          padding: border, // this padding IS the visible brown border
          borderRadius: h / 2,
          alignItems: 'center',
          justifyContent: 'center',
          pointerFilter: 'none'
        }}
        uiBackground={{ color: withAlpha(TOAST_BORDER_COLOR, alpha) }}
      >
        <UiEntity
          uiTransform={{
            width: '100%',
            height: '100%',
            borderRadius: h / 2 - border,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            padding: { left: S(44), right: S(44) } // clear the rounded caps so text sits on the flat middle
          }}
          uiBackground={{ color: withAlpha(TOAST_CREAM, alpha) }}
        >
          <Label value={t.message} fontSize={S(15)} color={withAlpha(PET_UI.ink, alpha)} textAlign="middle-center" uiTransform={{ width: '100%', height: h - S(24) }} />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

// Gamified reward popup — a quick "+XP  +coins" burst after a care action.
// Two rounded pills (star XP + coin), center-screen, auto-expiring.
function RewardPopup() {
  const r = clientState.reward
  if (!r || r.until <= Date.now()) {
    if (r) clientState.reward = null // expired: clear it
    return <UiEntity />
  }
  const pill = (icon: string, text: string, bg: Color) => (
    <UiEntity
      uiTransform={{ width: S(190), height: S(64), alignItems: 'center', justifyContent: 'center', borderRadius: S(32), margin: { left: S(8), right: S(8) } }}
      uiBackground={{ color: bg }}
    >
      <Label value={`${icon} ${text}`} fontSize={S(26)} color={LOC.white} textAlign="middle-center" uiTransform={{ width: S(182), height: S(42) }} />
    </UiEntity>
  )
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: '28%', left: '50%' }, margin: { left: -S(220) }, width: S(440), flexDirection: 'row', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}>
      {pill('⭐', `+${r.xp} XP`, LOC.violet)}
      {pill('🪙', `+${r.coins}`, LOC.orange)}
    </UiEntity>
  )
}

// Arrow icon (source art is 500x500; exported at 256x256 — plenty of headroom
// over this button's ~90-unit logical size on the highest-density mobile
// screens, at well under half the file size) for the shared BACK button below.
const BACK_ARROW_ICON = 'assets/images/revamp/backbutton256.png'

// Shared BACK button for full-screen action overlays (Petting / Fetch / Fruit
// game / Bath / Feed errand). Top-left, inset from the corner, pushed further
// in on mobile so the app's own corner UI doesn't cover it, and sat a quarter
// of the way down the screen (halfway between the top edge and
// screen-center). One place so every action's BACK matches.
function BackButton(props: { onClick: () => void; disabled?: boolean }) {
  const isM = mobile()
  const pos = { top: '25%' as const, left: isM ? S(210) : S(130) }
  const d = S(90)
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: pos, width: d, height: d, alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }}
      uiBackground={{
        texture: { src: BACK_ARROW_ICON },
        textureMode: 'stretch',
        // Disabled reads as greyed-out (not just faded) so it doesn't look like a
        // live button that's simply ignoring taps.
        color: props.disabled ? { r: 0.55, g: 0.55, b: 0.55, a: 0.55 } : { r: 1, g: 1, b: 1, a: 1 }
      }}
      onMouseDown={() => {
        if (!props.disabled) props.onClick()
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Pet gesture overlay — the camera is locked on the pet (rendered underneath),
// so this is a transparent layer: a BACK button, a hand that sways left/right to
// hint the swipe, and a progress bar. The hand is a placeholder (disc + emoji)
// until the designer's hand image lands.
// ---------------------------------------------------------------------------
function PettingOverlay() {
  const st = clientState.petting
  if (!st.active) return <UiEntity />
  const pct = Math.round(st.progress * 100)
  const handD = S(96)
  const isM = mobile()
  // Desktop/Bevy: a hand drifting side-to-side (swipe hint). Mobile: a centered
  // finger you tap (the app has no cursor-drag yet, so tapping fills the bar).
  const swayX = isM ? 0 : Math.round(sway() * S(150))
  const handIcon = isM ? '👆' : '✋'
  const hint = isM ? 'Tap your pet!' : 'Swipe left & right to pet!'
  return (
    // Full-screen blocker (transparent) so touches drive the gesture and never
    // reach the avatar. The pet shows through from the fixed camera. On mobile,
    // each tap here fills the bar (petTap); on desktop the swipe is polled.
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'block' }}
      uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0 } }}
      onMouseDown={() => {
        if (isM) petTap()
      }}
    >
      <BackButton onClick={() => cancelPetting()} />
      {/* Swipe hint: a hand that drifts side to side across the middle (over the
          centered pet). Placeholder disc + emoji until the hand art arrives. */}
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: '34%', left: '50%' }, width: handD, height: handD, margin: { left: -handD / 2 + swayX }, alignItems: 'center', justifyContent: 'center', pointerFilter: 'none' }}
      >
        <UiEntity
          uiTransform={{ width: handD, height: handD, borderRadius: Math.round(handD), alignItems: 'center', justifyContent: 'center' }}
          uiBackground={{ color: { r: 0.8, g: 0.8, b: 0.8, a: 0.28 } }}
        >
          <Label value={handIcon} fontSize={Math.round(handD * 0.5)} color={{ r: 1, g: 1, b: 1, a: 0.5 }} textAlign="middle-center" uiTransform={{ width: handD, height: handD }} />
        </UiEntity>
      </UiEntity>
      {/* Prompt + progress bar (bottom-center) */}
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { bottom: S(90), left: '50%' }, margin: { left: -S(190) }, width: S(380), flexDirection: 'column', alignItems: 'center', pointerFilter: 'none' }}
      >
        <OutlineLabel value={hint} fontSize={S(20)} color={C.text} width={'100%'} height={S(30)} textAlign="middle-center" />
        <UiEntity uiTransform={{ width: S(360), height: S(22), borderRadius: S(11), margin: { top: S(10) } }} uiBackground={{ color: C.trackBg }}>
          <UiEntity uiTransform={{ width: `${pct}%`, height: '100%', borderRadius: S(11) }} uiBackground={{ color: C.happy }} />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Hatch overlay — the egg is framed by a fixed camera; rub (desktop) / tap
// (mobile) to fill the bar and hatch the pet. Same gesture as petting.
// ---------------------------------------------------------------------------
function HatchOverlay() {
  const st = clientState.hatch
  if (!st.active) return <UiEntity />
  const pct = Math.round(st.progress * 100)
  const handD = S(96)
  const isM = mobile()
  const hatching = st.progress >= 1 // bar full: the egg is now playing its Hatch clip
  const swayX = isM ? 0 : Math.round(sway() * S(150))
  const handIcon = isM ? '👆' : '✋'
  const hint = hatching ? 'Hatching!' : isM ? 'Tap the egg to hatch!' : 'Rub the egg to hatch!'
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'block' }}
      uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0 } }}
      onMouseDown={() => {
        if (isM) hatchTap()
      }}
    >
      {/* Hand/finger hint over the centered egg (hidden once it's hatching) */}
      {!hatching && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: '34%', left: '50%' }, width: handD, height: handD, margin: { left: -handD / 2 + swayX }, alignItems: 'center', justifyContent: 'center', pointerFilter: 'none' }}
        >
          <UiEntity
            uiTransform={{ width: handD, height: handD, borderRadius: Math.round(handD), alignItems: 'center', justifyContent: 'center' }}
            uiBackground={{ color: { r: 0.8, g: 0.8, b: 0.8, a: 0.28 } }}
          >
            <Label value={handIcon} fontSize={Math.round(handD * 0.5)} color={{ r: 1, g: 1, b: 1, a: 0.5 }} textAlign="middle-center" uiTransform={{ width: handD, height: handD }} />
          </UiEntity>
        </UiEntity>
      )}
      {/* Prompt + progress bar */}
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { bottom: S(90), left: '50%' }, margin: { left: -S(190) }, width: S(380), flexDirection: 'column', alignItems: 'center', pointerFilter: 'none' }}
      >
        <OutlineLabel value={hint} fontSize={S(20)} color={C.text} width={'100%'} height={S(30)} textAlign="middle-center" />
        <UiEntity uiTransform={{ width: S(360), height: S(22), borderRadius: S(11), margin: { top: S(10) } }} uiBackground={{ color: C.trackBg }}>
          <UiEntity uiTransform={{ width: `${pct}%`, height: '100%', borderRadius: S(11) }} uiBackground={{ color: C.gold }} />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

// Calibrated positions for the mobile first-throw hint (bubble) and charge
// bar, in raw (pre-S()) pixels from the bottom-right corner — the native
// Throw button's exact screen position isn't something we control/know
// precisely, so these were found by testing on-device.
const bubbleBottomRaw = 180
const bubbleRightRaw = 250
const barBottomRaw = 320
const barRightRaw = 240

// ---------------------------------------------------------------------------
// Fetch (Play) mode — hold the Throw control to charge (a bar fills above it);
// releasing throws with that much power, which sets the distance/arc/flight
// time (see play.ts's beginThrow). Desktop shows its own labeled button;
// mobile instead gets a native on-screen gamepad button with a custom icon
// (play.ts's fetchTouchInputSystem + touchControls.ts — same icon throughout,
// reads its press/release to drive the same charge). Disables (busy) once
// thrown, until the pet drops the ball back at the player. BACK exits (only
// when not mid-charge/throw).
// ---------------------------------------------------------------------------
function FetchOverlay() {
  if (!clientState.fetch.active) return <UiEntity />
  const st = clientState.fetch
  const busy = st.busy
  const charging = st.charging
  const pct = Math.round(st.charge * 100)
  const isM = mobile()
  const pet = clientState.activePet
  // Every fetch costs PLAY_ENERGY_COST and pays XP + coins; under
  // PLAY_MIN_ENERGY the pet stops playing entirely. The meter below is the
  // whole loop made visible — the player can see the throws they have left.
  const energy = pet?.energy ?? 0
  const tired = !canPlayNow()
  const throwsLeft = Math.max(0, Math.floor((energy - Cfg.PLAY_MIN_ENERGY) / Cfg.PLAY_ENERGY_COST) + (tired ? 0 : 1))
  const bw = S(300)
  const bh = S(92)
  const meterW = S(360)
  const meterBottom = S(184)
  const meterH = S(74)
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
      {/* BACK — disabled while charging/mid-throw so you don't strand a charge or a ball in the air */}
      <BackButton disabled={busy || charging} onClick={() => (clientState.fetch.active = false)} />
      {/* Energy meter + reward line (bottom-center, above the Fetch button) —
          desktop only; mobile has no room for it next to the native button. */}
      {!isM && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: meterBottom, left: '50%' }, margin: { left: -meterW / 2 }, width: meterW, height: meterH, flexDirection: 'column', alignItems: 'center' }}>
          <Label
            value={tired ? 'Out of energy — time for bed' : `+${Cfg.PLAY_XP_REWARD} XP  ·  +${Cfg.PLAY_COINS_REWARD} coins per fetch`}
            fontSize={S(17)}
            color={tired ? C.hunger : C.text}
            textAlign="middle-center"
            uiTransform={{ width: '100%', height: S(22) }}
          />
          <UiEntity uiTransform={{ width: meterW, height: S(18), borderRadius: S(9) }} uiBackground={{ color: C.trackBg }}>
            <UiEntity uiTransform={{ width: `${Math.max(0, Math.min(100, energy))}%`, height: '100%', borderRadius: S(9) }} uiBackground={{ color: tired ? C.hunger : C.energy }} />
          </UiEntity>
          <Label
            value={tired ? 'Energy too low to play' : `Energy ${Math.round(energy)}  ·  ~${throwsLeft} throw${throwsLeft === 1 ? '' : 's'} left`}
            fontSize={S(15)}
            color={C.dim}
            textAlign="middle-center"
            uiTransform={{ width: '100%', height: S(20), margin: { top: S(4) } }}
          />
        </UiEntity>
      )}
      {/* Charge bar — fills 0→100% while held, above the energy meter. Desktop
          only — mobile has neither the meter nor this bar, just the vertical
          one below plus the one-time hint. */}
      {charging && !isM && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { bottom: meterBottom + meterH + S(18), left: '50%' }, margin: { left: -S(150) }, width: S(300), height: S(22), borderRadius: S(11) }}
          uiBackground={{ color: C.trackBg }}
        >
          <UiEntity uiTransform={{ width: `${pct}%`, height: '100%', borderRadius: S(11) }} uiBackground={{ color: C.gold }} />
        </UiEntity>
      )}
      {/* Mobile charge bar — subtle, thin, vertical (fills upward), calibrated
          on-device. Note for future positioning near this corner: the
          bottom-right is where the client draws its own native gamepad
          buttons OVER scene UI (docs: "Bottom-right action buttons — drawn
          deliberately over the [safe] area"), so anything placed too close to
          that corner's bottom edge gets hidden underneath them. */}
      {charging && isM && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { bottom: S(barBottomRaw), right: S(barRightRaw) }, width: S(14), height: S(90), borderRadius: S(7), pointerFilter: 'none' }}
          uiBackground={{ color: { r: 0.5, g: 0.5, b: 0.5, a: 0.35 } }}
        >
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { bottom: 0, left: 0 }, width: '100%', height: `${pct}%`, borderRadius: S(7) }}
            uiBackground={{ color: { r: 0.75, g: 0.9, b: 0.35, a: 0.65 } }}
          />
        </UiEntity>
      )}
      {/* Mobile first-throw hint — a speech bubble ("Hold to throw") pointing at
          the native Throw button, calibrated on-device. (The glow ring is
          pulled for now — bubble first.) Fully visible until the player's
          first throw (play.ts's beginThrow triggers the fade), then fades out
          for good — see ui/anim.ts's fetchHint*. */}
      {isM && fetchHintVisible() && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
          <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: S(bubbleBottomRaw), right: S(bubbleRightRaw) }, width: S(280), height: S(187) }}>
            <UiEntity
              uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: S(280), height: S(187) }}
              uiBackground={{ texture: { src: 'assets/images/revamp/bubble.png' }, textureMode: 'stretch', color: { r: 1, g: 1, b: 1, a: fetchHintAlpha() } }}
            />
            <Label
              value="Hold to throw"
              fontSize={S(20)}
              color={{ r: 0.25, g: 0.18, b: 0.14, a: fetchHintAlpha() }}
              textAlign="middle-center"
              uiTransform={{ positionType: 'absolute', position: { top: S(55), left: S(20) }, width: S(240), height: S(50) }}
            />
          </UiEntity>
        </UiEntity>
      )}
      {/* Desktop Throw button (bottom-center) — mobile's equivalent is the
          native gamepad button, not drawn here. */}
      {!isM && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: S(80), left: '50%' }, margin: { left: -bw / 2 }, width: bw, height: bh, alignItems: 'center', justifyContent: 'center' }}>
          <UiEntity
            uiTransform={{ width: bw, height: bh, alignItems: 'center', justifyContent: 'center', borderRadius: S(26), pointerFilter: busy || tired ? 'none' : 'block' }}
            uiBackground={{ color: busy || tired ? C.cardAlt : charging ? C.gold : C.green }}
            onMouseDown={() => !tired && startCharge()}
            onMouseUp={() => releaseCharge()}
            onMouseLeave={() => releaseCharge()}
          >
            <Label
              value={busy ? 'Searching…' : tired ? 'Too tired' : charging ? 'Release!' : 'Hold to Throw'}
              fontSize={S(28)}
              color={busy || tired ? C.dim : C.outline}
              textAlign="middle-center"
              uiTransform={{ width: bw, height: bh }}
            />
          </UiEntity>
        </UiEntity>
      )}
    </UiEntity>
  )
}

// Custom mobile move control for the catching phase — replaces the native
// joystick (hidden/restored from fruitGame.ts via TouchScreenControls) with a
// single-axis left/right button, since the lane only allows that anyway.
// uiInputBinding holds the action down for as long as the button is pressed,
// same as a native on-screen button.
const ARROW_ICON = {
  left: 'assets/images/left_arrow.png',
  left_pressed: 'assets/images/left_arrow_pressed.png',
  right: 'assets/images/right_arrow.png',
  right_pressed: 'assets/images/right_arrow_pressed.png'
}
// No passive way to read a UI element's held state — track it ourselves via
// mouse down/up (+ leave, so a touch dragged off the button doesn't stick
// visually pressed, matching uiInputBinding's own release semantics).
const arrowPressed = { left: false, right: false }

function MoveArrowButton(props: { side: 'left' | 'right' }) {
  const action = props.side === 'left' ? InputAction.IA_LEFT : InputAction.IA_RIGHT
  const pressed = arrowPressed[props.side]
  const icon = pressed ? ARROW_ICON[`${props.side}_pressed`] : ARROW_ICON[props.side]
  const size = S(120)
  const gap = S(420) // half-gap between the pair, centered as a group
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { bottom: S(60), left: '50%' },
        margin: { left: props.side === 'left' ? -(size + gap) : gap },
        width: size,
        height: size,
        pointerFilter: 'block'
      }}
      uiBackground={{ texture: { src: icon }, textureMode: 'stretch' }}
      uiInputBinding={{ actions: [action] }}
      onMouseDown={() => {
        arrowPressed[props.side] = true
      }}
      onMouseUp={() => {
        arrowPressed[props.side] = false
      }}
      onMouseLeave={() => {
        arrowPressed[props.side] = false
      }}
    />
  )
}

// Post-round reveal: a fruit count-up (0 -> caught) with a feed bar filling in
// lockstep (same fraction the actual hunger effect uses — Cfg.FEED_HUNGER_PER_FRUIT
// — so the bar reads as "this is how full your pet's about to get"), then Exit
// does the actual teardown (fruitGame.ts's finalizeAndClose). No BackButton here
// — the round is already decided, Exit is the only way out.
const RESULTS_COUNT_MS = 1500
function FeedResultsPanel() {
  const st = clientState.feedGame
  const elapsed = Date.now() - st.resultsAt
  const progress = Math.max(0, Math.min(1, RESULTS_COUNT_MS > 0 ? elapsed / RESULTS_COUNT_MS : 1))
  const shown = Math.round(progress * st.caught)
  const fillFrac = Math.max(0, Math.min(1, (st.caught * Cfg.FEED_HUNGER_PER_FRUIT) / 100))
  const barPct = Math.round(progress * fillFrac * 100)
  const cardW = S(460)
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }}
      uiBackground={{ color: C.scrim }}
    >
      <UiEntity
        uiTransform={{
          width: cardW,
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: S(24),
          padding: { top: S(28), bottom: S(28), left: S(24), right: S(24) },
          pointerFilter: 'block'
        }}
        uiBackground={{ color: C.panelBg }}
      >
        <OutlineLabel value="Fruits caught!" fontSize={S(28)} color={C.gold} width={cardW - S(48)} height={S(40)} textAlign="middle-center" />
        <Label
          value={`${shown}`}
          fontSize={S(64)}
          color={C.hunger}
          textAlign="middle-center"
          uiTransform={{ width: '100%', height: S(80), margin: { top: S(8) } }}
        />
        <Label value="Pet fed" fontSize={S(16)} color={C.dim} textAlign="middle-center" uiTransform={{ width: '100%', height: S(20), margin: { bottom: S(6) } }} />
        <UiEntity uiTransform={{ width: cardW - S(80), height: S(24), borderRadius: S(12), margin: { bottom: S(26) } }} uiBackground={{ color: C.trackBg }}>
          <UiEntity uiTransform={{ width: `${barPct}%`, height: '100%', borderRadius: S(12) }} uiBackground={{ color: C.hunger }} />
        </UiEntity>
        <TactileButton
          id="feed_results_exit"
          label="Exit"
          width={S(220)}
          height={S(70)}
          bg={C.green}
          textColor={C.outline}
          fontSize={S(26)}
          radius={S(24)}
          onClick={() => exitFeedResults()}
        />
      </UiEntity>
    </UiEntity>
  )
}

// DEBUG: live camera calibration panel for the fruit game cinematic (toggled
// by the "3" hotkey, input.ts). +/- nudges the relevant constant in
// fruitGame.ts and re-applies it straight to the active cinematic camera —
// "Print values" logs the final numbers to hardcode back into the source.
const DEBUG_CAM_STEP = 0.1
function DebugCamPanel() {
  if (!clientState.debugCamPanelOpen) return <UiEntity />
  const keys: DebugCamKey[] = debugCamAvailableKeys()
  const panelW = S(340)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: S(300), left: S(24) },
        width: panelW,
        flexDirection: 'column',
        alignItems: 'center',
        borderRadius: S(16),
        padding: S(14),
        pointerFilter: 'block'
      }}
      uiBackground={{ color: C.panelBg }}
    >
      <Label
        value={`Cam calib (${mobile() ? 'mobile' : 'desktop'})`}
        fontSize={S(18)}
        color={C.gold}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: S(26), margin: { bottom: S(6) } }}
      />
      {keys.map((k) => (
        <UiEntity key={k} uiTransform={{ width: '100%', height: S(40), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Label
            value={`${debugCamLabel(k)}: ${debugCamValue(k).toFixed(2)}`}
            fontSize={S(15)}
            color={C.text}
            textAlign="middle-left"
            uiTransform={{ width: S(190), height: S(30) }}
          />
          <TactileButton id={`debugcam_${k}_minus`} label="-" width={S(40)} height={S(34)} bg={C.card} onClick={() => debugCamAdjust(k, -DEBUG_CAM_STEP)} />
          <TactileButton id={`debugcam_${k}_plus`} label="+" width={S(40)} height={S(34)} bg={C.card} margin={{ left: S(6) }} onClick={() => debugCamAdjust(k, DEBUG_CAM_STEP)} />
        </UiEntity>
      ))}
      {mobile() ? (
        <TactileButton
          id="debugcam_toggle_close"
          label={debugCamIsClosePreview() ? 'Preview: CLOSE' : 'Preview: WIDE'}
          width={panelW - S(28)}
          height={S(38)}
          bg={C.cardAlt}
          margin={{ top: S(8) }}
          onClick={() => debugCamToggleClosePreview()}
        />
      ) : null}
      <TactileButton
        id="debugcam_print"
        label="Print values"
        width={panelW - S(28)}
        height={S(38)}
        bg={C.green}
        textColor={C.outline}
        margin={{ top: S(8) }}
        onClick={() => debugCamPrint()}
      />
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Feed tree minigame overlay (fruitGame.ts): "how to play" + arrows during
// arrival/intro (before the player can move freely to catch anything), then a
// fruit counter + countdown while catching (plus, on mobile, the custom
// left/right move buttons in place of the native joystick). BACK bails early,
// submitting whatever was caught so far (same as a natural timeout). Once the
// round ends, FeedResultsPanel takes over instead (see below).
// ---------------------------------------------------------------------------
function FeedGameOverlay() {
  const st = clientState.feedGame
  if (!st.active) return <UiEntity />
  if (st.phase === 'results') return <FeedResultsPanel />
  const catching = st.phase === 'catching'
  const introPhase = st.phase === 'intro'
  const countdown = st.phase === 'countdown'
  // Brief pop on the counter each time a fruit lands — works on every client,
  // unlike a particle effect would (Unity desktop only, so it's not used here).
  const flashing = Date.now() < st.catchFlashUntil
  const countdownNum = Math.max(1, Math.min(COUNTDOWN_S, Math.ceil(COUNTDOWN_S - (Date.now() - st.countdownAt) / 1000)))
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
      {/* BACK sits outside ScreenInsetArea, unwrapped like every other
          BACK-button overlay (Petting/Fetch/Bath/FeedErrand) — its own inset
          already clears the corner comfortably. Everything else here stays
          wrapped: this minigame owns the whole screen (cinematic camera, edge-
          anchored counter/timer panel, move arrows, debug panel) and needs the
          safe-area protection ScreenInsetArea provides on mobile (fixes #134;
          the renderer's own screenInset:'none' opts out of automatic inset
          scene-wide, so this wrapper is the only safe-area handling here). */}
      <BackButton onClick={() => cancelFruitGame()} />
      <ScreenInsetArea>
        <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
          <UiEntity
            uiTransform={
              catching
                ? {
                    positionType: 'absolute',
                    position: { top: S(160), right: S(24) },
                    width: S(320),
                    height: S(70),
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: S(20),
                    pointerFilter: 'none'
                  }
                : {
                    positionType: 'absolute',
                    position: { top: S(90), left: '50%' },
                    margin: { left: -S(220) },
                    width: S(440),
                    height: S(120),
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: S(20),
                    pointerFilter: 'none'
                  }
            }
            uiBackground={{ color: C.panelBg }}
          >
            {catching ? (
              <Label
                value={`Fruits: ${st.caught}   ${Math.ceil(st.timeLeft)}s`}
                fontSize={flashing ? S(34) : S(28)}
                color={flashing ? C.gold : C.hunger}
                textAlign="middle-center"
                uiTransform={{ width: '100%', height: S(36) }}
              />
            ) : countdown ? (
              <Label value={`${countdownNum}`} fontSize={S(72)} color={C.gold} textAlign="middle-center" uiTransform={{ width: '100%', height: '100%' }} />
            ) : (
              <UiEntity uiTransform={{ width: '100%', height: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                <Label value="◀" fontSize={S(36)} color={C.gold} textAlign="middle-center" uiTransform={{ width: S(50), height: S(50) }} />
                <Label
                  value="Move left and right to catch the food falling from the tree!"
                  fontSize={S(22)}
                  color={C.text}
                  textAlign="middle-center"
                  textWrap="wrap"
                  uiTransform={{ width: S(320), height: S(100) }}
                />
                <Label value="▶" fontSize={S(36)} color={C.gold} textAlign="middle-center" uiTransform={{ width: S(50), height: S(50) }} />
              </UiEntity>
            )}
          </UiEntity>
          {introPhase ? (
            <UiEntity uiTransform={{ positionType: 'absolute', position: { top: S(220), left: '50%' }, margin: { left: -S(110) }, width: S(220), height: S(70), pointerFilter: 'none' }}>
              <TactileButton id="feed_start" label="Start" width={S(220)} height={S(70)} bg={C.green} textColor={C.outline} fontSize={S(28)} radius={S(24)} pulse onClick={() => startCatchingCountdown()} />
            </UiEntity>
          ) : null}
          {mobile() ? <MoveArrowButton side="left" /> : null}
          {mobile() ? <MoveArrowButton side="right" /> : null}
          <DebugCamPanel />
        </UiEntity>
      </ScreenInsetArea>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Bubble-bath minigame overlay (see client/bathGame.ts). Light-blue circles rise
// up the screen at irregular speeds; tap them to pop. Pop BUBBLE_GOAL within the
// time to get the pet clean. Bubble positions/sizes come straight from the module
// bubble list (getBubbles), which the bath tick mutates every frame.
// ---------------------------------------------------------------------------
const BUBBLE_FILL = { r: 0.5, g: 0.8, b: 0.98, a: 0.82 } // celeste
const BUBBLE_SHINE = { r: 1, g: 1, b: 1, a: 0.55 }

function BathBubble(props: { key?: string; b: Bubble }) {
  const b = props.b
  const size = S(b.r * 2)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { left: `${b.x * 100}%`, top: `${b.y * 100}%` },
        margin: { left: -size / 2, top: -size / 2 }, // center the circle on (x,y)
        width: size,
        height: size,
        borderRadius: size / 2
      }}
      uiBackground={{ color: BUBBLE_FILL }}
      onMouseDown={() => popBubble(b.id)}
    >
      {/* little highlight so it reads as a bubble, not a flat disc */}
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { left: size * 0.22, top: size * 0.18 }, width: size * 0.26, height: size * 0.26, borderRadius: size * 0.13 }}
        uiBackground={{ color: BUBBLE_SHINE }}
      />
    </UiEntity>
  )
}

function BathResultsPanel() {
  const st = clientState.bathGame
  const clean = st.popped >= BUBBLE_GOAL
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }}
      uiBackground={{ color: C.scrim }}
    >
      <UiEntity
        uiTransform={{ width: S(480), height: S(310), flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRadius: S(24) }}
        uiBackground={{ color: C.panelBg }}
      >
        <Label value={clean ? 'Squeaky clean!' : 'Almost!'} fontSize={S(40)} color={clean ? C.hygiene : C.gold} textAlign="middle-center" uiTransform={{ width: '100%', height: S(52) }} />
        <Label value={`You popped ${st.popped} bubbles`} fontSize={S(24)} color={C.text} textAlign="middle-center" uiTransform={{ width: '100%', height: S(38), margin: { top: S(8), bottom: S(14) } }} />
        <Label
          value={clean ? '+Hygiene' : `Pop ${BUBBLE_GOAL} to get your pet clean — try again!`}
          fontSize={S(20)}
          color={C.dim}
          textAlign="middle-center"
          textWrap="wrap"
          uiTransform={{ width: S(420), height: S(46), margin: { bottom: S(18) } }}
        />
        <TactileButton id="bath_exit" label={clean ? 'Done' : 'Close'} width={S(200)} height={S(64)} bg={C.green} textColor={C.outline} fontSize={S(26)} radius={S(22)} pulse onClick={() => exitBathResults()} />
      </UiEntity>
    </UiEntity>
  )
}

function BathGameOverlay() {
  const st = clientState.bathGame
  if (!st.active) return <UiEntity />
  if (st.phase === 'results') return <BathResultsPanel />
  const popping = st.phase === 'popping'
  const intro = st.phase === 'intro'
  const countdown = st.phase === 'countdown'
  const flashing = Date.now() < st.popFlashUntil
  const countdownNum = Math.max(1, Math.min(BATH_COUNTDOWN_S, Math.ceil(BATH_COUNTDOWN_S - (Date.now() - st.countdownAt) / 1000)))
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
      <BackButton onClick={() => cancelBathGame()} />
      <ScreenInsetArea>
        <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
          {/* the bubbles — only score during 'popping', but they float during intro/countdown too */}
          {getBubbles().map((b) => (
            <BathBubble key={`bub-${b.id}`} b={b} />
          ))}
          {/* HUD: counter+timer / countdown / intro instructions. Same layout as
              the feed minigame — the live counter sits top-right (responsive,
              mobile-friendly), intro/countdown are centered. */}
          <UiEntity
            uiTransform={
              popping
                ? {
                    positionType: 'absolute',
                    position: { top: S(160), right: S(24) },
                    width: S(320),
                    height: S(70),
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: S(20),
                    pointerFilter: 'none'
                  }
                : {
                    positionType: 'absolute',
                    position: { top: S(90), left: '50%' },
                    margin: { left: -S(220) },
                    width: S(440),
                    height: S(120),
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: S(20),
                    pointerFilter: 'none'
                  }
            }
            uiBackground={{ color: C.panelBg }}
          >
            {popping ? (
              <Label
                value={`Bubbles: ${st.popped}/${BUBBLE_GOAL}    ${Math.ceil(st.timeLeft)}s`}
                fontSize={flashing ? S(34) : S(28)}
                color={flashing ? C.gold : C.hygiene}
                textAlign="middle-center"
                uiTransform={{ width: '100%', height: S(36) }}
              />
            ) : countdown ? (
              <Label value={`${countdownNum}`} fontSize={S(72)} color={C.gold} textAlign="middle-center" uiTransform={{ width: '100%', height: '100%' }} />
            ) : (
              <Label
                value={`Tap the bubbles to scrub your pet clean!\nPop ${BUBBLE_GOAL} before time runs out.`}
                fontSize={S(22)}
                color={C.text}
                textAlign="middle-center"
                textWrap="wrap"
                uiTransform={{ width: S(400), height: S(100) }}
              />
            )}
          </UiEntity>
          {intro ? (
            <UiEntity uiTransform={{ positionType: 'absolute', position: { top: S(230), left: '50%' }, margin: { left: -S(110) }, width: S(220), height: S(70), pointerFilter: 'none' }}>
              <TactileButton id="bath_start" label="Start" width={S(220)} height={S(70)} bg={C.green} textColor={C.outline} fontSize={S(28)} radius={S(24)} pulse onClick={() => startBathCountdown()} />
            </UiEntity>
          ) : null}
        </UiEntity>
      </ScreenInsetArea>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// "Choose Location!" modal — shown on scene entry (Adopt-Me style). Two options:
// Adoption Center (adopt a pet) and House (care for your pet). Centered, rounded,
// mobile-first. Uses its own bright palette to match the reference look.
// ---------------------------------------------------------------------------
const LOC = {
  card: { r: 1, g: 0.93, b: 0.95, a: 0.9 } as Color, // very light pink, slightly translucent
  title: { r: 0.29, g: 0.56, b: 0.95, a: 1 } as Color,
  titleOutline: { r: 1, g: 1, b: 1, a: 1 } as Color,
  tile: { r: 1, g: 1, b: 1, a: 1 } as Color,
  tileBorder: { r: 0.9, g: 0.91, b: 0.94, a: 1 } as Color,
  orange: { r: 0.95, g: 0.55, b: 0.16, a: 1 } as Color,
  blue: { r: 0.25, g: 0.66, b: 0.95, a: 1 } as Color,
  green: { r: 0.35, g: 0.75, b: 0.45, a: 1 } as Color,
  red: { r: 0.9, g: 0.24, b: 0.2, a: 1 } as Color,
  violet: { r: 0.6, g: 0.5, b: 0.86, a: 1 } as Color, // pastel violet (Keep)
  rose: { r: 0.9, g: 0.55, b: 0.72, a: 1 } as Color, // pastel rose (Discard)
  white: { r: 1, g: 1, b: 1, a: 1 } as Color,
  body: { r: 0.2, g: 0.22, b: 0.28, a: 1 } as Color, // dark text on the light card
  dim: { r: 0.5, g: 0.47, b: 0.53, a: 1 } as Color,
  neutral: { r: 0.85, g: 0.85, b: 0.88, a: 1 } as Color // back/secondary button
}

// Shared light modal shell (pink card + blue title + designer close button) —
// the "Choose Location!"/tutorial look. Used by the adoption flow.
const LOC_CLOSE = 'assets/images/tutorialUi/btn_close.png'
function LightModal(props: { title: string; width: number; height: number; onClose: () => void; children?: any }) {
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }}
      uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.5 } }}
      onMouseDown={() => {}}
    >
      <UiEntity
        uiTransform={{ width: props.width, height: props.height, flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', padding: { top: S(28), bottom: S(30), left: S(30), right: S(30) }, borderRadius: S(28), pointerFilter: 'block' }}
        uiBackground={{ color: LOC.card }}
      >
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: S(16), right: S(16) }, width: S(52), height: S(52), pointerFilter: 'block' }}
          uiBackground={{ texture: { src: LOC_CLOSE }, textureMode: 'stretch' }}
          onMouseDown={props.onClose}
        />
        <OutlineLabel value={props.title} fontSize={S(42)} color={LOC.title} outlineColor={LOC.titleOutline} width={'100%'} height={S(58)} textAlign="middle-center" />
        {/* Explicit height (NOT flex:1): Unity collapses flex-grow fill, piling the
            content up. height = card - paddings - title - margin. */}
        <UiEntity uiTransform={{ width: '100%', height: props.height - S(126), flexDirection: 'column', alignItems: 'center', margin: { top: S(10) }, overflow: 'hidden' }}>
          {props.children}
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Carry-egg-home flow — while carrying an egg, a hint says "take it home"; once
// the player is home a big centered "Hatch" button starts the rub-to-hatch flow.
// ---------------------------------------------------------------------------
const PET_HUD_SHEET = 'assets/images/revamp/hud2.png'
const PET_NEXT_TEXTURE = 'assets/images/tutorialUi/btn_next.png'
const PET_HUD_W = 1024
const PET_HUD_H = 1024

function petHudUvRect(x0: number, y0: number, x1: number, y1: number): number[] {
  const uL = x0 / PET_HUD_W
  const uR = x1 / PET_HUD_W
  const vTop = 1 - y0 / PET_HUD_H
  const vBottom = 1 - y1 / PET_HUD_H
  return [uL, vBottom, uL, vTop, uR, vTop, uR, vBottom]
}

const PET_MODAL_BOX = { x0: 532, y0: 277, x1: 988, y1: 710 }
const PET_CARD_SELECTED_BOX = { x0: 526, y0: 42, x1: 752, y1: 245 }
const PET_CARD_PLAIN_BOX = { x0: 531, y0: 745, x1: 757, y1: 947 }
const PET_CLOSE_PINK_BOX = { x0: 43, y0: 538, x1: 151, y1: 646 }

const PET_MODAL_UVS = petHudUvRect(PET_MODAL_BOX.x0, PET_MODAL_BOX.y0, PET_MODAL_BOX.x1, PET_MODAL_BOX.y1)
const PET_CARD_SELECTED_UVS = petHudUvRect(PET_CARD_SELECTED_BOX.x0, PET_CARD_SELECTED_BOX.y0, PET_CARD_SELECTED_BOX.x1, PET_CARD_SELECTED_BOX.y1)
const PET_CARD_PLAIN_UVS = petHudUvRect(PET_CARD_PLAIN_BOX.x0, PET_CARD_PLAIN_BOX.y0, PET_CARD_PLAIN_BOX.x1, PET_CARD_PLAIN_BOX.y1)
const PET_CLOSE_PINK_UVS = petHudUvRect(PET_CLOSE_PINK_BOX.x0, PET_CLOSE_PINK_BOX.y0, PET_CLOSE_PINK_BOX.x1, PET_CLOSE_PINK_BOX.y1)

const PET_MODAL_ASPECT = (PET_MODAL_BOX.x1 - PET_MODAL_BOX.x0) / (PET_MODAL_BOX.y1 - PET_MODAL_BOX.y0)
const PET_CARD_ASPECT = (PET_CARD_SELECTED_BOX.x1 - PET_CARD_SELECTED_BOX.x0) / (PET_CARD_SELECTED_BOX.y1 - PET_CARD_SELECTED_BOX.y0)
const PET_NEXT_ASPECT = 639 / 378

// Inventory item card template (hud3.png) — outlined card with a pink count
// badge (top-right) and a baked-in "Use" button (green enabled / gray
// disabled), plus the two food-bowl icons that fill each card.
const INV_SHEET = 'assets/images/revamp/hud3.png'
const INV_SHEET_W = 1024
const INV_SHEET_H = 1024
function invUvRect(x0: number, y0: number, x1: number, y1: number): number[] {
  const uL = x0 / INV_SHEET_W
  const uR = x1 / INV_SHEET_W
  const vTop = 1 - y0 / INV_SHEET_H
  const vBottom = 1 - y1 / INV_SHEET_H
  return [uL, vBottom, uL, vTop, uR, vTop, uR, vBottom]
}
const INV_CARD_ENABLED_BOX = { x0: 85, y0: 67, x1: 490, y1: 566 }
const INV_CARD_DISABLED_BOX = { x0: 516, y0: 67, x1: 921, y1: 566 }
const INV_BOWL1_BOX = { x0: 148, y0: 655, x1: 378, y1: 829 }
const INV_BOWL2_BOX = { x0: 593, y0: 636, x1: 816, y1: 831 }
const INV_CARD_ENABLED_UVS = invUvRect(INV_CARD_ENABLED_BOX.x0, INV_CARD_ENABLED_BOX.y0, INV_CARD_ENABLED_BOX.x1, INV_CARD_ENABLED_BOX.y1)
const INV_CARD_DISABLED_UVS = invUvRect(INV_CARD_DISABLED_BOX.x0, INV_CARD_DISABLED_BOX.y0, INV_CARD_DISABLED_BOX.x1, INV_CARD_DISABLED_BOX.y1)
const INV_BOWL1_UVS = invUvRect(INV_BOWL1_BOX.x0, INV_BOWL1_BOX.y0, INV_BOWL1_BOX.x1, INV_BOWL1_BOX.y1)
const INV_BOWL2_UVS = invUvRect(INV_BOWL2_BOX.x0, INV_BOWL2_BOX.y0, INV_BOWL2_BOX.x1, INV_BOWL2_BOX.y1)
const INV_CARD_ASPECT = (INV_CARD_ENABLED_BOX.x1 - INV_CARD_ENABLED_BOX.x0) / (INV_CARD_ENABLED_BOX.y1 - INV_CARD_ENABLED_BOX.y0)
const INV_BOWL1_ASPECT = (INV_BOWL1_BOX.x1 - INV_BOWL1_BOX.x0) / (INV_BOWL1_BOX.y1 - INV_BOWL1_BOX.y0)
const INV_BOWL2_ASPECT = (INV_BOWL2_BOX.x1 - INV_BOWL2_BOX.x0) / (INV_BOWL2_BOX.y1 - INV_BOWL2_BOX.y0)

// Top HUD bars (name/level, coins, colony pets count) + bottom nav icons
// (Pets/Inventory/Goals). Same 1024x1024 sheet size as PET_HUD_SHEET above, so
// petHudUvRect's math applies as-is.
const HUD_SHEET = 'assets/images/revamp/hud.png'
const BAR_NAME_BOX = { x0: 56, y0: 838, x1: 731, y1: 988 }
const BAR_COIN_BOX = { x0: 576, y0: 181, x1: 827, y1: 306 }
const BAR_PETS_BOX = { x0: 567, y0: 30, x1: 989, y1: 155 }
const NAV_PAW_BOX = { x0: 34, y0: 612, x1: 238, y1: 817 }
const NAV_INV_BOX = { x0: 263, y0: 612, x1: 466, y1: 817 }
const NAV_GOALS_BOX = { x0: 492, y0: 614, x1: 696, y1: 817 }
// Round music/trophy icon badges, stacked just under the coin pill in the
// sheet — now used in the top HUD row next to the pets counter instead of
// their old floating mid-right placeholder spot.
const HUD_MUSIC_BOX = { x0: 578, y0: 338, x1: 697, y1: 457 }
const HUD_TROPHY_BOX = { x0: 578, y0: 473, x1: 697, y1: 592 }

const BAR_NAME_UVS = petHudUvRect(BAR_NAME_BOX.x0, BAR_NAME_BOX.y0, BAR_NAME_BOX.x1, BAR_NAME_BOX.y1)
const BAR_COIN_UVS = petHudUvRect(BAR_COIN_BOX.x0, BAR_COIN_BOX.y0, BAR_COIN_BOX.x1, BAR_COIN_BOX.y1)
const BAR_PETS_UVS = petHudUvRect(BAR_PETS_BOX.x0, BAR_PETS_BOX.y0, BAR_PETS_BOX.x1, BAR_PETS_BOX.y1)
const NAV_PAW_UVS = petHudUvRect(NAV_PAW_BOX.x0, NAV_PAW_BOX.y0, NAV_PAW_BOX.x1, NAV_PAW_BOX.y1)
const NAV_INV_UVS = petHudUvRect(NAV_INV_BOX.x0, NAV_INV_BOX.y0, NAV_INV_BOX.x1, NAV_INV_BOX.y1)
const NAV_GOALS_UVS = petHudUvRect(NAV_GOALS_BOX.x0, NAV_GOALS_BOX.y0, NAV_GOALS_BOX.x1, NAV_GOALS_BOX.y1)
const HUD_MUSIC_UVS = petHudUvRect(HUD_MUSIC_BOX.x0, HUD_MUSIC_BOX.y0, HUD_MUSIC_BOX.x1, HUD_MUSIC_BOX.y1)
const HUD_TROPHY_UVS = petHudUvRect(HUD_TROPHY_BOX.x0, HUD_TROPHY_BOX.y0, HUD_TROPHY_BOX.x1, HUD_TROPHY_BOX.y1)

const BAR_NAME_ASPECT = (BAR_NAME_BOX.x1 - BAR_NAME_BOX.x0) / (BAR_NAME_BOX.y1 - BAR_NAME_BOX.y0)
const BAR_COIN_ASPECT = (BAR_COIN_BOX.x1 - BAR_COIN_BOX.x0) / (BAR_COIN_BOX.y1 - BAR_COIN_BOX.y0)
const BAR_PETS_ASPECT = (BAR_PETS_BOX.x1 - BAR_PETS_BOX.x0) / (BAR_PETS_BOX.y1 - BAR_PETS_BOX.y0)

const PET_UI = {
  scrim: { r: 0, g: 0, b: 0, a: 0.38 } as Color,
  ink: { r: 0.23, g: 0.17, b: 0.15, a: 1 } as Color,
  muted: { r: 0.48, g: 0.41, b: 0.37, a: 1 } as Color,
  white: { r: 1, g: 1, b: 1, a: 1 } as Color,
  badge: { r: 0.42, g: 0.37, b: 0.34, a: 1 } as Color,
  lock: { r: 0.58, g: 0.52, b: 0.49, a: 1 } as Color,
  coinOuter: { r: 0.96, g: 0.62, b: 0.19, a: 1 } as Color,
  coinInner: { r: 1, g: 0.78, b: 0.42, a: 1 } as Color
}

function PetHudModal(props: { title: string; subtitle?: string; width: number; height: number; onClose: () => void; children?: any }) {
  const topPad = S(26)
  const sidePad = S(30)
  const titleH = S(36)
  const subtitleH = props.subtitle ? S(38) : 0
  const bodyTop = props.subtitle ? S(10) : S(18)
  const bodyH = props.height - topPad - titleH - subtitleH - bodyTop - S(26)

  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }}
      uiBackground={{ color: PET_UI.scrim }}
      onMouseDown={() => {}}
    >
      <UiEntity uiTransform={{ width: props.width, height: props.height }}>
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: props.width, height: props.height }} uiBackground={{ texture: { src: PET_HUD_SHEET }, textureMode: 'stretch', uvs: PET_MODAL_UVS }} />
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: S(14), right: S(26) }, width: S(42), height: S(42), pointerFilter: 'block' }}
          uiBackground={{ texture: { src: PET_HUD_SHEET }, textureMode: 'stretch', uvs: PET_CLOSE_PINK_UVS }}
          onMouseDown={props.onClose}
        />
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: topPad, left: sidePad }, width: props.width - sidePad * 2, height: props.height - topPad - S(24), flexDirection: 'column', alignItems: 'center' }}>
          <Label value={props.title} fontSize={S(30)} color={PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: titleH }} />
          {props.subtitle ? <Label value={props.subtitle} fontSize={S(15)} color={PET_UI.muted} textAlign="middle-center" textWrap="wrap" uiTransform={{ width: '100%', height: subtitleH, margin: { top: S(4) } }} /> : null}
          <UiEntity uiTransform={{ width: '100%', height: bodyH, margin: { top: bodyTop }, flexDirection: 'column', alignItems: 'center', overflow: 'hidden' }}>{props.children}</UiEntity>
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

// Same hud2 card background + pink close button as PetHudModal, but with no
// built-in title bar — for panels (like the pet status detail) whose content
// already renders its own header (name/level) inline.
function PetHudCard(props: { width: number; height: number; onClose: () => void; children?: any }) {
  const sidePad = S(30)
  const topPad = S(26)
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }}
      uiBackground={{ color: PET_UI.scrim }}
      onMouseDown={() => {}}
    >
      <UiEntity uiTransform={{ width: props.width, height: props.height }}>
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: props.width, height: props.height }} uiBackground={{ texture: { src: PET_HUD_SHEET }, textureMode: 'stretch', uvs: PET_MODAL_UVS }} />
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: S(14), right: S(26) }, width: S(42), height: S(42), pointerFilter: 'block' }}
          uiBackground={{ texture: { src: PET_HUD_SHEET }, textureMode: 'stretch', uvs: PET_CLOSE_PINK_UVS }}
          onMouseDown={props.onClose}
        />
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: topPad, left: sidePad }, width: props.width - sidePad * 2, height: props.height - topPad * 2, flexDirection: 'column', alignItems: 'center', overflow: 'hidden' }}>
          {props.children}
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

function PetGridCard(props: { selected: boolean; width: number; height: number; onClick?: () => void; children?: any }) {
  return (
    <UiEntity uiTransform={{ width: props.width, height: props.height, margin: { left: S(6), right: S(6), top: S(6), bottom: S(6) } }}>
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: props.width, height: props.height, pointerFilter: props.onClick ? 'block' : 'none' }}
        uiBackground={{ texture: { src: PET_HUD_SHEET }, textureMode: 'stretch', uvs: props.selected ? PET_CARD_SELECTED_UVS : PET_CARD_PLAIN_UVS }}
        onMouseDown={props.onClick}
      />
      <UiEntity uiTransform={{ positionType: 'absolute', position: { top: S(18), left: S(18) }, width: props.width - S(36), height: props.height - S(36), flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        {props.children}
      </UiEntity>
    </UiEntity>
  )
}

function PriceDot(props: { size?: number }) {
  const d = props.size ?? S(18)
  const inner = Math.max(6, Math.round(d * 0.5))
  return (
    <UiEntity uiTransform={{ width: d, height: d, borderRadius: d / 2, alignItems: 'center', justifyContent: 'center' }} uiBackground={{ color: PET_UI.coinOuter }}>
      <UiEntity uiTransform={{ width: inner, height: inner, borderRadius: inner / 2 }} uiBackground={{ color: PET_UI.coinInner }} />
    </UiEntity>
  )
}

function CarryHatchButton() {
  const st = clientState.carryEgg
  if (!st.active) return <UiEntity />
  // While walking home there's no fixed banner — the "take your egg home"
  // guidance now rides the toast pipeline (fired when the flow starts).
  if (!st.atHome) return <UiEntity />
  const bw = S(300)
  const bh = S(92)
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: S(80), left: '50%' }, margin: { left: -bw / 2 }, width: bw, height: bh, alignItems: 'center', justifyContent: 'center', pointerFilter: 'none' }}>
      <TactileButton id="carry_hatch" label="Hatch" width={bw} height={bh} bg={C.green} textColor={C.outline} fontSize={S(34)} radius={S(26)} pulse onClick={() => beginHatchFromCarry()} />
    </UiEntity>
  )
}

// Carry-pet-to-bath flow — a hint while walking to the tub, then a big "Bath"
// button once close; tapping it places the pet in the tub and bathes it.
function BathButton() {
  const st = clientState.carryPet
  if (!st.active) return <UiEntity />
  const bw = S(300)
  const bh = S(92)
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
      {/* BACK — cancel the bath and just keep the pet following */}
      <BackButton onClick={() => cancelCarryPet()} />
      {!st.atStation ? (
        // Walking to the tub — no fixed banner; the "carry your pet to the bath"
        // guidance is a toast fired when the flow starts.
        <UiEntity />
      ) : (
        // At the tub — place the pet.
        <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: S(80), left: '50%' }, margin: { left: -bw / 2 }, width: bw, height: bh, alignItems: 'center', justifyContent: 'center', pointerFilter: 'none' }}>
          <TactileButton id="place_bath" label="Bath" width={bw} height={bh} bg={C.hygiene} textColor={C.outline} fontSize={S(34)} radius={S(26)} pulse onClick={() => placePetAtStation()} />
        </UiEntity>
      )}
    </UiEntity>
  )
}

// Feed errand — the player is out walking to the tree behind the guide arrow
// (feed.ts). Same shape as the bath carry: a banner saying where to go and a
// BACK button, which is the whole point here — the errand blocks every other
// care action while it runs, so there has to be a way out of it that doesn't
// require finishing the walk.
function FeedErrandOverlay() {
  if (!clientState.feedTask.active) return <UiEntity />
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
      <BackButton onClick={() => cancelFeedTask()} />
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: S(90), left: '50%' }, margin: { left: -S(240) }, width: S(480), height: S(58), alignItems: 'center', justifyContent: 'center', borderRadius: S(29), pointerFilter: 'none' }}
        uiBackground={{ color: C.panelBg }}
      >
        <Label value="Follow the arrow to the tree!" fontSize={S(20)} color={C.text} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: S(30) }} />
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Loading gate — invisible for the normal case (the server usually answers in
// well under a second), but if it's genuinely taking a while, a small message
// appears so a slow/dead server doesn't look like a silent freeze with zero
// feedback. Intentionally NOT a big persistent card like the old
// LoadingServerOverlay — the request was to remove that, not to remove all
// feedback whatsoever. This does not lift the freeze: per setup.ts, the scene
// is deliberately not playable offline, so it stays blocked until the server
// answers (or forever, if it never does).
// ---------------------------------------------------------------------------
let loadingGateSince = 0
const LOADING_HINT_DELAY_MS = 8000

function LoadingGate() {
  if (loadingGateSince === 0) loadingGateSince = Date.now()
  const waitingTooLong = Date.now() - loadingGateSince > LOADING_HINT_DELAY_MS
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'flex-end', pointerFilter: 'block' }}>
      {waitingTooLong && (
        <Label
          value="Still connecting to the server…"
          fontSize={S(16)}
          color={C.dim}
          textAlign="middle-center"
          uiTransform={{ width: '100%', height: S(30), margin: { bottom: S(60) } }}
        />
      )}
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
const Root = () => {
  // In petting mode the camera is locked on the pet — hide the whole HUD so
  // nothing covers it, leaving only the petting overlay (BACK + swipe hint).
  // Hatching also owns the whole screen (egg framed by a fixed camera).
  // Feed tree minigame also owns the whole screen (cinematic camera under the tree).
  // Computed as a value (not early-returned) so UI_DEBUG_MODE's browser bar
  // below can render on top of ANY of these branches, not just the default one.
  const content =
    !clientState.serverReady ? (
      <LoadingGate />
    ) : clientState.petting.active ? (
      <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
        <PettingOverlay />
      </UiEntity>
    ) : clientState.hatch.active ? (
      <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
        <HatchOverlay />
      </UiEntity>
    ) : clientState.feedGame.active ? (
      <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
        <FeedGameOverlay />
      </UiEntity>
    ) : clientState.bathGame.active ? (
      <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
        <BathGameOverlay />
      </UiEntity>
    ) : (
      <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
        <ServerStatus />
        <TopBars />
        <RemotePetPanel />
        <SwapOfferPanel />
        <SideButtons />
        <BottomNav />
        <FetchOverlay />
        <CarryHatchButton />
        <BathButton />
        <FeedErrandOverlay />
        {/* Rendered after the HUD chrome (side buttons, bottom nav) so it paints
            on top of them instead of the nav icons poking through over it. */}
        <PetPanel />
        {uiState.panel === 'adopt' && <AdoptPanel />}
        {uiState.panel === 'breedName' && <BreedNamePanel />}
        {uiState.panel === 'shop' && <ShopPanel />}
        {uiState.panel === 'roster' && <RosterPanel />}
        {uiState.panel === 'inventory' && <InventoryPanel />}
        {uiState.panel === 'spin' && <SpinPanel />}
        {uiState.panel === 'meteor' && <MeteorRewardPanel />}
        {uiState.panel === 'goals' && <GoalsPanel />}
        {uiState.panel === 'daily' && <DailyRewardPanel />}
        {uiState.panel === 'jukebox' && <JukeboxPanel />}
        {uiState.panel === 'leaderboard' && <LeaderboardPanel />}
        <DialogBox />
        {/* Reward + toasts render LAST so they sit on top of any panel/modal. */}
        <RewardPopup />
        <Toasts />
      </UiEntity>
    )
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
      {content}
      {UI_DEBUG_MODE && <DebugBrowserBar />}
    </UiEntity>
  )
}

let uiRendererSyncRegistered = false
let lastAppliedUiRendererSignature = ''

function applyUiRenderer(force: boolean = false): void {
  const config = getUiRendererConfig()
  const signature = `${mobile()}:${config.virtualWidth}x${config.virtualHeight}:${config.screenInset}`
  if (!force && signature === lastAppliedUiRendererSignature) return

  ReactEcsRenderer.setUiRenderer(Root, config)
  lastAppliedUiRendererSignature = signature
}

function syncUiRendererSystem(): void {
  applyUiRenderer()
}

export function setupUi(): void {
  if (!uiRendererSyncRegistered) {
    uiRendererSyncRegistered = true
    engine.addSystem(syncUiRendererSystem)
  }

  resolveRuntimePlatform()
  startAnimSystem()
  applyUiRenderer(true)
}
