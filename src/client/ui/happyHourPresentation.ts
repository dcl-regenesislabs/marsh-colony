import type { clientState } from '../state'

type PresentationState = Pick<typeof clientState,
  'firstSession' | 'dialog' | 'ark' | 'arkRedeem' | 'wearableReward' | 'reward' | 'screenFade'>

/** Keep the event pending through the whole Captain/Ark flow, including the
 * server response gap, reward cards and queued wearable acknowledgement. */
export function canPresentHappyHour(s: PresentationState, modalOpen: boolean, cinematic: boolean, petActivity: boolean, now = Date.now()): boolean {
  return !s.firstSession && !modalOpen && !cinematic && !petActivity && !s.dialog.open &&
    !s.arkRedeem.active && !s.ark.pendingDonation && s.ark.cinematic === 'none' &&
    !s.ark.thanks && !s.ark.launchCard && !s.wearableReward &&
    !(s.reward && s.reward.until > now) && s.screenFade.alpha <= 0
}

/** Update from the runtime system, never from render. A stale snapshot only
 * hides the UI; it must not undo a player's dismissal of the same activation. */
export function createHappyHourPresentation() {
  let eventEndsAt = 0
  let dismissed = false
  return {
    sync(endsAt: number | null): void {
      if (endsAt !== null && endsAt !== eventEndsAt) { eventEndsAt = endsAt; dismissed = false }
    },
    isDismissed: () => dismissed,
    dismiss: () => { dismissed = true },
    open: () => { dismissed = false }
  }
}
