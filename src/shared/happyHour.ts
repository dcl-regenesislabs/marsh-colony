import { EntityNames } from '../../assets/scene/entity-names'
import type { PlayerData } from './types'

export const HAPPY_HOUR = {
  durationMinutes: 60,
  spawnMinutes: 10,
  model: 'assets/Models/Mushroom_02.glb',
  entityNames: [EntityNames.Mushroom_event, EntityNames.Mushroom_event_2, EntityNames.Mushroom_event_3, EntityNames.Mushroom_event_4, EntityNames.Mushroom_event_5]
}
export type MushroomEventSchedule = readonly number[] // scheduled event starts, epoch ms
export interface HappyHourView {
  wave: number // the scheduled start: activation ID, stable throughout the hour
  serverNow: number
  endsAt: number
  available: number[]
  respawnsAt: Record<number, number>
}
export function mushroomEventEligible(p: Pick<PlayerData, 'firstSessionStep'>): boolean {
  return p.firstSessionStep === undefined || p.firstSessionStep === 'done'
}
export function happyHourWindow(now: number, schedule: MushroomEventSchedule | null): { wave: number; endsAt: number } | null {
  const duration = HAPPY_HOUR.durationMinutes * 60000
  let wave = 0
  // Overlapping entries: the latest start wins and opens a fresh hour.
  for (const start of schedule ?? []) {
    if (start > wave && start <= now && now < start + duration) wave = start
  }
  return wave ? { wave, endsAt: wave + duration } : null
}
export function happyHourView(p: PlayerData, now: number, schedule: MushroomEventSchedule | null,
  slots: number[] = HAPPY_HOUR.entityNames.map((_, i) => i)): HappyHourView | null {
  if (!mushroomEventEligible(p) || slots.length === 0) return null
  const window = happyHourWindow(now, schedule)
  if (!window) return null
  const available: number[] = []
  const respawnsAt: Record<number, number> = {}
  for (const slot of slots) {
    const pickedAt = p.counters[`happyHour:${slot}`] ?? 0
    const respawn = pickedAt + HAPPY_HOUR.spawnMinutes * 60000
    if (pickedAt >= window.wave && respawn > now) respawnsAt[slot] = respawn
    else available.push(slot)
  }
  return { ...window, serverNow: now, available, respawnsAt }
}
