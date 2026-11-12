const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const vm = require('vm')
const ts = require('typescript')

function load(file) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText, { exports, require: name => { throw new Error(`Unexpected import ${name}`) } })
  return exports
}

const { guideArrowGoal, tutorialCardText } = load('src/client/tutorialArrow.ts')
const base = {
  active: true, step: 'captain', growIntroDone: false, mushroomEaten: false,
  mushroomPopping: false, captainHeard: false, dialogOpen: false
}

test('captain step: arrow to the Captain until he is heard; hidden while a dialog is open', () => {
  assert.equal(guideArrowGoal(base), 'captain')
  assert.equal(guideArrowGoal({ ...base, dialogOpen: true }), null)
  assert.equal(guideArrowGoal({ ...base, captainHeard: true }), null)
  assert.equal(guideArrowGoal({ ...base, active: false }), null)
})

test('grow step: arrow to the mushroom only after the intro and before it is eaten', () => {
  const grow = { ...base, step: 'grow', growIntroDone: true }
  assert.equal(guideArrowGoal(grow), 'mushroom')
  assert.equal(guideArrowGoal({ ...grow, growIntroDone: false }), null)
  assert.equal(guideArrowGoal({ ...grow, mushroomEaten: true }), null)
  assert.equal(guideArrowGoal({ ...grow, mushroomPopping: true }), null)
})

test('no arrow on the other tutorial steps', () => {
  for (const step of ['intro', 'feed', 'bath', 'play', 'breed', 'wrapup', 'done']) {
    assert.equal(guideArrowGoal({ ...base, step, growIntroDone: true }), null, step)
  }
})

test('card keeps the step objective while the tutorial arrow is up; other routes keep their text', () => {
  const captain = 'Go talk to the Captain at the Ark. He has a mission for the whole colony!'
  const generic = 'Follow the green arrow to your next objective!'
  assert.equal(tutorialCardText(captain, generic, true), captain)
  assert.equal(tutorialCardText('', generic, true), generic)
  const feed = 'Follow the green arrow to the tree to feed your pet!'
  assert.equal(tutorialCardText('Your pet is hungry!', feed, false), feed)
  assert.equal(tutorialCardText('Your pet is hungry!', '', false), 'Your pet is hungry!')
})
