// The space Caretaker aboard the ark (Captain.glb). Taps open a small teaser
// dialog and swap its Idle/Talk clips while talking — mirrors caretaker.ts, but
// with no intro lock (it's an optional, flavour NPC).

import { engine, Entity, Transform, Animator, pointerEventsSystem, InputAction } from '@dcl/sdk/ecs'
import { EntityNames } from '../../assets/scene/entity-names'
import { clientState, openDialog } from './state'

// Clip names as authored on Captain.glb (assets/scene/main.composite) — case-sensitive.
const CLIP_IDLE = 'Idle'
const CLIP_TALK = 'Talk'
const NPC_NAME = 'Captain'

let curClip: string | null = null

function setClip(e: Entity, clip: string): void {
  if (curClip === clip) return
  curClip = clip
  const a = Animator.getMutable(e)
  for (const s of a.states) s.playing = s.clip === clip
}

let clickHandlerSet = false

/** Captain.glb supplies its own collider; attach the pointer event to the model
 *  entity itself so its collider shape receives the tap/click. */
function ensureClickHandler(captain: Entity): void {
  if (clickHandlerSet) return
  clickHandlerSet = true
  pointerEventsSystem.onPointerDown(
    { entity: captain, opts: { button: InputAction.IA_POINTER, hoverText: 'Talk to the Captain', maxDistance: 16, showHighlight: true } },
    () => {
      // Never open over an existing dialog — openDialog replaces clientState.dialog
      // wholesale, so stacking would drop the other dialog's onDone.
      if (clientState.dialog.open) return
      openDialog(
        NPC_NAME,
        [
          'The Legendary species are vanishing. Our mission: fill this ark with 100 Legendary pets to save them. Breed a Legendary, bring it to me, and I\'ll reward you with a wearable you can wear across other scenes too.'
        ],
        "Let's do it!"
      )
    }
  )
}

export function setupCaptain(): void {
  engine.addSystem(() => {
    const e = engine.getEntityOrNullByName(EntityNames.Captain_glb)
    if (!e || !Transform.has(e)) return // not loaded yet
    ensureClickHandler(e)
    if (Animator.has(e)) {
      const talking = clientState.dialog.open && clientState.dialog.npcName === NPC_NAME
      setClip(e, talking ? CLIP_TALK : CLIP_IDLE)
    }
  })
}
