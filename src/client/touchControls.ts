import { engine, InputAction, Material, TouchScreenControls } from '@dcl/sdk/ecs'

const UNUSED_SCENE_TOUCH_BUTTONS = [
  InputAction.IA_PRIMARY,
  InputAction.IA_SECONDARY,
  InputAction.IA_ACTION_3,
  InputAction.IA_ACTION_4,
  InputAction.IA_ACTION_5,
  InputAction.IA_ACTION_6
]

export function applyDefaultTouchControls(): void {
  TouchScreenControls.showAll()
  TouchScreenControls.hide(UNUSED_SCENE_TOUCH_BUTTONS)
  TouchScreenControls.showJoystick()
  TouchScreenControls.showCrosshair()
  petTouchControlsVisible = false
}

export function applyFruitGameTouchControls(): void {
  TouchScreenControls.hideAll()
  TouchScreenControls.hideJoystick()
  TouchScreenControls.hideCrosshair()
  petTouchControlsVisible = false
}

// The Fetch minigame's mobile Throw button: IA_PRIMARY (E on desktop, one of
// the UNUSED_SCENE_TOUCH_BUTTONS above so it's hidden everywhere else) is
// repurposed as a native on-screen gamepad button with a custom icon while
// Fetch mode is open (same icon throughout — see play.ts's
// fetchTouchInputSystem). The joystick/crosshair are left alone — the player
// can still walk/aim around while charging.
export const FETCH_TOUCH_ACTION = InputAction.IA_PRIMARY
export const PET_FOLLOW_TOUCH_ACTION = InputAction.IA_ACTION_3
export const PET_ACTIONS_TOUCH_ACTION = InputAction.IA_ACTION_4

const WHISTLE_ICON = 'assets/images/whistle_icon.png'
const STOP_ICON = 'assets/images/stop_icon.png'

// React-ECS renders each frame, so cache the last native-button configuration.
let petTouchControlsVisible = false
let petTouchControlsKey = ''

/** Merges one custom button's icon/visibility into whatever TouchScreenControls
 *  config is already active. createOrReplace() on this component replaces the
 *  WHOLE value, so this reads the current one first (same read-modify-write
 *  the SDK's own hide()/showJoystick() helpers use internally) to avoid
 *  clobbering joystick/crosshair/other-button state set elsewhere. */
function setTouchButtonIcon(action: InputAction, iconSrc: string | null): void {
  const value = TouchScreenControls.getOrNull(engine.RootEntity)
  const touchInputs = (value?.touchInputs ?? []).map((t) => ({ ...t }))
  const idx = touchInputs.findIndex((t) => t.inputAction === action)
  const entry = { inputAction: action, hide: iconSrc === null, icon: iconSrc ? Material.Texture.Common({ src: iconSrc }) : undefined }
  if (idx >= 0) touchInputs[idx] = entry
  else touchInputs.push(entry)
  TouchScreenControls.createOrReplace(engine.RootEntity, {
    touchInputs,
    mainAction: value?.mainAction,
    hideJoystick: value?.hideJoystick ?? false,
    hideCrosshair: value?.hideCrosshair ?? false
  })
}

/** Show the Fetch Throw button with the given icon (swap as charge/busy state changes). */
export function showFetchTouchButton(iconSrc: string): void {
  setTouchButtonIcon(FETCH_TOUCH_ACTION, iconSrc)
}

/** Hide the Fetch Throw button again (back to this scene's normal default). */
export function hideFetchTouchButton(): void {
  setTouchButtonIcon(FETCH_TOUCH_ACTION, null)
}

/** Whether the companion controls are installed in the native mobile HUD. */
export function petTouchControlsAreVisible(): boolean {
  return petTouchControlsVisible
}

/** Show the tap controls for follow/stay and the active pet's actions. */
export function showPetTouchControls(following: boolean, petIcon: string): void {
  const key = `${following ? 'follow' : 'stay'}|${petIcon}`
  if (petTouchControlsVisible && petTouchControlsKey === key) return

  setTouchButtonIcon(PET_FOLLOW_TOUCH_ACTION, following ? STOP_ICON : WHISTLE_ICON)
  setTouchButtonIcon(PET_ACTIONS_TOUCH_ACTION, petIcon)
  petTouchControlsVisible = true
  petTouchControlsKey = key
}

/** Hide companion controls without affecting joystick, crosshair or Fetch. */
export function hidePetTouchControls(): void {
  if (!petTouchControlsVisible) return
  setTouchButtonIcon(PET_FOLLOW_TOUCH_ACTION, null)
  setTouchButtonIcon(PET_ACTIONS_TOUCH_ACTION, null)
  petTouchControlsVisible = false
  petTouchControlsKey = ''
}

// Pepito's chase uses a separate native button so it can never collide with
// Fetch, even if a future flow accidentally tries to show both at once.
export const ROCK_TOUCH_ACTION = InputAction.IA_SECONDARY

export function showRockTouchButton(iconSrc: string): void {
  setTouchButtonIcon(ROCK_TOUCH_ACTION, iconSrc)
}

export function hideRockTouchButton(): void {
  setTouchButtonIcon(ROCK_TOUCH_ACTION, null)
}
