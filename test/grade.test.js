// Run with: npm test
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// grade.js is a browser script with no module wrapper, so evaluate it in a context
// and pull the functions out rather than duplicating them here.
const context = { console };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'grade.js'), 'utf8'), context);
const { gradeAnswer, normalizeAnswer, shuffled, allowedEdits, singularize } = context;

// Short answers are the case that actually bit: a set of one-word cards ("blood",
// "leaf", "sky") got no typo tolerance at all under a ratio-only rule.
test('short answers get a one-edit allowance, but the shortest must be exact', () => {
  for (const [given, expected] of [
    ['blod', 'blood'],      // a missing letter
    ['bloood', 'blood'],    // a doubled letter
    ['leat', 'leaf'],       // a single wrong letter
  ]) {
    assert.equal(gradeAnswer(given, expected).correct, true, `${given} should pass for ${expected}`);
  }

  for (const [given, expected] of [
    ['sly', 'sky'],         // 3 letters: one edit is a different word
    ['car', 'cat'],
    ['lief', 'leaf'],       // two edits away, not one
    ['blue', 'blood'],
  ]) {
    assert.equal(gradeAnswer(given, expected).correct, false, `${given} should fail for ${expected}`);
  }
});

test('plurals are accepted for singular answers', () => {
  for (const [given, expected] of [
    ['leaves', 'leaf'],
    ['leafs', 'leaf'],
    ['skies', 'sky'],
    ['bests', 'best'],
    ['boxes', 'box'],
  ]) {
    const result = gradeAnswer(given, expected);
    assert.equal(result.correct, true, `${given} should pass for ${expected}`);
    assert.equal(result.close, true, `${given} should be flagged close so the exact form is shown`);
  }
});

test('allowedEdits scales with length', () => {
  assert.equal(allowedEdits(3), 0);
  assert.equal(allowedEdits(4), 1);
  assert.equal(allowedEdits(7), 1);
  assert.ok(allowedEdits(19) >= 2, 'a long term should tolerate more than one slip');
});

test('exact and near-exact answers are accepted', () => {
  const cases = [
    ['countertransference', 'Countertransference', 'differs only by case'],
    ['countertransferance', 'Countertransference', 'a single typo is forgiven'],
    ['counter transference', 'Countertransference', 'a stray space is one edit away'],
    ['the strengths perspective', 'Strengths perspective', 'a leading article is dropped'],
    ['mandated reporter', 'Mandated Reporter.', 'trailing punctuation is ignored'],
    ['  ecomap  ', 'Ecomap', 'surrounding whitespace is ignored'],
    ['self determination', 'Self-determination', 'a hyphen matches a space'],
    ['milieu', 'miliéu', 'accents are stripped'],
  ];
  for (const [given, expected, why] of cases) {
    assert.equal(gradeAnswer(given, expected).correct, true, `${why}: ${given}`);
  }
});

test('wrong answers are rejected', () => {
  const cases = [
    ['genogram', 'Ecomap', 'a different term'],
    ['', 'Ecomap', 'a blank answer is never correct'],
    ['   ', 'Ecomap', 'whitespace only is never correct'],
    ['cat', 'Car', 'on a short answer a typo is simply wrong'],
    ['transference', 'Countertransference', 'a substring is not the answer'],
  ];
  for (const [given, expected, why] of cases) {
    assert.equal(gradeAnswer(given, expected).correct, false, `${why}: ${given}`);
  }
});

test('a forgiven typo is flagged close, so the UI can show the real spelling', () => {
  assert.deepEqual(
    gradeAnswer('countertransferance', 'Countertransference'),
    { correct: true, close: true, expected: 'Countertransference' }
  );
  assert.equal(gradeAnswer('Countertransference', 'Countertransference').close, false);
});

test('normalizeAnswer handles empty and non-string input', () => {
  assert.equal(normalizeAnswer(undefined), '');
  assert.equal(normalizeAnswer(null), '');
  assert.equal(normalizeAnswer(42), '42');
});

test('shuffled keeps every element and leaves the input alone', () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = shuffled(input);
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8], 'input must not be mutated');
  assert.deepEqual(out.slice().sort((a, b) => a - b), input);
});
