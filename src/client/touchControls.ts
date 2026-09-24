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
  resetTouchControlRequests()
}

export function applyFruitGameTouchControls(): void {
  TouchScreenControls.hideAll()
  TouchScreenControls.hideJoystick()
  TouchScreenControls.hideCrosshair()
  resetTouchControlRequests()
}

// The Fetch minigame's mobile Throw button: IA_PRIMARY (E on desktop, one of
// the UNUSED_SCENE_TOUCH_BUTTONS above so it's hidden everywhere else) is
// repurposed as a native on-screen gamepad button with a custom icon while
// Fetch mode is open (same icon throughout — see play.ts's
// fetchTouchInputSystem). The joystick/crosshair are left alone — the player
// can still walk/aim around while charging.
export const FETCH_TOUCH_ACTION = InputAction.IA_PRIMARY
// Primary/Secondary occupy the two direct native arc buttons after Pointer.
// Fetch and Pepito reuse them only while companion controls are hidden.
export const PET_FOLLOW_TOUCH_ACTION = InputAction.IA_PRIMARY
export const PET_ACTIONS_TOUCH_ACTION = InputAction.IA_SECONDARY
// With exactly these three numbered actions visible, Explorer's native "+"
// overflow presents a compact 1 / 2 / 3 menu for scene navigation.
export const NAV_ROSTER_TOUCH_ACTION = InputAction.IA_ACTION_3
export const NAV_INVENTORY_TOUCH_ACTION = InputAction.IA_ACTION_4
export const NAV_GOALS_TOUCH_ACTION = InputAction.IA_ACTION_5

const WHISTLE_ICON = 'assets/images/whistle_icon.png'
const STOP_ICON = 'assets/images/stop_icon.png'
const ROSTER_ICON = 'assets/images/revamp/pets_icon.png'
const INVENTORY_ICON = 'assets/images/revamp/inventory_icon.png'
const GOALS_ICON = 'assets/images/revamp/star_icon.png'

const MANAGED_TOUCH_ACTIONS = [
  InputAction.IA_PRIMARY,
  InputAction.IA_SECONDARY,
  InputAction.IA_ACTION_3,
  InputAction.IA_ACTION_4,
  InputAction.IA_ACTION_5,
  InputAction.IA_ACTION_6
]

type PetTouchControlRequest = {
  following: boolean
  petIcon: string
  key: string
}

type TouchControlLayout = {
  key: string
  petControlsVisible: boolean
  buttons: Array<{ action: InputAction; icon: string }>
}

// Systems request their desired controls here. Only reconcileTouchControls()
// writes TouchScreenControls, so exiting one mode cannot erase the layout that
// another system restored earlier in the same frame.
let petTouchControlRequest: PetTouchControlRequest | null = null
let fetchTouchButtonIcon: string | null = null
let rockTouchButtonIcon: string | null = null
let petTouchControlsVisible = false
let appliedTouchControlLayoutKey = ''

function resetTouchControlRequests(): void {
  petTouchControlRequest = null
  fetchTouchButtonIcon = null
  rockTouchButtonIcon = null
  petTouchControlsVisible = false
  appliedTouchControlLayoutKey = ''
}

function requestedTouchControlLayout(): TouchControlLayout {
  // Fetch and Pepito are mutually exclusive in normal play. Prioritizing them
  // nevertheless makes this safe if a future flow momentarily requests both.
  if (fetchTouchButtonIcon) {
    return {
      key: `fetch|${fetchTouchButtonIcon}`,
      petControlsVisible: false,
      buttons: [{ action: FETCH_TOUCH_ACTION, icon: fetchTouchButtonIcon }]
    }
  }

  if (rockTouchButtonIcon) {
    return {
      key: `rock|${rockTouchButtonIcon}`,
      petControlsVisible: false,
      buttons: [{ action: ROCK_TOUCH_ACTION, icon: rockTouchButtonIcon }]
    }
  }

  if (petTouchControlRequest) {
    const { following, petIcon, key } = petTouchControlRequest
    return {
      key: `pet|${key}`,
      petControlsVisible: true,
      buttons: [
        { action: PET_FOLLOW_TOUCH_ACTION, icon: following ? STOP_ICON : WHISTLE_ICON },
        { action: PET_ACTIONS_TOUCH_ACTION, icon: petIcon },
        { action: NAV_ROSTER_TOUCH_ACTION, icon: ROSTER_ICON },
        { action: NAV_INVENTORY_TOUCH_ACTION, icon: INVENTORY_ICON },
        { action: NAV_GOALS_TOUCH_ACTION, icon: GOALS_ICON }
      ]
    }
  }

  return { key: 'none', petControlsVisible: false, buttons: [] }
}

/** Replaces all scene-owned slots together while preserving the Explorer's
 * joystick, crosshair and unrelated control configuration. */
function reconcileTouchControls(): void {
  const layout = requestedTouchControlLayout()
  petTouchControlsVisible = layout.petControlsVisible
  if (layout.key === appliedTouchControlLayoutKey) return

  const value = TouchScreenControls.getOrNull(engine.RootEntity)
  const managedActions = new Set<InputAction>(MANAGED_TOUCH_ACTIONS)
  const icons = new Map<InputAction, string>(layout.buttons.map((button) => [button.action, button.icon]))
  const touchInputs = (value?.touchInputs ?? [])
    .filter((touchInput) => !managedActions.has(touchInput.inputAction))
    .map((touchInput) => ({ ...touchInput }))

  for (const action of MANAGED_TOUCH_ACTIONS) {
    const icon = icons.get(action)
    touchInputs.push(icon
      ? { inputAction: action, hide: false, icon: Material.Texture.Common({ src: icon }) }
      : { inputAction: action, hide: true })
  }

  TouchScreenControls.createOrReplace(engine.RootEntity, {
    touchInputs,
    mainAction: value?.mainAction,
    hideJoystick: value?.hideJoystick ?? false,
    hideCrosshair: value?.hideCrosshair ?? false
  })
  appliedTouchControlLayoutKey = layout.key
}

/** Show the Fetch Throw button with the given icon (swap as charge/busy state changes). */
export function showFetchTouchButton(iconSrc: string): void {
  fetchTouchButtonIcon = iconSrc
  reconcileTouchControls()
}

/** Hide the Fetch Throw button again (back to this scene's normal default). */
export function hideFetchTouchButton(): void {
  fetchTouchButtonIcon = null
  reconcileTouchControls()
}

/** Whether the companion controls are installed in the native mobile HUD. */
export function petTouchControlsAreVisible(): boolean {
  return petTouchControlsVisible
}

/** Show the direct companion controls plus the three native overflow entries. */
export function showPetTouchControls(following: boolean, petIcon: string): void {
  const key = `${following ? 'follow' : 'stay'}|${petIcon}`
  petTouchControlRequest = { following, petIcon, key }
  reconcileTouchControls()
}

/** Hide the companion request. Fetch or Pepito remains visible when active. */
export function hidePetTouchControls(): void {
  petTouchControlRequest = null
  reconcileTouchControls()
}

// Pepito's chase uses the secondary direct slot. The reconciler keeps it
// exclusive with Fetch and the normal companion layout.
export const ROCK_TOUCH_ACTION = InputAction.IA_SECONDARY

export function showRockTouchButton(iconSrc: string): void {
  rockTouchButtonIcon = iconSrc
  reconcileTouchControls()
}

export function hideRockTouchButton(): void {
  rockTouchButtonIcon = null
  reconcileTouchControls()
}
