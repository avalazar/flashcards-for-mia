const express = require('express');
const { query } = require('./db');
const { bad, isUuid } = require('./validate');
const L = require('./limits');

const router = express.Router();

// Results are batched and posted once at the end of a study session, so a session is
// one round trip rather than one per card. Neon wakes from idle per query, so this
// keeps compute time (and the 100 CU-hour free budget) down.
router.post('/', async (req, res, next) => {
  try {
    const results = req.body.results;
    if (!Array.isArray(results)) throw bad('Results must be a list.');
    if (results.length === 0) return res.json({ recorded: 0 });
    if (results.length > L.MAX_CARDS_PER_SET) throw bad('Too many results in one batch.');

    // Collapse repeats so a card seen twice in one session is a single upsert.
    const byCard = new Map();
    for (const item of results) {
      if (!item || !isUuid(item.cardId)) throw bad('Each result needs a valid card id.');
      if (typeof item.correct !== 'boolean') throw bad('Each result needs a correct flag.');
      const entry = byCard.get(item.cardId) || { correct: 0, incorrect: 0 };
      if (item.correct) entry.correct++; else entry.incorrect++;
      byCard.set(item.cardId, entry);
    }

    const cardIds = [...byCard.keys()];
    const corrects = cardIds.map(id => byCard.get(id).correct);
    const incorrects = cardIds.map(id => byCard.get(id).incorrect);

    // The join against cards/study_sets is what enforces ownership: a card id belonging
    // to someone else's set simply produces no row, so there is nothing to write.
    // `box` is a Leitner bucket, kept for future spaced repetition and study games:
    // a correct answer promotes (max 5), a wrong one drops straight back to 1.
    const { rowCount } = await query(
      `insert into card_progress (card_id, user_id, correct_count, incorrect_count, box, last_seen_at)
       select c.id, $1, t.correct, t.incorrect,
              case when t.incorrect > 0 then 1 else 2 end,
              now()
         from unnest($2::uuid[], $3::int[], $4::int[]) as t(card_id, correct, incorrect)
         join cards c on c.id = t.card_id
         join study_sets s on s.id = c.set_id and s.user_id = $1
       on conflict (card_id, user_id) do update set
              correct_count   = card_progress.correct_count   + excluded.correct_count,
              incorrect_count = card_progress.incorrect_count + excluded.incorrect_count,
              box = case
                      when excluded.box = 1 then 1
                      else least(card_progress.box + 1, 5)
                    end,
              last_seen_at = now()`,
      [req.user.id, cardIds, corrects, incorrects]
    );

    res.json({ recorded: rowCount });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
