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
const shared = () => load('src/shared/happyHour.ts', {
  '../../assets/scene/entity-names': load('assets/scene/entity-names.ts')
})
const start = Date.parse('2026-11-03T18:00:00Z')

test('each scheduled start opens its own hour: boundaries, stable activation ID, latest start wins an overlap', () => {
  const { happyHourWindow: window } = shared()
  const nextDay = start + 86400000, overlap = nextDay + 1800000
  const event = [start, nextDay, overlap]
  assert.equal(window(start, null), null)
  assert.equal(window(start, []), null)
  assert.equal(window(start - 1, event), null)
  assert.equal(window(start, event).wave, start)
  assert.equal(window(start + 600000, event).wave, start)
  assert.equal(window(start + 3599999, event).endsAt, start + 3600000)
  assert.equal(window(start + 3600000, event), null)
  assert.equal(window(nextDay - 1, event), null)
  assert.equal(window(nextDay, event).wave, nextDay)
  assert.equal(window(overlap - 1, event).wave, nextDay)
  assert.equal(window(overlap, event).wave, overlap)
  assert.equal(window(nextDay + 3600000, event).endsAt, overlap + 3600000)
  assert.equal(window(overlap + 3600000, event), null)
})

test('every incomplete tutorial checkpoint hides the event; done immediately sees remaining global time', () => {
  const { happyHourView: view } = shared()
  const event = [start]
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
  const event = [start]
  const p = { firstSessionStep: 'done', counters: { 'happyHour:2': start + 599999 } }
  assert.equal(view(p, start + 599999, event).available.includes(2), false)
  assert.equal(view(JSON.parse(JSON.stringify(p)), start + 600000, event).available.includes(2), false)
  assert.equal(view(p, start + 600000, event).available.length, 4)
  assert.equal(view(p, start + 1199999, event).available.length, 5)
})

function controllerFixture(opts = {}) {
  let now = start, value = '', reads = 0, fail = false
  let flag = '', stored = opts.stored ?? null, storageReads = 0, writes = 0
  const { createMushroomEventController: create } = load('src/server/mushroomEvent.ts', {
    '@dcl/sdk/server': { EnvVar: {}, Storage: {} }
  })
  const deps = { now: () => now,
    schedule: async () => { reads++; if (fail) throw new Error('env unavailable'); return value },
    manualFlag: async () => flag,
    readManual: async () => { storageReads++; return stored },
    writeManual: async next => { writes++; stored = next; return true } }
  let c = create(deps)
  return { refresh: () => c.refresh(), reads: () => reads,
    state: () => c.state() && Array.from(c.state()),
    set: async next => { value = next; fail = false; now += 5001; await c.refresh() },
    fail: async () => { fail = true; now += 5001; await c.refresh() },
    flag: async next => { flag = next; now += 5001; await c.refresh() },
    tick: async ms => { now += ms; await c.refresh() },
    now: () => now, stored: () => stored, storageReads: () => storageReads, writes: () => writes,
    restart: async () => { c = create(deps); now += 5001; await c.refresh() } }
}

test('START_MUSHROOM_EVENT=true opens one hour now as a manual fallback next to the schedule', async () => {
  const { happyHourWindow: window } = shared()
  const f = controllerFixture()
  await f.set('2026-11-10T18:00Z')
  await f.flag('true')
  const manualStart = f.now()
  assert.deepEqual(f.state(), [manualStart, Date.parse('2026-11-10T18:00Z')])
  assert.equal(window(manualStart + 1000, f.state()).wave, manualStart)
  // Leaving the flag on does not re-arm it, and storage is not re-read every poll.
  await f.tick(5001); await f.tick(5001)
  assert.equal(f.writes(), 1)
  assert.equal(f.storageReads(), 1)
  assert.equal(f.state()[0], manualStart)
  // A restart keeps the same manual hour instead of starting a new one.
  await f.restart()
  assert.equal(f.state()[0], manualStart)
  assert.equal(f.writes(), 1)
  // false clears it and the schedule stays; true again opens a fresh hour.
  await f.flag('false')
  assert.deepEqual(f.state(), [Date.parse('2026-11-10T18:00Z')])
  await f.flag('true')
  assert.equal(f.state()[0], f.now())
  // An empty / failed flag read never cancels or re-arms the manual hour.
  const again = f.state()[0]
  await f.flag('')
  assert.equal(f.state()[0], again)
})

test('a manual hour started by the old flag-only version keeps running after deploy', async () => {
  const f = controllerFixture({ stored: { enabled: true, startedAt: start } })
  await f.flag('true')
  assert.deepEqual(f.state(), [start])
  assert.equal(f.writes(), 0)
})

test('schedule lists several date-times; offsets are honoured and a bare time is UTC', async () => {
  const f = controllerFixture()
  assert.equal(f.state(), null)
  await f.set('2026-11-04T15:00-03:00, 2026-11-03T18:00Z 2026-11-05T18:00:30')
  assert.deepEqual(f.state(), [start, start + 86400000, start + 2 * 86400000 + 30000])
})

test('poll is throttled; empty, failed or unparseable reads keep the schedule and only "off" clears it', async () => {
  const f = controllerFixture()
  await f.set('2026-11-03T18:00Z')
  await Promise.all([f.refresh(), f.refresh()])
  assert.equal(f.reads(), 1)
  await f.set('')
  assert.deepEqual(f.state(), [start])
  await f.fail()
  assert.deepEqual(f.state(), [start])
  await f.set('tomorrow at six')
  assert.deepEqual(f.state(), [start])
  await f.set('2026-13-40T18:00Z,2026-11-04T18:00Z')
  assert.deepEqual(f.state(), [start + 86400000])
  await f.set('OFF')
  assert.deepEqual(f.state(), [])
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
    './state': { clientState: state, pushToast() {}, petActivityActive: () => false },
    './i18n': { t: key => key, onLanguageChanged() {} },
    './ui/happyHourPresentation': load('src/client/ui/happyHourPresentation.ts'),
    './mushroomGlow': { createMushroomGlow: () => {
      const glow = { visible: false, update(_, visible) { this.visible = visible }, dispose() { this.visible = false } }
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
  const result = view(p, start, [start], [0, 3])
  assert.deepEqual(Array.from(result.available), [0, 3])
  assert.equal(Object.keys(result.respawnsAt).length, 0)
  p.counters['happyHour:3'] = start
  const cooling = view(p, start, [start], [0, 3])
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
  assert.equal(show(s, false, false, false, start), false)
  s.firstSession = false // talking to Captain completed the tutorial
  assert.equal(show(s, false, false, false, start), false)
  s.dialog.open = false
  s.arkRedeem.active = true // confirm / approach
  assert.equal(show(s, false, false, false, start), false)
  s.arkRedeem.active = false; s.ark.pendingDonation = {}
  assert.equal(show(s, false, false, false, start), false) // await authoritative result
  s.ark.pendingDonation = null; s.ark.cinematic = 'handover'
  assert.equal(show(s, false, false, false, start), false)
  s.ark.cinematic = 'none'; s.ark.thanks = {}
  assert.equal(show(s, false, false, false, start), false)
  s.ark.thanks = null; s.wearableReward = { shownAt: 0 }
  assert.equal(show(s, false, false, false, start), false) // reward queued, not just visible
  s.wearableReward = null; s.reward = { until: start + 2000 }
  assert.equal(show(s, false, false, false, start), false)
  assert.equal(show(s, false, false, false, start + 2001), true)
  assert.equal(show(s, true, false, false, start + 2001), false)
  assert.equal(show(s, false, true, false, start + 2001), false)
  s.screenFade.alpha = 0.1
  assert.equal(show(s, false, false, false, start + 2001), false)
  s.screenFade.alpha = 0; s.ark.launchCard = [{}]
  assert.equal(show(s, false, false, false, start + 2001), false)
  s.ark.launchCard = null
  assert.equal(show(s, false, false, false, start + 2001), true)
})

test('pending or unknown hatchlings never write a receipt or burn a cooldown, including after Keep', async () => {
  let writes = 0
  const { createMushroomRewards: create } = load('src/server/mushroomRewards.ts', {
    '@dcl/sdk/server': { Storage: {} }, '../shared/config': { SIZE_MAX: 3 }
  })
  const rewards = create({ read: async () => [], write: async () => { writes++; return true } })
  const baby = { id: 'pending', size: 1, careCount: 0 }
  const p = { address: 'player', pets: [{ id: 'owned', size: 1, careCount: 0 }], hatchling: baby, counters: {} }
  assert.equal(await rewards.grant(p, { petId: baby.id, slot: 0, pickedAt: start }), false)
  assert.equal(await rewards.grant(p, { petId: 'owned', slot: 0, pickedAt: start }), false)
  assert.equal(writes, 0)
  assert.equal(p.counters['happyHour:0'], undefined)
  p.hatchling = null; p.pets.push(baby)
  await rewards.recover(p)
  assert.equal(baby.size, 1)
  assert.equal(await rewards.grant(p, { petId: 'missing', slot: 0, pickedAt: start }), false)
  assert.equal(writes, 0)
  assert.equal(await rewards.grant(p, { petId: baby.id, slot: 0, pickedAt: start }), true)
  assert.equal(baby.size, 3)
})

test('event waits for every actual pet activity flag, including pending Keep/Discard', () => {
  const { clientState: s, petActivityActive } = load('src/client/state.ts', {
    '@dcl/sdk/players': {}, '../shared/messages': { room: {} },
    '../shared/config': { ARK_GOAL: 100, NEW_PET_STATS: {} }
  })
  const { canPresentHappyHour: show } = load('src/client/ui/happyHourPresentation.ts')
  s.firstSession = false
  assert.equal(show(s, false, false, petActivityActive()), true)
  for (const key of ['hatch', 'carryEgg', 'carryPet', 'breed', 'petting', 'fetch', 'feedGame', 'bathGame', 'feedTask', 'sicknessErrand', 'pepitoChase']) {
    s[key].active = true
    assert.equal(show(s, false, false, petActivityActive()), false, key)
    s[key].active = false
  }
  s.player = { hatchling: { id: 'newborn' } }
  assert.equal(show(s, false, false, petActivityActive()), false)
  s.player.hatchling = null
  assert.equal(show(s, false, false, petActivityActive()), true)
})

test('dismissing the event survives snapshot outages and only a new activation reopens it', () => {
  const { createHappyHourPresentation } = load('src/client/ui/happyHourPresentation.ts')
  const p = createHappyHourPresentation()
  p.sync(start + 3600000)
  assert.equal(p.isDismissed(), false)
  p.dismiss()
  p.sync(null); p.sync(null); p.sync(start + 3600000)
  assert.equal(p.isDismissed(), true)
  p.sync(start + 7200000)
  assert.equal(p.isDismissed(), false)
  p.dismiss(); p.open()
  assert.equal(p.isDismissed(), false)
})

test('hidden mushroom glows write only on the hide transition and dispose releases the entities', () => {
  let hides = 0, creates = 0, removes = 0
  const { createMushroomGlow } = load('src/client/mushroomGlow.ts', {
    '@dcl/sdk/ecs': { engine: {}, Transform: { has: () => false } },
    '@dcl/sdk/math': { Vector3: { create: (x, y, z) => ({ x, y, z }) } },
    './starburst': { createStarburst: () => { creates++; return {} },
      hideStarburst: () => { hides++ }, removeStarburst: () => { removes++ }, updateStarburst() {} }
  })
  const glow = createMushroomGlow(), base = { x: 0, y: 0, z: 0 }
  glow.update(0.1, false, base)
  assert.equal(creates, 0)
  glow.update(0.1, true, base)
  for (let i = 0; i < 200; i++) glow.update(0.1, false, base)
  assert.equal(hides, 1)
  glow.dispose()
  for (let i = 0; i < 200; i++) glow.update(0.1, false, base)
  assert.equal(removes, 1)
  assert.equal(hides, 1)
})

test('missing composite entities are retried and recover; no absent-model event is announced', () => {
  const { HAPPY_HOUR, happyHourView } = shared()
  let present = false
  const { resolveMushroomPositions: resolve, mushroomPlacements } = load('src/shared/mushroomPlacement.ts', {
    './happyHour': { HAPPY_HOUR }, '@dcl/sdk/ecs': {
      engine: { getEntityOrNullByName: name => present ? HAPPY_HOUR.entityNames.indexOf(name) + 1 : null },
      Transform: { has: () => true }, getWorldPosition: () => ({ x: 120, y: 0, z: 260 })
    }
  })
  assert.equal(resolve(), false)
  assert.equal(mushroomPlacements.size, 0)
  assert.equal(happyHourView({ firstSessionStep: 'done', counters: {} }, start,
    [start], [...mushroomPlacements.keys()]), null)
  present = true
  assert.equal(resolve(), true)
  assert.equal(mushroomPlacements.size, 5)
})

test('shared panel geometry matches the original texture and event artwork stays within mobile budget', () => {
  const layout = load('src/client/ui/revampLayout.ts')
  const frame = fs.readFileSync(layout.REVAMP_PANEL_BG)
  assert.equal(layout.REVAMP_PANEL_W, frame.readUInt32BE(16))
  assert.equal(layout.REVAMP_PANEL_H, frame.readUInt32BE(20))
  const mushroom = fs.readFileSync('assets/images/revamp/growth_mushroom_red.png')
  assert.equal(mushroom.readUInt32BE(16), 512)
  assert.equal(mushroom.readUInt32BE(20), 512)
  assert.ok(mushroom.length < 400000)
})

test('all mushroom server rejection notes are localized in Spanish and Portuguese', () => {
  const i18n = load('src/client/i18n/index.ts', {
    '@dcl/sdk/platform': {}, '~system/Runtime': {}
  })
  for (const lang of ['es', 'pt']) {
    i18n.debugSetLanguage(lang)
    for (const note of ['Your pet is already an adult.', 'Move closer to the mushroom.',
      'Select a pet from My Pets first.', 'This mushroom is unavailable. Please try again.',
      'Could not save mushroom growth. Please try again.']) {
      assert.notEqual(i18n.translateText(note), note, `${lang}: ${note}`)
    }
  }
})
