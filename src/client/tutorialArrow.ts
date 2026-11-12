// Pure rules for the tutorial's green arrow, kept free of engine imports so
// they can be unit tested.

import type { FirstSessionStep } from '../shared/types'

export type GuideArrowGoal = 'mushroom' | 'captain'

export interface GuideArrowState {
  active: boolean
  step: FirstSessionStep
  growIntroDone: boolean
  mushroomEaten: boolean
  mushroomPopping: boolean
  captainHeard: boolean
  dialogOpen: boolean
}

/** What the tutorial's arrow points at right now, or null for no arrow. */
export function guideArrowGoal(s: GuideArrowState): GuideArrowGoal | null {
  if (!s.active) return null
  if (s.step === 'grow' && s.growIntroDone && !s.mushroomEaten && !s.mushroomPopping) return 'mushroom'
  // Last step: many players never found the Ark, so the tutorial never ended.
  if (s.step === 'captain' && !s.captainHeard && !s.dialogOpen) return 'captain'
  return null
}

/** The sticky tutorial card text. While the tutorial's own arrow is up, the
 *  step's objective names the destination ("Go talk to the Captain at the
 *  Ark"), so it beats the generic "Follow the green arrow" route text. Other
 *  routes (feed tree, care center...) keep their own route text. */
export function tutorialCardText(task: string, route: string, tutorialArrow: boolean): string {
  if (tutorialArrow && task) return task
  return route || task
}
