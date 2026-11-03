const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const vm = require('node:vm')

function load(file, mocks = {}, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText, { ...globals, exports, console: { log() {} }, require: name => {
    if (name in mocks) return mocks[name]
    throw new Error(`Unexpected import ${name}`)
  } })
  return exports
}
const shared = () => load('src/shared/happyHour.ts')
const start = Date.parse('2026-11-03T18:00:00Z')

test('one global hour: boundaries, stable activation ID, no daily repetition', () => {
  const { happyHourWindow: window } = shared()
  const event = { enabled: true, startedAt: start }
  assert.equal(window(start, null), null)
  assert.equal(window(start, { ...event, enabled: false }), null)
  assert.equal(window(start - 1, event), null)
  assert.equal(window(start, event).wave, start)
  assert.equal(window(start + 599999, event).wave, start)
  assert.equal(window(start + 600000, event).wave, start)
  assert.equal(window(start + 3599999, event).endsAt, start + 3600000)
  assert.equal(window(start + 3600000, event), null)
  assert.equal(window(start + 86400000, event), null)
})

test('every incomplete tutorial checkpoint hides the event; done immediately sees remaining global time', () => {
  const { happyHourView: view } = shared()
  const event = { enabled: true, startedAt: start }
  const steps = fs.readFileSync('src/shared/types.ts', 'utf8')
  const block = steps.match(/export const FIRST_SESSION_STEPS[^=]*=\s*\[([\s\S]*?)\]/)[1]
  const checkpoints = [...block.matchAll(/'([^']+)'/g)].map(m => m[1])
  assert.ok(checkpoints.includes('done'))
  const p = { firstSessionStep: 'intro', pets: [], counters: {} }
  for (const step of checkpoints.filter(s => s !== 'done')) {
    p.firstSessionStep = step
    assert.equal(view(p, start + 1200000, event), null, step)
  }
  p.firstSessionStep = 'done'
  assert.equal(view(p, start + 1200000, event).available.length, 5)
  assert.equal(view(p, start + 1200000, event).endsAt, start + 3600000)
  assert.equal(view(p, start + 3600000, event), null)
  delete p.firstSessionStep // migrated accounts already completed/skipped onboarding
  assert.ok(view(p, start, event))
})

test('individual cooldown survives reconnect and lasts ten minutes from collection', () => {
  const { happyHourView: view } = shared()
  const event = { enabled: true, startedAt: start }
  const p = { firstSessionStep: 'done', counters: { 'happyHour:2': start + 599999 } }
  assert.equal(view(p, start + 599999, event).available.includes(2), false)
  assert.equal(view(JSON.parse(JSON.stringify(p)), start + 600000, event).available.includes(2), false)
  assert.equal(view(p, start + 600000, event).available.length, 4)
  assert.equal(view(p, start + 1199999, event).available.length, 5)
})

function controllerFixture() {
  let now = start, flag = 'false', stored = null, reads = 0, writes = 0, fail = false
  const { createMushroomEventController: create } = load('src/server/mushroomEvent.ts', {
    '@dcl/sdk/server': { EnvVar: {}, Storage: {} }
  })
  const deps = { now: () => now, flag: async () => flag,
    read: async () => { reads++; if (fail) throw new Error('storage unavailable'); return stored },
    write: async value => { writes++; stored = value; return true } }
  return { create: () => create(deps), step: () => { now += 5001 },
    flag: value => { flag = value }, fail: () => { fail = true },
    stored: () => stored, reads: () => reads, writes: () => writes }
}

test('live flag starts one persisted hour for everyone, survives restarts and only rearms after false', async () => {
  const f = controllerFixture(), c = f.create()
  await c.refresh()
  assert.equal(c.state().enabled, false)
  f.flag('true'); f.step()
  await Promise.all([c.refresh(), c.refresh(), c.refresh()])
  const startedAt = c.state().startedAt
  assert.equal(c.state().enabled, true)
  assert.equal(f.writes(), 2) // initial off + one activation
  f.step(); await c.refresh()
  assert.equal(c.state().startedAt, startedAt)
  const restarted = f.create()
  await restarted.refresh()
  assert.equal(restarted.state().startedAt, startedAt)
  assert.equal(f.writes(), 2)
  f.flag('false'); f.step(); await restarted.refresh()
  assert.equal(restarted.state().enabled, false)
  f.flag('true'); f.step(); await restarted.refresh()
  assert.ok(restarted.state().startedAt > startedAt)
})

test('poll is throttled and read failures cannot manufacture/restart an event', async () => {
  const f = controllerFixture(), c = f.create()
  f.flag('true'); await c.refresh()
  const startedAt = c.state().startedAt
  await c.refresh(); assert.equal(f.reads(), 1)
  f.fail(); f.step(); await c.refresh()
  assert.equal(c.state().startedAt, startedAt)
  const restart = f.create(); await restart.refresh()
  assert.equal(restart.state(), null)
})

test('tutorial and event model are self-contained GLBs, not the broken external-texture asset', () => {
  const { HAPPY_HOUR } = shared()
  const bytes = fs.readFileSync(HAPPY_HOUR.model)
  const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)))
  assert.ok(gltf.images.length)
  assert.ok(gltf.images.every(image => image.bufferView !== undefined || image.uri?.startsWith('data:')))
  const scene = JSON.parse(fs.readFileSync('assets/scene/main.composite', 'utf8'))
  const names = scene.components.find(c => c.name === 'core-schema::Name').data
  const [id] = Object.entries(names).find(([, v]) => v.json.value === 'Gypsy mushroom')
  assert.equal(scene.components.find(c => c.name === 'core::GltfContainer').data[id].json.src, HAPPY_HOUR.model)
})

test('an empty environment response cannot stop and then silently restart a running hour', async () => {
  const f = controllerFixture(), c = f.create()
  f.flag('true'); await c.refresh()
  const startedAt = c.state().startedAt
  f.flag(''); f.step(); await c.refresh()
  assert.equal(c.state().startedAt, startedAt)
  assert.equal(c.state().enabled, true)
  f.flag('true'); f.step(); await c.refresh()
  assert.equal(c.state().startedAt, startedAt)
  assert.equal(f.writes(), 1)
})

test('the five actual Creator Hub mushrooms resolve in stable slot order without fallback positions', () => {
  const { HAPPY_HOUR } = shared()
  const scene = JSON.parse(fs.readFileSync('assets/scene/main.composite', 'utf8'))
  const names = scene.components.find(c => c.name === 'core-schema::Name').data
  const transforms = scene.components.find(c => c.name === 'core::Transform').data
  const ids = HAPPY_HOUR.entityNames.map(name => {
    const match = Object.entries(names).find(([, v]) => v.json.value === name)
    assert.ok(match, name)
    return Number(match[0])
  })
  const { resolveMushroomPositions, mushroomPlacements } = load('src/shared/mushroomPlacement.ts', {
    './happyHour': { HAPPY_HOUR },
    '@dcl/sdk/ecs': {
      engine: { getEntityOrNullByName: name => ids[HAPPY_HOUR.entityNames.indexOf(name)] ?? null },
      Transform: { has: () => true },
      getWorldPosition: (_, id) => transforms[id].json.position
    }
  })
  resolveMushroomPositions()
  assert.equal(mushroomPlacements.size, 5)
  for (let slot = 0; slot < 5; slot++) {
    assert.equal(mushroomPlacements.get(slot).entity, ids[slot])
    assert.equal(mushroomPlacements.get(slot).position.x, transforms[ids[slot]].json.position.x)
    assert.equal(mushroomPlacements.get(slot).position.y, transforms[ids[slot]].json.position.y)
  }
  assert.equal(HAPPY_HOUR.positions, undefined)
})

test('placed models, tap targets and effects hide during tutorial/off/cooldown and return on refresh', () => {
  const modelVisibility = new Map(), colliders = new Set(), glows = [], gltf = new Map()
  let system, nextEntity = 100
  const placements = new Map(Array.from({ length: 5 }, (_, slot) => [slot, {
    entity: slot + 1, position: { x: 120 + slot, y: slot * 0.25, z: 260 }
  }]))
  for (const { entity } of placements.values()) gltf.set(entity, {})
  const state = { serverReady: true, firstSession: true, player: { firstSessionStep: 'grow' } }
  let deviceTime = start + 86400000
  const { setupHappyHour, receiveHappyHour, happyHourStatus } = load('src/client/happyHour.ts', {
    '../shared/mushroomPlacement': { resolveMushroomPositions() {}, mushroomPlacements: placements },
    '../shared/happyHour': shared(),
    '../shared/messages': { room: { send() {} } },
    './state': { clientState: state, pushToast() {} },
    './i18n': { t: key => key, onLanguageChanged() {} },
    './mushroomGlow': { createMushroomGlow: () => {
      const glow = { visible: false, update(_, visible) { this.visible = visible } }
      glows.push(glow); return glow
    } },
    '../shared/config': { petStage() {} },
    '@dcl/sdk/ecs': {
      engine: { addEntity: () => nextEntity++, addSystem: fn => { system = fn } },
      Transform: { create() {} },
      GltfContainer: { getMutableOrNull: entity => gltf.get(entity) },
      VisibilityComponent: { createOrReplace: (entity, value) => modelVisibility.set(entity, value.visible) },
      MeshCollider: { setBox: entity => colliders.add(entity), deleteFrom: entity => colliders.delete(entity) },
      pointerEventsSystem: { removeOnPointerDown() {}, onPointerDown() {} },
      ColliderLayer: { CL_NONE: 0, CL_POINTER: 2 }, InputAction: { IA_POINTER: 0 }
    }
  }, { Date: { now: () => deviceTime } })
  setupHappyHour()
  const view = { serverNow: start, endsAt: start + 3600000, wave: start, available: [0, 1, 2, 3, 4], respawnsAt: {} }
  receiveHappyHour(view); system(0.1)
  assert.ok([...modelVisibility.values()].every(v => !v))
  assert.equal(colliders.size, 0)
  state.firstSession = false; state.player.firstSessionStep = 'done'; system(0.1)
  assert.ok([...modelVisibility.values()].every(Boolean))
  assert.equal(colliders.size, 5)
  assert.ok(glows.every(g => g.visible))
  receiveHappyHour({ ...view, available: [1, 2, 3, 4] }); system(0.1)
  assert.equal(modelVisibility.get(1), false)
  assert.equal(colliders.size, 4)
  assert.equal(glows[0].visible, false)
  receiveHappyHour({ ...view, wave: view.wave + 600000 }); system(0.1)
  assert.equal(modelVisibility.get(1), true)
  assert.equal(colliders.size, 5)
  assert.ok(happyHourStatus().remaining > 3599000)
  const remaining = happyHourStatus().remaining
  deviceTime -= 3 * 86400000
  assert.equal(happyHourStatus().remaining, remaining)
  receiveHappyHour({ ...view, serverNow: view.endsAt - 1000 }); system(2)
  assert.equal(happyHourStatus(), null)
  receiveHappyHour(null); system(0.1)
  assert.ok([...modelVisibility.values()].every(v => !v))
  assert.equal(colliders.size, 0)
  assert.ok(glows.every(g => !g.visible))
})

test('missing mushrooms do not inflate availability; previous events do not carry a cooldown', () => {
  const { happyHourView: view } = shared()
  const p = { firstSessionStep: 'done', counters: { 'happyHour:0': start - 1000 } }
  const result = view(p, start, { enabled: true, startedAt: start }, [0, 3])
  assert.deepEqual(Array.from(result.available), [0, 3])
  assert.equal(Object.keys(result.respawnsAt).length, 0)
  p.counters['happyHour:3'] = start
  const cooling = view(p, start, { enabled: true, startedAt: start }, [0, 3])
  assert.equal(cooling.available.length, 1)
  assert.equal(cooling.respawnsAt[3], start + 600000)
})

test('growth is not applied on receipt-write failure and is recoverable after a crash before player save', async () => {
  let disk = null, writesSucceed = false
  const { createMushroomRewards: create } = load('src/server/mushroomRewards.ts', {
    '@dcl/sdk/server': { Storage: {} }, '../shared/config': { SIZE_MAX: 3 }
  })
  const deps = { read: async () => disk,
    write: async (_, receipts) => { if (!writesSucceed) return false; disk = JSON.parse(JSON.stringify(receipts)); return true } }
  const player = () => ({ address: '0xplayer', counters: {}, pets: [{ id: 'baby', size: 1, careCount: 2 }] })
  const p = player(), rewards = create(deps)
  await rewards.recover(p)
  const receipt = { petId: 'baby', slot: 2, pickedAt: start + 599999 }
  assert.equal(await rewards.grant(p, receipt), false)
  assert.equal(p.pets[0].size, 1)
  assert.equal(p.counters['happyHour:2'], undefined)
  writesSucceed = true
  assert.equal(await rewards.grant(p, receipt), true)
  assert.equal(p.pets[0].size, 3)
  // Only the receipt reached storage: the ordinary player save was lost.
  const reconnected = player()
  await create(deps).recover(reconnected)
  assert.equal(reconnected.pets[0].size, 3)
  assert.equal(reconnected.pets[0].careCount, 70)
  assert.equal(reconnected.counters['happyHour:2'], receipt.pickedAt)
  // Replaying the journal is idempotent and never regresses a newer cooldown.
  reconnected.counters['happyHour:2'] = receipt.pickedAt + 1000
  await create(deps).recover(reconnected)
  assert.equal(reconnected.counters['happyHour:2'], receipt.pickedAt + 1000)
})

test('event waits through Captain dialog, donation response, animation, reward and wearable closure', () => {
  const { canPresentHappyHour: show } = load('src/client/ui/happyHourPresentation.ts')
  const s = { firstSession: true, dialog: { open: true },
    ark: { pendingDonation: null, cinematic: 'none', thanks: null, launchCard: null },
    arkRedeem: { active: false }, wearableReward: null, reward: null, screenFade: { alpha: 0 } }
  assert.equal(show(s, false, false, start), false)
  s.firstSession = false // talking to Captain completed the tutorial
  assert.equal(show(s, false, false, start), false)
  s.dialog.open = false
  s.arkRedeem.active = true // confirm / approach
  assert.equal(show(s, false, false, start), false)
  s.arkRedeem.active = false; s.ark.pendingDonation = {}
  assert.equal(show(s, false, false, start), false) // await authoritative result
  s.ark.pendingDonation = null; s.ark.cinematic = 'handover'
  assert.equal(show(s, false, false, start), false)
  s.ark.cinematic = 'none'; s.ark.thanks = {}
  assert.equal(show(s, false, false, start), false)
  s.ark.thanks = null; s.wearableReward = { shownAt: 0 }
  assert.equal(show(s, false, false, start), false) // reward queued, not just visible
  s.wearableReward = null; s.reward = { until: start + 2000 }
  assert.equal(show(s, false, false, start), false)
  assert.equal(show(s, false, false, start + 2001), true)
  assert.equal(show(s, true, false, start + 2001), false)
  assert.equal(show(s, false, true, start + 2001), false)
  s.screenFade.alpha = 0.1
  assert.equal(show(s, false, false, start + 2001), false)
  s.screenFade.alpha = 0; s.ark.launchCard = [{}]
  assert.equal(show(s, false, false, start + 2001), false)
  s.ark.launchCard = null
  assert.equal(show(s, false, false, start + 2001), true)
})
