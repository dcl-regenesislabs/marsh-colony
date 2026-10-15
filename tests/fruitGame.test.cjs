const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

// Execute the real scene module with ECS components in memory. Tweens deliberately
// do not move: this reproduces missing renderer write-back without an Explorer.
function loadGame() {
  const transforms = new Map()
  const tweens = new Map()
  const inputLocks = new Map()
  const results = []
  const systems = []
  let pending = true
  let completed = false
  let consumed = 0
  const vector = (x = 0, y = 0, z = 0) => ({ x, y, z })
  const Vector3 = {
    create: vector, Zero: () => vector(), One: () => vector(1, 1, 1),
    scale: (v, s) => vector(v.x * s, v.y * s, v.z * s),
    add: (a, b) => vector(a.x + b.x, a.y + b.y, a.z + b.z),
    subtract: (a, b) => vector(a.x - b.x, a.y - b.y, a.z - b.z),
    dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
  }
  // Unused rendering APIs are inert; component-specific behavior is below.
  const inert = new Proxy(() => ({}), { get: () => inert })
  const Transform = {
    get: (e) => transforms.get(e), getMutable: (e) => transforms.get(e),
    getOrNull: (e) => transforms.get(e) ?? null, has: (e) => transforms.has(e),
    createOrReplace: (e, t) => transforms.set(e, { position: vector(), ...t })
  }
  const ecs = new Proxy({
    Transform,
    InputModifier: { Mode: { Standard: (value) => value },
      createOrReplace: (entity, value) => inputLocks.set(entity, value),
      has: (entity) => inputLocks.has(entity), deleteFrom: (entity) => inputLocks.delete(entity) },
    engine: { PlayerEntity: 1, CameraEntity: 2, getEntityOrNullByName: () => null,
      addSystem: (fn) => systems.push(fn), removeSystem: () => {} },
    Tween: { Mode: { Move: (v) => v, MoveRotateScale: (v) => v },
      createOrReplace: (e, t) => tweens.set(e, t), deleteFrom: (e) => tweens.delete(e) },
    tweenSystem: { tweenCompleted: () => completed }
  }, { get: (obj, key) => obj[key] ?? inert })
  const state = { feedGame: { active: true, caught: 0, timeLeft: 0, resultsAt: 0 }, activePet: null, screenFade: { alpha: 0 } }
  const imports = {
    '@dcl/sdk/ecs': ecs,
    '@dcl/sdk/math': { Vector3, Quaternion: { fromEulerDegrees: () => ({}), Identity: () => ({}),
      fromLookAt: (from, to) => ({ from, to }) }, Color4: inert },
    '~system/RestrictedActions': { movePlayerTo: () => Promise.resolve({}) },
    '../../assets/scene/entity-names': { EntityNames: {} },
    '../shared/config': { FEED_MIN_FRUITS: 3, FEED_HUNGER_PER_FRUIT: 5, FEED_EAT_CINEMATIC_S: 6 },
    './sicknessCinematic': { startSicknessCinematicFromFeedBlackout: () => false },
    './state': { clientState: state, actions: { feedResult: (...args) => results.push(args) } },
    './firstSession': { firstSessionActive: () => true, firstSessionPoisonPending: () => pending,
      takeFirstSessionPoison: () => { consumed++; pending = false } }
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/client/fruitGame.ts'), 'utf8') + `
    exports.testScene = {
      init() {
        fruits.push({ entity: 3, phase: 'idle', poison: true });
        groundClutter.push(4);
        Transform.createOrReplace(3, { position: Vector3.create(0, 8.75, 0) });
        groundY = 0; canopyCenter = Vector3.create(0, 8.75, 0);
      },
      beginPoisonLesson, applyResults, cancelFruitGame,
      step(at) { clock = at; poisonLessonTick() },
      setPhase(value) { phase = value; phaseAt = clock },
      setCamera(value) { cinCam = value },
      snapshot() { return { phase, closing, caughtPoisonThisRound, lessonResolvedAt } },
      maxSeconds: POISON_LESSON_MAX_S,
      dropSeconds: POISON_LESSON_DROP_S,
      tick
    }
  `
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const exports = {}
  vm.runInNewContext(output, { exports, require: (id) => imports[id] ?? new Proxy({}, { get: () => inert }), console: { log() {} }, Date })
  const game = exports.testScene
  game.init()
  return { game, state, transforms, tweens, results, systems, inputLocks,
    completeTween: () => { completed = true }, consumed: () => consumed }
}

test('a stalled renderer exits the lesson within its absolute time budget', () => {
  const h = loadGame()
  h.game.beginPoisonLesson()
  h.game.step(h.game.maxSeconds)
  assert.equal(h.game.snapshot().phase, 'feeding')
  assert.equal(h.results.length, 1)
  assert.equal(h.results[0][1], true)
  assert.equal(h.consumed(), 1)
  h.game.tick(10)
  assert.equal(h.results.length, 1)
})

test('a stale transform resolves on the elapsed fallback even without tween completion', () => {
  const h = loadGame()
  h.game.beginPoisonLesson()
  h.game.step(h.game.dropSeconds)
  h.game.step(h.game.maxSeconds - 0.9)
  assert.equal(h.state.feedGame.caught, 0)
  assert.equal(h.game.snapshot().caughtPoisonThisRound, true)
  h.game.step(h.game.maxSeconds)
  assert.equal(h.game.snapshot().phase, 'feeding')
  assert.equal(h.results.length, 1)
})

test('tween completion without a valid catch resolves as a miss and continues', () => {
  const h = loadGame()
  h.game.beginPoisonLesson()
  h.completeTween()
  h.game.step(h.game.dropSeconds)
  assert.equal(h.state.feedGame.caught, 0)
  assert.equal(h.game.snapshot().caughtPoisonThisRound, true)
  h.game.step(h.game.dropSeconds + 1)
  assert.equal(h.game.snapshot().phase, 'feeding')
  assert.equal(h.results.length, 1)
})

test('a fruit in the catch band outside the radius is not awarded as caught', () => {
  const h = loadGame()
  h.game.beginPoisonLesson()
  h.game.step(h.game.dropSeconds)
  h.transforms.set(1, { position: { x: 10, y: 0, z: 0 } })
  h.transforms.set(3, { position: { x: 0, y: 1.5, z: 0 } })
  h.game.step(h.game.dropSeconds + 0.1)
  assert.equal(h.state.feedGame.caught, 0)
  assert.equal(h.game.snapshot().caughtPoisonThisRound, false)
})

test('a valid catch awards one fruit and submits exactly once', () => {
  const h = loadGame()
  h.game.beginPoisonLesson()
  h.game.step(h.game.dropSeconds)
  h.transforms.set(1, { position: { x: 0, y: 0, z: 0 } })
  h.transforms.set(3, { position: { x: 0, y: 1.5, z: 0 } })
  h.game.step(h.game.dropSeconds + 0.1)
  assert.equal(h.state.feedGame.caught, 1)
  h.game.step(h.game.dropSeconds + 0.2)
  assert.equal(h.state.feedGame.caught, 1)
  h.game.step(h.game.dropSeconds + 1.1)
  h.game.tick(0.1)
  assert.equal(h.results.length, 1)
  assert.equal(h.consumed(), 1)
})

for (const phase of ['arrival', 'intro', 'countdown']) {
  test(`BACK during ${phase} closes without submitting or consuming poison`, () => {
    const h = loadGame()
    h.game.setPhase(phase)
    h.inputLocks.set(1, {})
    h.game.cancelFruitGame()
    assert.equal(h.game.snapshot().closing, true)
    h.game.tick(5)
    assert.notEqual(h.game.snapshot().phase, 'poisonLesson')
    assert.equal(h.results.length, 0)
    assert.equal(h.consumed(), 0)
    const fade = h.systems[0]
    fade(0.2)
    fade(1)
    fade(0.3)
    assert.equal(h.game.snapshot().phase, 'idle')
    assert.equal(h.state.feedGame.active, false)
    assert.equal(h.inputLocks.has(1), false)
  })
}

test('the camera frames canopy height at reveal and follows the falling fruit', () => {
  const h = loadGame()
  h.transforms.set(5, { position: { x: 0, y: 3, z: -10 } })
  h.game.setCamera(5)
  h.game.beginPoisonLesson()
  assert.equal(h.tweens.get(5).mode.rotation.end.to.y, 8.75)
  h.game.step(h.game.dropSeconds)
  h.transforms.set(3, { position: { x: 0, y: 5, z: 0 } })
  h.game.step(h.game.dropSeconds + 0.1)
  assert.equal(h.transforms.get(5).rotation.to.y, 5)
})
