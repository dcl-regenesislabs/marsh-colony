// The space Caretaker aboard the ark (Captain.glb). Taps open a small teaser
// dialog and swap its Idle/Talk clips while talking — mirrors caretaker.ts, but
// with no intro lock (it's an optional, flavour NPC).

import { engine, Entity, Transform, Animator, pointerEventsSystem, InputAction } from '@dcl/sdk/ecs'
import { EntityNames } from '../../assets/scene/entity-names'
import { clientState, openDialog, CAPTAIN_NPC_NAME } from './state'
import { canStartPetInteraction } from './pet'

// Clip names as authored on Captain.glb (assets/scene/main.composite) — case-sensitive.
const CLIP_IDLE = 'Idle'
const CLIP_TALK = 'Talk'

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
      // Never open over an existing dialog (openDialog replaces clientState.dialog
      // wholesale, dropping the other dialog's onDone), and never over an active
      // activity (Pepito chase / feed / carry / sickness errand) — a stray tap
      // there would hide that flow's own controls behind the dialog. Mirrors
      // caretakerPet.ts's guard.
      if (clientState.dialog.open || !canStartPetInteraction()) return
      openDialog(
        CAPTAIN_NPC_NAME,
        [
          'The Legendary species are vanishing. Our mission: fill this ark with 100 Legendary pets to save them. Breed a Legendary, bring it to me, and I\'ll reward you with a wearable you can wear across other scenes too.'
        ],
        "Let's do it!"
      )
    }
  )
}

export function setupCaptain(): void {
  let captain: Entity | null = null
  engine.addSystem(() => {
    // Resolve the entity once, then keep the reference — no per-frame name scan.
    if (captain === null) {
      const e = engine.getEntityOrNullByName(EntityNames.Captain_glb)
      if (!e || !Transform.has(e)) return // not loaded yet
      captain = e
      ensureClickHandler(captain)
    }
    if (Animator.has(captain)) {
      const talking = clientState.dialog.open && clientState.dialog.npcName === CAPTAIN_NPC_NAME
      setClip(captain, talking ? CLIP_TALK : CLIP_IDLE)
    }
  })
}
