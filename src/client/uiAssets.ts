import { AssetLoad, assetLoadLoadingStateSystem, engine } from '@dcl/sdk/ecs'
import * as Cfg from '../shared/config'

// These are the images that can appear the instant the server snapshot opens the
// HUD: its chrome, the first dialog, the bottom navigation, and native controls.
// Keep this short so a first-time mobile visitor reaches a complete first frame
// quickly; the rest of the HUD warms in the background immediately afterwards.
const CRITICAL_UI_ASSETS: readonly string[] = [
  'assets/images/revamp/hud.png',
  'assets/images/revamp/hud2.png',
  'assets/images/revamp/dialogue.png',
  'assets/images/revamp/caretaker.png',
  'assets/images/revamp/capitan.png',
  'assets/images/revamp/pets_icon.png',
  'assets/images/revamp/inventory_icon.png',
  'assets/images/revamp/star_icon.png',
  'assets/images/whistle_icon.png',
  'assets/images/stop_icon.png',
  'assets/images/pets/sprout_mono.png',
  'assets/images/pets/pepito_mono.png',
  'assets/images/pets/amebita_mono.png',
  'assets/images/pets/fluflito_mono.png'
]

// All textures drawn by the screen-space UI, apart from species thumbnails which
// are derived from the same configuration used by the adoption/roster cards.
// This mirrors Raft's HUD-preload catalogue: all paths are declared once at
// boot and their AssetLoad entities stay alive for the session.
const STATIC_UI_ASSETS: readonly string[] = [
  'assets/images/revamp/hud.png',
  'assets/images/revamp/hud2.png',
  'assets/images/revamp/hud3.png',
  'assets/images/revamp/dialogue.png',
  'assets/images/revamp/caretaker.png',
  'assets/images/revamp/capitan.png',
  'assets/images/revamp/keepbutton.png',
  'assets/images/revamp/discardbutton.png',
  'assets/images/backbutton2.png',
  'assets/images/revamp/feed_hud.png',
  'assets/images/revamp/fruit_caught.png',
  'assets/images/revamp/bath_hud.png',
  'assets/images/bubbleFrame/spritesheet_6x1_512.png',
  'assets/images/revamp/breed.png',
  'assets/images/revamp/breed_hud.png',
  'assets/images/revamp/goals.png',
  'assets/images/revamp/pets_icon.png',
  'assets/images/revamp/inventory_icon.png',
  'assets/images/revamp/star_icon.png',
  'assets/images/revamp/chip_xp_4frames.png',
  'assets/images/revamp/chip_coins_4frames.png',
  'assets/images/revamp/buy_button_states.png',
  'assets/images/revamp/bubble.png',
  'assets/images/bubble.png',
  'assets/images/petmoods.png',
  'assets/images/revamp/potion.png',
  'assets/images/coin_icon.png',
  'assets/images/left_arrow.png',
  'assets/images/left_arrow_pressed.png',
  'assets/images/right_arrow.png',
  'assets/images/right_arrow_pressed.png',
  'assets/images/throwicon.png',
  'assets/images/throwrockicon.png',
  'assets/images/whistle_icon.png',
  'assets/images/stop_icon.png',
  'assets/images/pets/sprout_mono.png',
  'assets/images/pets/pepito_mono.png',
  'assets/images/pets/amebita_mono.png',
  'assets/images/pets/fluflito_mono.png',
  'assets/images/hatch_button.png',
  'assets/images/bath button.png',
  'assets/images/revamp/dailyrewards_hud.png',
  'assets/images/tutorialUi/btn_close.png',
  'assets/images/tutorialUi/btn_next.png',
  'assets/images/breedEffect/p1.png',
  'assets/images/breedEffect/p2.png',
  'assets/images/circle_01.png',
  'assets/images/poison.png',
  'assets/images/scorch_03.png',
  'assets/images/new_bubble_flipped.png',
  'assets/images/starburst.png',
  'assets/images/starburst_glow.png',
  // Album (collection book) — icon in the top HUD row + one sheet per rarity.
  'assets/images/album/album_icon.png',
  'assets/images/album/album_panel.png',
  'assets/images/album/album_parts.png',
  'assets/images/album/album_common.png',
  'assets/images/album/album_rare.png',
  'assets/images/album/album_legendary.png',
  'assets/images/album/album_locked.png',
  // World-space, not screen UI, but the same AssetLoad pipeline below preloads
  // any texture path — petEmotes.ts's floating icon otherwise pops in blank
  // the first time each one is shown.
  'assets/images/emotes/emote_Food.png',
  'assets/images/emotes/emote_Clean.png',
  'assets/images/emotes/emote_Play.png',
  'assets/images/emotes/emote_Sick.png',
  'assets/images/emotes/emote_faceHappy.png',
  'assets/images/emotes/emote_faceSad.png',
  'assets/images/emotes/emote_faceAngry.png',
  'assets/images/emotes/emote_heart.png',
  'assets/images/emotes/emote_music.png',
  'assets/images/emotes/emote_sleep.png',
  'assets/images/emotes/emote_sleeps.png'
]

let preloaded = false
let criticalAssetsReady = false
const criticalReadyCallbacks: Array<() => void> = []

// AssetLoad reports numeric LoadingState values. Keep literals here, like the
// creature-skin preloader, so isolatedModules does not require a const-enum
// import from generated protocol types.
const LS_NOT_FOUND = 2
const LS_FINISHED_WITH_ERROR = 3
const LS_FINISHED = 4

/**
 * Start the same persistent AssetLoad catalogue used by Raft, but split its
 * first visual frame from deferred panels. The loading gate waits only for the
 * critical group; waiting for every optional panel would turn a short texture
 * race into a long blank screen on a first-time mobile visit.
 */
export function preloadUiAssets(): void {
  if (preloaded) return
  preloaded = true

  const thumbnails = Cfg.SPECIES.map(Cfg.speciesImage).filter((src): src is string => !!src)
  const allAssets = [...new Set([...STATIC_UI_ASSETS, ...thumbnails])]
  const criticalAssets = [...new Set([...CRITICAL_UI_ASSETS, ...thumbnails])]
  const criticalSet = new Set(criticalAssets)
  const deferredAssets = allAssets.filter((asset) => !criticalSet.has(asset))
  const pendingCritical = new Set(criticalAssets)
  const failedCritical = new Set<string>()
  const criticalEntity = engine.addEntity()

  AssetLoad.create(criticalEntity, { assets: criticalAssets })
  assetLoadLoadingStateSystem.registerAssetLoadLoadingStateEntity(criticalEntity, (state) => {
    if (state.currentState !== LS_FINISHED && state.currentState !== LS_NOT_FOUND && state.currentState !== LS_FINISHED_WITH_ERROR) return
    if (!pendingCritical.delete(state.asset)) return
    if (state.currentState !== LS_FINISHED) failedCritical.add(state.asset)
    if (pendingCritical.size !== 0) return

    criticalAssetsReady = true
    assetLoadLoadingStateSystem.removeAssetLoadLoadingStateEntity(criticalEntity)
    console.log(
      `[uiAssets] critical preload settled: ${criticalAssets.length - failedCritical.size}/${criticalAssets.length} cached${
        failedCritical.size ? `, ${failedCritical.size} FAILED -> ${[...failedCritical].join(', ')}` : ''
      }`
    )

    // Keep Raft's complete HUD cache warm for panels and effects that are not
    // needed on the first screen. The entity intentionally persists.
    if (deferredAssets.length > 0) AssetLoad.create(engine.addEntity(), { assets: deferredAssets })

    for (const callback of criticalReadyCallbacks.splice(0)) callback()
  })
}

/** True once every asset required by the initial HUD has reached a terminal
 * renderer state (success or a logged failure), so UI can reveal without white
 * placeholder textures. */
export function areCriticalUiAssetsReady(): boolean {
  return criticalAssetsReady
}

/** Schedule work that must not compete with the first HUD frame, such as the
 * 16 MB creature-skin cache. */
export function onCriticalUiAssetsReady(callback: () => void): void {
  if (criticalAssetsReady) callback()
  else criticalReadyCallbacks.push(callback)
}
