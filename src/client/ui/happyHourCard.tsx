import ReactEcs, { Label, UiEntity } from '@dcl/sdk/react-ecs'
import { HAPPY_HOUR } from '../../shared/happyHour'
import { happyHourStatus } from '../happyHour'
import { t } from '../i18n'
import { mobile, S, playUiClick } from './theme'

const accent = { r: 0.64, g: 0.26, b: 0.13, a: 1 }
const muted = { r: 0.52, g: 0.39, b: 0.29, a: 1 }
const ink = { r: 0.32, g: 0.2, b: 0.14, a: 1 }
const ART = 'assets/images/revamp/panel_standard_bg.png'
const MUSHROOM = 'assets/images/revamp/growth_mushroom_red.png'

let dismissed = false
let lastEventEndsAt = 0
let wasActive = false

function clock(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/** Illustrated event panel. Only the art is baked; every word is localized live. */
export function HappyHourCard() {
  const status = happyHourStatus()
  if (!status) { wasActive = false; return null }
  if (!wasActive || status.endsAt !== lastEventEndsAt) {
    dismissed = false
    wasActive = true
    lastEventEndsAt = status.endsAt ?? 0
  }
  const isMobile = mobile()
  // Same mobile width as navPanelWidth(): Inventory, My Pets and Goals.
  const width = S(isMobile ? 660 : 820)
  const height = width * 732 / 1000
  const px = (n: number) => Math.round(n * width / 1000)
  const font = mobile() ? {} : { fontSrc: 'assets/fonts/Fredoka-SemiBold.ttf' }
  const bold = mobile() ? {} : { fontSrc: 'assets/fonts/Fredoka-Bold.ttf' }
  const close = () => { playUiClick(); dismissed = true }
  if (dismissed) {
    const iconSize = S(isMobile ? 88 : 72)
    return (
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: isMobile ? S(46) + (S(58) - iconSize) / 2 : S(112), right: S(isMobile ? 150 : 20) },
          width: iconSize, height: iconSize, borderRadius: iconSize / 2,
          borderWidth: S(2), borderColor: { r: 0.78, g: 0.58, b: 0.34, a: 1 },
          alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }}
        uiBackground={{ color: { r: 1, g: 0.96, b: 0.85, a: 0.97 } }}
        onMouseDown={() => { playUiClick(); dismissed = false }}
      >
        <UiEntity uiTransform={{ width: iconSize * 0.9, height: iconSize * 0.9, pointerFilter: 'none' }}
          uiBackground={{ texture: { src: MUSHROOM }, textureMode: 'stretch' }} />
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: S(2), right: S(2) },
          width: S(12), height: S(12), borderRadius: S(6), borderWidth: S(2),
          borderColor: { r: 1, g: 0.96, b: 0.85, a: 1 }, pointerFilter: 'none' }}
          uiBackground={{ color: { r: 0.4, g: 0.7, b: 0.26, a: 1 } }} />
      </UiEntity>
    )
  }
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', pointerFilter: 'block' }}
      onMouseDown={() => {}}>
      <UiEntity uiTransform={{ width, height, positionType: 'relative' }} uiBackground={{ texture: { src: ART }, textureMode: 'stretch' }}>
        {/* Compact heading, then two balanced columns on a shared grid. */}
        <Label value={t('happyHour.eyebrow')} {...bold} fontSize={px(isMobile ? 20 : 15)} color={accent} uiTransform={{ positionType: 'absolute', position: { top: px(32), left: px(90) }, width: px(740), height: px(isMobile ? 28 : 24) }} />
        <Label value={t('happyHour.title')} {...bold} fontSize={px(isMobile ? 38 : 34)} color={ink} uiTransform={{ positionType: 'absolute', position: { top: px(61), left: px(70) }, width: px(780), height: px(58) }} />
        <Label value={t('happyHour.duration', { minutes: HAPPY_HOUR.durationMinutes })} {...font} fontSize={px(isMobile ? 23 : 17)} color={muted} uiTransform={{ positionType: 'absolute', position: { top: px(117), left: px(80) }, width: px(840), height: px(30) }} />
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: px(160), left: px(85) }, width: px(830), height: px(1), pointerFilter: 'none' }} uiBackground={{ color: { r: 0.77, g: 0.6, b: 0.44, a: 0.3 } }} />
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: px(164), left: px(75) }, width: px(400), height: px(400), pointerFilter: 'none' }} uiBackground={{ texture: { src: MUSHROOM }, textureMode: 'stretch' }} />
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: px(174), left: px(530) }, width: px(385), flexDirection: 'column', pointerFilter: 'none' }}>
          <Label value={t('happyHour.body')} {...font} fontSize={px(isMobile ? 26 : 21)} color={ink} textAlign="middle-left" uiTransform={{ width: '100%', height: px(isMobile ? 190 : 112), margin: { bottom: px(isMobile ? 12 : 16) } }} />
          {/* Group caption and timer closely; the large digits retain priority. */}
          <UiEntity uiTransform={{ width: '100%', height: px(isMobile ? 160 : 175), flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRadius: px(22), borderWidth: px(2), borderColor: { r: 0.85, g: 0.67, b: 0.43, a: 1 }, pointerFilter: 'none' }} uiBackground={{ color: { r: 1, g: 0.93, b: 0.76, a: 1 } }}>
            <Label value={t('happyHour.endsLabel')} {...bold} fontSize={px(isMobile ? 22 : 16)} color={muted} uiTransform={{ width: '100%', height: px(isMobile ? 36 : 28) }} />
            <Label value={clock(status.remaining)} {...bold} fontSize={px(isMobile ? 82 : 78)} color={accent} textWrap="nowrap" uiTransform={{ width: '100%', height: px(100) }} />
          </UiEntity>
          <Label value={status.refresh > 0 ? t('happyHour.refresh', { time: clock(status.refresh) }) : t(status.available > 0 ? 'happyHour.ready' : 'happyHour.lastBloom')} {...font} fontSize={px(isMobile ? 23 : 17)} color={muted} uiTransform={{ width: '100%', height: px(isMobile ? 64 : 48), margin: { top: px(isMobile ? 12 : 16) } }} />
        </UiEntity>
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: px(isMobile ? 573 : 538), left: px(100) }, width: px(350), height: px(isMobile ? 58 : 42), borderRadius: px(21), alignItems: 'center', justifyContent: 'center', pointerFilter: 'none' }} uiBackground={{ color: { r: 0.94, g: 0.88, b: 0.75, a: 0.7 } }}>
          <Label value={t('happyHour.available', { count: status.available })} {...bold} fontSize={px(isMobile ? 24 : 18)} color={accent} uiTransform={{ width: '100%', height: '100%' }} />
        </UiEntity>
        {/* Match the standard panel's baked close button exactly. */}
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: px(20), left: px(865) }, width: px(104), height: px(104), pointerFilter: 'block' }} uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.001 } }} onMouseDown={close} />
      </UiEntity>
    </UiEntity>
  )
}
