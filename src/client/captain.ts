// The space Caretaker at the foot of the Ark's ramp (Captain.glb). Players hand
// their Adult pets to the Captain to fill the Ark (issue #248): the first tap of
// a session explains the goal, later taps go straight to the donation panel.
// Swaps its Idle/Talk clips while talking — mirrors caretaker.ts, but with no
// intro lock (it's an optional NPC).

import { engine, Entity, Transform, Animator, AudioSource, pointerEventsSystem, InputAction } from '@dcl/sdk/ecs'
import { EntityNames } from '../../assets/scene/entity-names'
import { clientState, openDialog, pushToast, CAPTAIN_NPC_NAME } from './state'
import { canQueueCareAction } from './pet'
import { playerName } from './ui/dialog'
import { ui } from './ui'

const TALK_SOUND = 'assets/sounds/AlienNod.mp3'
let talkSfx: Entity | null = null

function playTalkSound(): void {
  if (!talkSfx) {
    talkSfx = engine.addEntity()
    Transform.create(talkSfx, {})
    AudioSource.create(talkSfx, { audioClipUrl: TALK_SOUND, playing: false, global: true, volume: 0.6 })
  }
  AudioSource.playSound(talkSfx, TALK_SOUND)
}

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
let introShownThisSession = false

function captainIntro(): string[] {
  const s = clientState.ark.status
  return [
    `Welcome aboard, ${playerName()}! This Ark will carry our companions to a new colony among the stars.`,
    'Bring me an Adult pet and it will board the Ark. Rarer pets earn you more XP and coins — and your very first donation earns you the Caretaker Head wearable!',
    `When ${s.goal} pets are aboard, the Ark launches and everyone who sent a pet receives a special wearable. ${s.donated} / ${s.goal} aboard so far!`
  ]
}

/** Captain.glb supplies its own collider; attach the pointer event to the model
 *  entity itself so its collider shape receives the tap/click. */
function ensureClickHandler(captain: Entity): void {
  if (clickHandlerSet) return
  clickHandlerSet = true
  pointerEventsSystem.onPointerDown(
    { entity: captain, opts: { button: InputAction.IA_POINTER, hoverText: 'Talk to the Captain', maxDistance: 16, showHighlight: true } },
    () => {
      // Never open over an existing dialog (openDialog replaces clientState.dialog
      // wholesale, dropping the other dialog's onDone), an Ark cinematic, or a
      // donation still waiting on the server.
      if (clientState.dialog.open || clientState.ark.cinematic !== 'none' || clientState.ark.pendingDonation) return
      // Nor over an active activity (Pepito chase / feed / carry / breeding /
      // sickness errand) — its pet would board the Ark mid-flow. A sleeping
      // active pet is fine: the player can still donate another one.
      if (!canQueueCareAction() && !clientState.activePet?.sleeping) {
        pushToast('Finish what your pet is doing first!')
        return
      }
      playTalkSound()
      if (introShownThisSession) {
        ui.openArkDonate()
        return
      }
      openDialog(CAPTAIN_NPC_NAME, captainIntro(), 'Choose a pet', () => {
        introShownThisSession = true
        ui.openArkDonate()
      })
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
