// Keeps every screen-UI texture referenced by a real UiBackground from boot, so
// a panel that opens later finds its texture already decoded and cached.
//
// AssetLoad alone does not do this: both explorers store its textures under a
// different cache key than UiBackground looks up (Unity: no file hash and
// Repeat/Point instead of Clamp/Bilinear; Godot: `{hash}` instead of
// `{hash}_q{quality}`), so the UI would load each texture again on first show.
// AssetLoad stays as the loading gate's readiness signal; this warmer is what
// actually fills the cache entry the UI reads.
//
// The textures must be referenced exactly like the real UI does — plain
// `texture: { src }`, no wrapMode/filterMode — or the cache key differs again.
// Each one is a 1x1, fully transparent node; display:'none' is avoided because
// it is not guaranteed that every explorer loads textures for hidden nodes.

import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { areCriticalUiAssetsReady, getUiAssetGroups } from '../uiAssets'

const INVISIBLE = { r: 1, g: 1, b: 1, a: 0 }

function warmTexture(src: string) {
  return (
    <UiEntity
      key={src}
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: 1, height: 1, pointerFilter: 'none' }}
      uiBackground={{ texture: { src }, color: INVISIBLE }}
    />
  )
}

/** Mounted once at the UI root, outside every screen branch, so it is alive
 * behind the loading gate and never unmounts. Deferred textures wait for the
 * critical group, keeping the first frame's bandwidth for what is visible. */
export function UiTextureWarmer() {
  const { critical, deferred } = getUiAssetGroups()
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: 1, height: 1, pointerFilter: 'none' }}
    >
      {critical.map(warmTexture)}
      {areCriticalUiAssetsReady() && deferred.map(warmTexture)}
    </UiEntity>
  )
}
