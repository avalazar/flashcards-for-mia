const express = require('express');
const { query, withTransaction } = require('./db');
const { HttpError, bad, reqString, optString, isUuid } = require('./validate');
const L = require('./limits');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

// Validates an incoming cards array into [{term, definition}], dropping rows where
// both sides are blank (common in spreadsheet imports with trailing empty rows).
function parseCards(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw bad('Cards must be a list.');
  if (value.length > L.MAX_CARDS_PER_SET) {
    throw bad(`A set can hold at most ${L.MAX_CARDS_PER_SET} cards.`);
  }

  const cards = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') throw bad('Each card must have a term and a definition.');
    const term = optString(raw.term, 'Term', L.MAX_TEXT_LEN);
    const definition = optString(raw.definition, 'Definition', L.MAX_TEXT_LEN);
    if (!term && !definition) continue;   // skip fully blank rows
    if (!term || !definition) throw bad('Every card needs both a term and a definition.');

    // An id marks a card that already exists, so it can be updated in place instead of
    // being recreated, which is what preserves its star and its progress across an edit.
    if (raw.id !== undefined && raw.id !== null && !isUuid(raw.id)) {
      throw bad('A card id was not valid.');
    }
    cards.push({
      id: raw.id || null,
      term,
      definition,
      starred: raw.starred === true,
    });
  }
  return cards;
}

// Every read and write is scoped by user_id in the WHERE clause rather than checked
// after fetching, and a set owned by someone else returns 404 rather than 403 so ids
// cannot be probed for existence.
async function ownedSet(setId, userId) {
  if (!isUuid(setId)) throw new HttpError(404, 'Study set not found.');
  const { rows } = await query(
    'select id, title, description, created_at, updated_at from study_sets where id = $1 and user_id = $2',
    [setId, userId]
  );
  if (rows.length === 0) throw new HttpError(404, 'Study set not found.');
  return rows[0];
}

// Brings the stored cards in line with the list the editor sent, without recreating
// rows that already existed. A delete-and-reinsert would cascade away card_progress and
// reset every star, so fixing one typo would silently wipe the user's starred cards.
async function reconcileCards(client, setId, cards) {
  const keep = cards.filter(card => card.id);
  const fresh = cards.filter(card => !card.id);

  // Anything the editor no longer lists is genuinely gone; its progress and star go
  // with it, which is correct because the card itself was removed.
  if (keep.length > 0) {
    await client.query(
      'delete from cards where set_id = $1 and id <> all($2::uuid[])',
      [setId, keep.map(card => card.id)]
    );
  } else {
    await client.query('delete from cards where set_id = $1', [setId]);
  }

  // One statement rather than one per card: Neon wakes per query, so a 500-card set
  // must not become 500 round trips.
  if (keep.length > 0) {
    const positions = cards.map((card, i) => [card, i]).filter(([card]) => card.id);
    await client.query(
      `update cards c set term = t.term, definition = t.definition,
                          position = t.position, starred = t.starred
         from unnest($2::uuid[], $3::text[], $4::text[], $5::int[], $6::boolean[])
                as t(id, term, definition, position, starred)
        where c.id = t.id and c.set_id = $1`,
      [
        setId,
        positions.map(([card]) => card.id),
        positions.map(([card]) => card.term),
        positions.map(([card]) => card.definition),
        positions.map(([, i]) => i),
        positions.map(([card]) => card.starred),
      ]
    );
  }

  // New rows keep their index in the submitted list as their position.
  const freshWithPositions = cards
    .map((card, i) => ({ ...card, position: i }))
    .filter(card => !card.id);
  if (freshWithPositions.length > 0) {
    await insertCardsAt(client, setId, freshWithPositions);
  }
  return { kept: keep.length, added: fresh.length };
}

function insertCards(client, setId, cards, startPosition) {
  return insertCardsAt(client, setId, cards.map((card, i) => ({ ...card, position: startPosition + i })));
}

async function insertCardsAt(client, setId, cards) {
  if (cards.length === 0) return;
  // One multi-row insert instead of N round trips; Neon wakes from idle per query,
  // so batching matters more here than against a local database.
  const values = [];
  const params = [];
  cards.forEach((card, i) => {
    const base = i * 5;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    params.push(setId, card.term, card.definition, card.position, card.starred === true);
  });
  await client.query(
    `insert into cards (set_id, term, definition, position, starred) values ${values.join(', ')}`,
    params
  );
}

// ── Routes ────────────────────────────────────────────────────────────────────

// List the signed-in user's sets. Card bodies are left out; the dashboard only needs counts.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `select s.id, s.title, s.description, s.created_at, s.updated_at,
              count(c.id)::int as card_count
         from study_sets s
         left join cards c on c.set_id = s.id
        where s.user_id = $1
        group by s.id
        order by s.updated_at desc`,
      [req.user.id]
    );
    res.json({
      sets: rows.map(r => ({
        id: r.id,
        title: r.title,
        description: r.description,
        cardCount: r.card_count,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const title = reqString(req.body.title, 'Title', L.MAX_TITLE_LEN);
    const description = optString(req.body.description, 'Description', L.MAX_DESCRIPTION_LEN);
    const cards = parseCards(req.body.cards) || [];

    const { rows: countRows } = await query(
      'select count(*)::int as n from study_sets where user_id = $1', [req.user.id]
    );
    if (countRows[0].n >= L.MAX_SETS_PER_USER) {
      throw bad(`You have reached the limit of ${L.MAX_SETS_PER_USER} study sets.`);
    }

    const set = await withTransaction(async client => {
      const { rows } = await client.query(
        `insert into study_sets (user_id, title, description)
         values ($1, $2, $3) returning id, title, description, created_at, updated_at`,
        [req.user.id, title, description]
      );
      await insertCards(client, rows[0].id, cards, 0);
      return rows[0];
    });

    res.status(201).json({
      set: {
        id: set.id,
        title: set.title,
        description: set.description,
        cardCount: cards.length,
        createdAt: set.created_at,
        updatedAt: set.updated_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// One set with its ordered cards and this user's per-card progress.
router.get('/:id', async (req, res, next) => {
  try {
    const set = await ownedSet(req.params.id, req.user.id);
    const { rows } = await query(
      `select c.id, c.term, c.definition, c.position, c.starred,
              coalesce(p.correct_count, 0)   as correct_count,
              coalesce(p.incorrect_count, 0) as incorrect_count,
              p.last_seen_at
         from cards c
         left join card_progress p on p.card_id = c.id and p.user_id = $2
        where c.set_id = $1
        order by c.position`,
      [set.id, req.user.id]
    );
    res.json({
      set: {
        id: set.id,
        title: set.title,
        description: set.description,
        createdAt: set.created_at,
        updatedAt: set.updated_at,
        cards: rows.map(r => ({
          id: r.id,
          term: r.term,
          definition: r.definition,
          starred: r.starred,
          correctCount: r.correct_count,
          incorrectCount: r.incorrect_count,
          lastSeenAt: r.last_seen_at,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const set = await ownedSet(req.params.id, req.user.id);
    const cards = parseCards(req.body.cards);
    const title = req.body.title === undefined
      ? null : reqString(req.body.title, 'Title', L.MAX_TITLE_LEN);
    const description = req.body.description === undefined
      ? null : optString(req.body.description, 'Description', L.MAX_DESCRIPTION_LEN);

    await withTransaction(async client => {
      if (title !== null) {
        await client.query('update study_sets set title = $1 where id = $2', [title, set.id]);
      }
      if (description !== null) {
        await client.query('update study_sets set description = $1 where id = $2', [description, set.id]);
      }
      if (cards !== null) {
        await reconcileCards(client, set.id, cards);
      }
      await client.query('update study_sets set updated_at = now() where id = $1', [set.id]);
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const set = await ownedSet(req.params.id, req.user.id);
    // Cards and card_progress go with it via on delete cascade.
    await query('delete from study_sets where id = $1', [set.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Append cards to an existing set. Used when importing a spreadsheet into a set
// that already has cards in it.
router.post('/:id/cards', async (req, res, next) => {
  try {
    const set = await ownedSet(req.params.id, req.user.id);
    const cards = parseCards(req.body.cards) || [];
    if (cards.length === 0) throw bad('No cards to add.');

    const { rows } = await query(
      'select coalesce(max(position), -1) as maxpos, count(*)::int as n from cards where set_id = $1',
      [set.id]
    );
    if (rows[0].n + cards.length > L.MAX_CARDS_PER_SET) {
      throw bad(`That would exceed the limit of ${L.MAX_CARDS_PER_SET} cards in a set.`);
    }

    await withTransaction(async client => {
      await insertCards(client, set.id, cards, Number(rows[0].maxpos) + 1);
      await client.query('update study_sets set updated_at = now() where id = $1', [set.id]);
    });

    res.status(201).json({ added: cards.length });
  } catch (err) {
    next(err);
  }
});

// Stars or unstars one card. Kept separate from the set PATCH so starring while
// studying is a single small write and never has to resubmit the whole card list.
router.patch('/:id/cards/:cardId', async (req, res, next) => {
  try {
    const set = await ownedSet(req.params.id, req.user.id);
    if (!isUuid(req.params.cardId)) throw new HttpError(404, 'Card not found.');
    if (typeof req.body.starred !== 'boolean') throw bad('"starred" must be true or false.');

    // Scoping the update by set_id is what enforces ownership: ownedSet has already
    // confirmed the set belongs to this user, so a card id from someone else's set
    // matches nothing.
    const { rowCount } = await query(
      'update cards set starred = $1 where id = $2 and set_id = $3',
      [req.body.starred, req.params.cardId, set.id]
    );
    if (rowCount === 0) throw new HttpError(404, 'Card not found.');

    res.json({ starred: req.body.starred });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
