// Answer grading, shared by the typing and multiple-choice modes.

// Normalizes an answer so trivial differences do not count as wrong: case, surrounding
// and repeated whitespace, punctuation, and a leading article.
function normalizeAnswer(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')  // strip accents, so "milieu" matches "miliéu"
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')    // punctuation to space, keeps letters and digits
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(a|an|the) /, '');
}

// Levenshtein distance, capped implementation using two rows rather than a full matrix.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// How many character edits to forgive, by the length of the expected answer.
// A ratio alone is no use on short answers: 15% of "sky" rounds to nothing, so a
// one-letter slip on a 5-letter word like "blood" would be scored wrong. Equally, one
// edit on a 3-letter word can turn it into a different valid answer ("cat" / "car"),
// so the shortest answers still have to be exact.
function allowedEdits(length) {
  if (length <= 3) return 0;
  if (length <= 7) return 1;
  return Math.max(1, Math.floor(length * 0.15));   // about a 0.85 similarity
}

// Folds an obvious plural back to its singular, so "leaves" is accepted for "leaf".
// Deliberately shallow: it only needs to cover the endings a student actually types.
function singularizeWord(word) {
  if (word.length <= 3) return word;
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y';        // skies  -> sky
  if (/ves$/.test(word)) return word.slice(0, -3) + 'f';        // leaves -> leaf
  if (/(ch|sh|ss|s|x|z)es$/.test(word)) return word.slice(0, -2); // boxes -> box
  if (/[^s]s$/.test(word)) return word.slice(0, -1);            // leafs  -> leaf
  return word;
}

function singularize(text) {
  return text.split(' ').map(singularizeWord).join(' ');
}

// Grades a typed answer. Returns { correct, close, expected }.
// `close` marks an accepted near miss, so the UI can still show the exact spelling.
// Terms like "countertransference" are easy to typo and should not be scored wrong
// for it, and neither should a plural.
function gradeAnswer(given, expected) {
  const a = normalizeAnswer(given);
  const b = normalizeAnswer(expected);

  if (!a) return { correct: false, close: false, expected };
  if (a === b) return { correct: true, close: false, expected };

  // Compare with plurals folded away, which also lets a typo inside a plural through.
  const sa = singularize(a);
  const sb = singularize(b);
  if (sa === sb) return { correct: true, close: true, expected };

  const budget = allowedEdits(sb.length);
  if (budget > 0 && levenshtein(sa, sb) <= budget) {
    return { correct: true, close: true, expected };
  }
  return { correct: false, close: false, expected };
}

// Fisher-Yates. Returns a new array; the caller's card order is left alone.
function shuffled(items) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
