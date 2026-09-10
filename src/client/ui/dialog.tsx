// NPC dialog as a bottom-of-screen speech bubble, built from the revamp
// spritesheet (assets/images/revamp/dialogue.png) — bubble background, the
// Caretaker's portrait, and the Next/Adopt buttons are all real designer art
// cropped out of that one sheet via UV rects (measured directly from the PNG's
// pixel bounds, not eyeballed), not code-drawn shapes/colors. Mandatory
// dialogs — no close button, Next is the only way through.

import ReactEcs, { Label, UiEntity } from '@dcl/sdk/react-ecs'
import { getPlayer } from '@dcl/sdk/players'
import { advanceDialog, clientState, openDialog } from '../state'
import { S, TactileButton } from './theme'

const SHEET = 'assets/images/revamp/dialogue.png'
const SHEET_W = 1024
const SHEET_H = 1024
// Dedicated portrait (already a tight circular cutout on its own canvas) —
// used instead of the spritesheet's own avatar crop.
const CARETAKER_IMG = 'assets/images/revamp/caretaker.png'
const CARETAKER_ASPECT = 1 // 512x512, circle fills the square

/** uiBackground.uvs order: bottom-left, top-left, top-right, bottom-right
 *  (PBUiBackground doc: "starting from bottom-left vertex clock-wise").
 *  Pixel box uses normal top-left-origin image coordinates. */
function uvRect(x0: number, y0: number, x1: number, y1: number): number[] {
  const uL = x0 / SHEET_W
  const uR = x1 / SHEET_W
  const vTop = 1 - y0 / SHEET_H
  const vBottom = 1 - y1 / SHEET_H
  return [uL, vBottom, uL, vTop, uR, vTop, uR, vBottom]
}

// Exact pixel bounds measured from the spritesheet (flood-filled by alpha,
// not eyeballed) — image is 1024x1024.
const BUBBLE_BOX = { x0: 34, y0: 39, x1: 858, y1: 245 }
const NEXT_BOX = { x0: 188, y0: 310, x1: 344, y1: 399 }
const ADOPT_BOX = { x0: 367, y0: 310, x1: 597, y1: 401 }

const BUBBLE_UVS = uvRect(BUBBLE_BOX.x0, BUBBLE_BOX.y0, BUBBLE_BOX.x1, BUBBLE_BOX.y1)
const NEXT_UVS = uvRect(NEXT_BOX.x0, NEXT_BOX.y0, NEXT_BOX.x1, NEXT_BOX.y1)
const ADOPT_UVS = uvRect(ADOPT_BOX.x0, ADOPT_BOX.y0, ADOPT_BOX.x1, ADOPT_BOX.y1)

const BUBBLE_ASPECT = (BUBBLE_BOX.x1 - BUBBLE_BOX.x0) / (BUBBLE_BOX.y1 - BUBBLE_BOX.y0) // 824/206
const NEXT_ASPECT = (NEXT_BOX.x1 - NEXT_BOX.x0) / (NEXT_BOX.y1 - NEXT_BOX.y0) // 156/89
const ADOPT_ASPECT = (ADOPT_BOX.x1 - ADOPT_BOX.x0) / (ADOPT_BOX.y1 - ADOPT_BOX.y0) // 230/91

const LGT = {
  title: { r: 0.29, g: 0.56, b: 0.95, a: 1 }, // name text color, no outline
  body: { r: 0.2, g: 0.22, b: 0.28, a: 1 },
  dotOn: { r: 0.29, g: 0.56, b: 0.95, a: 1 },
  dotOff: { r: 0.8, g: 0.82, b: 0.86, a: 1 }
}

/** The local player's display name, or a themed fallback. */
export function playerName(): string {
  const n = getPlayer()?.name
  return n && n.trim() ? n.trim() : 'Settler'
}

/** Built dynamically so the Caretaker can greet the player by name. */
export function caretakerIntro(): string[] {
  return [
    `Welcome to the Mars colony, ${playerName()}. I'm the Caretaker — out here, every colony is built on the creatures we raise.`,
    'Tap "Adopt a Pet" to take in your first Martian companion.',
    'Keep it thriving: Feed at the Bowl, Bath at the Pond, Sleep on the Bed, Play at the Ball. Tap it anytime for some love.',
    "A healthy, happy pet earns Coins — and soon you'll breed it with other settlers' pets to grow the colony. Let's begin!"
  ]
}

export const CARETAKER_TIPS: string[] = [
  'Happy, healthy pets earn more Coins and XP — and the healthier the pet, the stronger its future offspring.',
  'Breeding is coming soon: raise your pet\'s level and you\'ll be able to cross it with other colonists\' pets.',
  'Use the Whistle button to call your pet over or tell it to stay put.'
]

export function openCaretakerIntro(onDone?: () => void): void {
  openDialog('Caretaker', caretakerIntro(), 'Adopt now!', onDone, true) // adopt CTA art
}

export function openCaretakerTips(): void {
  openDialog('Caretaker', CARETAKER_TIPS, 'Got it!')
}

// Shown when the player taps the Caretaker's own Golden Legendary familiar
// (client/caretakerPet.ts) — teases the breeding reward loop.
export const LEGENDARY_CREATURE_DIALOG: string[] = [
  'This is a rare LEGENDARY creature — the finest the colony has to offer.',
  'The secret? Keep your creatures thriving. When all four needs stay full, breeding two of them gives a far greater chance of hatching a LEGENDARY.',
  "When you do, we will contact you and exchange it for something I can't reveal now. Be a good caretaker and provide the colony with exceptional creatures."
]

export function openLegendaryCreatureDialog(): void {
  openDialog('Caretaker', LEGENDARY_CREATURE_DIALOG, 'Got it!')
}

export function DialogBox() {
  const d = clientState.dialog
  if (!d.open) return <UiEntity />
  const isLast = d.page >= d.pages.length - 1
  const body = d.pages[d.page] ?? ''
  const isAdoptCta = isLast && d.adoptCta

  const bubbleW = S(880)
  // A touch taller than the sprite's native aspect ratio (824/206) — the
  // background is a plain rounded rect, so a mild vertical stretch to fit
  // more content comfortably doesn't read as distorted.
  const bubbleH = Math.round((bubbleW / BUBBLE_ASPECT) * 1.15)

  // The sprite's tail notch pokes into the top of its own crop, so give the
  // top a bit more breathing room than the bottom.
  const padH = S(40)
  const padTop = S(40)
  const padBottom = S(20)
  const avatarH = bubbleH - padTop - padBottom
  const avatarW = Math.round(avatarH * CARETAKER_ASPECT)
  const gapAvatarText = S(20)
  const textColW = bubbleW - padH * 2 - avatarW - gapAvatarText

  const titleH = S(32)
  const bottomRowH = S(50)
  const rowGap = S(8)
  const bodyTextH = avatarH - titleH - bottomRowH - rowGap * 2

  const btnH = S(60)
  const nextW = Math.round(btnH * NEXT_ASPECT)
  const adoptW = Math.round(btnH * ADOPT_ASPECT)

  return (
    // Transparent full-screen catcher — no dark scrim (the bubble sits over
    // the bright scene, not a dimmed one) but still swallows clicks so the
    // rest of the HUD can't be interacted with mid-dialog.
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'block' }}
      uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0 } }}
      onMouseDown={() => {}}
    >
      <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: S(70), left: '50%' }, margin: { left: -bubbleW / 2 }, width: bubbleW, height: bubbleH }}>
        {/* Bubble background — real art, not a drawn rect. */}
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: bubbleW, height: bubbleH, pointerFilter: 'block' }}
          uiBackground={{ texture: { src: SHEET }, textureMode: 'stretch', uvs: BUBBLE_UVS }}
        />

        {/* Avatar (left) + name/body column (right), inset within the bubble art. */}
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: padTop, left: padH }, width: bubbleW - padH * 2, height: avatarH, flexDirection: 'row', alignItems: 'flex-start' }}>
          <UiEntity uiTransform={{ width: avatarW, height: avatarH }} uiBackground={{ texture: { src: CARETAKER_IMG }, textureMode: 'stretch' }} />
          <UiEntity uiTransform={{ width: textColW, height: avatarH, flexDirection: 'column', margin: { left: gapAvatarText } }}>
            <Label value={d.npcName} fontSize={S(28)} color={LGT.title} textAlign="middle-left" uiTransform={{ width: textColW, height: titleH, margin: { top: S(14) } }} />
            <Label value={body} fontSize={S(18)} color={LGT.body} textAlign="top-left" textWrap="wrap" uiTransform={{ width: textColW, height: bodyTextH, margin: { top: rowGap } }} />

            {/* Page dots (left) + Next/final button (right) */}
            <UiEntity uiTransform={{ width: '100%', height: bottomRowH, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { top: rowGap } }}>
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                {d.pages.map((_, i) => (
                  <UiEntity
                    key={`dot-${i}`}
                    uiTransform={{ width: S(12), height: S(12), borderRadius: S(6), margin: { left: S(4), right: S(4) } }}
                    uiBackground={{ color: i === d.page ? LGT.dotOn : LGT.dotOff }}
                  />
                ))}
              </UiEntity>
              <TactileButton
                id="dialog_next"
                label={isAdoptCta ? d.finalLabel : 'Next'}
                texture={SHEET}
                uvs={isAdoptCta ? ADOPT_UVS : NEXT_UVS}
                width={isAdoptCta ? adoptW : nextW}
                height={btnH}
                onClick={() => advanceDialog()}
              />
            </UiEntity>
          </UiEntity>
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
