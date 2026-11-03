import type { PlayerData } from './types'

export const HAPPY_HOUR = {
  durationMinutes: 60,
  spawnMinutes: 10,
  model: 'assets/Models/Mushroom_02.glb',
  entityNames: ['Mushroom_event', 'Mushroom_event_2', 'Mushroom_event_3', 'Mushroom_event_4', 'Mushroom_event_5']
}
export interface MushroomEventState { enabled: boolean; startedAt: number }
export interface HappyHourView {
  wave: number // activation ID, stable throughout the hour (message compatibility)
  serverNow: number
  endsAt: number
  available: number[]
  respawnsAt: Record<number, number>
}
export function mushroomEventEligible(p: Pick<PlayerData, 'firstSessionStep'>): boolean {
  return p.firstSessionStep === undefined || p.firstSessionStep === 'done'
}
export function happyHourWindow(now: number, event: MushroomEventState | null): { wave: number; endsAt: number } | null {
  if (!event?.enabled || !Number.isFinite(event.startedAt) || event.startedAt <= 0) return null
  const endsAt = event.startedAt + HAPPY_HOUR.durationMinutes * 60000
  if (now < event.startedAt || now >= endsAt) return null
  return { wave: event.startedAt, endsAt }
}
export function happyHourView(p: PlayerData, now: number, event: MushroomEventState | null,
  slots: number[] = HAPPY_HOUR.entityNames.map((_, i) => i)): HappyHourView | null {
  if (!mushroomEventEligible(p)) return null
  const window = happyHourWindow(now, event)
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
