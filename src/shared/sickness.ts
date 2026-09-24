// Shared world-space anchors for the sickness quest. The client uses the table
// position to spawn the runtime props; the authoritative server uses the same
// center to verify that a cure attempt actually began at the Care Center.

export const SICKNESS_TABLE_POSITION = { x: 159.75, y: 0.4, z: 251.25 }
export const SICKNESS_CARE_CENTER_RADIUS = 8
