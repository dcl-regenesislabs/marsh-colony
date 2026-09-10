import { AssetLoad, engine } from '@dcl/sdk/ecs'
import * as Cfg from '../shared/config'

// All textures drawn by the screen-space UI, apart from species thumbnails which
// are derived from the same configuration used by the adoption/roster cards.
const STATIC_UI_ASSETS = [
  'assets/images/revamp/hud.png',
  'assets/images/revamp/hud2.png',
  'assets/images/revamp/hud3.png',
  'assets/images/revamp/dialogue.png',
  'assets/images/revamp/caretaker.png',
  'assets/images/revamp/keepbutton.png',
  'assets/images/revamp/discardbutton.png',
  'assets/images/revamp/backbutton256.png',
  'assets/images/revamp/feed_hud.png',
  'assets/images/revamp/fruit_caught.png',
  'assets/images/revamp/bath_hud.png',
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
  'assets/images/tutorialUi/btn_close.png',
  'assets/images/tutorialUi/btn_next.png'
]

let preloaded = false

/** Warm the renderer cache before the loading gate lifts, so UI panels and
 * controls never show an untextured first frame when they are opened. */
export function preloadUiAssets(): void {
  if (preloaded) return
  preloaded = true

  const thumbnails = Cfg.SPECIES.map(Cfg.speciesImage).filter((src): src is string => !!src)
  AssetLoad.create(engine.addEntity(), { assets: [...new Set([...STATIC_UI_ASSETS, ...thumbnails])] })
}
