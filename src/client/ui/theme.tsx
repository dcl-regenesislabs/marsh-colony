// Shared mobile-first UI kit: warm "cute animal game" palette, responsive
// scaling, outlined labels, tactile (animated) buttons, pills, stat bars, and a
// panel shell that blocks the mobile joystick. Inspired by the cozy-farm UI.

import ReactEcs, { Label, UiEntity } from '@dcl/sdk/react-ecs'
import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
import { getExplorerInformation } from '~system/Runtime'
import { getPress, triggerPress, attentionPulse } from './anim'

export type Color = { r: number; g: number; b: number; a: number }

// ---- Palette -------------------------------------------------------------
export const C = {
  panelBg: { r: 0.16, g: 0.12, b: 0.1, a: 0.98 } as Color,
  card: { r: 0.24, g: 0.19, b: 0.16, a: 1 } as Color,
  cardAlt: { r: 0.3, g: 0.24, b: 0.2, a: 1 } as Color,
  scrim: { r: 0, g: 0, b: 0, a: 0.55 } as Color,
  text: { r: 0.98, g: 0.95, b: 0.88, a: 1 } as Color,
  dim: { r: 0.74, g: 0.68, b: 0.6, a: 1 } as Color,
  outline: { r: 0.12, g: 0.08, b: 0.06, a: 1 } as Color,
  gold: { r: 1, g: 0.8, b: 0.3, a: 1 } as Color,
  green: { r: 0.4, g: 0.82, b: 0.45, a: 1 } as Color,
  greenDark: { r: 0.22, g: 0.5, b: 0.28, a: 1 } as Color,
  // stat colors
  hunger: { r: 0.98, g: 0.6, b: 0.25, a: 1 } as Color,
  hygiene: { r: 0.38, g: 0.68, b: 0.98, a: 1 } as Color,
  energy: { r: 0.98, g: 0.82, b: 0.3, a: 1 } as Color,
  happy: { r: 0.98, g: 0.5, b: 0.68, a: 1 } as Color,
  trackBg: { r: 0.12, g: 0.1, b: 0.09, a: 0.9 } as Color,
  pink: { r: 0.85, g: 0.45, b: 0.62, a: 1 } as Color,
  blue: { r: 0.4, g: 0.6, b: 0.9, a: 1 } as Color,
  potion: { r: 0.62, g: 0.45, b: 0.93, a: 1 } as Color // rarity potion (purple accent)
}

export function dimColor(c?: Color): Color {
  const b = c ?? C.card
  return { r: b.r * 0.45, g: b.g * 0.45, b: b.b * 0.45, a: b.a }
}

// ---- Responsive scaling (virtual 1920x1080) ------------------------------
// Robust mobile detection. The SDK's isMobile() resolves the platform
// asynchronously and has no fallback: on some mobile app builds it never reports
// 'mobile', leaving the whole HUD at desktop scale (tiny). We resolve it
// ourselves and add an agent-string fallback, then store the result so S() reads
// it every render (React-ECS re-renders each frame, so the HUD resizes once the
// lookup resolves).
let isMobileRuntime = false
// The Bevy explorer reports platform:"web" agent:"bevy" and renders the HUD
// small at 1920x1080 — it needs the compact virtual canvas like mobile does.
let isBevyRuntime = false
let platformLookupStarted = false

const MOBILE_AGENT_RE = /mobile|android|iphone|ipad|ios/

/**
 * Live device pixel ratio, read from the renderer. Bevy (web) rasterizes the HUD
 * at the PHYSICAL resolution, so on a retina screen (dpr 2) everything comes out
 * half-size. We multiply S() by this on Bevy to compensate — resolution- and
 * density-independent, since it's read at render time.
 */
function devicePixelRatio(): number {
  const ci = UiCanvasInformation.getOrNull(engine.RootEntity)
  return ci?.devicePixelRatio || 1
}

/**
 * Kick off the (async) platform lookup once. Safe to call from setup.
 * `onResolved` fires once the lookup settles (success OR failure) — used to
 * re-apply the UI renderer with the right virtual canvas for mobile, since
 * virtualWidth/Height are fixed at setUiRenderer time and can't update per frame.
 */
export function resolveRuntimePlatform(onResolved?: () => void): void {
  if (platformLookupStarted) return
  platformLookupStarted = true
  void getExplorerInformation({})
    .then((info) => {
      const platform = (info.platform ?? '').toLowerCase()
      const agent = (info.agent ?? '').toLowerCase()
      isMobileRuntime = platform === 'mobile' || MOBILE_AGENT_RE.test(agent)
      isBevyRuntime = agent.includes('bevy')
      console.log('[Platform]', `platform:${platform || '?'} agent:${agent || '?'}`)
    })
    .catch(() => {
      // Couldn't read it — stay at desktop scale rather than guess wrong.
    })
    .then(() => {
      if (onResolved) onResolved()
    })
}

export function mobile(): boolean {
  return isMobileRuntime
}

/** True on the Bevy (web) explorer — reports platform:"web" agent:"bevy", so
 *  mobile()'s platform/agent heuristics don't catch it on their own. */
export function bevy(): boolean {
  return isBevyRuntime
}

/**
 * Mobile keeps the pre-7.26 HUD sizing by expanding the virtual canvas in lockstep
 * with the reported pixel density, while opting out of the new safe-area inset so
 * anchored HUD pieces stay flush with the full screen like before.
 */
export function getUiRendererConfig() {
  const densityScale = isMobileRuntime ? Math.max(1, devicePixelRatio()) : 1

  return {
    virtualWidth: isMobileRuntime ? Math.max(1, Math.round(1600 * densityScale)) : 1920,
    virtualHeight: isMobileRuntime ? Math.max(1, Math.round(720 * densityScale)) : 1080,
    screenInset: 'none' as const
  }
}

// Global UI scale — larger touch targets on mobile, slightly larger on desktop
// too (mobile-testing friendly). React-ECS re-renders every frame, so the HUD
// resizes automatically once the platform lookup resolves.
export function S(n: number): number {
  // Bevy renders at physical resolution, so compensate for the pixel ratio.
  if (isBevyRuntime) return Math.round(n * 1.18 * devicePixelRatio())
  return Math.round(n * (isMobileRuntime ? 1.6 : 1.18))
}

/** Extra bump for touch buttons on mobile only (on top of S). Tune freely. */
export const MOBILE_BTN_BOOST = 1.2
export function Sbtn(n: number): number {
  return Math.round(S(n) * (isMobileRuntime ? MOBILE_BTN_BOOST : 1))
}

// ---- Outlined label (readable over the 3D world) -------------------------
const OFFSETS = [
  { left: -2, top: 0 },
  { left: 2, top: 0 },
  { left: 0, top: -2 },
  { left: 0, top: 2 }
]
export function OutlineLabel(props: {
  value: string
  fontSize: number
  color: Color
  outlineColor?: Color
  width: number | string
  height: number
  textAlign?: 'middle-left' | 'middle-center' | 'middle-right'
}) {
  const align = props.textAlign ?? 'middle-center'
  return (
    <UiEntity uiTransform={{ width: props.width as any, height: props.height }}>
      {OFFSETS.map((off, i) => (
        <Label
          key={`ol-${i}`}
          value={props.value}
          fontSize={props.fontSize}
          color={props.outlineColor ?? C.outline}
          textAlign={align}
          uiTransform={{ width: '100%', height: props.height, positionType: 'absolute', position: off }}
        />
      ))}
      <Label
        value={props.value}
        fontSize={props.fontSize}
        color={props.color}
        textAlign={align}
        uiTransform={{ width: '100%', height: props.height, positionType: 'absolute', position: { left: 0, top: 0 } }}
      />
    </UiEntity>
  )
}

// ---- Tactile button (press/bounce animation) -----------------------------
export function TactileButton(props: {
  key?: string | number
  id: string
  label: string
  onClick: () => void
  width: number
  height: number
  bg?: Color
  textColor?: Color
  fontSize?: number
  disabled?: boolean
  pulse?: boolean
  radius?: number
  margin?: Partial<{ top: number; right: number; bottom: number; left: number }>
  /**
   * Optional background image. When set it replaces the color fill and the label
   * is skipped — these textures ship with their caption already baked in.
   */
  texture?: string
  /** Optional UV crop (8 numbers, bottom-left clockwise) for pulling this
   *  button out of a spritesheet instead of a standalone texture file. */
  uvs?: number[]
}) {
  const scale = getPress(props.id) * (props.pulse && !props.disabled ? attentionPulse() : 1)
  const w = Math.round(props.width * scale)
  const h = Math.round(props.height * scale)
  const textured = !!props.texture
  return (
    <UiEntity
      uiTransform={{ width: props.width, height: props.height, alignItems: 'center', justifyContent: 'center', margin: props.margin }}
    >
      <UiEntity
        uiTransform={{ width: w, height: h, alignItems: 'center', justifyContent: 'center', borderRadius: textured ? 0 : props.radius ?? S(16) }}
        uiBackground={
          textured
            ? { texture: { src: props.texture! }, textureMode: 'stretch', uvs: props.uvs }
            : { color: props.disabled ? dimColor(props.bg) : props.bg ?? C.card }
        }
        onMouseDown={() => {
          if (props.disabled) return
          triggerPress(props.id)
          props.onClick()
        }}
      >
        {!textured && (
          <Label
            value={props.label}
            fontSize={props.fontSize ?? S(18)}
            color={props.disabled ? C.dim : props.textColor ?? C.text}
            textAlign="middle-center"
            uiTransform={{ width: w, height: h }}
          />
        )}
      </UiEntity>
    </UiEntity>
  )
}

// Big circular care button: colored disc with caption beneath.
export function CareButton(props: {
  id: string
  caption: string
  glyph: string
  onClick: () => void
  bg: Color
  size: number
  disabled?: boolean
  pulse?: boolean
}) {
  const scale = getPress(props.id) * (props.pulse && !props.disabled ? attentionPulse() : 1)
  const d = Math.round(props.size * scale)
  return (
    <UiEntity uiTransform={{ width: props.size, height: props.size + S(22), flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', margin: { left: S(7), right: S(7) } }}>
      <UiEntity uiTransform={{ width: props.size, height: props.size, alignItems: 'center', justifyContent: 'center' }}>
        <UiEntity
          uiTransform={{ width: d, height: d, alignItems: 'center', justifyContent: 'center', borderRadius: Math.round(props.size) }}
          uiBackground={{ color: props.disabled ? dimColor(props.bg) : props.bg }}
          onMouseDown={() => {
            if (props.disabled) return
            triggerPress(props.id)
            props.onClick()
          }}
        >
          <OutlineLabel value={props.glyph} fontSize={Math.round(props.size * 0.42)} color={C.text} width={d} height={d} />
        </UiEntity>
      </UiEntity>
      <Label value={props.caption} fontSize={S(14)} color={C.text} textAlign="middle-center" uiTransform={{ width: props.size + S(14), height: S(20) }} />
    </UiEntity>
  )
}

// ---- Info pill -----------------------------------------------------------
export function Pill(props: { label: string; value: string; bg?: Color; accent?: Color; width?: number }) {
  return (
    <UiEntity
      uiTransform={{ width: props.width ?? S(132), height: S(40), flexDirection: 'row', alignItems: 'center', borderRadius: S(20), margin: { bottom: S(6) } }}
      uiBackground={{ color: props.bg ?? C.card }}
    >
      <UiEntity
        uiTransform={{ width: S(30), height: S(30), borderRadius: S(15), margin: { left: S(5), right: S(8) }, alignItems: 'center', justifyContent: 'center' }}
        uiBackground={{ color: props.accent ?? C.gold }}
      >
        <Label value={props.label} fontSize={S(15)} color={C.outline} textAlign="middle-center" uiTransform={{ width: S(30), height: S(30) }} />
      </UiEntity>
      <Label value={props.value} fontSize={S(17)} color={C.text} textAlign="middle-left" uiTransform={{ width: (props.width ?? S(132)) - S(48), height: S(40) }} />
    </UiEntity>
  )
}

// ---- Stat bar (rounded) --------------------------------------------------
/** Track art aspect (bar_track.png is 600x30). Keeps the groove undistorted. */
const TRACK_ASPECT = 20

/**
 * A bar texture plus the normalized width of its rounded cap. We nine-slice on
 * that inset so the caps keep their radius no matter how far the bar is
 * stretched — the art ships at different lengths, and the fill's width tracks
 * the live stat value, so plain 'stretch' would distort every bar differently.
 */
export type BarArt = { src: string; slice: number }

function nineSlice(a: BarArt) {
  return {
    texture: { src: a.src },
    textureMode: 'nine-slices' as const,
    textureSlices: { top: 0, right: a.slice, bottom: 0, left: a.slice }
  }
}

export function StatBar(props: {
  label: string
  value: number
  color: Color
  width: number
  /** Optional art. `icon` replaces the text label; `track`/`fill` the flat bars. */
  icon?: string
  track?: BarArt
  fill?: BarArt
}) {
  const v = Math.max(0, Math.min(100, props.value))
  const textured = !!(props.track && props.fill)
  const iconW = S(24)
  const gap = S(8)
  const headW = props.icon ? iconW : S(58)
  const trackW = props.width - headW - gap
  const trackH = textured ? Math.round(trackW / TRACK_ASPECT) : S(15)
  const rowH = Math.max(S(26), props.icon ? iconW : S(22))
  return (
    <UiEntity uiTransform={{ width: props.width, height: rowH, flexDirection: 'row', alignItems: 'center', margin: { bottom: S(4) } }}>
      {props.icon ? (
        <UiEntity
          uiTransform={{ width: iconW, height: iconW, margin: { right: gap } }}
          uiBackground={{ texture: { src: props.icon }, textureMode: 'stretch' }}
        />
      ) : (
        <Label
          value={props.label}
          fontSize={S(13)}
          color={C.text}
          textAlign="middle-left"
          uiTransform={{ width: headW, height: S(22), margin: { right: gap } }}
        />
      )}
      <UiEntity
        uiTransform={{ width: trackW, height: trackH, borderRadius: textured ? 0 : S(8) }}
        uiBackground={textured ? nineSlice(props.track!) : { color: C.trackBg }}
      >
        <UiEntity
          uiTransform={{ width: `${v}%`, height: '100%', borderRadius: textured ? 0 : S(8) }}
          uiBackground={textured ? nineSlice(props.fill!) : { color: props.color }}
        />
      </UiEntity>
    </UiEntity>
  )
}

// ---- Panel shell ---------------------------------------------------------
export function PanelShell(props: { title: string; onClose: () => void; width?: number; height?: number; children?: any }) {
  const w = props.width ?? S(620)
  const h = props.height ?? S(640)
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', pointerFilter: 'none' }}
    >
      {/* Full-screen blocker so touches outside the card don't move the avatar. */}
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'block' }}
        uiBackground={{ color: C.scrim }}
        onMouseDown={() => {}}
      />
      <UiEntity
        uiTransform={{ width: w, height: h, flexDirection: 'column', padding: { top: S(18), bottom: S(22), left: S(24), right: S(24) }, borderRadius: S(24), pointerFilter: 'block' }}
        uiBackground={{ color: C.panelBg }}
      >
        {/* Header */}
        <UiEntity uiTransform={{ width: '100%', height: S(50), alignItems: 'center', justifyContent: 'center', margin: { bottom: S(6) } }}>
          <OutlineLabel value={props.title} fontSize={S(28)} color={C.gold} width={'100%'} height={S(40)} textAlign="middle-center" />
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { right: 0, top: 0 }, width: S(44), height: S(44), borderRadius: S(22), alignItems: 'center', justifyContent: 'center' }}
            uiBackground={{ color: { r: 0.5, g: 0.2, b: 0.16, a: 1 } }}
            onMouseDown={props.onClose}
          >
            <Label value="X" fontSize={S(22)} color={C.text} textAlign="middle-center" uiTransform={{ width: S(44), height: S(44) }} />
          </UiEntity>
        </UiEntity>
        <UiEntity uiTransform={{ width: '100%', height: S(3), margin: { bottom: S(12) }, borderRadius: S(2) }} uiBackground={{ color: C.cardAlt }} />
        <UiEntity uiTransform={{ flex: 1, width: '100%', flexDirection: 'column', overflow: 'hidden' }}>{props.children}</UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
