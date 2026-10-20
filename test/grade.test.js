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
const { gradeAnswer, normalizeAnswer, shuffled, allowedEdits, singularize,
  answerFeatures, answerSimilarity } = context;

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

const similarity = (a, b) => answerSimilarity(answerFeatures(a), answerFeatures(b));

test('answers sharing words score above unrelated ones', () => {
  const right = 'the powerhouse of the cell';
  assert.ok(similarity(right, 'the control centre of the cell') >
            similarity(right, 'a large body of water'));
  // Filler words alone do not make two answers alike.
  assert.ok(similarity('the speed of light', 'the history of rome') < 0.2);
});

test('word families and look-alike terms count as similar', () => {
  assert.ok(similarity('photosynthesis', 'photosynthetic pigment') >= 0.2);
  assert.ok(similarity('mitosis', 'meiosis') > similarity('mitosis', 'osmosis cell wall'));
  assert.equal(Math.round(similarity('cell membrane', 'cell membrane') * 100), 100);
});

test('quiz options favour the answers most like the right one', () => {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'grade.js'), 'utf8')
    + '\nvar STUDY_MODES = [];\n'
    + fs.readFileSync(path.join(__dirname, '..', 'public', 'modes', 'choice.js'), 'utf8')
    + '\nthis.quiz = STUDY_MODES[0];', ctx);
  const quiz = ctx.quiz;
  quiz.featureCache = new Map();

  const alike = ['the control centre of the cell', 'the outer wall of the cell', 'stores energy in the cell'];
  const unrelated = ['a large body of water', 'an ancient roman road', 'a type of cloud', 'a musical scale'];
  for (let i = 0; i < 20; i++) {
    const picked = quiz.pickDistractors('the powerhouse of the cell', [...unrelated, ...alike]);
    assert.equal(picked.length, 3);
    assert.deepEqual(picked.slice().sort(), alike.slice().sort());
  }

  // With nothing alike, it still fills every option from the rest.
  const picked = quiz.pickDistractors('photosynthesis', unrelated);
  assert.equal(new Set(picked).size, 3);
});
