// Mobile-first HUD + panels for MyDearPet, modeled on the cozy-farm IO layout:
//  - TOP: player profile bar (Caretaker level + XP) -> taps to Goals
//  - TOP (when a pet is selected): pet stat bars + care actions
//  - BOTTOM: 3 big nav buttons (Pets / Inventory / Goals)
//  - NATIVE MOBILE: Whistle/Stay + active pet actions
// Reads the client mirror of authoritative server state.

import ReactEcs, { InteractableArea, ReactEcsRenderer, Label, ScreenInsetArea, UiEntity, Input } from '@dcl/sdk/react-ecs'
import { engine, InputAction, inputSystem, PointerEventType, UiCanvasInformation } from '@dcl/sdk/ecs'
import * as Cfg from '../shared/config'
import { cancelArkRedeem, confirmArkRedeem, openArkConfirm, startArkRedeem } from './arkRedeem'
import type { CareAction, PetData, Rarity } from '../shared/types'
import { actions, clientState, discardHatchling, keepHatchling, pushToast, switchActivePet, hasPendingHatchling } from './state'
import {
  startPetting,
  cancelPetting,
  petTap,
  hatchTap,
  startGetEgg,
  getEggPending,
  cancelGetEgg,
  beginHatchFromCarry,
  startCarryPet,
  placePetAtStation,
  cancelCarryPet,
  canStartPetInteraction,
  startBreedErrand,
  cancelBreed,
  placeParentA,
  chooseBreedPartner,
  startBreedCross,
  getBreedFx,
  BREED_ORB_FRAMES,
  BREED_BURST_FRAMES,
  playPetVoice
} from './pet'
import { hidePetTouchControls, NAV_GOALS_TOUCH_ACTION, NAV_INVENTORY_TOUCH_ACTION, NAV_ROSTER_TOUCH_ACTION, showPetTouchControls } from './touchControls'
import { musicState, playSong, setMusicVolume, SONGS, type SongId, toggleMute } from './music'
import { triggerCare, careActive, queueLength } from './input'
import { cancelFeedTask, startFeedTask } from './feed'
import {
  cancelFruitGame,
  exitFeedResults,
  startCatchingCountdown,
  COUNTDOWN_S,
  FEED_RESULTS_CARD_FADE_S,
  FEED_RESULTS_FOCUS_S,
  feedResultsCounterDurationMs,
  FEED_PET_SIT_TUNER_ENABLED,
  getFeedPetSitTuning,
  nudgeFeedPetSit,
  resetFeedPetSitTuning,
  type FeedPetSitAxis
} from './fruitGame'
import { getBubbles, getPops, popBubble, startBathCountdown, exitBathResults, cancelBathGame, BUBBLE_GOAL, BATH_COUNTDOWN_S, BUBBLE_POP_FRAMES, BUBBLE_POP_MS, type Bubble, type PopFx } from './bathGame'
import { dismissMeteorAfterClaim } from './meteor'
import { buyItemLocal, buyPotionLocal, buySlotLocal, canPlayNow, claimStreak, dailyClaimable, dailyLadderDay, sleepLockLeft, sleepTimerLeft, spinLocal, streakClaimable, streakWeekDay, useItemLocal } from './sim'
import { sway, startAnimSystem, attentionPulse, fetchHintAlpha, fetchHintVisible, getPress, triggerPress } from './ui/anim'
import { C, Color, getUiRendererConfig, mobile, OutlineLabel, PanelShell, playUiClick, resolveRuntimePlatform, S, Sbtn, TactileButton } from './ui/theme'
import { DialogBox, openCaretakerIntro, openCaretakerTips, playerName } from './ui/dialog'
import { endCaretakerIntroLock } from './caretaker'
import { DebugBrowserBar, UI_DEBUG_MODE } from './ui/debugBrowser'
import { pepitoStealHidesHud } from './pepitoSteal'
import { areCriticalUiAssetsReady } from './uiAssets'
import {
  ARK_HANDOVER_TUNER_ENABLED,
  closeArkLaunchCard,
  closeArkThanks,
  debugPlayArkHandover,
  getArkHandoverTuning,
  nudgeArkHandover,
  resetArkHandoverTuning,
  toggleArkHandoverPause,
  type ArkTuneKey
} from './arkCinematics'

export type Panel =
  | 'none'
  | 'adopt'
  | 'shop'
  | 'roster'
  | 'inventory'
  | 'spin'
  | 'goals'
  | 'daily'
  | 'meteor'
  | 'breedName'
  | 'jukebox'
  | 'leaderboard'
  | 'album'
  | 'arkDonate'
  | 'arkRanking'
export type ShopTabId = 'food' | 'slots'
type MobileNameInput = 'adopt' | 'breed'
type MobileMagnifierPhase = 'idle' | 'opening' | 'closing'

// The HUD group is intentionally offset from the canvas centre. Keep floating
// feedback on the same visual axis rather than the raw screen midpoint.
const TOP_HUD_CENTER_SHIFT = 40

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
  rosterPage: 0,
  // Album page = rarity tier being viewed (0 common, 1 rare, 2 legendary).
  albumPage: 0,
  // Choose a Partner (breeding) page — same 4-per-row paging as My Pets.
  breedPickerPage: 0,
  // Ark (Captain) panel: pet-picker page.
  arkPage: 0
}

const MOBILE_NAME_OVERLAY_MS = 260
const mobileMagnifier = {
  target: null as MobileNameInput | null,
  phase: 'idle' as MobileMagnifierPhase,
  startedAt: 0,
  // UiInput can report a submit as an immediately-following onChange. Remember
  // that value only long enough to ignore that echo; a later changed value opens
  // the magnifier normally.
  submittedEcho: null as { target: MobileNameInput; value: string } | null
}

function resetMobileMagnifier(): void {
  mobileMagnifier.target = null
  mobileMagnifier.phase = 'idle'
  mobileMagnifier.startedAt = 0
  mobileMagnifier.submittedEcho = null
}

function showMobileMagnifier(target: MobileNameInput): void {
  if (mobileMagnifier.target === target && mobileMagnifier.phase === 'opening') return
  mobileMagnifier.target = target
  mobileMagnifier.phase = 'opening'
  mobileMagnifier.startedAt = Date.now()
}

function hideMobileMagnifier(target: MobileNameInput, value: string): void {
  mobileMagnifier.submittedEcho = { target, value }
  if (mobileMagnifier.target !== target || mobileMagnifier.phase === 'idle') return
  mobileMagnifier.phase = 'closing'
  mobileMagnifier.startedAt = Date.now()
}

function isMobileMagnifierSubmitEcho(target: MobileNameInput, value: string): boolean {
  const echo = mobileMagnifier.submittedEcho
  if (!echo) return false
  if (echo.target !== target) {
    mobileMagnifier.submittedEcho = null
    return false
  }
  mobileMagnifier.submittedEcho = null
  return echo.value === value
}

function mobileMagnifierVisible(target: MobileNameInput): boolean {
  return mobileMagnifier.target === target && mobileMagnifier.phase !== 'idle'
}

function mobileMagnifierProgress(): number {
  const elapsed = Date.now() - mobileMagnifier.startedAt
  const linear = Math.max(0, Math.min(1, elapsed / MOBILE_NAME_OVERLAY_MS))
  const eased = linear * linear * (3 - 2 * linear)
  return mobileMagnifier.phase === 'closing' ? 1 - eased : eased
}

function syncMobileMagnifierSystem(): void {
  if (mobileMagnifier.phase === 'closing' && Date.now() - mobileMagnifier.startedAt >= MOBILE_NAME_OVERLAY_MS) {
    resetMobileMagnifier()
  }
}

export const ui = {
  openAdopt(): void {
    // One hatchling at a time: finish (keep/discard) the current one first.
    if (hasPendingHatchling()) {
      pushToast('Place or discard your current pet first.')
      return
    }
    // One egg at a time — don't let a second adoption overwrite an egg that's
    // still waiting at the Caretaker (its species/name would be lost silently).
    if (getEggPending()) {
      pushToast('Go to the Caretaker to pick up your egg first!')
      return
    }
    uiState.panel = 'adopt'
    uiState.adoptStep = 'pick'
    resetMobileMagnifier()
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
  openAlbum(): void {
    uiState.panel = 'album'
    uiState.albumPage = 0
  },
  openLeaderboard(): void {
    uiState.panel = 'leaderboard'
    actions.requestLeaderboard() // fetch fresh standings each time it opens
  },
  // The Captain's panel: pick an Adult pet to send aboard the Ark.
  openArkDonate(): void {
    uiState.panel = 'arkDonate'
    uiState.arkPage = 0
  },
  openArkRanking(): void {
    uiState.panel = 'arkRanking'
    actions.requestArkLeaderboard() // fetch fresh standings each time it opens
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
    resetMobileMagnifier()
  }
}

// DEBUG bridge for ui/debugBrowser.tsx — lets it force any panel/uiState field
// directly, bypassing ui.openX()'s guard conditions (e.g. openAdopt() blocks if
// a hatchling already exists). Not part of the public `ui` API above.
export function debugForcePanel(panel: Panel): void {
  uiState.panel = panel
}
/** True while any nav panel is up — the Ark launch waits for it to close. */
export function uiPanelOpen(): boolean {
  return uiState.panel !== 'none'
}
export function debugSetUiState(patch: Partial<{ shopTab: ShopTabId; adoptStep: 'pick' | 'name'; breedUsePotion: boolean; rosterPage: number; albumPage: number }>): void {
  Object.assign(uiState, patch)
}

// True while any big modal/panel owns the screen (inventory, animal actions,
// swap offer, passport, adopt, shop, etc.) — used to hold off the toast queue
// (#186) and to hide the bottom nav so its icons don't poke through under/over
// whatever's open.
function bigUiOpen(): boolean {
  return (
    uiState.panel !== 'none' ||
    clientState.dialog.open ||
    clientState.petPanelOpen ||
    clientState.viewingPetAddress !== null ||
    clientState.incomingSwap !== null ||
    clientState.ark.thanks !== null ||
    (clientState.arkRedeem.active && clientState.arkRedeem.phase === 'confirm') ||
    (clientState.breed.active && clientState.breed.phase === 'pickB') // Choose a Partner
  )
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
      onMouseDown={() => {
        playUiClick()
        ui.openGoals()
      }}
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

// The shared goal: creatures sent aboard the Ark by the whole colony, out of
// the Ark's target. Broadcast by the server, so every player sees the same number.
function PetsCountBar(props: { height: number }) {
  const h = props.height
  const w = Math.round(h * BAR_PETS_ASPECT)
  const pop = clientState.ark.status.donated
  const goal = clientState.ark.status.goal
  const textW = Math.round(w * 0.65)
  return (
    <UiEntity uiTransform={{ width: w, height: h }} uiBackground={{ texture: { src: HUD_SHEET }, textureMode: 'stretch', uvs: BAR_PETS_UVS }}>
      <UiEntity uiTransform={{ positionType: 'absolute', position: { right: S(28), top: 0 }, width: textW, height: h, overflow: 'hidden' }}>
        <Label
          value={`${pop}/${goal}`}
          fontSize={S(22)}
          color={PET_UI.ink}
          textAlign="middle-right"
          textWrap="nowrap"
          uiTransform={{ width: textW, height: h }}
        />
      </UiEntity>
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
    !clientState.breed.active &&
    !clientState.hatch.active
  const iconsW = gap + iconSize + gap + iconSize // music + album (leaderboard is now the physical in-world board)
  const totalW = w1 + gap + w2 + gap + w3 + (showIcons ? iconsW : 0)
  const rightShift = S(TOP_HUD_CENTER_SHIFT) // nudged off-center — plenty of clearance either side of this row
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
          {/* Album takes the leaderboard's old slot — the leaderboard now lives on the physical in-world board. */}
          <TactileButton id="hud_album" label="" texture={ALBUM_ICON} width={iconSize} height={iconSize} onClick={() => ui.openAlbum()} />
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
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: S(8), bottom: S(2) } }}>
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
// no separate title bar); RemotePetPanel leaves them off since its PetHudModal
// title already shows the name/level.
type PetProfilePhoto = { src: string; uvs?: number[] }

/**
 * Junior pets use their exact creature portrait from the album sheet. Unlike
 * the original-family thumbnails, those sheets include every head/body cross
 * and every rarity, so a newborn never falls back to a plain color disc.
 */
function petProfilePhoto(species: string, rarity: Rarity, size: number): PetProfilePhoto | undefined {
  if (Cfg.petStage(size) === 'JUNIOR') {
    const { head, body } = Cfg.speciesParts(species)
    const albumIndex = Cfg.ALBUM_SPECIES.indexOf(Cfg.crossSpecies(head, body))
    if (albumIndex >= 0) return { src: ALBUM_SHEETS[rarity], uvs: albumCellUvs(albumIndex) }
  }

  const src = Cfg.speciesImage(species)
  return src ? { src } : undefined
}

function PetIdentityRow(props: { species: string; rarity: Rarity; size: number; width: number; name?: string; level?: number; ring?: boolean }) {
  const photo = petProfilePhoto(props.species, props.rarity, props.size)
  const rc = Cfg.RARITY_COLOR[props.rarity] ?? Cfg.RARITY_COLOR.common
  const rarityColor: Color = { r: rc.r, g: rc.g, b: rc.b, a: 1 }
  const discSize = S(84)
  const textW = props.width - discSize - S(14)
  return (
    <UiEntity uiTransform={{ width: props.width, flexDirection: 'row', alignItems: 'center', margin: { bottom: S(10) } }}>
      <UiEntity
        uiTransform={{ width: discSize, height: discSize, borderRadius: discSize / 2, margin: { right: S(14) } }}
        uiBackground={
          photo
            ? { texture: { src: photo.src }, textureMode: 'stretch', ...(photo.uvs ? { uvs: photo.uvs } : {}) }
            : { color: speciesColor(props.species) }
        }
      >
        {props.ring ? (
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: -S(4), left: -S(4) }, width: discSize + S(8), height: discSize + S(8) }}
            uiBackground={{ texture: { src: PASSPORT_PARTS }, textureMode: 'stretch', uvs: PASSPORT_RING_UVS }}
          />
        ) : null}
      </UiEntity>
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

// ---------------------------------------------------------------------------
// Revamp pill buttons for the Animal Actions panel — same look as the Feed/Bath
// HUD "Start" button (dark outline, light top band, darker bottom band, gloss,
// soft drop shadow). The art has NO text: labels here are dynamic ("Wake · 2:30",
// "Play · Tired", "Breed · Adult"), so they're drawn on top with an outline in
// the pill's own dark tone. Two shapes sized to this panel: `chip` (the 4 care
// buttons) and `wide` (Pet / Breed).
// ---------------------------------------------------------------------------
const PILL_SHEET = 'assets/images/revamp/pet_action_buttons.png'
const PILL_SHEET_W = 2048
const PILL_SHEET_H = 512
type PillColor = 'orange' | 'blue' | 'yellow' | 'pink' | 'purple' | 'green' | 'gray'
const PILL_BOX: Record<string, { x0: number; y0: number; x1: number; y1: number }> = {
  chip_orange: { x0: 0, y0: 0, x1: 304, y1: 120 },
  chip_blue: { x0: 312, y0: 0, x1: 616, y1: 120 },
  chip_yellow: { x0: 624, y0: 0, x1: 928, y1: 120 },
  chip_pink: { x0: 936, y0: 0, x1: 1240, y1: 120 },
  chip_gray: { x0: 1248, y0: 0, x1: 1552, y1: 120 },
  wide_pink: { x0: 0, y0: 128, x1: 632, y1: 236 },
  wide_purple: { x0: 640, y0: 128, x1: 1272, y1: 236 },
  wide_gray: { x0: 1280, y0: 128, x1: 1912, y1: 236 },
  // Passport (another player's pet): full-width buttons
  pass_green: { x0: 0, y0: 256, x1: 656, y1: 336 },
  pass_purple: { x0: 664, y0: 256, x1: 1320, y1: 336 },
  pass_gray: { x0: 1328, y0: 256, x1: 1984, y1: 336 },
  // Half-width buttons (two side by side): Swap Offer Accept / Decline
  half_green: { x0: 0, y0: 392, x1: 360, y1: 482 },
  half_pink: { x0: 368, y0: 392, x1: 728, y1: 482 },
  half_gray: { x0: 736, y0: 392, x1: 1096, y1: 482 }
}
// Dark outline tone of each pill, reused as the label's outline.
const PILL_INK: Record<PillColor, Color> = {
  orange: { r: 0.55, g: 0.24, b: 0.04, a: 1 },
  blue: { r: 0.09, g: 0.32, b: 0.55, a: 1 },
  yellow: { r: 0.59, g: 0.39, b: 0.03, a: 1 },
  pink: { r: 0.59, g: 0.16, b: 0.35, a: 1 },
  purple: { r: 0.31, g: 0.17, b: 0.59, a: 1 },
  green: { r: 0.09, g: 0.35, b: 0.12, a: 1 },
  gray: { r: 0.41, g: 0.39, b: 0.37, a: 1 }
}
const PILL_SHADOW_FRAC = 8 / 120 // bottom strip of each cell is the drop shadow
const PILL_HALF_ASPECT = (PILL_BOX.half_green.x1 - PILL_BOX.half_green.x0) / (PILL_BOX.half_green.y1 - PILL_BOX.half_green.y0)
// Soft tan edge for the name field on the revamp panels' cream background.
const ADOPT_INPUT_BORDER: Color = { r: 0.87, g: 0.8, b: 0.71, a: 1 }

function PillButton(props: {
  id: string
  label: string
  shape: 'chip' | 'wide' | 'pass' | 'half'
  color: PillColor
  width: number
  height: number
  onClick: () => void
  disabled?: boolean
  pulse?: boolean
  fontSize?: number
  margin?: Partial<{ top: number; right: number; bottom: number; left: number }>
}) {
  const color: PillColor = props.disabled ? 'gray' : props.color
  const b = PILL_BOX[`${props.shape}_${color}`] ?? PILL_BOX[`${props.shape}_gray`]
  const uvs = [b.x0 / PILL_SHEET_W, 1 - b.y1 / PILL_SHEET_H, b.x0 / PILL_SHEET_W, 1 - b.y0 / PILL_SHEET_H, b.x1 / PILL_SHEET_W, 1 - b.y0 / PILL_SHEET_H, b.x1 / PILL_SHEET_W, 1 - b.y1 / PILL_SHEET_H]
  const scale = getPress(props.id) * (props.pulse && !props.disabled ? attentionPulse() : 1)
  const w = Math.round(props.width * scale)
  const h = Math.round(props.height * scale)
  const bodyH = Math.round(h * (1 - PILL_SHADOW_FRAC))
  return (
    <UiEntity uiTransform={{ width: props.width, height: props.height, alignItems: 'center', justifyContent: 'center', margin: props.margin }}>
      <UiEntity
        uiTransform={{ width: w, height: h, flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start' }}
        uiBackground={{ texture: { src: PILL_SHEET }, textureMode: 'stretch', uvs }}
        onMouseDown={() => {
          if (props.disabled) return
          triggerPress(props.id)
          playUiClick()
          props.onClick()
        }}
      >
        <OutlineLabel value={props.label} fontSize={props.fontSize ?? S(17)} color={PET_UI.white} outlineColor={PILL_INK[color]} width={w} height={bodyH} />
      </UiEntity>
    </UiEntity>
  )
}

function PetPanel() {
  const pet = clientState.activePet
  // Never show the actions panel while a hatchling is still pending Keep/Discard —
  // its actions would run on a pet that isn't accepted into a slot yet (bug). The
  // Keep/Discard modal owns this moment.
  if (!pet || !clientState.petPanelOpen || hasPendingHatchling() || clientState.feedGame.active) return <UiEntity />

  const care = (a: CareAction) => triggerCare(a)
  // Keep the former on-screen width so care controls retain their readable size,
  // while matching the re-baked 998x730 frame aspect ratio.
  const panelW = S(700)
  const panelH = Math.round(PET_ACTIONS_TEX_H * (panelW / PET_ACTIONS_TEX_W))
  const contentW = panelW - S(30) * 2 // Pet Actions inner width (card minus padding)
  const chipW = Math.floor((contentW - S(30)) / 4) // 4 care buttons across, with slack
  const chipH = S(60)
  const halfW = Math.round((contentW - S(8)) / 2)
  const thirdW = Math.round((contentW - S(16)) / 3)
  const unlocked = Cfg.petStage(pet.size) === 'ADULT'
  const otherPets = clientState.player?.pets.filter((x) => x.id !== pet.id) ?? []
  const partner = otherPets.find((x) => Cfg.petStage(x.size) === 'ADULT')
  // Interactions are mutually exclusive: a moment already in progress (carry-
  // to-bathe, petting, fetch, hatching, or a queued care action) blocks
  // starting another, and being asleep blocks everything except waking up.
  const busy = !canStartPetInteraction() && !pet.sleeping
  const locked = pet.sleeping || busy
  // Exhaustion naps show the 30-second wake lock first. Once it finishes, the
  // control switches to the remaining nap timer and becomes Wake.
  const lockLeft = sleepLockLeft()
  const sleepLeft = sleepTimerLeft()
  // Energy gate: below PLAY_MIN_ENERGY the pet refuses to play until it sleeps.
  const tired = !canPlayNow()
  // Why the panel is locked, phrased as something the player can act on. The
  // World errands have their own on-screen BACK button, so name the active one
  // instead of leaving the player with a generic "busy" message.
  const busyMessage = () =>
    lockLeft > 0
      ? `${pet.name} is settling in — Wake is available in ${Cfg.formatLockCountdown(lockLeft)}.`
      : clientState.feedTask.active
        ? 'Finish the tree errand or tap BACK first!'
        : clientState.sicknessErrand.active
          ? 'Go see the Caretaker or tap BACK first!'
        : 'Your pet is busy right now!'
  const guard = (fn: () => void) => () => {
    if (locked) {
      pushToast(busyMessage())
      return
    }
    fn()
  }

  return (
    <PetHudCard width={panelW} height={panelH} onClose={() => (clientState.petPanelOpen = false)}>
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
        <PillButton id="care_feed" label="Feed" shape="chip" color="orange" width={chipW} height={chipH} disabled={locked} margin={{ left: S(3), right: S(3) }} onClick={guard(() => startFeedTask())} />
        <PillButton
          id="care_bath"
          label="Bath"
          shape="chip"
          color="blue"
          width={chipW}
          height={chipH}
          disabled={locked}
          margin={{ left: S(3), right: S(3) }}
          onClick={guard(() => {
            // Pick the pet up and carry it to the tub (place it there to bathe).
            playPetVoice(pet.species)
            startCarryPet()
            clientState.petPanelOpen = false
          })}
        />
        <PillButton
          id="care_sleep"
          label={pet.sleeping ? (lockLeft > 0 ? `Wake in ${Cfg.formatLockCountdown(lockLeft)}` : sleepLeft > 0 ? `Wake · ${Cfg.formatLockCountdown(sleepLeft)}` : 'Wake') : 'Sleep'}
          shape="chip"
          color={lockLeft > 0 ? 'gray' : 'yellow'}
          width={chipW}
          height={chipH}
          fontSize={pet.sleeping && (lockLeft > 0 || sleepLeft > 0) ? S(14) : S(17)}
          disabled={!pet.sleeping && busy}
          pulse={!pet.sleeping && tired && !busy}
          margin={{ left: S(3), right: S(3) }}
          onClick={() => {
            // An exhausted pet needs 30 seconds to settle before it can wake.
            if (lockLeft > 0) {
              pushToast(`${pet.name} is settling in — Wake is available in ${Cfg.formatLockCountdown(lockLeft)}.`)
              return
            }
            // Waking is instant once the lock is up — no walk back to the bed.
            if (pet.sleeping) {
              pet.sleeping = false
              pet.sleepLockUntil = 0
              playPetVoice(pet.species)
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
        <PillButton
          id="care_play"
          label={tired ? 'Play  ·  Tired' : 'Play'}
          shape="chip"
          color={tired ? 'gray' : 'pink'}
          width={chipW}
          height={chipH}
          fontSize={tired ? S(15) : S(17)}
          disabled={locked}
          margin={{ left: S(3), right: S(3) }}
          onClick={guard(() => {
            // Out of energy: playing is what drains it, so the way back is bed.
            if (tired) {
              pushToast(`${pet.name} is too tired to play — send it to sleep.`)
              return
            }
            // Enter Fetch mode: hide the panel and show the centered Fetch button.
            playPetVoice(pet.species)
            clientState.fetch.active = true
            clientState.petPanelOpen = false
          })}
        />
      </UiEntity>
      {/* Pet, Breed and Send to Ark, side by side and equal size. Breed and the
          Ark are for Adults only. */}
      <UiEntity uiTransform={{ width: contentW, flexDirection: 'row', justifyContent: 'center', margin: { top: S(12) } }}>
        <PillButton id="pet_gesture" label="Pet  ·  +Happy" shape="wide" color="pink" width={thirdW} height={S(54)} fontSize={S(16)} disabled={locked} margin={{ right: S(4) }} onClick={guard(() => startPetting())} />
        <PillButton
          id="breed_teaser"
          label={unlocked ? 'Breed' : 'Breed  ·  Adult'}
          shape="wide"
          color={unlocked ? 'purple' : 'gray'}
          width={thirdW}
          height={S(54)}
          fontSize={S(16)}
          margin={{ left: S(4), right: S(4) }}
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
            // New flow: carry this pet to the breeding nest, place it, pick the
            // partner there, then breed (name/potion modal → egg cinematic).
            startBreedErrand()
          }}
        />
        <PillButton
          id="ark_send"
          label={unlocked ? 'Send to Ark' : 'Ark  ·  Adult'}
          shape="pass"
          color={unlocked ? 'green' : 'gray'}
          width={thirdW}
          height={S(54)}
          fontSize={S(16)}
          margin={{ left: S(4) }}
          onClick={() => {
            if (!unlocked) {
              pushToast('Only Adult pets can board the Ark.')
              return
            }
            startArkRedeem()
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
// Passport art (Feed-HUD style: thick dark outline, cream fill, paw ornament on
// top, baked close X). Texture px: the frame is 1120x940 (= S(560)xS(470) at 2x)
// with 70px of headroom above it for the ornament.
const PASSPORT_PANEL = 'assets/images/revamp/passport_panel.png'
const PASSPORT_PARTS = 'assets/images/revamp/passport_parts.png'
const PASSPORT_TEX = { w: 1120, h: 1010, top: 70 }
const PASSPORT_CLOSE = { x: 996, y: 106, size: 84 }
const PASSPORT_RING_UVS = [0, 1 - 200 / 256, 0, 1, 200 / 1024, 1, 200 / 1024, 1 - 200 / 256]
const PASSPORT_TRACK_UVS = [0, 1 - 254 / 256, 0, 1 - 210 / 256, 880 / 1024, 1 - 210 / 256, 880 / 1024, 1 - 254 / 256]

function PassportBar(props: { value: number; color: Color; width: number; height: number }) {
  const v = Math.max(0, Math.min(100, props.value))
  const inset = Math.max(2, Math.round(props.height * (6 / 44)))
  const innerH = props.height - inset * 2
  return (
    <UiEntity uiTransform={{ width: props.width, height: props.height }} uiBackground={{ texture: { src: PASSPORT_PARTS }, textureMode: 'stretch', uvs: PASSPORT_TRACK_UVS }}>
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: inset, left: inset }, width: Math.round(((props.width - inset * 2) * v) / 100), height: innerH, borderRadius: innerH / 2 }}
        uiBackground={{ color: props.color }}
      />
    </UiEntity>
  )
}

function RemotePetPanel() {
  const addr = clientState.viewingPetAddress
  if (!addr) return <UiEntity />
  const entry = clientState.presence.find((p) => p.address.toLowerCase() === addr.toLowerCase())
  if (!entry) return <UiEntity />
  const w = navPanelWidth()
  const k = w / PASSPORT_TEX.w
  const h = Math.round(PASSPORT_TEX.h * k)
  const pad = Math.round(64 * k)
  const contentW = w - pad * 2
  const close = () => (clientState.viewingPetAddress = null)
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }}
      uiBackground={{ color: PET_UI.scrim }}
      onMouseDown={() => {}}
    >
      <UiEntity uiTransform={{ width: w, height: h, positionType: 'relative' }} uiBackground={{ texture: { src: PASSPORT_PANEL }, textureMode: 'stretch' }}>
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: Math.round((PASSPORT_TEX.top + 64) * k), left: pad }, width: contentW, flexDirection: 'column', alignItems: 'center' }}
        >
          <Label value={`${entry.name}  ·  Lv ${entry.level}`} fontSize={S(26)} color={PET_UI.ink} textAlign="middle-center" uiTransform={{ width: contentW, height: S(40), margin: { bottom: S(8) } }} />
          <PetIdentityRow species={entry.species} rarity={entry.rarity} size={entry.size} width={contentW} ring />
          <Label value="Mood" fontSize={S(15)} color={ALBUM_INK} textAlign="middle-center" uiTransform={{ width: contentW, height: S(22) }} />
          <PassportBar value={entry.mood} color={C.happy} width={contentW} height={S(22)} />
          <PillButton
            id="give_treat"
            label="Give a treat"
            shape="pass"
            color="green"
            width={contentW}
            height={S(56)}
            fontSize={S(19)}
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
          <PillButton
            id="propose_swap"
            label={`Propose Swap  ·  ${clientState.activePet ? clientState.activePet.name : '—'}`}
            shape="pass"
            color="purple"
            width={contentW}
            height={S(56)}
            fontSize={S(19)}
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
        </UiEntity>
        {/* Invisible hit area over the baked close X — last, so it wins the tap. */}
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: Math.round(PASSPORT_CLOSE.y * k), left: Math.round(PASSPORT_CLOSE.x * k) }, width: Math.round(PASSPORT_CLOSE.size * k), height: Math.round(PASSPORT_CLOSE.size * k), pointerFilter: 'block' }}
          uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0 } }}
          onMouseDown={() => {
            playUiClick()
            close()
          }}
        />
      </UiEntity>
    </UiEntity>
  )
}

// Incoming pet-swap offer — another player wants to trade their pet for yours.
// Shows the offered pet's full profile; Accept swaps both rosters, Decline drops it.
// Same art direction + frame as the Passport (passport_panel.png: dark outline,
// paw ornament, baked close X = Decline) and the same pill buttons.
function SwapStatRow(props: { key?: string; label: string; value: number; color: Color; width: number }) {
  const labelW = S(84)
  return (
    <UiEntity uiTransform={{ width: props.width, height: S(28), flexDirection: 'row', alignItems: 'center', margin: { bottom: S(6) } }}>
      <Label value={props.label} fontSize={S(15)} color={PET_UI.ink} textAlign="middle-left" uiTransform={{ width: labelW, height: S(24) }} />
      <PassportBar value={props.value} color={props.color} width={props.width - labelW} height={S(20)} />
    </UiEntity>
  )
}

function SwapOfferPanel() {
  const offer = clientState.incomingSwap
  if (!offer) return <UiEntity />
  const p = offer.offeredPet
  const respond = (accept: boolean) => {
    if (accept) playPetVoice(p.species)
    actions.respondSwap(accept)
    clientState.incomingSwap = null
  }
  const w = navPanelWidth()
  const k = w / PASSPORT_TEX.w
  const h = Math.round(PASSPORT_TEX.h * k)
  const pad = Math.round(64 * k)
  const contentW = w - pad * 2
  const halfW = Math.round((contentW - S(16)) / 2)
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }}
      uiBackground={{ color: PET_UI.scrim }}
      onMouseDown={() => {}}
    >
      <UiEntity uiTransform={{ width: w, height: h, positionType: 'relative' }} uiBackground={{ texture: { src: PASSPORT_PANEL }, textureMode: 'stretch' }}>
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: Math.round((PASSPORT_TEX.top + 52) * k), left: pad }, width: contentW, flexDirection: 'column', alignItems: 'center' }}>
          <Label value="Swap Offer!" fontSize={S(28)} color={PET_UI.ink} textAlign="middle-center" uiTransform={{ width: contentW, height: S(38) }} />
          <Label
            value={`${offer.fromName} offers ${p.name} for your ${offer.wantedPetName}`}
            fontSize={S(16)}
            color={ALBUM_INK}
            textAlign="middle-center"
            textWrap="wrap"
            uiTransform={{ width: contentW, height: S(26), margin: { bottom: S(10) } }}
          />
          <PetIdentityRow species={p.species} rarity={p.rarity} size={p.size} width={contentW} name={p.name} level={p.petLevel} ring />
          <UiEntity uiTransform={{ width: contentW, flexDirection: 'column', margin: { top: S(2) } }}>
            <SwapStatRow label="Hunger" value={p.hunger} color={C.hunger} width={contentW} />
            <SwapStatRow label="Hygiene" value={p.hygiene} color={C.hygiene} width={contentW} />
            <SwapStatRow label="Energy" value={p.energy} color={C.energy} width={contentW} />
            <SwapStatRow label="Happy" value={p.happiness} color={C.happy} width={contentW} />
          </UiEntity>
          <UiEntity uiTransform={{ width: contentW, flexDirection: 'row', justifyContent: 'center', margin: { top: S(10) } }}>
            <PillButton id="swap_decline" label="Decline" shape="half" color="pink" width={halfW} height={S(60)} fontSize={S(20)} margin={{ right: S(8) }} onClick={() => respond(false)} />
            <PillButton id="swap_accept" label="Accept" shape="half" color="green" width={halfW} height={S(60)} fontSize={S(20)} pulse margin={{ left: S(8) }} onClick={() => respond(true)} />
          </UiEntity>
        </UiEntity>
        {/* Invisible hit area over the baked close X — closing declines, like before. */}
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: Math.round(PASSPORT_CLOSE.y * k), left: Math.round(PASSPORT_CLOSE.x * k) }, width: Math.round(PASSPORT_CLOSE.size * k), height: Math.round(PASSPORT_CLOSE.size * k), pointerFilter: 'block' }}
          uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0 } }}
          onMouseDown={() => {
            playUiClick()
            respond(false)
          }}
        />
      </UiEntity>
    </UiEntity>
  )
}

// Keep/Discard button art (source is 443x336) — sized off this ratio wherever
// they're used instead of the old text-pill's own width/height, so the art
// never gets stretched.
const KEEP_BUTTON_ICON = 'assets/images/revamp/keepbutton.png'
const DISCARD_BUTTON_ICON = 'assets/images/revamp/discardbutton.png'
const KEEP_DISCARD_ASPECT = 443 / 336

// Hatch/Bath action button art — same idea, sized off each image's own native
// ratio (hatch is 671x323, bath is 812x323) so neither gets stretched.
const HATCH_BUTTON_ICON = 'assets/images/hatch_button.png'
const BATH_BUTTON_ICON = 'assets/images/bath button.png'
const HATCH_BUTTON_ASPECT = 671 / 323
const BATH_BUTTON_ASPECT = 812 / 323

// ---------------------------------------------------------------------------
// Bottom nav: 3 big buttons (cozy-farm style)
// ---------------------------------------------------------------------------
// DEV ONLY — force the nav/menu visible without adopting a pet, to dial in the
// menu button's position. Keep false in shipping builds.
const DEV_ALWAYS_SHOW_NAV = false

function BottomNav() {
  const p = clientState.player
  // Hidden while any big panel/dialog is open (bigUiOpen) — it sits where these
  // buttons are, or on top of them. Also hidden in the active throw sequences,
  // while carrying an egg or the pet, and during the hatch animation (so
  // Keep/Discard only appears once the newborn has emerged).
  if (!p || bigUiOpen() || clientState.fetch.active || clientState.pepitoChase.active || clientState.carryEgg.active || clientState.carryPet.active || clientState.breed.active || clientState.hatch.active) return <UiEntity />
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
  if (p.pets.length === 0 && !DEV_ALWAYS_SHOW_NAV) return <UiEntity />

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
  // Mobile navigation is supplied by Explorer's native "+" overflow menu.
  if (mobile()) return <UiEntity />

  // DESKTOP: the classic centered bottom bar.
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: S(18), left: 0 }, width: '100%', height: bh, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}>
      {nav('nav_pets', NAV_PAW_UVS, 'roster', () => ui.openRoster())}
      {nav('nav_inv', NAV_INV_UVS, 'inventory', () => ui.openInventory())}
      {nav('nav_goals', NAV_GOALS_UVS, 'goals', () => ui.openGoals())}
    </UiEntity>
  )
}

/** One source of truth for when the native companion buttons may appear.
 * It intentionally keeps them up for a sleeping pet: the action button still
 * opens its panel to wake it, while the follow button reports that it is asleep. */
function canShowPetTouchControls(): boolean {
  const pet = clientState.activePet
  return (
    mobile() &&
    !!pet &&
    !bigUiOpen() &&
    !hasPendingHatchling() &&
    !clientState.petting.active &&
    !clientState.fetch.active &&
    !clientState.feedTask.active &&
    !clientState.sicknessErrand.active &&
    !clientState.pepitoChase.active &&
    !clientState.hatch.active &&
    !clientState.feedGame.active &&
    !clientState.bathGame.active &&
    !clientState.carryEgg.active &&
    !clientState.carryPet.active &&
    !clientState.breed.active
  )
}

/** Sync native mobile controls from an ECS system, rather than from the React
 * renderer. This keeps their lifecycle correct when Root swaps to an overlay. */
function syncPetTouchControlsSystem(): void {
  const pet = clientState.activePet
  const icon = pet ? Cfg.speciesControlIcon(pet.species) : undefined
  if (!canShowPetTouchControls() || !icon) {
    hidePetTouchControls()
    return
  }
  showPetTouchControls(clientState.followEnabled, icon)
  if (inputSystem.isTriggered(NAV_ROSTER_TOUCH_ACTION, PointerEventType.PET_DOWN)) {
    ui.openRoster()
  } else if (inputSystem.isTriggered(NAV_INVENTORY_TOUCH_ACTION, PointerEventType.PET_DOWN)) {
    ui.openInventory()
  } else if (inputSystem.isTriggered(NAV_GOALS_TOUCH_ACTION, PointerEventType.PET_DOWN)) {
    ui.openGoals()
  }
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

// Same card as My Pets / Choose a Partner (one row of 4 in the Inventory-sized
// revamp panel); the chosen one gets the selected card (PetGridCard adds the tick).
function SpeciesCard(props: { key?: string; species: string }) {
  const selected = uiState.adoptSpecies === props.species
  const cardW = S(ROSTER_CARD_W)
  const cardH = Math.round(cardW / PET_CARD_ASPECT)
  const disc = rosterPx(78)
  const img = Cfg.speciesImage(props.species)
  return (
    <UiEntity uiTransform={{ width: cardW + S(12), height: cardH + S(12) }}>
      <PetGridCard
        pad={rosterPx(13)}
        selected={selected}
        width={cardW}
        height={cardH}
        onClick={() => {
          uiState.adoptSpecies = props.species
        }}
      >
        <UiEntity
          uiTransform={{ width: disc, height: disc, borderRadius: disc / 2, margin: { bottom: rosterPx(8) } }}
          uiBackground={img ? { texture: { src: img }, textureMode: 'stretch' } : { color: speciesColor(props.species) }}
        />
        <Label value={Cfg.speciesLabel(props.species)} fontSize={rosterPx(17)} color={selected ? C.greenDark : PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: rosterPx(22) }} />
        <Label value={selected ? 'Selected' : 'Tap to choose'} fontSize={rosterPx(13)} color={selected ? C.greenDark : PET_UI.muted} textAlign="middle-center" uiTransform={{ width: '100%', height: rosterPx(18), margin: { top: rosterPx(2) } }} />
      </PetGridCard>
    </UiEntity>
  )
}

const ADOPT_CHOOSE_PANEL = 'assets/images/revamp/adopt_choose_panel.png'
const ADOPT_NAME_PANEL = 'assets/images/revamp/adopt_name_panel.png'

function AdoptPanel() {
  const p = clientState.player
  const slotsFree = p ? p.pets.length < p.petSlots : true
  const nextSlotPrice = Cfg.slotPrice(p ? p.petSlots : Cfg.STARTING_SLOTS)
  const sp = uiState.adoptSpecies

  if (uiState.adoptStep === 'pick') {
    // Use the same revamp action-pill treatment as the adoption controls below.
    const nextW = S(165)
    const nextH = Math.round(nextW / PILL_HALF_ASPECT)
    return (
      <RevampPanel src={ADOPT_CHOOSE_PANEL} texW={REVAMP_PANEL_W} texH={MYPETS_PANEL_H} width={navPanelWidth()} contentTop={REVAMP_CONTENT_TOP} onClose={() => ui.close()}>
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'flex-start', margin: { top: S(40) } }}>
          {Cfg.SPECIES.map((s) => (
            <SpeciesCard key={s} species={s} />
          ))}
        </UiEntity>
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center', margin: { top: S(14) } }}>
          <PillButton id="adopt_next" label="Next" shape="half" color="green" width={nextW} height={nextH} pulse onClick={() => (uiState.adoptStep = 'name')} />
        </UiEntity>
      </RevampPanel>
    )
  }

  // Name + confirm step
  const disc = S(104)
  const img = Cfg.speciesImage(sp)
  // A name is REQUIRED — the Adopt button stays disabled until one is typed, so
  // players can't skip past the input (many missed it and got stuck wondering why
  // nothing happened).
  const named = uiState.adoptName.trim().length > 0
  const halfW = S(165)
  const halfH = Math.round(halfW / PILL_HALF_ASPECT)
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%' }}>
    <RevampPanel src={ADOPT_NAME_PANEL} texW={REVAMP_PANEL_W} texH={MYPETS_PANEL_H} width={navPanelWidth()} contentTop={REVAMP_CONTENT_TOP} onClose={() => ui.close()}>
      {/* Species snapshot in the Passport's ringed disc */}
      <UiEntity uiTransform={{ width: disc, height: disc, borderRadius: disc / 2, margin: { top: S(10) } }} uiBackground={img ? { texture: { src: img }, textureMode: 'stretch' } : { color: speciesColor(sp) }}>
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: -S(4), left: -S(4) }, width: disc + S(8), height: disc + S(8) }}
          uiBackground={{ texture: { src: PASSPORT_PARTS }, textureMode: 'stretch', uvs: PASSPORT_RING_UVS }}
        />
      </UiEntity>
      <Label value={Cfg.speciesLabel(sp)} fontSize={S(22)} color={PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: S(30), margin: { top: S(8) } }} />
      <UiEntity
        uiTransform={{ width: S(340), height: S(50), margin: { top: S(8) }, borderRadius: S(14), borderWidth: S(2), borderColor: ADOPT_INPUT_BORDER }}
        uiBackground={{ color: LOC.white }}
      >
        <Input
          placeholder="Type a name..."
          fontSize={S(19)}
          color={PET_UI.ink}
          placeholderColor={PET_UI.muted}
          uiTransform={{ width: '100%', height: '100%' }}
          uiBackground={{ color: { r: 1, g: 1, b: 1, a: 0 } }}
          onMouseDown={() => {
            if (mobile()) showMobileMagnifier('adopt')
          }}
          onChange={(v) => {
            uiState.adoptName = v
            if (mobile() && !isMobileMagnifierSubmitEcho('adopt', v)) showMobileMagnifier('adopt')
          }}
          onSubmit={(v) => {
            uiState.adoptName = v
            if (mobile()) hideMobileMagnifier('adopt', v)
          }}
        />
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', height: S(30), margin: { top: S(6) }, alignItems: 'center', justifyContent: 'center' }}>
        {!slotsFree && <Label value="No free pet slots. Buy one first." fontSize={S(15)} color={LOC.red} textAlign="middle-center" uiTransform={{ width: '100%', height: S(24) }} />}
        {slotsFree && !named && <Label value="Give your pet a name to continue." fontSize={S(15)} color={LOC.orange} textAlign="middle-center" uiTransform={{ width: '100%', height: S(24) }} />}
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center', margin: { top: S(4) } }}>
        <PillButton id="adopt_back" label="Back" shape="half" color="pink" width={halfW} height={halfH} fontSize={S(19)} margin={{ right: S(12) }} onClick={() => { uiState.adoptName = ''; uiState.adoptStep = 'pick'; resetMobileMagnifier() }} />
        {slotsFree ? (
          <PillButton
            id="adopt_confirm"
            label="Adopt!"
            shape="half"
            color="green"
            width={halfW}
            height={halfH}
            fontSize={S(21)}
            pulse
            disabled={!named}
            onClick={() => {
              // Adoption gives an egg — but you collect it FROM the Caretaker
              // (an arrow guides you there), not spawned into your hand from
              // wherever you're standing. startGetEgg hands it over on arrival
              // (or immediately if you're already at the Caretaker).
              startGetEgg(sp, uiState.adoptName.trim())
              uiState.adoptName = ''
              ui.close()
            }}
          />
        ) : (
          <PillButton
            id="adopt_buyslot"
            label={`Buy Slot ${nextSlotPrice}`}
            shape="half"
            color="green"
            width={halfW}
            height={halfH}
            fontSize={S(18)}
            onClick={() => {
              buySlotLocal() // optimistic slot bump; the server sends the single confirming/failure toast
              actions.buySlot()
            }}
          />
        )}
      </UiEntity>
    </RevampPanel>
    {mobile() && mobileMagnifierVisible('adopt') && <MobileNameMagnifier target="adopt" />}
    </UiEntity>
  )
}

/** A visual magnifier for a focused mobile input. The real Input remains in its
 * modal underneath, preserving native keyboard focus without intercepting taps. */
function MobileNameMagnifier(props: { target: MobileNameInput }) {
  const value = props.target === 'adopt' ? uiState.adoptName : uiState.breedName
  const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
  // The mobile virtual canvas grows with DPR. Use canvas fractions so the lens
  // starts on top of the actual input on any density, rather than at a fixed px.
  const canvasW = canvas?.width ?? 1600
  const canvasH = canvas?.height ?? 720
  const startWidthRatio = 0.36
  const startTopRatio = props.target === 'adopt' ? 0.45 : 0.35
  const zoom = mobileMagnifierProgress()
  const width = Math.round(canvasW * (startWidthRatio + (0.54 - startWidthRatio) * zoom))
  const height = Math.round(canvasH * (0.125 + (0.182 - 0.125) * zoom))
  const top = Math.round(canvasH * (startTopRatio + (0.045 - startTopRatio) * zoom))
  const fontSize = Math.round((canvasH / 720) * (S(20) + (S(30) - S(20)) * zoom))
  const padding = Math.round(canvasH * 0.04)
  const border = Math.max(2, Math.round(canvasH * 0.006))

  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', alignItems: 'center', pointerFilter: 'none', zIndex: 100 }}
    >
      <UiEntity uiTransform={{ positionType: 'absolute', position: { top, left: '50%' }, margin: { left: -width / 2 }, width, height, alignItems: 'center', justifyContent: 'center', padding: { left: padding, right: padding }, borderRadius: Math.round(canvasH * 0.025), borderWidth: border, borderColor: LOC.violet, opacity: zoom, pointerFilter: 'none' }} uiBackground={{ color: LOC.white }}>
        <Label value={value.trim() ? value : 'Type a name...'} fontSize={fontSize} color={value.trim() ? PET_UI.ink : PET_UI.muted} textAlign="middle-center" uiTransform={{ width: '100%', height: '100%' }} />
      </UiEntity>
    </UiEntity>
  )
}

// Breeding: name the offspring before crossing. The species + rarity are the
// server's surprise inside the egg; the name is prefixed "Gen-N" server-side.
// A rarity potion (bought in the Shop) can be spent on this roll to tilt the
// odds toward rare/legendary — it is consumed server-side by this breed only.
// Same revamp frame as the adoption "Name Your Pet" step (title, subtitle and
// close X baked into breeding_background.png); the input, potion row and Breed
// button are laid out on top.
const BREED_NAME_PANEL = 'assets/images/revamp/breeding_background.png'

// Inline notice for the breed flow (name modal and partner picker) — toasts are
// hidden while a big panel is open (bigUiOpen), so feedback inside the flow shows
// here instead. Auto-expires.
let breedNotice = { text: '', until: 0 }
function showBreedNotice(text: string) {
  breedNotice = { text, until: Date.now() + 2500 }
}
function BreedNoticePill(props: { marginTop: number }) {
  if (Date.now() >= breedNotice.until) return <UiEntity />
  return (
    <UiEntity
      uiTransform={{ margin: { top: props.marginTop }, padding: { left: S(16), right: S(16), top: S(4), bottom: S(4) }, borderRadius: S(13), alignItems: 'center', justifyContent: 'center' }}
      uiBackground={{ color: { r: 0.1, g: 0.08, b: 0.14, a: 0.85 } }}
    >
      <Label value={breedNotice.text} fontSize={S(15)} color={LOC.white} textAlign="middle-center" uiTransform={{ height: S(24) }} />
    </UiEntity>
  )
}

function BreedNamePanel() {
  if (uiState.panel !== 'breedName') return <UiEntity />
  const potions = clientState.player?.inventory.rarityPotions ?? 0
  const coins = clientState.player?.currency ?? 0
  const hasPotion = potions > 0
  const usingPotion = hasPotion && uiState.breedUsePotion
  const noticeOn = Date.now() < breedNotice.until

  const potionIcon = S(60)
  const buyW = S(120)
  const addW = S(120)
  const addH = Math.round(addW / PILL_HALF_ASPECT)
  const breedW = S(190)
  const breedH = Math.round(breedW / PILL_HALF_ASPECT)

  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%' }}>
    <RevampPanel src={BREED_NAME_PANEL} texW={REVAMP_PANEL_W} texH={MYPETS_PANEL_H} width={navPanelWidth()} contentTop={REVAMP_CONTENT_TOP} onClose={() => ui.close()}>
      {/* Offspring name (same field as the adoption name step) */}
      <UiEntity
        uiTransform={{ width: S(340), height: S(50), margin: { top: S(14) }, borderRadius: S(14), borderWidth: S(2), borderColor: ADOPT_INPUT_BORDER }}
        uiBackground={{ color: LOC.white }}
      >
        <Input
          placeholder="Type a name..."
          fontSize={S(19)}
          color={PET_UI.ink}
          placeholderColor={PET_UI.muted}
          uiTransform={{ width: '100%', height: '100%' }}
          uiBackground={{ color: { r: 1, g: 1, b: 1, a: 0 } }}
          onMouseDown={() => {
            if (mobile()) showMobileMagnifier('breed')
          }}
          onChange={(v) => {
            uiState.breedName = v
            if (mobile() && !isMobileMagnifierSubmitEcho('breed', v)) showMobileMagnifier('breed')
          }}
          onSubmit={(v) => {
            uiState.breedName = v
            if (mobile()) hideMobileMagnifier('breed', v)
          }}
        />
      </UiEntity>

      {/* Rarity potion row: icon + owned count, BUY (coins), and Add/Remove to
          spend one on this breed. */}
      <UiEntity uiTransform={{ width: S(520), height: S(70), margin: { top: S(18) }, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
        <UiEntity uiTransform={{ width: potionIcon, height: potionIcon }} uiBackground={{ texture: { src: 'assets/images/revamp/potion.png' }, textureMode: 'stretch' }} />
        <UiEntity uiTransform={{ width: S(170), height: S(52), flexDirection: 'column', margin: { left: S(6), right: S(8) } }}>
          <Label value={`${Cfg.RARITY_POTION_LABEL}  x${potions}`} fontSize={S(17)} color={PET_UI.ink} textAlign="middle-left" uiTransform={{ width: '100%', height: S(28) }} />
          <Label value={`${Cfg.RARITY_POTION_PRICE} coins each`} fontSize={S(13)} color={PET_UI.muted} textAlign="middle-left" uiTransform={{ width: '100%', height: S(22) }} />
        </UiEntity>
        <BuyButton
          id="breed_buy_potion"
          width={buyW}
          enabled={coins >= Cfg.RARITY_POTION_PRICE}
          onClick={() => {
            // buyPotionLocal is the optimistic mirror (deducts coins + adds the
            // potion, false if broke); the server call confirms. Auto-add it — you
            // bought it for THIS roll. Feedback goes to the inline notice, not
            // pushToast: toasts are suppressed while a modal (bigUiOpen) is open.
            if (buyPotionLocal()) {
              uiState.breedUsePotion = true
              actions.buyPotion()
              showBreedNotice('Bought a Rarity Potion!')
            } else {
              showBreedNotice(`Not enough coins — a Rarity Potion costs ${Cfg.RARITY_POTION_PRICE}`)
            }
          }}
        />
        <PillButton
          id="breed_add_potion"
          label={usingPotion ? 'Remove' : 'Add'}
          shape="half"
          color={usingPotion ? 'pink' : 'green'}
          width={addW}
          height={addH}
          fontSize={S(16)}
          margin={{ left: S(8) }}
          disabled={!hasPotion}
          onClick={() => {
            uiState.breedUsePotion = !uiState.breedUsePotion
          }}
        />
      </UiEntity>

      {/* Status line: inline notice (buy / fee feedback) while it lasts, else
          whether a potion is on this breed and the breeding fee. */}
      <UiEntity uiTransform={{ width: '100%', height: S(30), margin: { top: S(8) }, alignItems: 'center', justifyContent: 'center' }}>
        <Label
          value={noticeOn ? breedNotice.text : `${usingPotion ? 'Rarity Potion added  ·  ' : ''}Breeding costs ${Cfg.BREED_COST} coins`}
          fontSize={S(15)}
          color={noticeOn ? LOC.orange : PET_UI.muted}
          textAlign="middle-center"
          uiTransform={{ width: '100%', height: S(24) }}
        />
      </UiEntity>

      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center', margin: { top: S(8) } }}>
        <PillButton
          id="breed_confirm"
          label="Breed!"
          shape="half"
          color="green"
          width={breedW}
          height={breedH}
          fontSize={S(21)}
          pulse
          onClick={() => {
            // Nest flow: the partner is already placed; run the egg cinematic
            // (which sends the breed). If the flow was cancelled (world BACK) while
            // this modal was still open, just close — no stale actions.breed('').
            // Check the fee here too: once the egg cinematic starts it can't be taken back.
            if (coins < Cfg.BREED_COST) {
              showBreedNotice(`Not enough coins — breeding costs ${Cfg.BREED_COST}`)
              return
            }
            if (clientState.breed.active) startBreedCross(uiState.breedName, usingPotion)
            uiState.breedName = ''
            uiState.breedUsePotion = false
            ui.close()
          }}
        />
      </UiEntity>
    </RevampPanel>
    {mobile() && mobileMagnifierVisible('breed') && <MobileNameMagnifier target="breed" />}
    </UiEntity>
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
              desc={item.desc}
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
// Illustrated BUY button — a 3-state horizontal sprite strip (0 = normal,
// 1 = pressed, 2 = disabled). Sits under each inventory food card so a player can
// restock the item they'd otherwise only be able to feed. Shares the tap-bounce
// press system with TactileButton, swapping to the pressed frame while held.
// Revamp pill buttons (same style as the Feed/Bath HUD "Start" button).
// BUY: 3-frame strip [enabled, pressed, disabled]. USE: 2-frame strip
// [enabled, disabled], drawn over the blank inventory card.
const BUY_BTN_SHEET = 'assets/images/revamp/inv_buy_button.png'
const BUY_BTN_FRAMES = 3
const BUY_BTN_ASPECT = 360 / 104 // one state's cell aspect (~3.46, includes the soft drop shadow)
const USE_BTN_SHEET = 'assets/images/revamp/inv_use_button.png'
const USE_BTN_ASPECT = 360 / 104
// Inventory card without the old baked "Use" (hud3.png card, button painted out);
// the Use pill sits where the old one was, as fractions of the card box.
const INV_CARD_BLANK = 'assets/images/revamp/inv_card.png'
const INV_USE_BOX = { left: 30 / 405, top: 377 / 499, width: 345 / 405 }
function BuyButton(props: { key?: string; id: string; width: number; enabled: boolean; onClick: () => void }) {
  const height = Math.round(props.width / BUY_BTN_ASPECT)
  const scale = props.enabled ? getPress(props.id) : 1
  const frame = !props.enabled ? 2 : scale < 0.995 ? 1 : 0 // pressed frame during the tap bounce
  const w = Math.round(props.width * scale)
  const h = Math.round(height * scale)
  return (
    <UiEntity uiTransform={{ width: props.width, height, alignItems: 'center', justifyContent: 'center', pointerFilter: props.enabled ? 'block' : 'none' }}>
      <UiEntity
        uiTransform={{ width: w, height: h }}
        uiBackground={{ texture: { src: BUY_BTN_SHEET }, textureMode: 'stretch', uvs: stripFrameUvs(frame, BUY_BTN_FRAMES) }}
        onMouseDown={
          props.enabled
            ? () => {
                triggerPress(props.id)
                playUiClick()
                props.onClick()
              }
            : undefined
        }
      />
    </UiEntity>
  )
}

function InvCard(props: { key?: string; id: string; title: string; bowlUvs?: number[]; bowlSrc?: string; bowlAspect: number; bowlScale?: number; bowlTop?: number; count: number; enabled: boolean; onClick: () => void }) {
  const cardW = S(180)
  const cardH = Math.round(cardW / INV_CARD_ASPECT)
  // bowlScale = art width as a fraction of the card; bowlTop = its vertical spot.
  // Defaults match the food bowls; the potion overrides them (bigger + higher).
  const bowlW = Math.round(cardW * (props.bowlScale ?? 0.46))
  const bowlH = Math.round(bowlW / props.bowlAspect)
  const bowlTop = Math.round(cardH * (props.bowlTop ?? 0.3))
  return (
    <UiEntity
      uiTransform={{ width: cardW, height: cardH, margin: S(6), pointerFilter: props.enabled ? 'block' : 'none' }}
      onMouseDown={
        props.enabled
          ? () => {
              playUiClick()
              props.onClick()
            }
          : undefined
      }
    >
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: cardW, height: cardH }}
        uiBackground={{ texture: { src: INV_CARD_BLANK }, textureMode: 'stretch' }}
      />
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { left: Math.round(cardW * INV_USE_BOX.left), top: Math.round(cardH * INV_USE_BOX.top) },
          width: Math.round(cardW * INV_USE_BOX.width),
          height: Math.round((cardW * INV_USE_BOX.width) / USE_BTN_ASPECT),
          pointerFilter: 'none'
        }}
        uiBackground={{ texture: { src: USE_BTN_SHEET }, textureMode: 'stretch', uvs: stripFrameUvs(props.enabled ? 0 : 1, 2) }}
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

// ---------------------------------------------------------------------------
// Revamp panel shell — the "Your Journey" frame (goals.png) with the title,
// subtitle, icon and close X BAKED into the image, same family as the Album.
// Children are laid out in a full-width column starting at `contentTop`
// (texture px, scaled with the panel). An invisible hit area sits on the baked
// X. The art lives in assets/images/revamp/ (generated from goals.png).
// ---------------------------------------------------------------------------
const REVAMP_PANEL_W = 998 // every revamp panel shares the Goals frame width
/** On-screen width shared by the nav panels (Inventory, My Pets, Goals) and the
 *  pet Passport, so they all open at the same size on desktop and mobile. */
function navPanelWidth(): number {
  return S(660)
}
const REVAMP_CONTENT_TOP = 190 // first px below the baked title + subtitle
const REVAMP_CLOSE = { x: 865, y: 20, size: 104 } // baked close button box
const INVENTORY_PANEL = 'assets/images/revamp/inventory_panel.png'
const INVENTORY_PANEL_H = 730
const MYPETS_PANEL = 'assets/images/revamp/mypets_panel.png'
const MYPETS_PANEL_H = 730

function RevampPanel(props: { src: string; texW: number; texH: number; width: number; contentTop: number; onClose: () => void; children?: any }) {
  const w = props.width
  const k = w / props.texW
  const h = Math.round(props.texH * k)
  const top = Math.round(props.contentTop * k)
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }}
      uiBackground={{ color: PET_UI.scrim }}
      onMouseDown={() => {}}
    >
      <UiEntity uiTransform={{ width: w, height: h, positionType: 'relative' }} uiBackground={{ texture: { src: props.src }, textureMode: 'stretch' }}>
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top, left: 0 }, width: w, height: h - top, flexDirection: 'column', alignItems: 'center' }}>{props.children}</UiEntity>
        {/* Invisible hit area over the baked close X (transparent bg so the tap registers). */}
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: Math.round(REVAMP_CLOSE.y * k), left: Math.round(REVAMP_CLOSE.x * k) }, width: Math.round(REVAMP_CLOSE.size * k), height: Math.round(REVAMP_CLOSE.size * k), pointerFilter: 'block' }}
          uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0 } }}
          onMouseDown={() => {
            playUiClick()
            props.onClose()
          }}
        />
      </UiEntity>
    </UiEntity>
  )
}

// One inventory column: the food/consumable card with a BUY button stacked
// beneath it (or a matching-height spacer for cards bought by tapping, so the
// columns bottom-align). Sized EXPLICITLY (width+height) so the row is laid out
// deterministically — an auto-sized column left the button height ambiguous under
// flex and it could collapse/clip; a fixed box always reserves its space.
function InvColumn(props: { key?: string; width: number; height: number; children?: any }) {
  return (
    <UiEntity uiTransform={{ width: props.width, height: props.height, flexDirection: 'column', alignItems: 'center' }}>{props.children}</UiEntity>
  )
}

function InventoryPanel() {
  const p = clientState.player
  const t1 = p?.inventory.tier1 ?? 0
  const t2 = p?.inventory.tier2 ?? 0
  const potions = p?.inventory.rarityPotions ?? 0
  const coins = p?.currency ?? 0
  // The Rarity Potion is the only way to buy the breeding consumable while the
  // Shop is suspended (SideButtons() is empty). It's TAPPED to buy (150 coins) —
  // it's spent later by the breed that toggles it on, not "used" from here.
  const canAffordPotion = coins >= Cfg.RARITY_POTION_PRICE
  const price1 = Cfg.SHOP_ITEMS[0].price
  const price2 = Cfg.SHOP_ITEMS[1].price
  // Column geometry, computed here so the row is deterministic (see InvColumn).
  const cardW = S(180)
  const cardH = Math.round(cardW / INV_CARD_ASPECT)
  const buyW = S(150)
  const buyH = Math.round(buyW / BUY_BTN_ASPECT)
  const colGap = S(10) // gap between a card and its BUY button
  const colW = cardW + S(12) // card art + its own S(6) side margins
  const colH = cardH + S(12) + colGap + buyH // card + margins + gap + button
  const buy = (tier: number) => () => {
    if (buyItemLocal(tier)) pushToast(`Bought ${Cfg.SHOP_ITEMS[tier - 1].label}!`)
    else pushToast('Not enough coins!')
    actions.buyItem(tier) // server is authoritative
  }
  return (
    <RevampPanel src={INVENTORY_PANEL} texW={REVAMP_PANEL_W} texH={INVENTORY_PANEL_H} width={navPanelWidth()} contentTop={REVAMP_CONTENT_TOP} onClose={() => ui.close()}>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'center', alignItems: 'flex-start' }}>
        <InvColumn width={colW} height={colH}>
          <InvCard key="inv-1" id="use_1" title={`${Cfg.SHOP_ITEMS[0].label}  ${price1}`} bowlUvs={INV_BOWL1_UVS} bowlAspect={INV_BOWL1_ASPECT} count={t1} enabled={t1 > 0} onClick={() => { useItemLocal(1); actions.useItem(1) }} />
          <BuyButton id="buy_1" width={buyW} enabled={coins >= price1} onClick={buy(1)} />
        </InvColumn>
        <InvColumn width={colW} height={colH}>
          <InvCard key="inv-2" id="use_2" title={`${Cfg.SHOP_ITEMS[1].label}  ${price2}`} bowlUvs={INV_BOWL2_UVS} bowlAspect={INV_BOWL2_ASPECT} count={t2} enabled={t2 > 0} onClick={() => { useItemLocal(2); actions.useItem(2) }} />
          <BuyButton id="buy_2" width={buyW} enabled={coins >= price2} onClick={buy(2)} />
        </InvColumn>
        <InvColumn width={colW} height={colH}>
          {/* Potion is bought (never "used" from here — it's spent by breeding), so it
              buys via its BUY button like the food, not by tapping the card. */}
          <InvCard key="inv-potion" id="use_potion" title={`${Cfg.RARITY_POTION_LABEL}  ${Cfg.RARITY_POTION_PRICE}`} bowlSrc="assets/images/revamp/potion.png" bowlAspect={1} bowlScale={0.56} bowlTop={0.18} count={potions} enabled={potions > 0} onClick={() => pushToast('Rarity Potions are used when breeding')} />
          <BuyButton id="buy_potion" width={buyW} enabled={canAffordPotion} onClick={() => { if (buyPotionLocal()) { pushToast('Bought a Rarity Potion!'); actions.buyPotion() } else pushToast('Not enough coins!') }} />
        </InvColumn>
      </UiEntity>
    </RevampPanel>
  )
}

// ---------------------------------------------------------------------------
// Roster (Pets) — selection system
// ---------------------------------------------------------------------------
const ROSTER_CARD_W = 140
const ROSTER_CARD_SCALE = ROSTER_CARD_W / 180
const rosterPx = (n: number) => Math.round(S(n) * ROSTER_CARD_SCALE)

function RosterSlotCard(props: { key?: number; index: number }) {
  const p = clientState.player
  if (!p) return <UiEntity />

  // Four slots in one row so My Pets fits the Inventory-sized panel: the card and
  // everything inside it are the old 180-wide layout scaled by ROSTER_CARD_SCALE.
  const cardW = S(ROSTER_CARD_W)
  const cardH = Math.round(cardW / PET_CARD_ASPECT)
  const disc = rosterPx(78)
  const unlocked = props.index < p.petSlots
  const pet = p.pets[props.index]

  if (!unlocked) {
    // Slots are unlimited, and the grid only ever renders ONE locked card: the
    // next one up. Its price is the one for the slot count the player is at.
    const canUnlock = props.index === p.petSlots
    return (
      <PetGridCard pad={rosterPx(13)}
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
        <UiEntity uiTransform={{ width: rosterPx(42), height: rosterPx(42), borderRadius: rosterPx(21), alignItems: 'center', justifyContent: 'center', margin: { bottom: rosterPx(10) } }} uiBackground={{ color: canUnlock ? PET_UI.badge : PET_UI.lock }}>
          <Label value={canUnlock ? '+' : 'x'} fontSize={rosterPx(26)} color={PET_UI.white} textAlign="middle-center" uiTransform={{ width: rosterPx(42), height: rosterPx(42) }} />
        </UiEntity>
        <Label value={canUnlock ? 'Unlock' : 'Locked'} fontSize={rosterPx(18)} color={PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: rosterPx(24) }} />
        <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: { top: rosterPx(4) } }}>
          <PriceDot />
          <Label value={`${Cfg.slotPrice(props.index)}`} fontSize={rosterPx(16)} color={PET_UI.muted} textAlign="middle-center" uiTransform={{ width: rosterPx(54), height: rosterPx(20), margin: { left: rosterPx(6) } }} />
        </UiEntity>
      </PetGridCard>
    )
  }

  if (!pet) {
    const isFirstEmpty = props.index === p.pets.length
    const hatch = p.hatchling
    if (isFirstEmpty && hatch) {
      const photo = petProfilePhoto(hatch.species, hatch.rarity, hatch.size)
      return (
        <PetGridCard pad={rosterPx(13)} selected={false} width={cardW} height={cardH}>
          <UiEntity
            uiTransform={{ width: rosterPx(70), height: rosterPx(70), borderRadius: rosterPx(35), margin: { bottom: rosterPx(6) } }}
            uiBackground={
              photo
                ? { texture: { src: photo.src }, textureMode: 'stretch', ...(photo.uvs ? { uvs: photo.uvs } : {}) }
                : { color: speciesColor(hatch.species) }
            }
          />
          <Label value={`${hatch.name} hatched!`} fontSize={rosterPx(14)} color={PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: rosterPx(20) }} />
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center', margin: { top: rosterPx(6) } }}>
            <TactileButton id="hatch_keep" label="" texture={KEEP_BUTTON_ICON} width={rosterPx(70)} height={Math.round(rosterPx(70) / KEEP_DISCARD_ASPECT)} margin={{ right: rosterPx(4) }} pulse onClick={() => keepHatchling()} />
            <TactileButton id="hatch_discard" label="" texture={DISCARD_BUTTON_ICON} width={rosterPx(70)} height={Math.round(rosterPx(70) / KEEP_DISCARD_ASPECT)} margin={{ left: rosterPx(4) }} onClick={() => discardHatchling()} />
          </UiEntity>
        </PetGridCard>
      )
    }

    return (
      <PetGridCard pad={rosterPx(13)} selected={false} width={cardW} height={cardH} onClick={() => ui.openAdopt()}>
        <UiEntity uiTransform={{ width: rosterPx(42), height: rosterPx(42), borderRadius: rosterPx(21), alignItems: 'center', justifyContent: 'center', margin: { bottom: rosterPx(10) } }} uiBackground={{ color: PET_UI.badge }}>
          <Label value="+" fontSize={rosterPx(28)} color={PET_UI.white} textAlign="middle-center" uiTransform={{ width: rosterPx(42), height: rosterPx(42) }} />
        </UiEntity>
        <Label value="Adopt" fontSize={rosterPx(18)} color={PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: rosterPx(24) }} />
        <Label value="Tap to adopt" fontSize={rosterPx(13)} color={PET_UI.muted} textAlign="middle-center" uiTransform={{ width: '100%', height: rosterPx(18), margin: { top: rosterPx(2) } }} />
      </PetGridCard>
    )
  }

  const isActive = pet.id === p.activePetId
  const photo = petProfilePhoto(pet.species, pet.rarity, pet.size)
  return (
    <PetGridCard pad={rosterPx(13)}
      selected={isActive}
      width={cardW}
      height={cardH}
      onClick={() => {
        if (!isActive) playPetVoice(pet.species)
        switchActivePet(pet.id)
      }}
    >
      <UiEntity
        uiTransform={{ width: disc, height: disc, borderRadius: disc / 2, margin: { bottom: rosterPx(8) } }}
        uiBackground={
          photo
            ? { texture: { src: photo.src }, textureMode: 'stretch', ...(photo.uvs ? { uvs: photo.uvs } : {}) }
            : { color: speciesColor(pet.species) }
        }
      />
      <Label value={pet.name} fontSize={rosterPx(17)} color={isActive ? C.greenDark : PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: rosterPx(22) }} />
      <Label value={`Lv ${pet.petLevel}`} fontSize={rosterPx(13)} color={isActive ? C.greenDark : PET_UI.muted} textAlign="middle-center" uiTransform={{ width: '100%', height: rosterPx(18), margin: { top: rosterPx(2) } }} />
    </PetGridCard>
  )
}

// The roster grid used to be a fixed [0,1,2,3] because slots were capped at 4.
// They're unlimited now, so it pages: one row of 4 fits the Inventory-sized panel.
const ROSTER_PAGE_SIZE = 4

/** `< 1 / N >` pager shared by the 4-per-row card panels (My Pets, Choose a
 *  Partner). Renders nothing when everything fits on one page. */
function CardPager(props: { idPrefix: string; page: number; pageCount: number; onPage: (page: number) => void }) {
  if (props.pageCount <= 1) return <UiEntity />
  return (
    <UiEntity uiTransform={{ width: '100%', height: S(48), flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
      <TactileButton
        id={`${props.idPrefix}_prev`}
        label="<"
        width={S(60)}
        height={S(40)}
        bg={LOC.neutral}
        textColor={PET_UI.ink}
        fontSize={S(20)}
        radius={S(12)}
        disabled={props.page === 0}
        onClick={() => props.onPage(props.page - 1)}
      />
      <Label value={`${props.page + 1} / ${props.pageCount}`} fontSize={S(16)} color={PET_UI.muted} textAlign="middle-center" uiTransform={{ width: S(90), height: S(40) }} />
      <TactileButton
        id={`${props.idPrefix}_next`}
        label=">"
        width={S(60)}
        height={S(40)}
        bg={LOC.neutral}
        textColor={PET_UI.ink}
        fontSize={S(20)}
        radius={S(12)}
        disabled={props.page >= props.pageCount - 1}
        onClick={() => props.onPage(props.page + 1)}
      />
    </UiEntity>
  )
}

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
    <RevampPanel src={MYPETS_PANEL} texW={REVAMP_PANEL_W} texH={MYPETS_PANEL_H} width={navPanelWidth()} contentTop={REVAMP_CONTENT_TOP} onClose={() => ui.close()}>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'center', alignItems: 'flex-start', margin: { top: S(46), bottom: S(10) } }}>
        {indices.map((i) => (
          <RosterSlotCard key={i} index={i} />
        ))}
      </UiEntity>
      <CardPager idPrefix="roster" page={page} pageCount={pageCount} onPage={(n) => (uiState.rosterPage = n)} />
    </RevampPanel>
  )
}

// ---------------------------------------------------------------------------
// Album — collection book. One page per rarity, 4x4 grid of the 16 creatures
// (row = head family, column = body family, same order as Cfg.ALBUM_SPECIES).
// Art (assets/images/album/): the panel with its title + close X baked in (same
// frame as Goals), a parts sheet (rarity cards, locked card, check badge,
// arrows, rarity pills), one 4x4 creature sheet per rarity and a shared
// silhouette sheet for the ones not collected yet. Every position below is in
// panel-texture pixels and scaled by the panel's on-screen width, so the
// runtime pieces stay locked to the baked art.
// ---------------------------------------------------------------------------
const ALBUM_ICON = 'assets/images/album/album_icon.png'
const ALBUM_PANEL = 'assets/images/album/album_panel.png'
const ALBUM_PARTS = 'assets/images/album/album_parts.png'
const ALBUM_SHEETS: Record<Rarity, string> = {
  common: 'assets/images/album/album_common.png',
  rare: 'assets/images/album/album_rare.png',
  legendary: 'assets/images/album/album_legendary.png'
}
const ALBUM_LOCKED_SHEET = 'assets/images/album/album_locked.png'
const ALBUM_COLS = 4

type Box = { x0: number; y0: number; x1: number; y1: number }
function albumUvs(b: Box, texW: number, texH: number): number[] {
  const uL = b.x0 / texW
  const uR = b.x1 / texW
  const vTop = 1 - b.y0 / texH
  const vBottom = 1 - b.y1 / texH
  return [uL, vBottom, uL, vTop, uR, vTop, uR, vBottom]
}
const partUvs = (b: Box) => albumUvs(b, 1024, 512)

// Landscape book: 16 creatures in 2 rows of 8 (row-major over ALBUM_SPECIES).
const ALBUM_PANEL_W = 1800
const ALBUM_PANEL_H = 830
const ALBUM_GRID_COLS = 8
const ALBUM_CARD_BOX: Record<Rarity | 'locked', Box> = {
  common: { x0: 8, y0: 8, x1: 208, y1: 218 },
  rare: { x0: 220, y0: 8, x1: 420, y1: 218 },
  legendary: { x0: 432, y0: 8, x1: 632, y1: 218 },
  locked: { x0: 644, y0: 8, x1: 844, y1: 218 }
}
const ALBUM_CHECK_BOX: Box = { x0: 860, y0: 8, x1: 924, y1: 72 }
const ALBUM_ARROW_BOX = {
  left: { x0: 8, y0: 236, x1: 112, y1: 340 },
  right: { x0: 124, y0: 236, x1: 228, y1: 340 },
  leftOff: { x0: 240, y0: 236, x1: 344, y1: 340 },
  rightOff: { x0: 356, y0: 236, x1: 460, y1: 340 }
}
const ALBUM_PILL_BOX: Record<Rarity, Box> = {
  common: { x0: 8, y0: 360, x1: 308, y1: 440 },
  rare: { x0: 320, y0: 360, x1: 620, y1: 440 },
  legendary: { x0: 632, y0: 360, x1: 932, y1: 440 }
}
// Layout inside the panel texture.
const AL = {
  closeX: 1667, closeY: 20, closeSize: 104, // baked close button
  gridTop: 196, cardW: 190, cardH: 200, gapX: 18, gapY: 16, art: 160,
  checkSize: 58, checkDx: 140, checkDy: -10,
  pagerTop: 630, arrow: 84, pillW: 300, pillH: 80, arrowGap: 26,
  countTop: 718, countH: 40, countFont: 26
}
const ALBUM_INK: Color = { r: 0.6, g: 0.48, b: 0.39, a: 1 }

function albumCellUvs(index: number): number[] {
  const col = index % ALBUM_COLS
  const row = Math.floor(index / ALBUM_COLS)
  return albumUvs({ x0: col * 256, y0: row * 256, x1: (col + 1) * 256, y1: (row + 1) * 256 }, 1024, 1024)
}

function AlbumCard(props: { key?: string; index: number; rarity: Rarity; collected: boolean; k: number }) {
  const k = props.k
  const col = props.index % ALBUM_GRID_COLS
  const row = Math.floor(props.index / ALBUM_GRID_COLS)
  const gridW = ALBUM_GRID_COLS * AL.cardW + (ALBUM_GRID_COLS - 1) * AL.gapX
  const left = Math.round(((ALBUM_PANEL_W - gridW) / 2 + col * (AL.cardW + AL.gapX)) * k)
  const top = Math.round((AL.gridTop + row * (AL.cardH + AL.gapY)) * k)
  const w = Math.round(AL.cardW * k)
  const h = Math.round(AL.cardH * k)
  const art = Math.round(AL.art * k)
  const inset = Math.round(((AL.cardW - AL.art) / 2) * k)
  const check = Math.round(AL.checkSize * k)
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top, left }, width: w, height: h, pointerFilter: 'none' }}>
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: w, height: h }}
        uiBackground={{ texture: { src: ALBUM_PARTS }, textureMode: 'stretch', uvs: partUvs(ALBUM_CARD_BOX[props.collected ? props.rarity : 'locked']) }}
      />
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: inset, left: inset }, width: art, height: art }}
        uiBackground={{ texture: { src: props.collected ? ALBUM_SHEETS[props.rarity] : ALBUM_LOCKED_SHEET }, textureMode: 'stretch', uvs: albumCellUvs(props.index) }}
      />
      {props.collected ? (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: Math.round(AL.checkDy * k), left: Math.round(AL.checkDx * k) }, width: check, height: check }}
          uiBackground={{ texture: { src: ALBUM_PARTS }, textureMode: 'stretch', uvs: partUvs(ALBUM_CHECK_BOX) }}
        />
      ) : null}
    </UiEntity>
  )
}

function AlbumArrow(props: { side: 'left' | 'right'; enabled: boolean; k: number; onClick: () => void }) {
  const size = Math.round(AL.arrow * props.k)
  const offset = Math.round((AL.pillW / 2 + AL.arrowGap + AL.arrow) * props.k)
  const left = Math.round((ALBUM_PANEL_W / 2) * props.k) + (props.side === 'left' ? -offset : offset - size)
  const top = Math.round(AL.pagerTop * props.k)
  const box = props.side === 'left' ? (props.enabled ? ALBUM_ARROW_BOX.left : ALBUM_ARROW_BOX.leftOff) : props.enabled ? ALBUM_ARROW_BOX.right : ALBUM_ARROW_BOX.rightOff
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top, left }, width: size, height: size }}>
      {props.enabled ? (
        <TactileButton id={`album_${props.side}`} label="" texture={ALBUM_PARTS} uvs={partUvs(box)} width={size} height={size} onClick={props.onClick} />
      ) : (
        <UiEntity uiTransform={{ width: size, height: size }} uiBackground={{ texture: { src: ALBUM_PARTS }, textureMode: 'stretch', uvs: partUvs(box) }} />
      )}
    </UiEntity>
  )
}

function AlbumPanel() {
  const p = clientState.player
  const owned = new Set(p?.collection ?? [])
  const page = Math.min(Math.max(0, uiState.albumPage), Cfg.RARITIES.length - 1)
  uiState.albumPage = page
  const rarity = Cfg.RARITIES[page]
  const collected = Cfg.ALBUM_SPECIES.map((sp) => owned.has(Cfg.collectionKey(sp, rarity)))
  const pageCount = collected.filter(Boolean).length

  // Landscape: sized off S() so it grows on mobile like the other panels. The
  // canvas clamp is desktop-only — on mobile UiCanvasInformation under-reports the
  // real screen and clamping there shrank the panel.
  const aspect = ALBUM_PANEL_W / ALBUM_PANEL_H
  const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
  let w = mobile() ? S(960) : S(1000)
  let h = Math.round(w / aspect)
  if (canvas && !mobile()) {
    const maxW = canvas.width * 0.92
    const maxH = canvas.height * 0.92
    if (w > maxW) { w = maxW; h = Math.round(w / aspect) }
    if (h > maxH) { h = maxH; w = Math.round(h * aspect) }
  }
  const k = w / ALBUM_PANEL_W
  const pillW = Math.round(AL.pillW * k)
  const pillH = Math.round(AL.pillH * k)

  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }} uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.45 } }}>
      <UiEntity uiTransform={{ width: w, height: h, positionType: 'relative' }} uiBackground={{ texture: { src: ALBUM_PANEL }, textureMode: 'stretch' }}>
        {Cfg.ALBUM_SPECIES.map((sp, i) => (
          <AlbumCard key={`${rarity}-${sp}`} index={i} rarity={rarity} collected={collected[i]} k={k} />
        ))}
        <AlbumArrow side="left" enabled={page > 0} k={k} onClick={() => (uiState.albumPage = page - 1)} />
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: Math.round((AL.pagerTop + (AL.arrow - AL.pillH) / 2) * k), left: Math.round((w - pillW) / 2) }, width: pillW, height: pillH }}
          uiBackground={{ texture: { src: ALBUM_PARTS }, textureMode: 'stretch', uvs: partUvs(ALBUM_PILL_BOX[rarity]) }}
        />
        <AlbumArrow side="right" enabled={page < Cfg.RARITIES.length - 1} k={k} onClick={() => (uiState.albumPage = page + 1)} />
        <Label
          value={`${pageCount} / ${Cfg.ALBUM_SPECIES.length} collected`}
          fontSize={Math.round(AL.countFont * k)}
          color={ALBUM_INK}
          textAlign="middle-center"
          uiTransform={{ positionType: 'absolute', position: { top: Math.round(AL.countTop * k), left: 0 }, width: w, height: Math.round(AL.countH * k) }}
        />
        {/* Invisible hit area over the close X baked into the art (transparent bg so the tap registers). */}
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: Math.round(AL.closeY * k), left: Math.round(AL.closeX * k) }, width: Math.round(AL.closeSize * k), height: Math.round(AL.closeSize * k), pointerFilter: 'block' }}
          uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0 } }}
          onMouseDown={() => {
            playUiClick()
            ui.close()
          }}
        />
      </UiEntity>
    </UiEntity>
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
// Meteor daily rewards — the supplied sheet contains the full Marsh Colony
// treatment (modal, cards, claim buttons and close control). Only the changing
// values live in React-ECS labels: day, currency and the current claim state.
// Keeping that split means the server-authoritative daily ladder below stays
// completely independent from the visual revamp.
// ---------------------------------------------------------------------------
const DAILY_REWARDS_SHEET = 'assets/images/revamp/dailyrewards_hud.png'
const DAILY_REWARDS_SHEET_SIZE = 1024

function dailyRewardsUvRect(x0: number, y0: number, x1: number, y1: number): number[] {
  const uL = x0 / DAILY_REWARDS_SHEET_SIZE
  const uR = x1 / DAILY_REWARDS_SHEET_SIZE
  const vTop = 1 - y0 / DAILY_REWARDS_SHEET_SIZE
  const vBottom = 1 - y1 / DAILY_REWARDS_SHEET_SIZE
  return [uL, vBottom, uL, vTop, uR, vTop, uR, vBottom]
}

// Pixel bounds were taken from dailyrewards_hud.png. The crops include their
// baked highlights/shadows but exclude the transparent sheet around them.
const DAILY_PANEL_BOX = { x0: 12, y0: 474, x1: 1008, y1: 994 }
const DAILY_CLOSE_BOX = { x0: 100, y0: 40, x1: 161, y1: 101 }
// The larger Claim variants include their side sparkles in the atlas. Keep
// the complete 407 px-wide crops so they render sharp rather than sampling a
// clipped inner section of the sheet.
const DAILY_CLAIM_BOX = { x0: 179, y0: 27, x1: 586, y1: 121 }
const DAILY_CLAIM_DISABLED_BOX = { x0: 604, y0: 27, x1: 1011, y1: 121 }
const DAILY_CARD_TODAY_BOX = { x0: 70, y0: 157, x1: 261, y1: 426 }
const DAILY_CARD_FUTURE_BOX = { x0: 307, y0: 156, x1: 495, y1: 426 }
const DAILY_CARD_JACKPOT_BOX = { x0: 510, y0: 157, x1: 713, y1: 426 }
const DAILY_CARD_CLAIMED_BOX = { x0: 730, y0: 157, x1: 916, y1: 426 }

const DAILY_PANEL_UVS = dailyRewardsUvRect(DAILY_PANEL_BOX.x0, DAILY_PANEL_BOX.y0, DAILY_PANEL_BOX.x1, DAILY_PANEL_BOX.y1)
const DAILY_CLOSE_UVS = dailyRewardsUvRect(DAILY_CLOSE_BOX.x0, DAILY_CLOSE_BOX.y0, DAILY_CLOSE_BOX.x1, DAILY_CLOSE_BOX.y1)
const DAILY_CLAIM_UVS = dailyRewardsUvRect(DAILY_CLAIM_BOX.x0, DAILY_CLAIM_BOX.y0, DAILY_CLAIM_BOX.x1, DAILY_CLAIM_BOX.y1)
const DAILY_CLAIM_DISABLED_UVS = dailyRewardsUvRect(DAILY_CLAIM_DISABLED_BOX.x0, DAILY_CLAIM_DISABLED_BOX.y0, DAILY_CLAIM_DISABLED_BOX.x1, DAILY_CLAIM_DISABLED_BOX.y1)
const DAILY_CARD_TODAY_UVS = dailyRewardsUvRect(DAILY_CARD_TODAY_BOX.x0, DAILY_CARD_TODAY_BOX.y0, DAILY_CARD_TODAY_BOX.x1, DAILY_CARD_TODAY_BOX.y1)
const DAILY_CARD_FUTURE_UVS = dailyRewardsUvRect(DAILY_CARD_FUTURE_BOX.x0, DAILY_CARD_FUTURE_BOX.y0, DAILY_CARD_FUTURE_BOX.x1, DAILY_CARD_FUTURE_BOX.y1)
const DAILY_CARD_JACKPOT_UVS = dailyRewardsUvRect(DAILY_CARD_JACKPOT_BOX.x0, DAILY_CARD_JACKPOT_BOX.y0, DAILY_CARD_JACKPOT_BOX.x1, DAILY_CARD_JACKPOT_BOX.y1)
const DAILY_CARD_CLAIMED_UVS = dailyRewardsUvRect(DAILY_CARD_CLAIMED_BOX.x0, DAILY_CARD_CLAIMED_BOX.y0, DAILY_CARD_CLAIMED_BOX.x1, DAILY_CARD_CLAIMED_BOX.y1)
const DAILY_PANEL_ASPECT = (DAILY_PANEL_BOX.x1 - DAILY_PANEL_BOX.x0) / (DAILY_PANEL_BOX.y1 - DAILY_PANEL_BOX.y0)

const DAILY_TEXT = {
  ink: { r: 0.38, g: 0.23, b: 0.18, a: 1 } as Color,
  muted: { r: 0.52, g: 0.38, b: 0.33, a: 1 } as Color,
  today: { r: 0.58, g: 0.31, b: 0.1, a: 1 } as Color,
  claimed: { r: 1, g: 1, b: 1, a: 1 } as Color,
  jackpot: { r: 0.4, g: 0.22, b: 0.42, a: 1 } as Color
}

type DailyCardState = 'claimed' | 'today' | 'future'

function dailyCardUvs(day: number, state: DailyCardState): number[] {
  if (state === 'claimed') return DAILY_CARD_CLAIMED_UVS
  if (state === 'today') return DAILY_CARD_TODAY_UVS
  return day === 7 ? DAILY_CARD_JACKPOT_UVS : DAILY_CARD_FUTURE_UVS
}

function DailyDayCard(props: { key?: string; day: number; state: DailyCardState; width: number; height: number }) {
  const reward = Cfg.STREAK_WEEK_REWARDS[props.day - 1]
  const isToday = props.state === 'today'
  const isClaimed = props.state === 'claimed'
  const isJackpot = props.day === 7 && !isClaimed
  // The claimed tile only has a green value badge; its header sits on the
  // same light card surface as the future tiles, so it needs dark ink too.
  const titleColor = isToday ? DAILY_TEXT.today : isJackpot ? DAILY_TEXT.jackpot : DAILY_TEXT.muted
  const rewardColor = isToday ? DAILY_TEXT.today : isClaimed ? DAILY_TEXT.claimed : isJackpot ? DAILY_TEXT.jackpot : DAILY_TEXT.muted
  const titleSize = Math.max(S(12), Math.round(props.height * 0.095))
  const rewardSize = Math.max(S(14), Math.round(props.height * 0.105))

  return (
    <UiEntity uiTransform={{ width: props.width, height: props.height }}>
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: props.width, height: props.height }}
        uiBackground={{ texture: { src: DAILY_REWARDS_SHEET }, textureMode: 'stretch', uvs: dailyCardUvs(props.day, props.state) }}
      />
      <Label
        value={isToday ? 'TODAY' : `DAY ${props.day}`}
        fontSize={titleSize}
        color={titleColor}
        textAlign="middle-center"
        uiTransform={{ positionType: 'absolute', position: { top: Math.round(props.height * 0.055), left: 0 }, width: props.width, height: Math.round(props.height * 0.15) }}
      />
      <Label
        value={`$${reward.currency}`}
        fontSize={rewardSize}
        color={rewardColor}
        textAlign="middle-center"
        uiTransform={{ positionType: 'absolute', position: { top: Math.round(props.height * 0.74), left: 0 }, width: props.width, height: Math.round(props.height * 0.14) }}
      />
    </UiEntity>
  )
}

function MeteorRewardPanel() {
  const weekDay = dailyLadderDay() // server-derived (from streakCount)
  const claimable = dailyClaimable() // server-derived (meteorDay gate)
  const days = [1, 2, 3, 4, 5, 6, 7].map((day) => {
    let state: DailyCardState = 'future'
    if (day < weekDay) state = 'claimed'
    else if (day === weekDay) state = claimable ? 'today' : 'claimed'
    return { day, state }
  })

  // On mobile, the virtual canvas is 1600 x 720. This keeps the full 7-day
  // calendar visible with room for the touch controls; desktop receives the
  // larger presentation in the supplied reference.
  const panelWidth = mobile() ? S(720) : S(960)
  const panelHeight = Math.round(panelWidth / DAILY_PANEL_ASPECT)
  const cardsSidePad = Math.round(panelWidth * 0.042)
  const cardGap = Math.max(S(4), Math.round(panelWidth * 0.01))
  const cardWidth = Math.floor((panelWidth - cardsSidePad * 2 - cardGap * 6) / 7)
  const cardHeight = Math.round(panelHeight * 0.35)
  // Keep the reward actions in the lower half of the panel, beneath the
  // already-baked title treatment.
  const cardsTop = Math.round(panelHeight * 0.325)
  // The supplied button includes transparent spark margins. Size its crop from
  // the visible green pill, so it carries the same visual weight as the cards.
  const claimWidth = Math.round(panelWidth * 0.34)
  const claimHeight = Math.round(claimWidth / ((DAILY_CLAIM_BOX.x1 - DAILY_CLAIM_BOX.x0) / (DAILY_CLAIM_BOX.y1 - DAILY_CLAIM_BOX.y0)))
  const claimTop = cardsTop + cardHeight + Math.round(panelHeight * 0.07)
  const closeSize = Math.round(panelHeight * 0.118)

  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }}
      uiBackground={{ color: PET_UI.scrim }}
      onMouseDown={() => {}}
    >
      <UiEntity uiTransform={{ width: panelWidth, height: panelHeight }}>
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: panelWidth, height: panelHeight }}
          uiBackground={{ texture: { src: DAILY_REWARDS_SHEET }, textureMode: 'stretch', uvs: DAILY_PANEL_UVS }}
        />
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: Math.round(panelHeight * 0.035), right: Math.round(panelWidth * 0.035) }, width: closeSize, height: closeSize, pointerFilter: 'block' }}
          uiBackground={{ texture: { src: DAILY_REWARDS_SHEET }, textureMode: 'stretch', uvs: DAILY_CLOSE_UVS }}
          onMouseDown={() => {
            playUiClick()
            ui.close()
          }}
        />
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: cardsTop, left: cardsSidePad }, width: panelWidth - cardsSidePad * 2, height: cardHeight, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          {days.map((card) => (
            <DailyDayCard key={`dd-${card.day}`} day={card.day} state={card.state} width={cardWidth} height={cardHeight} />
          ))}
        </UiEntity>
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: claimTop, left: Math.round((panelWidth - claimWidth) / 2) }, width: claimWidth, height: claimHeight, pointerFilter: 'block' }}>
          <TactileButton
            id="daily_claim"
            label=""
            texture={DAILY_REWARDS_SHEET}
            uvs={claimable ? DAILY_CLAIM_UVS : DAILY_CLAIM_DISABLED_UVS}
            width={claimWidth}
            height={claimHeight}
            disabled={!claimable}
            pulse={claimable}
            onClick={() => {
              actions.claimDaily() // server grants + persists; toast comes back from it
              ui.close()
              dismissMeteorAfterClaim()
            }}
          />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Goals / achievements — the "Your Journey" art (goals.png) is the whole panel.
// The 1024² file has transparent padding, so we crop to the art's opaque box
// (measured from the PNG's alpha) and render it at the SAME width as the Inventory
// panel so all three nav panels read as the same size. The close X is baked into
// the top-right; an invisible button is overlaid on it.
// ---------------------------------------------------------------------------
const GOALS_IMG = 'assets/images/revamp/goals.png'
const GOALS_PANEL_H = 730 // same frame size as the Inventory panel (998x730)

// Journey steps. The art has no baked ticks: each completed step gets a tick
// badge (goals_tick.png) on the bottom-right of its disc. Centres are in
// goals.png px; `done` reads the player's progress so the panel shows how far
// along they are.
const GOALS_TICK_IMG = 'assets/images/revamp/goals_tick.png'
const GOALS_TICK_SIZE = 54 // goals.png px
type JourneyStep = { id: 'adopt' | 'feed' | 'bath' | 'breed' | 'ark'; tickX: number; tickY: number }
const JOURNEY_STEPS: JourneyStep[] = [
  { id: 'adopt', tickX: 192, tickY: 429 },
  { id: 'feed', tickX: 372, tickY: 494 },
  { id: 'bath', tickX: 552, tickY: 429 },
  { id: 'breed', tickX: 732, tickY: 494 },
  { id: 'ark', tickX: 912, tickY: 429 }
]
function journeyStepDone(id: JourneyStep['id']): boolean {
  const p = clientState.player
  return !!p && Cfg.journeyStepDone(id, p) // same rule the server pays the Journey rewards on
}

function GoalsPanel() {
  // Same shell + size as Inventory / My Pets (RevampPanel at navPanelWidth()).
  const w = navPanelWidth()
  const k = w / REVAMP_PANEL_W
  const sz = Math.round(GOALS_TICK_SIZE * k)
  return (
    <RevampPanel src={GOALS_IMG} texW={REVAMP_PANEL_W} texH={GOALS_PANEL_H} width={w} contentTop={0} onClose={() => ui.close()}>
      {JOURNEY_STEPS.filter((st) => journeyStepDone(st.id)).map((st) => (
        <UiEntity
          key={`tick-${st.id}`}
          uiTransform={{ positionType: 'absolute', position: { left: Math.round(st.tickX * k - sz / 2), top: Math.round(st.tickY * k - sz / 2) }, width: sz, height: sz, pointerFilter: 'none' }}
          uiBackground={{ texture: { src: GOALS_TICK_IMG }, textureMode: 'stretch' }}
        />
      ))}
    </RevampPanel>
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
// instead of cozy-farm's 10 so each button stays a comfortable touch target on
// mobile.
// Same revamp frame as Inventory / My Pets / Goals: title, subtitle and close X
// are baked into jukebox.png, and the rows use the cream/brown card palette.
const JUKEBOX_PANEL = 'assets/images/revamp/jukebox.png'
const JUKEBOX_PANEL_H = 730
const JUKEBOX_UI = {
  tile: { r: 1, g: 0.99, b: 0.96, a: 1 } as Color,
  selected: { r: 0.99, g: 0.89, b: 0.77, a: 1 } as Color, // peach fill of the selected pet card
  selectedBorder: { r: 0.36, g: 0.69, b: 0.62, a: 1 } as Color // its teal outline
}
const VOLUME_STEPS = [20, 40, 60, 80, 100]
// NOT module-level consts: S() reads the async-resolved platform, so anything
// computed at import time would be frozen at desktop scale.
const jukeboxContentW = () => S(470)
const songRowH = () => S(56)
const songRowGap = () => S(8)

function SongRow(props: { key?: string; id: SongId; label: string; playing: boolean }) {
  const disc = S(38)
  const tick = S(28)
  return (
    <UiEntity
      uiTransform={{ width: '100%', height: songRowH(), flexDirection: 'row', alignItems: 'center', padding: { left: S(12), right: S(12) }, margin: { bottom: songRowGap() }, borderRadius: S(14), borderWidth: S(2), borderColor: props.playing ? JUKEBOX_UI.selectedBorder : ADOPT_INPUT_BORDER, pointerFilter: 'block' }}
      uiBackground={{ color: props.playing ? JUKEBOX_UI.selected : JUKEBOX_UI.tile }}
      onMouseDown={() => {
        if (props.playing) return
        playUiClick()
        playSong(props.id)
      }}
    >
      <UiEntity uiTransform={{ width: disc, height: disc, borderRadius: disc / 2, margin: { right: S(12) }, alignItems: 'center', justifyContent: 'center' }} uiBackground={{ color: props.playing ? PET_UI.badge : PET_UI.lock }}>
        <Label value="♪" fontSize={S(19)} color={PET_UI.white} textAlign="middle-center" uiTransform={{ width: disc, height: disc }} />
      </UiEntity>
      <UiEntity uiTransform={{ flex: 1, height: '100%', flexDirection: 'column', justifyContent: 'center' }}>
        <Label value={props.label} fontSize={S(18)} color={props.playing ? C.greenDark : PET_UI.ink} textAlign="middle-left" textWrap="nowrap" uiTransform={{ width: '100%', height: S(24) }} />
        {props.playing && <Label value={musicState.muted ? 'Muted' : 'Now playing'} fontSize={S(13)} color={musicState.muted ? PET_UI.muted : C.greenDark} textAlign="middle-left" textWrap="nowrap" uiTransform={{ width: '100%', height: S(18) }} />}
      </UiEntity>
      {/* Same external tick the selected pet card uses. */}
      {props.playing && <UiEntity uiTransform={{ width: tick, height: tick }} uiBackground={{ texture: { src: GOALS_TICK_IMG }, textureMode: 'stretch' }} />}
    </UiEntity>
  )
}

function VolumeStep(props: { key?: string; pct: number; active: boolean; width: number }) {
  return (
    <UiEntity
      uiTransform={{ width: props.width, height: S(42), margin: { left: S(3), right: S(3) }, alignItems: 'center', justifyContent: 'center', borderRadius: S(12), borderWidth: S(2), borderColor: props.active ? PET_UI.badge : ADOPT_INPUT_BORDER, pointerFilter: 'block' }}
      uiBackground={{ color: props.active ? PET_UI.badge : JUKEBOX_UI.tile }}
      onMouseDown={() => {
        if (props.active) return
        playUiClick()
        setMusicVolume(props.pct / 100)
      }}
    >
      <Label value={`${props.pct}%`} fontSize={S(14)} color={props.active ? PET_UI.white : PET_UI.muted} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: S(20) }} />
    </UiEntity>
  )
}

function JukeboxPanel() {
  const contentW = jukeboxContentW()
  const muted = musicState.muted
  // Snap the live volume to the nearest ladder step so exactly one button reads
  // as selected even when the value isn't on the ladder (the 42% default isn't).
  const volPct = musicState.volume * 100
  const activeStep = VOLUME_STEPS.reduce((best, pct) => (Math.abs(pct - volPct) < Math.abs(best - volPct) ? pct : best))
  const stepW = Math.round(contentW / VOLUME_STEPS.length) - S(6)
  return (
    <RevampPanel src={JUKEBOX_PANEL} texW={REVAMP_PANEL_W} texH={JUKEBOX_PANEL_H} width={navPanelWidth()} contentTop={REVAMP_CONTENT_TOP} onClose={() => ui.close()}>
      <UiEntity uiTransform={{ width: contentW, height: SONGS.length * (songRowH() + songRowGap()), flexDirection: 'column', margin: { top: S(8) } }}>
        {SONGS.map((song) => (
          <SongRow key={song.id} id={song.id} label={song.label} playing={song.id === musicState.currentSongId} />
        ))}
      </UiEntity>

      <Label value="Volume" fontSize={S(15)} color={PET_UI.muted} textAlign="middle-center" uiTransform={{ width: contentW, height: S(22), margin: { top: S(4) } }} />
      <UiEntity uiTransform={{ width: contentW, height: S(42), flexDirection: 'row', justifyContent: 'center', alignItems: 'center', margin: { top: S(2) } }}>
        {VOLUME_STEPS.map((pct) => (
          <VolumeStep key={`vol-${pct}`} pct={pct} active={pct === activeStep} width={stepW} />
        ))}
      </UiEntity>

      <UiEntity uiTransform={{ width: contentW, height: S(50), justifyContent: 'center', alignItems: 'center', margin: { top: S(12) } }}>
        <TactileButton
          id="jukebox_mute"
          label={muted ? 'Unmute music' : 'Mute music'}
          width={S(260)}
          height={S(50)}
          bg={muted ? PET_UI.badge : ADOPT_INPUT_BORDER}
          textColor={muted ? PET_UI.white : PET_UI.ink}
          fontSize={S(18)}
          radius={S(14)}
          onClick={() => toggleMute()}
        />
      </UiEntity>
    </RevampPanel>
  )
}

// ---------------------------------------------------------------------------
// Toasts (screen left, slide in/out from the left)
// ---------------------------------------------------------------------------
// Shows one toast at a time from clientState.toasts (a queue) — advances to the
// next message once the current one expires, instead of stacking every pushed
// toast on screen at once. It deploys from the left edge, holds, then retracts
// left while staying in the Explorer-reported interactable safe zone.
// The server `notify` kind picks the accent color (error/reward/progress/info).
const TOAST_ENTER_MS = 240 // slide-in from the left
const TOAST_HOLD_MS = 3100 // fully-shown dwell
const TOAST_EXIT_MS = 300 // retract back to the left
const TOAST_TOTAL_MS = TOAST_ENTER_MS + TOAST_HOLD_MS + TOAST_EXIT_MS
// Notification pill, drawn in code (no image): a cream fill inside a brown border,
// both fully rounded. TOAST_BORDER is pre-S (applied with S() at render).
const TOAST_BORDER = 5 // border thickness (pre-S)
const TOAST_TOP = '25%' as const
const DESKTOP_ACTION_LEFT = 60 // pre-S; left padding from the device-safe edge
const TOAST_HEIGHT = 92 // pre-S
const BACK_BUTTON_TOAST_GAP = 14 // pre-S
// This is a fixed vertical composition adjustment, not a safe-area fallback.
const TOAST_MOBILE_OFFSET_Y = -40 // pre-S
const TOAST_BORDER_COLOR: Color = { r: 0.525, g: 0.318, b: 0.173, a: 1 } // #86512C brown
const TOAST_CREAM: Color = { r: 0.969, g: 0.941, b: 0.871, a: 1 } // #F7F0DE cream

const withAlpha = (c: Color, a: number): Color => ({ r: c.r, g: c.g, b: c.b, a: c.a * a })
const easeOutCubic = (p: number): number => 1 - Math.pow(1 - p, 3)

// The main renderer uses screenInset: 'none', so the toast is explicitly wrapped
// in ScreenInsetArea. On mobile its left edge comes from the renderer-reported
// device safe border; on Unity it stays near the screen edge instead of inside
// the Explorer interactable area. The slide tween remains relative to that edge.
function actionHudLayout() {
  const isM = mobile()
  const toastLeft = isM ? 0 : S(DESKTOP_ACTION_LEFT)
  return {
    mobile: isM,
    toastPosition: { top: TOAST_TOP, left: toastLeft },
    toastMargin: { left: 0, top: isM ? S(TOAST_MOBILE_OFFSET_Y) : 0 },
    backPosition: { top: TOAST_TOP, left: toastLeft },
    toastBackOffsetY: isM ? S(TOAST_MOBILE_OFFSET_Y) : 0
  }
}

function toastIsVisible(now: number): boolean {
  return !bigUiOpen() && !!clientState.currentToast && clientState.currentToast.until > now
}

function Toasts() {
  const now = Date.now()
  // Hold the queue while a panel/modal/dialog owns the screen, so a toast can't
  // paint over open UI (the #186 overlap complaint). Nothing is shifted or shown
  // until they close, then the queue resumes.
  if (bigUiOpen()) return <UiEntity />
  if ((!clientState.currentToast || clientState.currentToast.until <= now) && clientState.toasts.length > 0) {
    const next = clientState.toasts.shift()!
    clientState.currentToast = { message: next.message, kind: next.kind, shownAt: now, until: now + TOAST_TOTAL_MS }
  }
  const t = clientState.currentToast
  if (!t || t.until <= now) return <UiEntity />
  const layout = actionHudLayout()
  // A visible BackButton reads the active toast below and shifts beneath this
  // fixed notification row, so the two never overlap.
  // Slide in from the LEFT edge + fade. Enter: from off-screen left -> rest.
  // Exit: retract back off the left + fade.
  const elapsed = now - t.shownAt
  const remaining = t.until - now
  const w = S(500)
  const h = S(TOAST_HEIGHT)
  const offMax = w + S(20) // far enough left to sit fully off-screen while hidden
  let slide = 0
  let alpha = 1
  if (elapsed < TOAST_ENTER_MS) {
    const e = easeOutCubic(elapsed / TOAST_ENTER_MS)
    slide = offMax * (1 - e)
    alpha = e
  } else if (remaining < TOAST_EXIT_MS) {
    const p = remaining / TOAST_EXIT_MS // 1 -> 0
    slide = offMax * (1 - p)
    alpha = p
  }

  const border = S(TOAST_BORDER)
  return (
    // Left side, slide-in from the left. The pill is drawn in code: a brown
    // border (outer) wrapping a cream fill (inner), both fully rounded.
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
      <ScreenInsetArea>
        <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: layout.toastPosition,
              margin: { left: -slide + layout.toastMargin.left, top: layout.toastMargin.top },
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
      </ScreenInsetArea>
    </UiEntity>
  )
}

// Care rewards deliberately use just the game's existing coin and star art,
// not the old illustrated chips. Each small token rises and fades quickly so it
// reads as a moment of progress without competing with the HUD or a toast.
const REWARD_COIN_ICON = 'assets/images/coin_icon.png'
const REWARD_XP_ICON = 'assets/images/revamp/star_icon.png'

function RewardPopup() {
  const reward = clientState.reward
  const now = Date.now()
  if (!reward || reward.until <= now) {
    if (reward) clientState.reward = null
    return <UiEntity />
  }

  const progress = Math.max(0, Math.min(1, (now - reward.shownAt) / (reward.until - reward.shownAt)))
  const rise = Math.round(S(68) * easeOutCubic(progress))
  const alpha = 1 - progress * progress
  const iconSize = S(42)
  const tokenWidth = S(148)
  const tokenHeight = iconSize
  const visibleTokens = (reward.xp > 0 ? 1 : 0) + (reward.coins > 0 ? 1 : 0)
  const totalWidth = visibleTokens * tokenWidth

  const token = (kind: 'xp' | 'coins', amount: number) => {
    if (amount <= 0) return null
    const isXp = kind === 'xp'
    return (
      <UiEntity key={kind} uiTransform={{ width: tokenWidth, height: tokenHeight, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', pointerFilter: 'none' }}>
        {isXp ? (
          <UiEntity uiTransform={{ width: iconSize, height: iconSize, borderRadius: iconSize / 2, alignItems: 'center', justifyContent: 'center' }} uiBackground={{ color: withAlpha(C.potion, alpha) }}>
            <UiEntity uiTransform={{ width: Math.round(iconSize * 0.62), height: Math.round(iconSize * 0.62) }} uiBackground={{ texture: { src: REWARD_XP_ICON }, textureMode: 'stretch', color: { r: 1, g: 1, b: 1, a: alpha } }} />
          </UiEntity>
        ) : (
          <UiEntity uiTransform={{ width: iconSize, height: iconSize }} uiBackground={{ texture: { src: REWARD_COIN_ICON }, textureMode: 'stretch', color: { r: 1, g: 1, b: 1, a: alpha } }} />
        )}
        <OutlineLabel
          value={isXp ? `+${amount} XP` : `+${amount}`}
          fontSize={S(25)}
          color={withAlpha(isXp ? PET_UI.white : C.gold, alpha)}
          outlineColor={withAlpha(PET_UI.ink, alpha)}
          textAlign="middle-left"
          width={tokenWidth - iconSize - S(6)}
          height={tokenHeight}
        />
      </UiEntity>
    )
  }

  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: '50%', left: '50%' }, margin: { left: -totalWidth / 2 + S(TOP_HUD_CENTER_SHIFT), top: -S(22) - rise }, width: totalWidth, height: tokenHeight, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}>
      {token('xp', reward.xp)}
      {token('coins', reward.coins)}
    </UiEntity>
  )
}

// Artwork for the shared BACK button below.
const BACK_ARROW_ICON = 'assets/images/backbutton2.png'
const BACK_ARROW_ASPECT_RATIO = 341 / 256

// Shared BACK button for full-screen action overlays (Petting / Fetch / Fruit
// game / Bath / Feed errand). It shares the toast's device-safe anchor on both
// mobile and Unity, then moves below the toast while that notification is open.
function BackButton(props: { onClick: () => void; disabled?: boolean }) {
  const toastVisible = toastIsVisible(Date.now())
  const layout = actionHudLayout()
  const height = S(90)
  const width = Math.round(height * BACK_ARROW_ASPECT_RATIO)
  return (
    <ScreenInsetArea>
      <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: layout.backPosition, margin: { top: toastVisible ? S(TOAST_HEIGHT + BACK_BUTTON_TOAST_GAP) + layout.toastBackOffsetY : 0 }, width, height, alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }}
          uiBackground={{
            texture: { src: BACK_ARROW_ICON },
            textureMode: 'stretch',
            // Disabled reads as greyed-out (not just faded) so it doesn't look like a
            // live button that's simply ignoring taps.
            color: props.disabled ? { r: 0.55, g: 0.55, b: 0.55, a: 0.55 } : { r: 1, g: 1, b: 1, a: 1 }
          }}
          onMouseDown={() => {
            if (props.disabled) return
            playUiClick()
            props.onClick()
          }}
        />
      </UiEntity>
    </ScreenInsetArea>
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
  const celebrating = st.celebrationUntil > Date.now()
  const pct = Math.round(st.progress * 100)
  const handD = S(96)
  const isM = mobile()
  // Desktop/Bevy: a hand drifting side-to-side (swipe hint). Mobile: a centered
  // finger you tap (the app has no cursor-drag yet, so tapping fills the bar).
  const swayX = isM ? 0 : Math.round(sway() * S(150))
  const handIcon = isM ? '👆' : '✋'
  const hint = celebrating ? 'Your pet is happy!' : isM ? 'Tap your pet!' : 'Swipe left & right to pet!'
  return (
    // Full-screen blocker (transparent) so touches drive the gesture and never
    // reach the avatar. The pet shows through from the fixed camera. On mobile,
    // each tap here fills the bar (petTap); on desktop the swipe is polled.
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'block' }}
      uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0 } }}
      onMouseDown={() => {
        if (isM && !celebrating) petTap()
      }}
    >
      {!celebrating && <BackButton onClick={() => cancelPetting()} />}
      {/* Swipe hint: a hand that drifts side to side across the middle (over the
          centered pet). Placeholder disc + emoji until the hand art arrives. */}
      <UiEntity
        uiTransform={{ display: celebrating ? 'none' : 'flex', positionType: 'absolute', position: { top: '34%', left: '50%' }, width: handD, height: handD, margin: { left: -handD / 2 + swayX }, alignItems: 'center', justifyContent: 'center', pointerFilter: 'none' }}
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
const bubbleRightRaw = 290
const barBottomRaw = 320
const barRightRaw = 240

// ---------------------------------------------------------------------------
// Fetch (Play) mode — holding E charges the throw on desktop; the mouse camera
// sets its direction. Mobile uses a native on-screen button with the same
// charge/release behavior. BACK exits only when no throw is in progress.
// ---------------------------------------------------------------------------
// Desktop intentionally stays quiet while aiming: one instruction and its
// charge meter, with no large scene button or progression readout.
function DesktopThrowGuidance(props: { instruction: string; charge: number; visible: boolean }) {
  if (!props.visible) return <UiEntity />
  const width = S(450)
  const meterWidth = S(14)
  const meterHeight = S(58)
  const textWidth = width - meterWidth - S(12)
  const pct = Math.round(Math.max(0, Math.min(1, props.charge)) * 100)
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { bottom: S(72), left: '50%' }, margin: { left: -width / 2 }, width, height: meterHeight, flexDirection: 'row', alignItems: 'center', pointerFilter: 'none' }}
    >
      <Label
        value={props.instruction}
        fontSize={S(16)}
        color={{ ...C.dim, a: 0.92 }}
        textAlign="middle-center"
        textWrap="wrap"
        uiTransform={{ width: textWidth, height: meterHeight }}
      />
      <UiEntity
        uiTransform={{ width: meterWidth, height: meterHeight, borderRadius: meterWidth / 2, margin: { left: S(12) } }}
        uiBackground={{ color: { r: 0.5, g: 0.5, b: 0.5, a: 0.35 } }}
      >
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { bottom: 0, left: 0 }, width: '100%', height: `${pct}%`, borderRadius: meterWidth / 2 }}
          uiBackground={{ color: { r: 0.75, g: 0.9, b: 0.35, a: 0.65 } }}
        />
      </UiEntity>
    </UiEntity>
  )
}

function FetchOverlay() {
  if (!clientState.fetch.active) return <UiEntity />
  const st = clientState.fetch
  const busy = st.busy
  const charging = st.charging
  const pct = Math.round(st.charge * 100)
  const isM = mobile()
  const tired = !canPlayNow()
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
      {/* BACK — disabled while charging/mid-throw so you don't strand a charge or a ball in the air */}
      <BackButton disabled={busy || charging} onClick={() => (clientState.fetch.active = false)} />
      {/* Mobile charge bar — subtle, thin, vertical (fills upward), calibrated
          on-device. Note for future positioning near this corner: the
          bottom-right is where the client draws its own native gamepad
          buttons OVER scene UI (docs: "Bottom-right action buttons — drawn
          deliberately over the [safe] area"), so anything placed too close to
          that corner's bottom edge gets hidden underneath them. */}
      {!isM && (
        <DesktopThrowGuidance
          instruction={busy ? 'Your pet is fetching the ball.' : tired ? 'Your pet needs rest before playing.' : 'Use your mouse to aim. Hold E to charge, then release to throw.'}
          charge={charging ? st.charge : 0}
          visible
        />
      )}
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
    </UiEntity>
  )
}

// Custom mobile move control for the catching phase — replaces the native
// joystick (hidden/restored from fruitGame.ts via TouchScreenControls) with a
// single-axis left/right button, since the lane only allows that anyway.
// uiInputBinding holds the action down for as long as the button is pressed,
// same as a native on-screen button.
// Pepito's rock uses the same hold/release language as Fetch. Mobile keeps the
// native custom button and its vertical meter; desktop has compact keyboard and
// mouse guidance instead of a center-screen button.
function PepitoRockChargeOverlay() {
  const st = clientState.pepitoChase
  if (!st.active || clientState.dialog.open) return <UiEntity />
  const isM = mobile()
  const charging = st.charging
  const locked = st.targetLocked
  const pct = Math.round(st.charge * 100)
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
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
      {!isM && (
        <DesktopThrowGuidance
          instruction={st.rockBusy ? 'The rock is in the air.' : charging && locked ? 'Pepito locked. Release F to throw.' : 'Use your mouse to aim. Hold F to charge, then release to throw.'}
          charge={charging ? st.charge : 0}
          visible
        />
      )}
    </UiEntity>
  )
}

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

function FeedEatingPanel() {
  const st = clientState.feedGame
  const isMobile = mobile()
  const revealElapsed = Math.max(0, (Date.now() - st.resultsAt) / 1000)
  const fadeRaw = Math.max(0, Math.min(1, (revealElapsed - FEED_RESULTS_FOCUS_S) / FEED_RESULTS_CARD_FADE_S))
  const cardFade = fadeRaw * fadeRaw * (3 - 2 * fadeRaw)
  const countElapsedMs = Math.max(0, (revealElapsed - FEED_RESULTS_FOCUS_S - FEED_RESULTS_CARD_FADE_S) * 1000)
  const countDurationMs = feedResultsCounterDurationMs(st.caught)
  const countProgress = st.phase === 'results' ? 1 : Math.max(0, Math.min(1, countElapsedMs / countDurationMs))
  const shownCaught = Math.min(st.caught, Math.max(0, Math.round(st.caught * countProgress)))
  const countOpacity = 0.45 + Math.min(1, countElapsedMs / 260) * 0.55
  const progress = st.hungerFillProgress
  // This is a celebratory fill animation, not a live stat readout: it always
  // starts empty so a fully fed pet still gets the same satisfying 0 → 100 beat.
  const hungerNow = st.hungerTarget * progress
  const barPct = Math.max(0, Math.min(100, hungerNow))
  const cardW = S(360)
  const cardH = Math.round(cardW / FEED_RESULTS_ASPECT)
  // Exact inner bounds of the illustrated progress track in fruit_caught.png.
  const barLeft = Math.round(cardW * 73 / FEED_RESULTS_W)
  // Mobile keeps the fill just under the illustrated track's midpoint, while
  // desktop retains its existing pixel-perfect alignment.
  const barTop = Math.round(cardH * 238 / FEED_RESULTS_H) + (isMobile ? S(1) : 0)
  const barW = Math.round(cardW * 398 / FEED_RESULTS_W) - (isMobile ? S(6) : 0)
  const barH = Math.round(cardH * 19 / FEED_RESULTS_H)
  const resultsReady = st.phase === 'results'
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: isMobile ? { top: '50%', left: S(48) } : { top: '50%', left: S(120) },
        margin: { top: -cardH / 2 + S(10) * (1 - cardFade) },
        width: cardW,
        height: cardH,
        opacity: cardFade,
        pointerFilter: 'none'
      }}
      uiBackground={{ texture: { src: FEED_RESULTS_TEXTURE }, textureMode: 'stretch' }}
    >
      <Label value={`<b>x ${shownCaught}</b>`} fontSize={S(42)} color={{ ...PET_UI.ink, a: PET_UI.ink.a * countOpacity }} textAlign="middle-center" uiTransform={{ positionType: 'absolute', position: { top: Math.round(cardH * 0.26), left: 0 }, width: '100%', height: Math.round(cardH * 0.19) }} />
      <UiEntity uiTransform={{ positionType: 'absolute', position: { top: barTop, left: barLeft }, width: barW, height: barH }}>
        <UiEntity uiTransform={{ width: `${barPct}%`, height: '100%', borderRadius: barH / 2 }} uiBackground={{ color: C.green }} />
      </UiEntity>
      {resultsReady ? (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: Math.round(cardH * 0.69), left: Math.round(cardW * 0.18) }, width: Math.round(cardW * 0.64), height: Math.round(cardH * 0.2), pointerFilter: 'block' }}
          uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0 } }}
          onMouseDown={() => {
            playUiClick()
            exitFeedResults()
          }}
        />
      ) : null}
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Feed tree minigame overlay (fruitGame.ts): "how to play" + arrows during
// arrival/intro (before the player can move freely to catch anything), then a
// fruit counter + countdown while catching (plus, on mobile, the custom
// left/right move buttons in place of the native joystick). BACK bails early,
// submitting whatever was caught so far (same as a natural timeout). Once the
// round ends, FeedEatingPanel presents the count-up and hunger bar.
// ---------------------------------------------------------------------------

// Crop an axis-aligned pixel box out of a sprite sheet into DCL's UV order
// (bottom-left, then clockwise). Shared by the feed and bath illustrated HUDs,
// which both pack their cards into a single sheet.
function sheetUvRect(x0: number, y0: number, x1: number, y1: number, w: number, h: number): number[] {
  const uL = x0 / w
  const uR = x1 / w
  const vTop = 1 - y0 / h
  const vBottom = 1 - y1 / h
  return [uL, vBottom, uL, vTop, uR, vTop, uR, vBottom]
}

// The feed HUD art is a 1024px sheet. Crop each card at its native aspect so
// the illustrated borders and icons never get stretched by the responsive UI.
const FEED_HUD_SHEET = 'assets/images/revamp/feed_hud.png'
const FEED_HUD_W = 1024
const FEED_HUD_H = 1024
function feedHudUvRect(x0: number, y0: number, x1: number, y1: number): number[] {
  return sheetUvRect(x0, y0, x1, y1, FEED_HUD_W, FEED_HUD_H)
}

// End above the results card, whose top-left corner starts at y=400.
const FEED_START_BOX = { x0: 28, y0: 8, x1: 672, y1: 399 }
const FEED_TIMER_BOX = { x0: 38, y0: 440, x1: 366, y1: 595 }
const FEED_COUNT_BOX = { x0: 40, y0: 622, x1: 444, y1: 773 }
const FEED_START_UVS = feedHudUvRect(FEED_START_BOX.x0, FEED_START_BOX.y0, FEED_START_BOX.x1, FEED_START_BOX.y1)
const FEED_TIMER_UVS = feedHudUvRect(FEED_TIMER_BOX.x0, FEED_TIMER_BOX.y0, FEED_TIMER_BOX.x1, FEED_TIMER_BOX.y1)
const FEED_COUNT_UVS = feedHudUvRect(FEED_COUNT_BOX.x0, FEED_COUNT_BOX.y0, FEED_COUNT_BOX.x1, FEED_COUNT_BOX.y1)
const FEED_START_ASPECT = (FEED_START_BOX.x1 - FEED_START_BOX.x0) / (FEED_START_BOX.y1 - FEED_START_BOX.y0)
const FEED_TIMER_ASPECT = (FEED_TIMER_BOX.x1 - FEED_TIMER_BOX.x0) / (FEED_TIMER_BOX.y1 - FEED_TIMER_BOX.y0)
const FEED_COUNT_ASPECT = (FEED_COUNT_BOX.x1 - FEED_COUNT_BOX.x0) / (FEED_COUNT_BOX.y1 - FEED_COUNT_BOX.y0)
const FEED_RESULTS_TEXTURE = 'assets/images/revamp/fruit_caught.png'
const FEED_RESULTS_W = 538
const FEED_RESULTS_H = 404
const FEED_RESULTS_ASPECT = FEED_RESULTS_W / FEED_RESULTS_H

function FeedStartCard() {
  const width = S(540)
  const height = Math.round(width / FEED_START_ASPECT)
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: S(72), left: '50%' }, margin: { left: -width / 2 }, width, height, pointerFilter: 'block' }}>
      <TactileButton id="feed_start" label="" texture={FEED_HUD_SHEET} uvs={FEED_START_UVS} width={width} height={height} onClick={() => startCatchingCountdown()} />
    </UiEntity>
  )
}

function FeedRoundPill(props: { kind: 'timer' | 'fruit'; value: string; width: number; flashing?: boolean; countdown?: boolean }) {
  const width = props.width
  const aspect = props.kind === 'timer' ? FEED_TIMER_ASPECT : FEED_COUNT_ASPECT
  const height = Math.round(width / aspect)
  const uvs = props.kind === 'timer' ? FEED_TIMER_UVS : FEED_COUNT_UVS
  const fontSize = props.countdown ? S(28) : props.kind === 'fruit' ? S(18) : S(20)
  const labelLeft = props.kind === 'fruit' ? Math.round(width * 0.34) : Math.round(width * 0.39)
  const labelWidth = props.kind === 'fruit' ? Math.round(width * 0.63) : Math.round(width * 0.58)
  return (
    <UiEntity uiTransform={{ width, height, pointerFilter: 'none' }} uiBackground={{ texture: { src: FEED_HUD_SHEET }, textureMode: 'stretch', uvs }}>
      <Label
        value={`<b>${props.value}</b>`}
        fontSize={fontSize}
        color={PET_UI.ink}
        textAlign="middle-center"
        uiTransform={{ positionType: 'absolute', position: { top: 0, left: labelLeft }, width: labelWidth, height }}
      />
    </UiEntity>
  )
}

function FeedRoundHud(props: { timeLeft: number; caught: number; flashing: boolean; countdown?: number }) {
  const timerWidth = S(145)
  const timerHeight = Math.round(timerWidth / FEED_TIMER_ASPECT)
  // Keep the fruit pill at the timer's exact height; it is wider because its
  // source card has a wider native aspect ratio.
  const fruitWidth = Math.round(timerHeight * FEED_COUNT_ASPECT)
  const gap = S(10)
  const showFruit = props.countdown === undefined
  const width = showFruit ? timerWidth + gap + fruitWidth : timerWidth
  const timerValue = props.countdown === undefined ? `${Math.ceil(props.timeLeft)}s` : `${props.countdown}`
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: S(12), left: '50%' }, margin: { left: -width / 2 }, width, height: S(86), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', pointerFilter: 'none' }}>
      <FeedRoundPill kind="timer" value={timerValue} width={timerWidth} countdown={props.countdown !== undefined} />
      {showFruit ? <UiEntity uiTransform={{ width: gap }} /> : null}
      {showFruit ? <FeedRoundPill kind="fruit" value={`Fruits: ${props.caught}`} width={fruitWidth} flashing={props.flashing} /> : null}
    </UiEntity>
  )
}

const FEED_PET_SIT_TUNER_STEP = 0.1

function FeedPetSitTunerAxis(props: { axis: FeedPetSitAxis; value: number }) {
  const axis = props.axis.toUpperCase()
  return (
    <UiEntity uiTransform={{ width: '100%', height: S(38), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { bottom: S(4) } }}>
      <TactileButton id={`feed_sit_${props.axis}_minus`} label={`- ${axis}`} width={S(70)} height={S(34)} bg={C.cardAlt} fontSize={S(13)} onClick={() => nudgeFeedPetSit(props.axis, -FEED_PET_SIT_TUNER_STEP)} />
      <Label value={`${axis}: ${props.value.toFixed(2)}`} fontSize={S(15)} color={C.text} textAlign="middle-center" uiTransform={{ width: S(92), height: S(34) }} />
      <TactileButton id={`feed_sit_${props.axis}_plus`} label={`+ ${axis}`} width={S(70)} height={S(34)} bg={C.cardAlt} fontSize={S(13)} onClick={() => nudgeFeedPetSit(props.axis, FEED_PET_SIT_TUNER_STEP)} />
    </UiEntity>
  )
}

/** Temporary live positioning controls for the pet sitting beside the lane.
 * Kept on the left so it never covers the pet being calibrated on screen-right. */
function FeedPetSitTuner() {
  if (!FEED_PET_SIT_TUNER_ENABLED) return null
  const tuning = getFeedPetSitTuning()
  if (!tuning.position) return null
  const width = S(270)
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: S(104), left: S(16) }, width, flexDirection: 'column', alignItems: 'center', padding: S(10), borderRadius: S(12), pointerFilter: 'block' }}
      uiBackground={{ color: { r: 0.05, g: 0.05, b: 0.08, a: 0.9 } }}
    >
      <Label value="DEBUG · PET SIT (world)" fontSize={S(14)} color={C.gold} textAlign="middle-center" uiTransform={{ width: '100%', height: S(24) }} />
      <Label value={`Offset  X ${tuning.offset.x.toFixed(2)}  Y ${tuning.offset.y.toFixed(2)}  Z ${tuning.offset.z.toFixed(2)}`} fontSize={S(11)} color={C.dim} textAlign="middle-center" uiTransform={{ width: '100%', height: S(20) }} />
      <FeedPetSitTunerAxis axis="x" value={tuning.position.x} />
      <FeedPetSitTunerAxis axis="y" value={tuning.position.y} />
      <FeedPetSitTunerAxis axis="z" value={tuning.position.z} />
      <TactileButton id="feed_sit_reset" label="Reset" width={S(110)} height={S(32)} bg={C.pink} fontSize={S(13)} onClick={() => resetFeedPetSitTuning()} />
    </UiEntity>
  )
}

function FeedGameOverlay() {
  const st = clientState.feedGame
  if (!st.active) return <UiEntity />
  if (st.phase === 'feeding' || st.phase === 'results') {
    return (
      <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
        <ScreenInsetArea>
          <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
            <FeedEatingPanel />
          </UiEntity>
        </ScreenInsetArea>
      </UiEntity>
    )
  }
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
          anchored counter/timer panel and move arrows) and needs the
          safe-area protection ScreenInsetArea provides on mobile (fixes #134;
          the renderer's own screenInset:'none' opts out of automatic inset
          scene-wide, so this wrapper is the only safe-area handling here). */}
      <BackButton onClick={() => cancelFruitGame()} />
      <ScreenInsetArea>
        <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
          {catching || countdown ? <FeedRoundHud timeLeft={st.timeLeft} caught={st.caught} flashing={flashing} countdown={countdown ? countdownNum : undefined} /> : null}
          <UiEntity
            uiTransform={{ display: 'none' }}
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
          {introPhase ? <FeedStartCard /> : null}
          <FeedPetSitTuner />
          {mobile() ? <MoveArrowButton side="left" /> : null}
          {mobile() ? <MoveArrowButton side="right" /> : null}
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
function BathBubble(props: { key?: string; b: Bubble }) {
  const b = props.b
  // Frame 0's glossy bubble only fills the center ~58% of its cell (the rest is
  // transparent). Crop the UV to that bbox and size the box to the bubble itself,
  // so the tappable area wraps the *visible* bubble exactly — a full-cell box would
  // be ~3x too big, overlap its neighbours, and pop the wrong bubble on a near miss.
  const size = S(b.r * 2 * BUBBLE_ART_FRAC)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { left: `${b.x * 100}%`, top: `${b.y * 100}%` },
        margin: { left: -size / 2, top: -size / 2 }, // center on (x,y)
        width: size,
        height: size,
        pointerFilter: 'block'
      }}
      uiBackground={{ texture: { src: BUBBLE_POP_SHEET }, textureMode: 'stretch', uvs: bubbleArtUvs() }}
      onMouseDown={() => popBubble(b.id)}
    />
  )
}

// Pop-splash: a short sprite-sheet animation played where a bubble burst. The
// sheet is one horizontal row of BUBBLE_POP_FRAMES frames; we crop the current
// frame's UVs by elapsed time.
const BUBBLE_POP_SHEET = 'assets/images/bubbleFrame/spritesheet_6x1_512.png'
// Frame-0 bubble bbox within its 512px cell (measured off the sheet). The splash
// frames grow from this to fill the whole cell, so the visible bubble occupies
// BUBBLE_ART_FRAC of its own box.
const BUBBLE_ART = { x0: 107, y0: 107, x1: 405, y1: 405, cell: 512 }
const BUBBLE_ART_FRAC = (BUBBLE_ART.x1 - BUBBLE_ART.x0) / BUBBLE_ART.cell // ~0.582 of the cell
function bubbleArtUvs(): number[] {
  const sheetW = BUBBLE_POP_FRAMES * BUBBLE_ART.cell
  const uL = BUBBLE_ART.x0 / sheetW
  const uR = BUBBLE_ART.x1 / sheetW
  const vBottom = 1 - BUBBLE_ART.y1 / BUBBLE_ART.cell
  const vTop = 1 - BUBBLE_ART.y0 / BUBBLE_ART.cell
  return [uL, vBottom, uL, vTop, uR, vTop, uR, vBottom]
}
// Splash box == the bubble's full cell (2r). Since the pop's frame 0 is the same
// 58% art as the floating bubble, POP_SCALE 1.0 makes the burst start exactly at
// the bubble's size and then expand outward as later frames fill their cell (up to
// ~1.7x). A larger scale here double-counts that growth and oversizes the splash.
const POP_SCALE = 1.0
// Crop frame `i` of `total` from a horizontal sprite strip (one row, full height).
// Shared by the bath pop-splash sprite strips.
function stripFrameUvs(i: number, total: number): number[] {
  const uL = i / total
  const uR = (i + 1) / total
  return [uL, 0, uL, 1, uR, 1, uR, 0] // [bl, tl, tr, br] — full frame height, one column
}
function BathPop(props: { key?: string; p: PopFx }) {
  const p = props.p
  const t = (Date.now() - p.startAt) / BUBBLE_POP_MS // 0..1
  const frame = Math.min(BUBBLE_POP_FRAMES - 1, Math.max(0, Math.floor(t * BUBBLE_POP_FRAMES)))
  const size = S(p.r * 2 * POP_SCALE)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { left: `${p.x * 100}%`, top: `${p.y * 100}%` },
        margin: { left: -size / 2, top: -size / 2 }, // center the splash on the burst point
        width: size,
        height: size,
        pointerFilter: 'none'
      }}
      uiBackground={{ texture: { src: BUBBLE_POP_SHEET }, textureMode: 'stretch', uvs: stripFrameUvs(frame, BUBBLE_POP_FRAMES) }}
    />
  )
}

// The bath HUD art is a single 1024px sheet holding every card of the minigame:
// the intro/Start card, the timer + counter pills, and the results card. Crop
// each at its native aspect (same feedHud pattern) so the illustrated borders
// and icons never get stretched by the responsive UI.
const BATH_HUD_SHEET = 'assets/images/revamp/bath_hud.png'
const BATH_HUD_W = 1024
const BATH_HUD_H = 1024
function bathHudUvRect(x0: number, y0: number, x1: number, y1: number): number[] {
  return sheetUvRect(x0, y0, x1, y1, BATH_HUD_W, BATH_HUD_H)
}
// Pixel boxes of each piece within bath_hud.png (measured off the source art).
const BATH_START_BOX = { x0: 19, y0: 6, x1: 731, y1: 394 }
const BATH_TIMER_BOX = { x0: 12, y0: 471, x1: 384, y1: 626 }
const BATH_COUNT_BOX = { x0: 13, y0: 661, x1: 381, y1: 812 }
const BATH_RESULTS_BOX = { x0: 402, y0: 397, x1: 908, y1: 833 }
const BATH_START_UVS = bathHudUvRect(BATH_START_BOX.x0, BATH_START_BOX.y0, BATH_START_BOX.x1, BATH_START_BOX.y1)
const BATH_TIMER_UVS = bathHudUvRect(BATH_TIMER_BOX.x0, BATH_TIMER_BOX.y0, BATH_TIMER_BOX.x1, BATH_TIMER_BOX.y1)
const BATH_COUNT_UVS = bathHudUvRect(BATH_COUNT_BOX.x0, BATH_COUNT_BOX.y0, BATH_COUNT_BOX.x1, BATH_COUNT_BOX.y1)
const BATH_RESULTS_UVS = bathHudUvRect(BATH_RESULTS_BOX.x0, BATH_RESULTS_BOX.y0, BATH_RESULTS_BOX.x1, BATH_RESULTS_BOX.y1)
const BATH_START_ASPECT = (BATH_START_BOX.x1 - BATH_START_BOX.x0) / (BATH_START_BOX.y1 - BATH_START_BOX.y0)
const BATH_TIMER_ASPECT = (BATH_TIMER_BOX.x1 - BATH_TIMER_BOX.x0) / (BATH_TIMER_BOX.y1 - BATH_TIMER_BOX.y0)
const BATH_COUNT_ASPECT = (BATH_COUNT_BOX.x1 - BATH_COUNT_BOX.x0) / (BATH_COUNT_BOX.y1 - BATH_COUNT_BOX.y0)
const BATH_RESULTS_ASPECT = (BATH_RESULTS_BOX.x1 - BATH_RESULTS_BOX.x0) / (BATH_RESULTS_BOX.y1 - BATH_RESULTS_BOX.y0)

// Intro card: the whole illustrated card ("Tap the bubbles…" + a drawn Start
// button) is one big tappable button, exactly like the feed minigame's start card.
function BathStartCard() {
  const width = S(540)
  const height = Math.round(width / BATH_START_ASPECT)
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: S(72), left: '50%' }, margin: { left: -width / 2 }, width, height, pointerFilter: 'block' }}>
      <TactileButton id="bath_start" label="" texture={BATH_HUD_SHEET} uvs={BATH_START_UVS} width={width} height={height} onClick={() => startBathCountdown()} />
    </UiEntity>
  )
}

// One HUD pill (timer or bubble counter): the illustrated pill sprite with the
// live value dropped into the empty cream area to the right of its baked-in icon.
function BathRoundPill(props: { kind: 'timer' | 'count'; value: string; width: number; countdown?: boolean; flashing?: boolean }) {
  const width = props.width
  const aspect = props.kind === 'timer' ? BATH_TIMER_ASPECT : BATH_COUNT_ASPECT
  const height = Math.round(width / aspect)
  const uvs = props.kind === 'timer' ? BATH_TIMER_UVS : BATH_COUNT_UVS
  // Brief gold pop on the counter each time a bubble bursts (popFlashUntil).
  const fontSize = props.countdown ? S(28) : props.flashing ? S(27) : S(22)
  const labelLeft = Math.round(width * 0.4)
  const labelWidth = Math.round(width * 0.55)
  return (
    <UiEntity uiTransform={{ width, height, pointerFilter: 'none' }} uiBackground={{ texture: { src: BATH_HUD_SHEET }, textureMode: 'stretch', uvs }}>
      <Label
        value={`<b>${props.value}</b>`}
        fontSize={fontSize}
        color={props.flashing ? C.gold : PET_UI.ink}
        textAlign="middle-center"
        uiTransform={{ positionType: 'absolute', position: { top: 0, left: labelLeft }, width: labelWidth, height }}
      />
    </UiEntity>
  )
}

// Top-center HUD: timer + bubble counter while popping; during the 3-2-1 it
// collapses to just the timer pill showing the countdown number (feed pattern).
function BathRoundHud(props: { timeLeft: number; popped: number; countdown?: number; flashing?: boolean }) {
  const timerWidth = S(150)
  const timerHeight = Math.round(timerWidth / BATH_TIMER_ASPECT)
  const countWidth = Math.round(timerHeight * BATH_COUNT_ASPECT) // match heights; count is a touch wider
  const gap = S(10)
  const showCount = props.countdown === undefined
  const width = showCount ? timerWidth + gap + countWidth : timerWidth
  const timerValue = props.countdown === undefined ? `${Math.ceil(props.timeLeft)}s` : `${props.countdown}`
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: S(12), left: '50%' }, margin: { left: -width / 2 }, width, height: S(86), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', pointerFilter: 'none' }}>
      <BathRoundPill kind="timer" value={timerValue} width={timerWidth} countdown={props.countdown !== undefined} />
      {showCount ? <UiEntity uiTransform={{ width: gap }} /> : null}
      {showCount ? <BathRoundPill kind="count" value={`${props.popped}/${BUBBLE_GOAL}`} width={countWidth} flashing={props.flashing} /> : null}
    </UiEntity>
  )
}

// Results card fill animation — a celebratory 0 → clean% sweep on the illustrated
// "Pet clean" track, kicked off a beat after the card appears (resultsAt).
const BATH_RESULTS_FILL_DELAY_S = 0.3
const BATH_RESULTS_FILL_DUR_S = 0.9
function BathResultsPanel() {
  const st = clientState.bathGame
  const clean = st.popped >= BUBBLE_GOAL
  const cardW = S(400)
  const cardH = Math.round(cardW / BATH_RESULTS_ASPECT)
  // Inner "Pet clean" track bounds, as fractions of the illustrated card.
  const barLeft = Math.round(cardW * 0.103)
  const barTop = Math.round(cardH * 0.516)
  const barW = Math.round(cardW * 0.796)
  const barH = Math.round(cardH * 0.106)
  const elapsed = Math.max(0, (Date.now() - st.resultsAt) / 1000 - BATH_RESULTS_FILL_DELAY_S)
  const raw = Math.max(0, Math.min(1, elapsed / BATH_RESULTS_FILL_DUR_S))
  const eased = raw * raw * (3 - 2 * raw) // smoothstep
  const target = clean ? 1 : Math.min(1, st.popped / BUBBLE_GOAL)
  const barPct = Math.max(0, Math.min(100, target * eased * 100))
  // The illustrated card's text ("Bubbles popped! / Pet clean") is baked and fixed,
  // so the outcome rides on a caption below the card + the bar's colour (blue =
  // full clean, amber = partial). Hygiene now scales with bubbles, so a partial
  // round reports the hygiene it earned instead of a misleading "try again".
  const gained = Math.round(Math.min(st.popped, BUBBLE_GOAL) * Cfg.BATH_HYGIENE_PER_BUBBLE)
  const caption = clean
    ? `Squeaky clean!   ${st.popped} bubbles popped`
    : st.popped > 0
      ? `${st.popped}/${BUBBLE_GOAL} popped — +${gained} hygiene`
      : `Popped 0/${BUBBLE_GOAL} — try again!`
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }}
      uiBackground={{ color: C.scrim }}
    >
      <UiEntity
        uiTransform={{ width: cardW, height: cardH, pointerFilter: 'block' }}
        uiBackground={{ texture: { src: BATH_HUD_SHEET }, textureMode: 'stretch', uvs: BATH_RESULTS_UVS }}
      >
        {/* hygiene fill overlaid on the illustrated progress track */}
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: barTop, left: barLeft }, width: barW, height: barH }}>
          <UiEntity uiTransform={{ width: `${barPct}%`, height: '100%', borderRadius: barH / 2 }} uiBackground={{ color: clean ? C.hygiene : C.gold }} />
        </UiEntity>
        {/* invisible clickable hotspot over the illustrated Exit button */}
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: Math.round(cardH * 0.727), left: Math.round(cardW * 0.215) }, width: Math.round(cardW * 0.573), height: Math.round(cardH * 0.172), pointerFilter: 'block' }}
          uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0 } }}
          onMouseDown={() => {
            playUiClick()
            exitBathResults()
          }}
        />
      </UiEntity>
      <Label
        value={caption}
        fontSize={S(22)}
        color={clean ? C.hygiene : C.gold}
        textAlign="middle-center"
        uiTransform={{ width: cardW, height: S(34), margin: { top: S(14) } }}
      />
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
  const flashing = Date.now() < st.popFlashUntil // brief counter pop on each burst
  const countdownNum = Math.max(1, Math.min(BATH_COUNTDOWN_S, Math.ceil(BATH_COUNTDOWN_S - (Date.now() - st.countdownAt) / 1000)))
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
      <BackButton onClick={() => cancelBathGame()} />
      <ScreenInsetArea>
        <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
          {/* the bubbles — they only exist (and are poppable) during the timed 'popping' phase */}
          {getBubbles().map((b) => (
            <BathBubble key={`bub-${b.id}`} b={b} />
          ))}
          {/* pop-splash sprite animations at each burst point */}
          {getPops().map((p) => (
            <BathPop key={`pop-${p.id}`} p={p} />
          ))}
          {/* Illustrated HUD (bath_hud.png): timer+counter pills while popping,
              timer-only during the 3-2-1, and the full Start card during intro —
              the same sprite-card presentation as the revamped feed minigame. */}
          {popping || countdown ? <BathRoundHud timeLeft={st.timeLeft} popped={st.popped} countdown={countdown ? countdownNum : undefined} flashing={flashing} /> : null}
          {intro ? <BathStartCard /> : null}
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
          onMouseDown={() => {
            playUiClick()
            props.onClose()
          }}
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

const PET_CARD_ASPECT = (PET_CARD_SELECTED_BOX.x1 - PET_CARD_SELECTED_BOX.x0) / (PET_CARD_SELECTED_BOX.y1 - PET_CARD_SELECTED_BOX.y0)

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
          onMouseDown={() => {
            playUiClick()
            props.onClose()
          }}
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
// Animal Actions card (the owner's PetPanel): the revamp frame (same family as
// the Album / Inventory / My Pets panels) WITHOUT a baked title, since the header
// is the pet's own name/level rendered inline by PetIdentityRow. Its close X
// uses the standard revamp dimensions; an invisible hit area sits on it.
const PET_ACTIONS_PANEL = 'assets/images/revamp/pet_actions_panel.png'
const PET_ACTIONS_TEX_W = 998
const PET_ACTIONS_TEX_H = 730
const PET_ACTIONS_CLOSE = REVAMP_CLOSE

function PetHudCard(props: { width: number; height: number; onClose: () => void; children?: any }) {
  const sidePad = S(30)
  const topPad = S(26)
  const k = props.width / PET_ACTIONS_TEX_W
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }}
      uiBackground={{ color: PET_UI.scrim }}
      onMouseDown={() => {}}
    >
      <UiEntity uiTransform={{ width: props.width, height: props.height }}>
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: props.width, height: props.height }} uiBackground={{ texture: { src: PET_ACTIONS_PANEL }, textureMode: 'stretch' }} />
        {/* Buttons may pulse slightly past the content column, into this card's
            built-in side padding. Keeping that padding visible prevents the
            Breed CTA from being clipped at its widest point. */}
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: topPad, left: sidePad }, width: props.width - sidePad * 2, height: props.height - topPad * 2, flexDirection: 'column', alignItems: 'center', overflow: 'visible' }}>
          {props.children}
        </UiEntity>
        {/* Invisible hit area over the baked close X — after the content so it wins the tap. */}
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: Math.round(PET_ACTIONS_CLOSE.y * k), left: Math.round(PET_ACTIONS_CLOSE.x * k) }, width: Math.round(PET_ACTIONS_CLOSE.size * k), height: Math.round(PET_ACTIONS_CLOSE.size * k), pointerFilter: 'block' }}
          uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0 } }}
          onMouseDown={() => {
            playUiClick()
            props.onClose()
          }}
        />
      </UiEntity>
    </UiEntity>
  )
}

function PetGridCard(props: { selected: boolean; width: number; height: number; onClick?: () => void; children?: any; pad?: number }) {
  const pad = props.pad ?? S(18)
  const tick = S(30)
  return (
    <UiEntity uiTransform={{ width: props.width, height: props.height, margin: { left: S(6), right: S(6), top: S(6), bottom: S(6) } }}>
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: props.width, height: props.height, pointerFilter: props.onClick ? 'block' : 'none' }}
        uiBackground={{ texture: { src: PET_HUD_SHEET }, textureMode: 'stretch', uvs: props.selected ? PET_CARD_SELECTED_UVS : PET_CARD_PLAIN_UVS }}
        onMouseDown={
          props.onClick
            ? () => {
                playUiClick()
                props.onClick!()
              }
            : undefined
        }
      />
      <UiEntity uiTransform={{ positionType: 'absolute', position: { top: pad, left: pad }, width: props.width - pad * 2, height: props.height - pad * 2, flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        {props.children}
      </UiEntity>
      {/* The selected card art has no baked check: overlay the Goals tick on its
          top-right corner, overhanging into the card's own margin. */}
      {props.selected && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: -S(6), left: props.width - Math.round(tick * 0.8) }, width: tick, height: tick, pointerFilter: 'none' }}
          uiBackground={{ texture: { src: GOALS_TICK_IMG }, textureMode: 'stretch' }}
        />
      )}
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
  const bh = S(92)
  const bw = Math.round(bh * HATCH_BUTTON_ASPECT)
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: S(80), left: '50%' }, margin: { left: -bw / 2 }, width: bw, height: bh, alignItems: 'center', justifyContent: 'center', pointerFilter: 'none' }}>
      <TactileButton id="carry_hatch" label="" texture={HATCH_BUTTON_ICON} width={bw} height={bh} pulse onClick={() => beginHatchFromCarry()} />
    </UiEntity>
  )
}

// Carry-pet-to-bath flow — a hint while walking to the tub, then a big "Bath"
// button once close; tapping it places the pet in the tub and bathes it.
function BathButton() {
  const st = clientState.carryPet
  if (!st.active) return <UiEntity />
  const bh = S(92)
  const bw = Math.round(bh * BATH_BUTTON_ASPECT)
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
          <TactileButton id="place_bath" label="" texture={BATH_BUTTON_ICON} width={bw} height={bh} pulse onClick={() => placePetAtStation()} />
        </UiEntity>
      )}
    </UiEntity>
  )
}

// World buttons for the breeding-nest flow. 'pickB' (partner picker modal) and
// 'animating' (frozen egg cinematic) render no world buttons; 'toNest' shows a
// "Place Pet" once you reach the nest; 'ready' shows "Breed" (opens the
// name/potion modal). BACK cancels the whole flow at any step.
// breed.png is a 1920x1320 sheet stacking the two illustrated pill buttons:
// PLACE PET on top, BREED on the bottom (same style as the bath button). Crop
// each half and render it at its native aspect, like BathButton.
const BREED_BTN_SHEET = 'assets/images/revamp/breed.png'
const BREED_BTN_W = 812
const BREED_BTN_H = 666
const BREED_PLACE_UVS = sheetUvRect(0, 0, BREED_BTN_W, BREED_BTN_H / 2, BREED_BTN_W, BREED_BTN_H) // top half
const BREED_GO_UVS = sheetUvRect(0, BREED_BTN_H / 2, BREED_BTN_W, BREED_BTN_H, BREED_BTN_W, BREED_BTN_H) // bottom half
const BREED_BTN_ASPECT = BREED_BTN_W / (BREED_BTN_H / 2)

function BreedButtons() {
  const b = clientState.breed
  // Also hidden while the name/potion modal is up — otherwise the world "Breed"
  // button (phase 'ready') shows through behind it.
  if (!b.active || b.phase === 'pickB' || b.phase === 'animating' || uiState.panel === 'breedName') return <UiEntity />
  const showPlace = b.phase === 'toNest' && b.atNest
  const showBreed = b.phase === 'ready'
  const bh = S(92) // match the bath/hatch button height
  const bw = Math.round(bh * BREED_BTN_ASPECT)
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
      <BackButton onClick={() => cancelBreed()} />
      {(showPlace || showBreed) && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: S(80), left: '50%' }, margin: { left: -bw / 2 }, width: bw, height: bh, alignItems: 'center', justifyContent: 'center', pointerFilter: 'none' }}>
          {showPlace ? (
            <TactileButton id="breed_place" label="" texture={BREED_BTN_SHEET} uvs={BREED_PLACE_UVS} width={bw} height={bh} pulse onClick={() => placeParentA()} />
          ) : (
            <TactileButton
              id="breed_go"
              label=""
              texture={BREED_BTN_SHEET}
              uvs={BREED_GO_UVS}
              width={bw}
              height={bh}
              pulse
              onClick={() => {
                uiState.breedName = ''
                uiState.breedUsePotion = false
                uiState.panel = 'breedName'
              }}
            />
          )}
        </UiEntity>
      )}
    </UiEntity>
  )
}

// Partner picker (breed phase 'pickB'): tap a second Adult to place it in the
// right bowl. Non-Adults are shown but rejected with a toast. Close/BACK cancels.
// Same shell, card size and paging as My Pets (Inventory-sized revamp panel,
// one row of 4 roster-style cards).
const CHOOSE_PARTNER_PANEL = 'assets/images/revamp/choose_partner_panel.png'

function PartnerCard(props: { key?: string; pet: PetData }) {
  const pet = props.pet
  const adult = Cfg.petStage(pet.size) === 'ADULT'
  const img = Cfg.speciesImage(pet.species)
  const cardW = S(ROSTER_CARD_W)
  const cardH = Math.round(cardW / PET_CARD_ASPECT)
  const disc = rosterPx(78)
  return (
    <PetGridCard
      pad={rosterPx(13)}
      selected={false}
      width={cardW}
      height={cardH}
      onClick={() => (adult ? chooseBreedPartner(pet.id) : showBreedNotice('That pet must be an Adult to breed.'))}
    >
      <UiEntity
        uiTransform={{ width: disc, height: disc, borderRadius: disc / 2, margin: { bottom: rosterPx(8) } }}
        uiBackground={img ? { texture: { src: img }, textureMode: 'stretch', color: adult ? undefined : { r: 1, g: 1, b: 1, a: 0.5 } } : { color: speciesColor(pet.species) }}
      />
      <Label value={pet.name} fontSize={rosterPx(17)} color={adult ? PET_UI.ink : PET_UI.muted} textAlign="middle-center" uiTransform={{ width: '100%', height: rosterPx(22) }} />
      <Label value={adult ? `Lv ${pet.petLevel}` : 'Not Adult'} fontSize={rosterPx(13)} color={PET_UI.muted} textAlign="middle-center" uiTransform={{ width: '100%', height: rosterPx(18), margin: { top: rosterPx(2) } }} />
    </PetGridCard>
  )
}

function BreedPickerPanel() {
  const p = clientState.player
  const activeId = clientState.activePet?.id
  // Adults first, so the pets you can actually pick lead the list.
  const others = (p?.pets ?? []).filter((x) => x.id !== activeId)
  others.sort((a, b) => Number(Cfg.petStage(b.size) === 'ADULT') - Number(Cfg.petStage(a.size) === 'ADULT'))
  const pageCount = Math.max(1, Math.ceil(others.length / ROSTER_PAGE_SIZE))
  const page = Math.min(Math.max(0, uiState.breedPickerPage), pageCount - 1)
  uiState.breedPickerPage = page
  const shown = others.slice(page * ROSTER_PAGE_SIZE, (page + 1) * ROSTER_PAGE_SIZE)
  return (
    <RevampPanel src={CHOOSE_PARTNER_PANEL} texW={REVAMP_PANEL_W} texH={MYPETS_PANEL_H} width={navPanelWidth()} contentTop={REVAMP_CONTENT_TOP} onClose={() => cancelBreed()}>
      {shown.length === 0 ? (
        <Label value="You need a second pet to breed with." fontSize={S(18)} color={PET_UI.muted} textAlign="middle-center" uiTransform={{ width: '100%', height: S(40), margin: { top: S(90) } }} />
      ) : (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'center', alignItems: 'flex-start', margin: { top: S(46), bottom: S(10) } }}>
          {shown.map((pet) => (
            <PartnerCard key={pet.id} pet={pet} />
          ))}
        </UiEntity>
      )}
      <CardPager idPrefix="partner" page={page} pageCount={pageCount} onPage={(n) => (uiState.breedPickerPage = n)} />
      {/* Rejections (non-Adult) show here: toasts are suppressed while the picker
          is open. Absolute, in the gap above the cards, so nothing shifts. */}
      <UiEntity uiTransform={{ positionType: 'absolute', position: { top: S(4), left: 0 }, width: '100%', justifyContent: 'center', flexDirection: 'row', pointerFilter: 'none' }}>
        <BreedNoticePill marginTop={0} />
      </UiEntity>
    </RevampPanel>
  )
}

// ---------------------------------------------------------------------------
// The Ark (issue #248) — the Captain's pet picker (any Adult in the roster; the
// pick opens ArkConfirmPanel, shared with the pet panel's "Send to Ark"), the
// donor ranking, the first-donation card after the boarding cinematic and the
// "lifted off" card at the end of a launch. Logic: arkRedeem.ts, arkCinematics.ts.
// ---------------------------------------------------------------------------
let arkNotice = { text: '', until: 0 }
function showArkNotice(text: string) {
  arkNotice = { text, until: Date.now() + 2500 }
}

function rarityColor(r: Rarity): Color {
  const c = Cfg.RARITY_COLOR[r] ?? Cfg.RARITY_COLOR.common
  return { r: c.r, g: c.g, b: c.b, a: 1 }
}

/** Why a pet can't board right now ('' = it can). Mirrors server/state.ts donatePet. */
function arkBlockReason(pet: PetData): string {
  if (Cfg.petStage(pet.size) !== 'ADULT') return 'Not Adult'
  if ((clientState.player?.pets.length ?? 0) < 2) return 'Last pet'
  if (pet.sleeping) return 'Sleeping'
  if (pet.sick) return 'Sick'
  return ''
}

function ArkProgress(props: { width: number }) {
  const s = clientState.ark.status
  const frac = s.goal > 0 ? Math.max(0, Math.min(1, s.donated / s.goal)) : 0
  const barH = S(14)
  return (
    <UiEntity uiTransform={{ width: props.width, flexDirection: 'column', alignItems: 'center' }}>
      <Label value={`Ark progress: ${s.donated} / ${s.goal} pets aboard`} fontSize={S(16)} color={PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: S(24) }} />
      <UiEntity uiTransform={{ width: props.width, height: barH, borderRadius: barH / 2, margin: { top: S(4) } }} uiBackground={{ color: { r: 0.87, g: 0.8, b: 0.71, a: 1 } }}>
        <UiEntity uiTransform={{ width: Math.max(barH, Math.round(props.width * frac)), height: barH, borderRadius: barH / 2 }} uiBackground={{ color: LOC.blue }} />
      </UiEntity>
    </UiEntity>
  )
}

function ArkPetCard(props: { key?: string; pet: PetData }) {
  const pet = props.pet
  const blocked = arkBlockReason(pet)
  const img = Cfg.speciesImage(pet.species)
  const cardW = S(ROSTER_CARD_W)
  const cardH = Math.round(cardW / PET_CARD_ASPECT)
  const disc = rosterPx(78)
  return (
    <PetGridCard
      pad={rosterPx(13)}
      selected={false}
      width={cardW}
      height={cardH}
      onClick={() => {
        if (blocked) {
          showArkNotice(blocked === 'Not Adult' ? 'Only Adult pets can board the Ark.' : blocked === 'Last pet' ? 'Keep at least one pet in your colony.' : `${pet.name} is ${blocked.toLowerCase()} right now.`)
          return
        }
        ui.close()
        openArkConfirm(pet.id)
      }}
    >
      <UiEntity
        uiTransform={{ width: disc, height: disc, borderRadius: disc / 2, margin: { bottom: rosterPx(8) } }}
        uiBackground={img ? { texture: { src: img }, textureMode: 'stretch', color: blocked ? { r: 1, g: 1, b: 1, a: 0.5 } : undefined } : { color: speciesColor(pet.species) }}
      />
      <Label value={pet.name} fontSize={rosterPx(17)} color={blocked ? PET_UI.muted : PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: rosterPx(22) }} />
      <Label
        value={blocked || Cfg.rarityLabel(pet.rarity)}
        fontSize={rosterPx(13)}
        color={blocked ? PET_UI.muted : rarityColor(pet.rarity)}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: rosterPx(18), margin: { top: rosterPx(2) } }}
      />
    </PetGridCard>
  )
}

function ArkDonatePanel() {
  const p = clientState.player
  const pets = [...(p?.pets ?? [])]
  // Pets that can board first, so the ones you can actually pick lead the list.
  pets.sort((a, b) => Number(arkBlockReason(b) === '') - Number(arkBlockReason(a) === ''))
  const width = S(720)
  const innerW = width - S(60)
  const pageCount = Math.max(1, Math.ceil(pets.length / ROSTER_PAGE_SIZE))
  const page = Math.min(Math.max(0, uiState.arkPage), pageCount - 1)
  uiState.arkPage = page
  const shown = pets.slice(page * ROSTER_PAGE_SIZE, (page + 1) * ROSTER_PAGE_SIZE)
  const btnW = S(170)
  const btnH = Math.round(btnW / PILL_HALF_ASPECT)
  const noticeOn = Date.now() < arkNotice.until
  return (
    <PetHudModal title="Board the Ark" subtitle="Hand an Adult pet to the Captain. Rarer pets earn more XP and coins." width={width} height={S(620)} onClose={() => ui.close()}>
      <ArkProgress width={innerW - S(80)} />
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
        {shown.length === 0 ? (
          <Label
            value="You have no pets yet — adopt one at the Care Center and raise it to Adult."
            fontSize={S(17)}
            color={PET_UI.muted}
            textAlign="middle-center"
            textWrap="wrap"
            uiTransform={{ width: '100%', height: S(60), margin: { top: S(60) } }}
          />
        ) : (
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'center', alignItems: 'flex-start', margin: { top: S(14) } }}>
            {shown.map((pet) => (
              <ArkPetCard key={pet.id} pet={pet} />
            ))}
          </UiEntity>
        )}
        <CardPager idPrefix="ark" page={page} pageCount={pageCount} onPage={(n) => (uiState.arkPage = n)} />
        <Label
          value={noticeOn ? arkNotice.text : 'Tap a pet to send it aboard.'}
          fontSize={S(15)}
          color={noticeOn ? LOC.orange : PET_UI.muted}
          textAlign="middle-center"
          uiTransform={{ width: '100%', height: S(24), margin: { top: S(4) } }}
        />
        <PillButton id="ark_ranking" label="Ranking" shape="half" color="pink" width={btnW} height={btnH} margin={{ top: S(6) }} onClick={() => ui.openArkRanking()} />
      </UiEntity>
    </PetHudModal>
  )
}

function ArkRankingRow(props: { key?: string; rank: number; name: string; count: number; isMe: boolean }) {
  const ink = props.isMe ? LOC.white : PET_UI.ink
  const iconS = S(22)
  return (
    <UiEntity
      uiTransform={{ width: LB_ROW_W, height: S(36), flexDirection: 'row', alignItems: 'center', margin: { bottom: S(3) }, padding: { left: S(12), right: S(14) }, borderRadius: S(12) }}
      uiBackground={{ color: props.isMe ? LOC.blue : LOC.tile }}
    >
      <Label value={`${props.rank}`} fontSize={S(17)} color={ink} textAlign="middle-center" uiTransform={{ width: LB_RANK_W, height: S(24) }} />
      <Label value={props.name} fontSize={S(16)} color={ink} textAlign="middle-left" textWrap="nowrap" uiTransform={{ flex: 1, height: S(24) }} />
      <UiEntity uiTransform={{ width: LB_COINS_W, height: S(26), flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}>
        <UiEntity uiTransform={{ width: iconS, height: iconS }} uiBackground={{ texture: { src: HUD_SHEET }, textureMode: 'stretch', uvs: NAV_PAW_UVS }} />
        <Label value={`${props.count}`} fontSize={S(16)} color={ink} textAlign="middle-left" uiTransform={{ width: S(10 + `${props.count}`.length * 10), height: S(24), margin: { left: S(6) } }} />
      </UiEntity>
    </UiEntity>
  )
}

function ArkRankingPanel() {
  const lb = clientState.ark.leaderboard
  const me = clientState.myAddress.toLowerCase()
  const meInTop = !!lb && lb.rows.some((r) => r.address.toLowerCase() === me)
  const btnW = S(170)
  const btnH = Math.round(btnW / PILL_HALF_ASPECT)
  return (
    <PetHudModal title="Ark Ranking" subtitle="Top pet donors across every launch." width={S(640)} height={S(620)} onClose={() => ui.close()}>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
        {!lb ? (
          <Label value="Loading standings…" fontSize={S(18)} color={LOC.dim} textAlign="middle-center" uiTransform={{ width: '100%', height: S(40), margin: { top: S(20) } }} />
        ) : lb.rows.length === 0 ? (
          <Label value="No donations yet — be the first to board a pet!" fontSize={S(18)} color={LOC.dim} textAlign="middle-center" uiTransform={{ width: '100%', height: S(40), margin: { top: S(20) } }} />
        ) : (
          lb.rows.map((r, i) => <ArkRankingRow key={r.address} rank={i + 1} name={r.name} count={r.count} isMe={r.address.toLowerCase() === me} />)
        )}
        {lb && lb.me && !meInTop && <ArkRankingRow key="me" rank={lb.me.rank} name="You" count={lb.me.count} isMe />}
        <PillButton id="ark_rank_back" label="Back" shape="half" color="gray" width={btnW} height={btnH} margin={{ top: S(10) }} onClick={() => ui.openArkDonate()} />
      </UiEntity>
    </PetHudModal>
  )
}

function WearablePreview(props: { key?: string; wearableId: string }) {
  const w = Cfg.arkWearableById(props.wearableId)
  if (!w) return <UiEntity />
  const tile = S(110)
  return (
    <UiEntity uiTransform={{ width: tile + S(40), flexDirection: 'column', alignItems: 'center', margin: { left: S(8), right: S(8) } }}>
      <UiEntity uiTransform={{ width: tile, height: tile, borderRadius: S(18), alignItems: 'center', justifyContent: 'center' }} uiBackground={{ color: LOC.tile }}>
        <UiEntity uiTransform={{ width: tile - S(16), height: tile - S(16) }} uiBackground={{ texture: { src: w.image }, textureMode: 'stretch' }} />
      </UiEntity>
      <Label value={w.name} fontSize={S(15)} color={PET_UI.ink} textAlign="middle-center" textWrap="wrap" uiTransform={{ width: '100%', height: S(40), margin: { top: S(4) } }} />
    </UiEntity>
  )
}

function ArkThanksPanel() {
  const r = clientState.ark.thanks
  if (!r) return <UiEntity />
  const btnW = S(190)
  const btnH = Math.round(btnW / PILL_HALF_ASPECT)
  const height = S(560)
  return (
    <PetHudModal title="Thank you!" subtitle={`${r.petName} boarded the Ark.`} width={S(620)} height={height} onClose={() => closeArkThanks()}>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
        <Label value={`+${r.xp} Caretaker XP  ·  +${r.coins} coins`} fontSize={S(20)} color={PET_UI.ink} textAlign="middle-center" uiTransform={{ width: '100%', height: S(30) }} />
        <ArkProgress width={S(420)} />
        {r.firstWearableId !== '' && (
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center', margin: { top: S(10) } }}>
            <Label value="First donation! You'll receive this wearable:" fontSize={S(16)} color={LOC.violet} textAlign="middle-center" uiTransform={{ width: '100%', height: S(24) }} />
            <WearablePreview wearableId={r.firstWearableId} />
          </UiEntity>
        )}
        <PillButton id="ark_thanks_ok" label="Great!" shape="half" color="green" width={btnW} height={btnH} pulse margin={{ top: S(10) }} onClick={() => closeArkThanks()} />
      </UiEntity>
    </PetHudModal>
  )
}

// DEBUG (ARK_HANDOVER_TUNER_ENABLED): live tuning for the hand-over shot and the
// pet's height on the ramp. Outside the cinematic it's just a "Test walk" button
// that replays it without donating; values are logged on every change.
const ARK_TUNE_ROWS: { key: ArkTuneKey; label: string; step: number }[] = [
  { key: 'camX', label: 'Cam X', step: 0.5 },
  { key: 'camY', label: 'Cam Y', step: 0.5 },
  { key: 'camZ', label: 'Cam Z', step: 0.5 },
  { key: 'lookLift', label: 'Look Y', step: 0.1 },
  { key: 'rampLift', label: 'Ramp Y', step: 0.05 }
]

function ArkTunerRow(props: { key?: string; tuneKey: ArkTuneKey; label: string; step: number; value: number }) {
  return (
    <UiEntity uiTransform={{ width: '100%', height: S(38), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { bottom: S(4) } }}>
      <TactileButton id={`ark_tune_${props.tuneKey}_minus`} label="-" width={S(54)} height={S(34)} bg={C.cardAlt} fontSize={S(16)} onClick={() => nudgeArkHandover(props.tuneKey, -props.step)} />
      <Label value={`${props.label}: ${props.value.toFixed(2)}`} fontSize={S(14)} color={C.text} textAlign="middle-center" uiTransform={{ width: S(130), height: S(34) }} />
      <TactileButton id={`ark_tune_${props.tuneKey}_plus`} label="+" width={S(54)} height={S(34)} bg={C.cardAlt} fontSize={S(16)} onClick={() => nudgeArkHandover(props.tuneKey, props.step)} />
    </UiEntity>
  )
}

function ArkHandoverTuner() {
  if (!ARK_HANDOVER_TUNER_ENABLED) return null
  const t = getArkHandoverTuning()
  const box = { positionType: 'absolute' as const, position: { top: S(104), left: S(16) }, padding: S(10), borderRadius: S(12), pointerFilter: 'block' as const }
  const bg = { color: { r: 0.05, g: 0.05, b: 0.08, a: 0.9 } }
  if (!t.running) {
    if (clientState.ark.cinematic !== 'none') return null
    return (
      <UiEntity uiTransform={{ ...box, flexDirection: 'column', alignItems: 'center' }} uiBackground={bg}>
        <Label value="DEBUG · ARK WALK" fontSize={S(13)} color={C.gold} textAlign="middle-center" uiTransform={{ width: S(170), height: S(22) }} />
        <TactileButton id="ark_tune_play" label="Test walk" width={S(150)} height={S(34)} bg={C.greenDark} fontSize={S(14)} onClick={() => debugPlayArkHandover()} />
      </UiEntity>
    )
  }
  return (
    <UiEntity uiTransform={{ ...box, width: S(270), flexDirection: 'column', alignItems: 'center' }} uiBackground={bg}>
      <Label value="DEBUG · ARK WALK (world)" fontSize={S(14)} color={C.gold} textAlign="middle-center" uiTransform={{ width: '100%', height: S(24) }} />
      {ARK_TUNE_ROWS.map((r) => (
        <ArkTunerRow key={r.key} tuneKey={r.key} label={r.label} step={r.step} value={t.values[r.key]} />
      ))}
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between', margin: { top: S(4) } }}>
        <TactileButton id="ark_tune_pause" label={t.paused ? 'Resume' : 'Pause'} width={S(118)} height={S(32)} bg={C.blue} fontSize={S(13)} onClick={() => toggleArkHandoverPause()} />
        <TactileButton id="ark_tune_reset" label="Reset" width={S(118)} height={S(32)} bg={C.pink} fontSize={S(13)} onClick={() => resetArkHandoverTuning()} />
      </UiEntity>
    </UiEntity>
  )
}

function ArkLaunchCard() {
  const views = clientState.ark.launchCard
  if (!views) return <UiEntity />
  const donated = views.filter((v) => v.donatedByMe > 0)
  const pets = donated.reduce((n, v) => n + v.donatedByMe, 0)
  const btnW = S(190)
  const btnH = Math.round(btnW / PILL_HALF_ASPECT)
  return (
    <PetHudModal
      title="The Ark has lifted off!"
      subtitle={`Carrying ${Cfg.ARK_GOAL} companions to a new colony among the stars.`}
      width={S(680)}
      height={donated.length > 0 ? S(520) : S(360)}
      onClose={() => closeArkLaunchCard()}
    >
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
        {donated.length > 0 ? (
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
            <Label
              value={`Thanks for sending ${pets} of them — you'll receive ${donated.length > 1 ? 'these wearables' : 'this wearable'}:`}
              fontSize={S(17)}
              color={PET_UI.ink}
              textAlign="middle-center"
              textWrap="wrap"
              uiTransform={{ width: '100%', height: S(48) }}
            />
            <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center', margin: { top: S(6) } }}>
              {donated.map((v) => (
                <WearablePreview key={`launch-${v.eventId}`} wearableId={v.wearableId} />
              ))}
            </UiEntity>
          </UiEntity>
        ) : (
          <Label
            value="Donate an Adult pet to the Captain to earn a reward on the next launch!"
            fontSize={S(17)}
            color={PET_UI.ink}
            textAlign="middle-center"
            textWrap="wrap"
            uiTransform={{ width: '100%', height: S(56), margin: { top: S(10) } }}
          />
        )}
        <PillButton id="ark_launch_ok" label="Amazing!" shape="half" color="green" width={btnW} height={btnH} pulse margin={{ top: S(10) }} onClick={() => closeArkLaunchCard()} />
      </UiEntity>
    </PetHudModal>
  )
}

// Screen-space effects for the breeding cinematic (pet.ts updateBreed drives the
// state via getBreedFx): a violet magic orb that swirls + swells over the nest, a
// one-shot burst at the climax, and full-screen light blinks. The camera is locked
// on the nest, so the effect sits at a fixed spot on screen (BREED_FX_CX/CY tune it
// over the centre bowl). The 3D egg pops in underneath as the burst fades.
const BREED_ORB_SHEET = 'assets/images/breedEffect/p1.png'
const BREED_BURST_SHEET = 'assets/images/breedEffect/p2.png'
const BREED_FX_CX = '50%' // horizontal centre of the effect on screen (TUNE)
const BREED_FX_CY = '44%' // vertical centre — a touch above middle, over the bowl (TUNE)
const BREED_FX_SIZE = 380 // base on-screen size of the orb/burst, pre-S (TUNE)

function BreedFxOverlay() {
  const fx = getBreedFx()
  if (!fx.active) return <UiEntity />
  const base = S(BREED_FX_SIZE)
  const orb = Math.round(base * fx.orbScale)
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
      {fx.orbAlpha > 0.01 && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { left: BREED_FX_CX, top: BREED_FX_CY }, margin: { left: -orb / 2, top: -orb / 2 }, width: orb, height: orb, pointerFilter: 'none' }}
          uiBackground={{ texture: { src: BREED_ORB_SHEET }, textureMode: 'stretch', uvs: stripFrameUvs(fx.orbFrame, BREED_ORB_FRAMES), color: { r: 1, g: 1, b: 1, a: fx.orbAlpha } }}
        />
      )}
      {fx.burstFrame >= 0 && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { left: BREED_FX_CX, top: BREED_FX_CY }, margin: { left: -base / 2, top: -base / 2 }, width: base, height: base, pointerFilter: 'none' }}
          uiBackground={{ texture: { src: BREED_BURST_SHEET }, textureMode: 'stretch', uvs: stripFrameUvs(fx.burstFrame, BREED_BURST_FRAMES) }}
        />
      )}
      {fx.flash > 0.01 && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }} uiBackground={{ color: { r: 0.72, g: 0.45, b: 1, a: fx.flash } }} />
      )}
    </UiEntity>
  )
}

// Feed errand — the player is out walking to the tree behind the guide arrow
// (feed.ts). Same shape as the bath carry: a banner saying where to go and a
// BACK button, which is the whole point here — the errand blocks every other
// care action while it runs, so there has to be a way out of it that doesn't
// require finishing the walk.
// Guide overlay while an adopted egg waits at the Caretaker: BACK cancels the
// adoption, the banner reinforces the arrow. Hidden while a carry flow owns the
// screen (updateGetEgg yields the arrow to it), so the two never stack.
/** Walking a pet to the Ark: BACK cancels, and a line says where to go. */
function ArkErrandOverlay() {
  const r = clientState.arkRedeem
  if (!r.active || r.phase !== 'toCaptain') return <UiEntity />
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
      <BackButton onClick={() => cancelArkRedeem()} />
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: S(90), left: '50%' }, margin: { left: -S(240) }, width: S(480), height: S(58), alignItems: 'center', justifyContent: 'center', borderRadius: S(29), pointerFilter: 'none' }}
        uiBackground={{ color: C.panelBg }}
      >
        <Label value="Follow the arrow to the Captain at the Ark!" fontSize={S(20)} color={C.text} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: S(30) }} />
      </UiEntity>
    </UiEntity>
  )
}

/** At the Captain: are you sure? Thanks for helping save the colony. Same
 *  brown-framed card, ink and pills as Inventory / Goals / Pet Actions. */
function ArkConfirmPanel() {
  const r = clientState.arkRedeem
  // By id, not the active pet: the Captain's picker can send a stored pet too.
  const pet = clientState.player?.pets.find((x) => x.id === r.petId)
  if (!r.active || r.phase !== 'confirm' || !pet) return <UiEntity />
  const firstDonation = (clientState.player?.counters['arkCount'] ?? 0) === 0
  const reward = Cfg.ARK_REWARDS[pet.rarity] ?? Cfg.ARK_REWARDS.common
  const panelW = S(700)
  const panelH = Math.round(PET_ACTIONS_TEX_H * (panelW / PET_ACTIONS_TEX_W))
  const contentW = panelW - S(30) * 2
  const btnW = S(220)
  const btnH = Math.round(btnW / PILL_HALF_ASPECT)
  const icon = S(34)
  const rewardItem = (src: string, text: string) => (
    <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { left: S(14), right: S(14) } }}>
      <UiEntity uiTransform={{ width: icon, height: icon }} uiBackground={{ texture: { src }, textureMode: 'stretch' }} />
      <Label value={text} fontSize={S(24)} color={PET_UI.ink} textAlign="middle-left" uiTransform={{ height: icon, margin: { left: S(8) } }} />
    </UiEntity>
  )
  return (
    <PetHudCard width={panelW} height={panelH} onClose={() => cancelArkRedeem()}>
      <Label value="Board the Ark?" fontSize={S(40)} color={PET_UI.ink} textAlign="middle-center" uiTransform={{ width: contentW, height: S(54), margin: { top: S(18) } }} />
      <Label
        value={`${pet.name} · ${Cfg.rarityLabel(pet.rarity)}`}
        fontSize={S(18)}
        color={PET_UI.muted}
        textAlign="middle-center"
        uiTransform={{ width: contentW, height: S(26) }}
      />
      <Label
        value={`I will keep ${pet.name} safe aboard the Ark, for good. Thank you for helping save the colony!`}
        fontSize={S(19)}
        color={PET_UI.ink}
        textAlign="middle-center"
        textWrap="wrap"
        uiTransform={{ width: contentW - S(60), height: S(70), margin: { top: S(16) } }}
      />
      <UiEntity uiTransform={{ width: contentW, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', margin: { top: S(10) } }}>
        {rewardItem(REWARD_XP_ICON, `+${reward.xp} XP`)}
        {rewardItem(REWARD_COIN_ICON, `+${reward.coins} coins`)}
      </UiEntity>
      {firstDonation && (
        <Label value={`First donation bonus: ${Cfg.ARK_FIRST_DONATION_WEARABLE.name} wearable`} fontSize={S(16)} color={LOC.violet} textAlign="middle-center" uiTransform={{ width: contentW, height: S(24), margin: { top: S(6) } }} />
      )}
      <Label
        value={`Creatures aboard the Ark: ${clientState.ark.status.donated} / ${clientState.ark.status.goal}`}
        fontSize={S(16)}
        color={PET_UI.muted}
        textAlign="middle-center"
        uiTransform={{ width: contentW, height: S(26), margin: { top: firstDonation ? S(2) : S(12) } }}
      />
      <UiEntity uiTransform={{ width: contentW, flexDirection: 'row', justifyContent: 'center', margin: { top: S(18) } }}>
        <PillButton id="ark_cancel" label="Not yet" shape="half" color="pink" width={btnW} height={btnH} fontSize={S(19)} margin={{ right: S(12) }} onClick={() => cancelArkRedeem()} />
        <PillButton id="ark_confirm" label="Send aboard" shape="half" color="green" width={btnW} height={btnH} fontSize={S(19)} pulse onClick={() => confirmArkRedeem()} />
      </UiEntity>
    </PetHudCard>
  )
}

function GetEggOverlay() {
  if (!getEggPending() || clientState.carryEgg.active || clientState.carryPet.active) return <UiEntity />
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
      <BackButton onClick={() => cancelGetEgg()} />
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: S(90), left: '50%' }, margin: { left: -S(240) }, width: S(480), height: S(58), alignItems: 'center', justifyContent: 'center', borderRadius: S(29), pointerFilter: 'none' }}
        uiBackground={{ color: C.panelBg }}
      >
        <Label value="Follow the arrow to the Caretaker to get your egg!" fontSize={S(20)} color={C.text} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: S(30) }} />
      </UiEntity>
    </UiEntity>
  )
}

function FeedErrandOverlay() {
  if (!clientState.feedTask.active) return <UiEntity />
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
      <BackButton onClick={() => cancelFeedTask()} />
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
  const waitingForAssets = !areCriticalUiAssetsReady()
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'flex-end', pointerFilter: 'block' }}>
      {waitingForAssets && (
        <Label
          value="Loading game art..."
          fontSize={S(16)}
          color={C.dim}
          textAlign="middle-center"
          uiTransform={{ width: '100%', height: S(30), margin: { bottom: S(60) } }}
        />
      )}
      {!waitingForAssets && waitingTooLong && (
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
  // The breeding animation likewise owns the screen while its egg cinematic plays.
  // Computed as a value (not early-returned) so UI_DEBUG_MODE's browser bar
  // below can render on top of ANY of these branches, not just the default one.
  const hideHudForPepitoTheft = pepitoStealHidesHud()
  const content =
    !clientState.serverReady || (!Cfg.DEV_SKIP_SERVER_GATE && !areCriticalUiAssetsReady()) ? (
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
    ) : clientState.breed.active && clientState.breed.phase === 'animating' ? (
      <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
        <BreedFxOverlay />
      </UiEntity>
    ) : clientState.ark.cinematic !== 'none' ? (
      // A pet boarding the Ark / the Ark launching owns the camera: no HUD, only
      // the "lifted off" card once the ship is gone.
      <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
        <ArkLaunchCard />
        <ArkHandoverTuner />
      </UiEntity>
    ) : (
      <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
        {!hideHudForPepitoTheft && (
          <UiEntity uiTransform={{ width: '100%', height: '100%', pointerFilter: 'none' }}>
            {/* Hide the top bar while any panel / passport / dialog is open, so it never
                overlaps them (same gate the bottom nav uses). */}
            {!bigUiOpen() && <TopBars />}
            <BottomNav />
            <FetchOverlay />
            <PepitoRockChargeOverlay />
            <CarryHatchButton />
            <BathButton />
            <BreedButtons />
            <FeedErrandOverlay />
            <GetEggOverlay />
            <ArkErrandOverlay />
            {/* Rendered after the HUD chrome (side buttons, bottom nav) so they paint
                on top of it instead of the nav icons poking through over them. Moot
                now that bigUiOpen() hides the nav while these are open, but keeps
                the same defensive ordering PetPanel already relies on. */}
            <RemotePetPanel />
            <SwapOfferPanel />
            <PetPanel />
            {uiState.panel === 'adopt' && <AdoptPanel />}
            {clientState.breed.active && clientState.breed.phase === 'pickB' && <BreedPickerPanel />}
            {uiState.panel === 'breedName' && <BreedNamePanel />}
            <ArkConfirmPanel />
            {uiState.panel === 'shop' && <ShopPanel />}
            {uiState.panel === 'roster' && <RosterPanel />}
            {uiState.panel === 'inventory' && <InventoryPanel />}
            {uiState.panel === 'spin' && <SpinPanel />}
            {uiState.panel === 'meteor' && <MeteorRewardPanel />}
            {uiState.panel === 'goals' && <GoalsPanel />}
            {uiState.panel === 'daily' && <DailyRewardPanel />}
            {uiState.panel === 'jukebox' && <JukeboxPanel />}
            {uiState.panel === 'album' && <AlbumPanel />}
            {uiState.panel === 'leaderboard' && <LeaderboardPanel />}
            {uiState.panel === 'arkDonate' && <ArkDonatePanel />}
            {uiState.panel === 'arkRanking' && <ArkRankingPanel />}
            <ArkThanksPanel />
            {!bigUiOpen() && <ArkHandoverTuner />}
          </UiEntity>
        )}
        <DialogBox />
        {/* Toasts are the only global notification surface. */}
        {!hideHudForPepitoTheft && <Toasts />}
      </UiEntity>
    )
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
      {content}
      <RewardPopup />
      {UI_DEBUG_MODE && <DebugBrowserBar />}
      <ScreenFadeOverlay />
    </UiEntity>
  )
}

// Full-screen black mask (see clientState.screenFade's doc comment) — drawn
// above EVERY branch above, including the full-screen minigame ones, since it
// has to cover the seam no matter which HUD state the camera hand-off lands
// in. `pointerFilter: 'none'` while invisible (alpha 0) is the default for
// every UiEntity, so it doesn't block clicks when not in use.
function ScreenFadeOverlay() {
  const alpha = clientState.screenFade.alpha
  if (alpha <= 0) return null
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: alpha >= 0.99 ? 'block' : 'none' }}
      uiBackground={{ color: { r: 0, g: 0, b: 0, a: alpha } }}
    />
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
    engine.addSystem(syncPetTouchControlsSystem)
    engine.addSystem(syncMobileMagnifierSystem)
  }

  resolveRuntimePlatform()
  startAnimSystem()
  applyUiRenderer(true)
}
