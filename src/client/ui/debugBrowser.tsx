// UI Debug Browser — jump straight to any screen/panel in the game (and its
// data-driven variants) without playing into it. Built for revamping screens
// one at a time on both desktop and mobile.
//
// No hotkey: flip UI_DEBUG_MODE below by hand, save, and reload. When on,
// ui.tsx's Root() renders whichever registry entry is selected (by directly
// driving the SAME clientState/uiState the real game reads — no special
// rendering path) plus this file's on-screen Prev/Next/variant/jump bar.
// Flip back to false to return to normal gameplay; nothing else changes.

import ReactEcs, { Label, UiEntity } from '@dcl/sdk/react-ecs'
import * as Cfg from '../../shared/config'
import type { PetData, PlayerData, PresenceEntry, Rarity, SwapOfferPayload } from '../../shared/types'
import { clientState, openDialog, pushToast } from '../state'
import { debugForcePanel, debugSetUiState, type Panel } from '../ui'
import { playSong, setMusicVolume, setMuted } from '../music'
import { CARETAKER_TIPS, caretakerIntro } from './dialog'
import { C, S, TactileButton } from './theme'

export const UI_DEBUG_MODE = false

// ---------------------------------------------------------------------------
// Fixtures — minimal placeholder data for screens that render empty without a
// real pet/presence-entry/swap-offer to read. Mirrors state.ts's makeLocalPet
// shape, extended with overridable rarity/level/size for the variants below.
// ---------------------------------------------------------------------------
function fakePet(overrides: Partial<PetData> = {}): PetData {
  const t = Date.now()
  return {
    id: 'debug_pet',
    species: 'sprout-original',
    name: 'Buddy',
    rarity: 'common',
    hunger: 80,
    hygiene: 80,
    energy: 80,
    happiness: 80,
    petXp: 0,
    petLevel: 3,
    size: Cfg.SIZE_BASE,
    careCount: 10,
    generation: 0,
    sleeping: false,
    sleepOnBed: false,
    sleepLockUntil: 0,
    bornAt: t,
    lastUpdated: t,
    ...overrides
  }
}

function fakePlayer(overrides: Partial<PlayerData> = {}): PlayerData {
  const t = Date.now()
  return {
    address: '0xDEBUG',
    currency: 500,
    inventory: { tier1: 2, tier2: 1, rarityPotions: 1 },
    caretakerXp: 120,
    caretakerLevel: 3,
    givingScore: 0,
    spinTickets: 2,
    streakCount: 3,
    lastLoginDay: Math.floor(t / Cfg.DAY_MS),
    meteorDay: -1,
    achievements: [],
    counters: {},
    petSlots: 2,
    activePetId: 'debug_pet',
    pets: [fakePet()],
    hatchling: null,
    createdAt: t,
    lastUpdated: t,
    ...overrides
  }
}

function fakePresence(overrides: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    address: '0xREMOTE',
    species: 'pepito-original',
    name: 'Rex',
    rarity: 'rare',
    size: 0.8,
    mood: 70,
    level: 4,
    ...overrides
  }
}

function fakeSwapOffer(overrides: Partial<SwapOfferPayload> = {}): SwapOfferPayload {
  return {
    fromAddress: '0xOTHER',
    fromName: 'Alex',
    offeredPet: fakePet({ id: 'debug_offered', name: 'Milo', rarity: 'legendary', species: 'amebita-original' }),
    wantedPetName: 'Buddy',
    ...overrides
  }
}

/** Sets both clientState.player and clientState.activePet consistently — most
 *  screens need both (e.g. PetPanel's partner lookup reads player.pets). */
function applyFixturePlayer(player: PlayerData, activePet: PetData | null): void {
  clientState.player = player
  clientState.activePet = activePet
}

interface DebugScreen {
  id: string
  label: string
  /** Labels for alternate data states; omit if the screen only has one look. */
  variants?: string[]
  activate: (variantIndex: number) => void
}

const DEBUG_SCREENS: DebugScreen[] = [
  {
    id: 'petting',
    label: 'Petting Overlay',
    variants: ['Just started', 'Halfway', 'Almost full'],
    activate: (v) => {
      applyFixturePlayer(fakePlayer(), fakePet())
      clientState.petting = { active: true, progress: [0.1, 0.5, 0.9][v] ?? 0.5 }
    }
  },
  {
    id: 'hatch',
    label: 'Hatch Overlay',
    variants: ['Rubbing (30%)', 'Almost there (90%)', 'Hatching! (100%)'],
    activate: (v) => {
      applyFixturePlayer(fakePlayer(), fakePet())
      clientState.hatch = { active: true, progress: [0.3, 0.9, 1][v] ?? 0.3 }
    }
  },
  {
    id: 'feedGame',
    label: 'Feed Minigame',
    variants: ['Arrival', 'Intro (Start button)', 'Countdown 3-2-1', 'Catching', 'Results'],
    activate: (v) => {
      applyFixturePlayer(fakePlayer(), fakePet())
      const base = { active: true, caught: 0, timeLeft: 30, catchFlashUntil: 0, countdownAt: 0, resultsAt: 0, petSitPos: null, petSitLook: null }
      const byVariant = [
        { ...base, phase: 'arrival' as const },
        { ...base, phase: 'intro' as const },
        { ...base, phase: 'countdown' as const, countdownAt: Date.now() },
        { ...base, phase: 'catching' as const, caught: 3, timeLeft: 15, catchFlashUntil: Date.now() + 300 },
        { ...base, phase: 'results' as const, caught: 8, resultsAt: Date.now() }
      ]
      clientState.feedGame = byVariant[v] ?? byVariant[0]
    }
  },
  {
    id: 'petPanel',
    label: 'Pet Panel',
    variants: ['Junior · Common', 'Teen · Rare', 'Adult · Legendary (breed unlocked)'],
    activate: (v) => {
      const configs: { size: number; rarity: Rarity; partnerAdult: boolean }[] = [
        { size: Cfg.SIZE_BASE, rarity: 'common', partnerAdult: false },
        { size: Cfg.PET_STAGE_TEEN_SIZE + 0.05, rarity: 'rare', partnerAdult: false },
        { size: Cfg.SIZE_MAX, rarity: 'legendary', partnerAdult: true }
      ]
      const cfg = configs[v] ?? configs[0]
      const pet = fakePet({ id: 'debug_active', name: 'Buddy', size: cfg.size, rarity: cfg.rarity })
      const partner = fakePet({ id: 'debug_partner', name: 'Nova', size: cfg.partnerAdult ? Cfg.SIZE_MAX : Cfg.SIZE_BASE })
      applyFixturePlayer(fakePlayer({ pets: [pet, partner], activePetId: pet.id, petSlots: 2 }), pet)
      clientState.petPanelOpen = true
    }
  },
  {
    id: 'remotePetPanel',
    label: 'Remote Pet Panel (another player)',
    variants: ['Common', 'Legendary'],
    activate: (v) => {
      applyFixturePlayer(fakePlayer(), fakePet())
      const entry = fakePresence(v === 1 ? { rarity: 'legendary', name: 'Nova' } : {})
      clientState.presence = [entry]
      clientState.viewingPetAddress = entry.address
    }
  },
  {
    id: 'swapOffer',
    label: 'Swap Offer Panel',
    activate: () => {
      applyFixturePlayer(fakePlayer(), fakePet())
      clientState.incomingSwap = fakeSwapOffer()
    }
  },
  {
    id: 'adopt',
    label: 'Adopt Panel',
    variants: ['Pick species', 'Name your pet'],
    activate: (v) => {
      applyFixturePlayer(fakePlayer({ pets: [], hatchling: null }), null)
      debugSetUiState({ adoptStep: v === 1 ? 'name' : 'pick' })
      debugForcePanel('adopt')
    }
  },
  {
    id: 'breedName',
    label: 'Breed Name Panel',
    variants: ['Has a rarity potion', 'No potions'],
    activate: (v) => {
      applyFixturePlayer(fakePlayer({ inventory: { tier1: 2, tier2: 1, rarityPotions: v === 1 ? 0 : 2 } }), fakePet())
      debugSetUiState({ breedUsePotion: false })
      debugForcePanel('breedName')
    }
  },
  {
    id: 'shop',
    label: 'Shop Panel',
    variants: ['Food tab · can afford', 'Food tab · broke', 'Slots tab · stepped-up price'],
    activate: (v) => {
      applyFixturePlayer(fakePlayer({ currency: v === 1 ? 0 : 500, petSlots: v === 2 ? 6 : 1 }), fakePet())
      debugSetUiState({ shopTab: v === 2 ? 'slots' : 'food' })
      debugForcePanel('shop')
    }
  },
  {
    id: 'roster',
    label: 'Roster (My Pets) Panel',
    variants: ['1 slot, empty', '2 pets filled', 'Pending hatchling', '6 pets · paged grid'],
    activate: (v) => {
      if (v === 1) {
        const a = fakePet({ id: 'p1', name: 'Buddy' })
        const b = fakePet({ id: 'p2', name: 'Nova', rarity: 'rare' })
        applyFixturePlayer(fakePlayer({ petSlots: 2, pets: [a, b], activePetId: a.id }), a)
      } else if (v === 2) {
        applyFixturePlayer(fakePlayer({ petSlots: 1, pets: [], activePetId: '', hatchling: fakePet({ id: 'hatch1', name: 'New Egg' }) }), null)
      } else if (v === 3) {
        // Past one page — exercises the pager now that slots are uncapped.
        const pets = [0, 1, 2, 3, 4, 5].map((i) => fakePet({ id: `p${i}`, name: `Pet ${i + 1}` }))
        applyFixturePlayer(fakePlayer({ petSlots: 6, pets, activePetId: pets[0].id }), pets[0])
      } else {
        applyFixturePlayer(fakePlayer({ petSlots: 1, pets: [], activePetId: '' }), null)
      }
      debugForcePanel('roster')
    }
  },
  {
    id: 'inventory',
    label: 'Inventory Panel',
    variants: ['Empty', 'Full'],
    activate: (v) => {
      applyFixturePlayer(fakePlayer({ inventory: v === 1 ? { tier1: 9, tier2: 5, rarityPotions: 3 } : { tier1: 0, tier2: 0, rarityPotions: 0 } }), fakePet())
      debugForcePanel('inventory')
    }
  },
  {
    id: 'spin',
    label: 'Spin Wheel Panel',
    variants: ['No tickets', 'Has tickets', 'Just won'],
    activate: (v) => {
      applyFixturePlayer(fakePlayer({ spinTickets: v === 0 ? 0 : 3 }), fakePet())
      clientState.lastSpin = v === 2 ? { reward: Cfg.SPIN_REWARDS[0], index: 0, at: Date.now() } : null
      debugForcePanel('spin')
    }
  },
  {
    id: 'meteor',
    label: 'Meteor Daily Reward Panel',
    variants: ['Day 3 · claimable', 'Day 3 · already claimed', 'Day 7 jackpot · claimable'],
    activate: (v) => {
      const today = Math.floor(Date.now() / Cfg.DAY_MS)
      const configs = [
        { streakCount: 3, meteorDay: -1 },
        { streakCount: 3, meteorDay: today },
        { streakCount: 7, meteorDay: -1 }
      ]
      applyFixturePlayer(fakePlayer(configs[v] ?? configs[0]), fakePet())
      debugForcePanel('meteor')
    }
  },
  {
    id: 'goals',
    label: 'Goals & Achievements Panel',
    variants: ['No progress', 'Mixed progress', 'All done'],
    activate: (v) => {
      const counters: Record<string, number> = {}
      const achievements: string[] = []
      if (v === 1) {
        counters.feedCount = 1
        counters.cleanCount = 10
      } else if (v === 2) {
        for (const a of Cfg.ACHIEVEMENTS) {
          counters[a.counter] = a.goal
          achievements.push(a.id)
        }
      }
      applyFixturePlayer(fakePlayer({ counters, achievements }), fakePet())
      debugForcePanel('goals')
    }
  },
  {
    id: 'daily',
    label: 'Daily Reward Panel (legacy — no live call site in normal play)',
    variants: ['Day 3 · claimable', 'Day 3 · claimed'],
    activate: (v) => {
      applyFixturePlayer(fakePlayer(), fakePet())
      const today = Math.floor(Date.now() / Cfg.DAY_MS)
      clientState.streak = { count: 3, lastDay: today, claimedDay: v === 1 ? today : today - 1 }
      debugForcePanel('daily')
    }
  },
  {
    id: 'jukebox',
    label: 'Jukebox Panel',
    variants: ['Marshy Marsh (default)', 'Swampy Marsh', 'Muted · low volume'],
    activate: (v) => {
      applyFixturePlayer(fakePlayer(), fakePet())
      playSong(v === 1 ? 'swampy_marsh' : 'marshy_marsh')
      setMuted(v === 2)
      setMusicVolume(v === 2 ? 0.2 : 0.42)
      debugForcePanel('jukebox')
    }
  },
  {
    id: 'dialogIntro',
    label: 'Dialog — Caretaker Intro',
    activate: () => {
      applyFixturePlayer(fakePlayer({ pets: [], hatchling: null }), null)
      openDialog('Caretaker', caretakerIntro(), 'Adopt now!', undefined, true)
    }
  },
  {
    id: 'dialogTips',
    label: 'Dialog — Caretaker Tips',
    activate: () => {
      applyFixturePlayer(fakePlayer(), fakePet())
      openDialog('Caretaker', CARETAKER_TIPS, 'Got it!')
    }
  },
  {
    id: 'fetch',
    label: 'Fetch (Play) Overlay',
    variants: ['Ready', 'Fetching (busy)'],
    activate: (v) => {
      applyFixturePlayer(fakePlayer(), fakePet())
      clientState.fetch = { active: true, busy: v === 1, charging: false, charge: 0 }
    }
  },
  {
    id: 'carryEgg',
    label: 'Carry Egg Home',
    variants: ['Walking home', 'Home — Hatch button'],
    activate: (v) => {
      applyFixturePlayer(fakePlayer(), fakePet())
      clientState.carryEgg = { active: true, species: 'sprout-original', name: 'New Egg', atHome: v === 1 }
    }
  },
  {
    id: 'bath',
    label: 'Carry Pet To Bath',
    variants: ['Walking to tub', 'At tub — Bath button'],
    activate: (v) => {
      applyFixturePlayer(fakePlayer(), fakePet())
      clientState.carryPet = { active: true, atStation: v === 1 }
    }
  },
  {
    id: 'normalHud',
    label: 'Normal HUD (top bar / side buttons / bottom nav)',
    variants: ['With an active pet', 'Hatchling pending (Keep/Discard)', 'No pets yet'],
    activate: (v) => {
      if (v === 1) {
        applyFixturePlayer(fakePlayer({ pets: [], activePetId: '', hatchling: fakePet({ id: 'h1', name: 'New Egg' }) }), null)
      } else if (v === 2) {
        applyFixturePlayer(fakePlayer({ pets: [], activePetId: '' }), null)
      } else {
        const pet = fakePet()
        applyFixturePlayer(fakePlayer({ pets: [pet], activePetId: pet.id }), pet)
      }
      debugForcePanel('none')
    }
  },
  {
    id: 'hint',
    label: 'Hint Toast',
    activate: () => {
      applyFixturePlayer(fakePlayer(), fakePet())
      pushToast('Go explore the meteorite for daily rewards and surprises!', 'reward')
    }
  },
  {
    id: 'reward',
    label: 'Reward Popup (+XP +coins)',
    activate: () => {
      applyFixturePlayer(fakePlayer(), fakePet())
      clientState.reward = { xp: 8, coins: 5, until: Date.now() + 60000 }
    }
  },
  {
    id: 'toasts',
    label: 'Toasts',
    activate: () => {
      applyFixturePlayer(fakePlayer(), fakePet())
      pushToast('Rare potion added to your inventory!', 'reward')
      pushToast('Not enough coins for that.', 'error')
      pushToast('Your pet reached Adult — breeding unlocked!', 'level')
      pushToast('Music muted.')
    }
  }
]

/** Clears every flag any registry entry might have set, so screens never
 *  bleed into each other when switching. Called before every activate(). */
function resetAllDebugFlags(): void {
  clientState.petting = { active: false, progress: 0 }
  clientState.hatch = { active: false, progress: 0 }
  clientState.feedGame = { active: false, phase: 'arrival', caught: 0, timeLeft: 0, catchFlashUntil: 0, countdownAt: 0, resultsAt: 0, petSitPos: null, petSitLook: null }
  clientState.dialog.open = false
  clientState.fetch = { active: false, busy: false, charging: false, charge: 0 }
  clientState.carryEgg = { active: false, species: '', name: '', atHome: false }
  clientState.carryPet = { active: false, atStation: false }
  clientState.incomingSwap = null
  clientState.viewingPetAddress = null
  clientState.petPanelOpen = false
  clientState.reward = null
  clientState.lastSpin = null
  clientState.toasts = []
  clientState.currentToast = null
  debugForcePanel('none' as Panel)
}

let currentScreenIndex = 0
let currentVariantIndex = 0
let showJumpList = false
let initialized = false

function activateCurrent(): void {
  resetAllDebugFlags()
  DEBUG_SCREENS[currentScreenIndex].activate(currentVariantIndex)
}

function gotoScreen(index: number): void {
  const n = DEBUG_SCREENS.length
  currentScreenIndex = ((index % n) + n) % n
  currentVariantIndex = 0
  activateCurrent()
}

function gotoVariant(delta: number): void {
  const count = DEBUG_SCREENS[currentScreenIndex].variants?.length ?? 1
  currentVariantIndex = ((currentVariantIndex + delta) % count + count) % count
  activateCurrent()
}

function ensureDebugInitialized(): void {
  if (initialized) return
  initialized = true
  activateCurrent()
}

export function DebugBrowserBar() {
  ensureDebugInitialized()
  const entry = DEBUG_SCREENS[currentScreenIndex]
  const hasVariants = (entry.variants?.length ?? 0) > 1
  const barW = S(760)
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: '50%' }, margin: { left: -barW / 2 }, width: barW, flexDirection: 'column', alignItems: 'center', pointerFilter: 'block' }}
    >
      <UiEntity
        uiTransform={{ width: '100%', height: S(56), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: S(16), padding: { left: S(12), right: S(12) } }}
        uiBackground={{ color: { r: 0.05, g: 0.05, b: 0.08, a: 0.94 } }}
      >
        <TactileButton id="dbg_prev" label="< Prev" width={S(90)} height={S(40)} bg={C.card} onClick={() => gotoScreen(currentScreenIndex - 1)} />
        <UiEntity uiTransform={{ width: S(500), flexDirection: 'column', alignItems: 'center' }} onMouseDown={() => (showJumpList = !showJumpList)}>
          <Label value={`${currentScreenIndex + 1} / ${DEBUG_SCREENS.length} — ${entry.label}`} fontSize={S(15)} color={C.gold} textAlign="middle-center" uiTransform={{ width: '100%', height: S(22) }} />
          {hasVariants && (
            <Label value={entry.variants![currentVariantIndex]} fontSize={S(12)} color={C.dim} textAlign="middle-center" uiTransform={{ width: '100%', height: S(16) }} />
          )}
        </UiEntity>
        <TactileButton id="dbg_next" label="Next >" width={S(90)} height={S(40)} bg={C.card} onClick={() => gotoScreen(currentScreenIndex + 1)} />
      </UiEntity>
      {hasVariants && (
        <UiEntity uiTransform={{ width: '100%', height: S(38), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: { top: S(4) } }}>
          <TactileButton id="dbg_variant_prev" label="< Variant" width={S(130)} height={S(34)} bg={C.cardAlt} onClick={() => gotoVariant(-1)} />
          <TactileButton id="dbg_variant_next" label="Variant >" width={S(130)} height={S(34)} bg={C.cardAlt} margin={{ left: S(8) }} onClick={() => gotoVariant(1)} />
        </UiEntity>
      )}
      {showJumpList && (
        <UiEntity
          uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', margin: { top: S(6) }, borderRadius: S(12), padding: S(8), overflow: 'hidden' }}
          uiBackground={{ color: { r: 0.05, g: 0.05, b: 0.08, a: 0.96 } }}
        >
          {DEBUG_SCREENS.map((s, i) => (
            <UiEntity
              key={s.id}
              uiTransform={{ width: S(160), height: S(32), alignItems: 'center', justifyContent: 'center', borderRadius: S(8), margin: S(2) }}
              uiBackground={{ color: i === currentScreenIndex ? C.green : C.card }}
              onMouseDown={() => {
                showJumpList = false
                gotoScreen(i)
              }}
            >
              <Label value={`${i + 1}. ${s.label}`} fontSize={S(11)} color={C.text} textAlign="middle-center" textWrap="wrap" uiTransform={{ width: S(150), height: S(28) }} />
            </UiEntity>
          ))}
        </UiEntity>
      )}
    </UiEntity>
  )
}
