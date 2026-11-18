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

const L = load('src/client/scoreboardLayout.ts')

test('top 10 split over two panels of 5', () => {
  assert.equal(L.SCOREBOARD_TOP, 10)
  const ranks = Array.from({ length: 12 }, (_, i) => i + 1)
  assert.deepEqual(L.scoreboardPage(ranks, 0), [1, 2, 3, 4, 5])
  assert.deepEqual(L.scoreboardPage(ranks, 1), [6, 7, 8, 9, 10])
  assert.deepEqual(L.scoreboardPage([1, 2, 3], 1), [])
  assert.deepEqual(L.scoreboardPage([1, 2, 3, 4, 5, 6, 7], 1), [6, 7])
})

test('XP never takes more than 5 characters', () => {
  assert.equal(L.scoreboardXp(0), '0')
  assert.equal(L.scoreboardXp(14944), '14944')
  assert.equal(L.scoreboardXp(99999), '99999')
  assert.equal(L.scoreboardXp(100000), '100K')
  assert.equal(L.scoreboardXp(123456), '123K')
  assert.equal(L.scoreboardXp(999999), '999K')
  assert.equal(L.scoreboardXp(1250000), '1.2M')
  assert.equal(L.scoreboardXp(25000000), '25M')
  assert.equal(L.scoreboardXp(123456789), '123M')
  assert.equal(L.scoreboardXp(-5), '0')
  assert.equal(L.scoreboardXp(NaN), '0')
  for (let n = 1; n < 1e12; n *= 3) assert.ok(L.scoreboardXp(n).length <= 5, String(n))
})

test('names are trimmed and capped so they never reach the XP column', () => {
  assert.equal(L.scoreboardName('MetaMonkey', false), 'MetaMon')
  assert.equal(L.scoreboardName('MetaMonkey', true), 'MetaMo')
  assert.equal(L.scoreboardName('  Bit  ', false), 'Bit')
})
