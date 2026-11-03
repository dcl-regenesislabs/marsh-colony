import type { clientState } from '../state'

type PresentationState = Pick<typeof clientState,
  'firstSession' | 'dialog' | 'ark' | 'arkRedeem' | 'wearableReward' | 'reward' | 'screenFade'>

/** Keep the event pending through the whole Captain/Ark flow, including the
 * server response gap, reward cards and queued wearable acknowledgement. */
export function canPresentHappyHour(s: PresentationState, modalOpen: boolean, cinematic: boolean, now = Date.now()): boolean {
  return !s.firstSession && !modalOpen && !cinematic && !s.dialog.open &&
    !s.arkRedeem.active && !s.ark.pendingDonation && s.ark.cinematic === 'none' &&
    !s.ark.thanks && !s.ark.launchCard && !s.wearableReward &&
    !(s.reward && s.reward.until > now) && s.screenFade.alpha <= 0
}
