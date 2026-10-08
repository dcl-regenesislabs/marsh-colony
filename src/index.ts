import { engine, SkyboxTime } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'

export async function main() {
  if (isServer()) {
    // Headless authoritative server: state, validation, decay, persistence.
    const { server } = await import('./server/server')
    server()
    return
  }

  // Client: UI, pet rendering, input, and message handling.
  SkyboxTime.createOrReplace(engine.RootEntity, { fixedTime: 36000 })
  const { setupClient } = await import('./client/setup')
  setupClient()
}
