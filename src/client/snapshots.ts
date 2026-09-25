// Player profile face snapshots (face256.png) fetched over HTTP and cached, for
// use as plane textures on the physical leaderboard. This works across ALL clients
// (mobile + Unity), unlike Material.Texture.Avatar which mobile may not render.
// Client-only — the server never participates.
//
// We resolve the face URL from the Catalyst content entity (which lets us build a
// URL on peer.decentraland.org, a host we whitelist in scene.json — avoiding the
// Cloudflare CDN that returned 525s), with the lambdas profile as a fallback.
// Every hostname used here must be listed in scene.json > allowedMediaHostnames.

// Peers are tried in order; each is also a whitelisted media hostname.
const PEERS = [
  'https://peer.decentraland.org',
  'https://peer-ec1.decentraland.org',
  'https://peer-wc1.decentraland.org',
  'https://peer-eu1.decentraland.org'
]

type SnapState = 'loading' | 'ok' | 'missing'
type Snap = { state: SnapState; url?: string }
const cache = new Map<string, Snap>() // wallet (lowercased) -> snapshot

const contentUrl = (peer: string, hash: string): string => `${peer}/content/contents/${hash}`

/** ipfs://CID or a bare content hash -> a peer content URL; pass through http(s). */
function normalize(raw: string | undefined, peer: string): string | null {
  if (!raw) return null
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw
  if (raw.startsWith('ipfs://')) return contentUrl(peer, raw.slice('ipfs://'.length))
  if (/^(baf|Qm)/.test(raw)) return contentUrl(peer, raw)
  return null
}

async function resolve(wallet: string): Promise<void> {
  for (const peer of PEERS) {
    // 1) Catalyst content entity -> face256.png (or smaller) hash -> peer content URL.
    try {
      const res = await fetch(`${peer}/content/entities/profile?pointer=${wallet}`)
      if (res.ok) {
        const arr = await res.json()
        const content: { file: string; hash: string }[] = arr?.[0]?.content ?? []
        const pick =
          content.find((c) => c.file === 'face256.png') ??
          content.find((c) => c.file === 'face128.png') ??
          content.find((c) => c.file === 'face.png')
        if (pick?.hash) {
          cache.set(wallet, { state: 'ok', url: contentUrl(peer, pick.hash) })
          return
        }
      }
    } catch (e) {
      void e
    }
    // 2) Lambdas profile fallback.
    try {
      const res = await fetch(`${peer}/lambdas/profiles/${wallet}`)
      if (res.ok) {
        const body = await res.json()
        const snaps = body?.avatars?.[0]?.avatar?.snapshots
        const url = normalize(snaps?.face256 ?? snaps?.face, peer)
        if (url) {
          cache.set(wallet, { state: 'ok', url })
          return
        }
      }
    } catch (e) {
      void e
    }
  }
  cache.set(wallet, { state: 'missing' })
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
