const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const vm = require('vm')
const ts = require('typescript')

function load(file, mocks = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText, { exports, require: name => {
    if (name in mocks) return mocks[name]
    throw new Error(`Unexpected import ${name}`)
  } })
  return exports
}

const filter = load('src/shared/nameFilter.ts', { './nameBlocklist': load('src/shared/nameBlocklist.ts') })

test('blocks offensive names in English, Spanish and Portuguese', () => {
  for (const name of ['Fuck', 'Bitch', 'Nigga', 'Puta', 'PUTO', 'Pelotudo', 'Hijodeputa', 'Trolo',
    'Caralho', 'Buceta', 'Viado', 'Arrombado', 'Hitler', 'Nazi', 'Ass', 'Mierda', 'Merda']) {
    assert.equal(filter.isBlockedName(name), true, name)
  }
})

test('blocks common tricks: case, accents, look-alikes, separators, stretching, glued words', () => {
  for (const name of ['fUcK', 'F.U.C.K', 'f u c k', 'fuuuuck', 'xFuckx', 'N1gg4', 'a$$', 'Pelotüdo',
    'B1tch', 'Hij0 de puta', 'iamawhore', '🖕']) {
    assert.equal(filter.isBlockedName(name), true, name)
  }
})

test('keeps innocent names that look like blocked words', () => {
  for (const name of ['Sprout', 'Pepito', 'Cassie', 'Assistant', 'Classic', 'Bobbi', 'Bobs', 'Peacock',
    'Dickens', 'Ignazio', 'Computadora', 'Burro', 'Pinto', 'Negro', 'Concha', 'Grape', 'Pussycat',
    'Gen-2 Sprout', 'Luna 3', 'Mr. Fluffy', '']) {
    assert.equal(filter.isBlockedName(name), false, name)
  }
})

test('petNameProblem enforces the 12-character cap and the blocklist; empty falls back', () => {
  assert.equal(filter.PET_NAME_MAX, 12)
  assert.equal(filter.petNameProblem('Twelve chars'), null)
  assert.equal(filter.petNameProblem('Thirteen char'), 'tooLong')
  assert.equal(filter.petNameProblem('  Sprout  '), null)
  assert.equal(filter.petNameProblem('Puta'), 'blocked')
  assert.equal(filter.petNameProblem(''), null)
})
