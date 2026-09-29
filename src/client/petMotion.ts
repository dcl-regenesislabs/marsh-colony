// Per-entity locomotion state. A pet's target can change every frame (follow,
// wandering, wall navigation), so a Tween would be constantly recreated.
// Retaining only its scalar speed gives us natural acceleration and braking
// while each caller remains responsible for its route.

import type { Entity } from '@dcl/sdk/ecs'
import * as C from '../shared/config'

const speeds = new Map<Entity, number>()

/** Clear momentum when a pet reaches its target or stops for an interaction. */
export function stopPetMotion(entity: Entity): void {
  speeds.delete(entity)
}

/**
 * Return this frame's step length using a capped acceleration curve. The
 * stopping-speed equation means the pet begins braking at the distance where
 * it can comfortably reach the arrival radius rather than overshooting it.
 */
export function petMotionStep(entity: Entity, distance: number, dt: number, maxSpeed: number): number {
  const remaining = Math.max(0, distance - C.PET_ARRIVE_DISTANCE)
  if (remaining <= 0 || dt <= 0) {
    stopPetMotion(entity)
    return 0
  }

  const currentSpeed = speeds.get(entity) ?? 0
  const brakingLimitedSpeed = Math.sqrt(2 * C.PET_MOVE_BRAKING * remaining)
  const targetSpeed = Math.min(maxSpeed, brakingLimitedSpeed)
  const rate = targetSpeed >= currentSpeed ? C.PET_MOVE_ACCELERATION : C.PET_MOVE_BRAKING
  const nextSpeed = currentSpeed + Math.sign(targetSpeed - currentSpeed) * Math.min(Math.abs(targetSpeed - currentSpeed), rate * dt)
  speeds.set(entity, nextSpeed)
  return Math.min(distance, nextSpeed * dt)
}
