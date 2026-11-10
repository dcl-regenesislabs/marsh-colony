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
  // A start inside an hour that is already running is ignored. Otherwise it
  // would open a fresh hour and reset every pick cooldown (each pick is an
  // instant Adult), e.g. the manual flag used during a scheduled event.
  let end = -Infinity
  for (const start of [...(schedule ?? [])].sort((a, b) => a - b)) {
    if (start > now) break
    if (start < end) continue
    end = start + duration
    if (now < end) return { wave: start, endsAt: end }
  }
  return null
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
