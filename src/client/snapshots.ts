// Player profile face snapshots fetched over HTTP and cached, for use as plane
// textures on the physical leaderboard. This works across ALL clients (mobile +
// Unity), unlike Material.Texture.Avatar which mobile may not render. Client-only.
//
// Profile faces are no longer Catalyst entity content files, so we read the face
// URL from the lambdas profile (`avatar.snapshots.face256|face`), which points at
// https://profile-images.decentraland.org/... (it 301s to an S3 bucket). Both the
// profile-images host AND its S3 redirect target must be in scene.json >
// allowedMediaHostnames, and USE_FETCH must be in requiredPermissions.

// Lambdas peers, tried in order. (peer-wc1 was removed — it no longer resolves and
// just burned a full timeout per lookup.)
const PEERS = [
  'https://peer.decentraland.org',
  'https://peer-ec1.decentraland.org',
  'https://peer-eu1.decentraland.org'
]

type SnapState = 'loading' | 'ok' | 'missing'
type Snap = { state: SnapState; url?: string }
const cache = new Map<string, Snap>() // wallet (lowercased) -> snapshot

async function resolve(wallet: string): Promise<void> {
  for (const peer of PEERS) {
    try {
      const res = await fetch(`${peer}/lambdas/profiles/${wallet}`)
      if (res.ok) {
        const body = await res.json()
        const snaps = body?.avatars?.[0]?.avatar?.snapshots
        const url: string | undefined = snaps?.face256 ?? snaps?.face
        // Only accept a ready-to-use http(s) URL (profile-images.decentraland.org).
        if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
          cache.set(wallet, { state: 'ok', url })
          return
        }
      }
    } catch (e) {
      void e
    }
  }
  cache.set(wallet, { state: 'missing' }) // guest / no deployed profile -> placeholder stays
}

/** Kick off a fetch for this wallet's face (no-op if already requested). */
export function requestPlayerFace(wallet: string): void {
  const key = wallet.toLowerCase()
  if (cache.has(key)) return
  cache.set(key, { state: 'loading' })
  void resolve(key)
}

/** The resolved face URL, or null while loading / if missing. */
export function getPlayerFaceUrl(wallet: string): string | null {
  const s = cache.get(wallet.toLowerCase())
  return s && s.state === 'ok' ? s.url ?? null : null
}
