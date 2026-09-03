# Flashcards for Mia - Specifications

## 1. Overview
A flashcard study site for Master's in Social Work coursework. Users create an account, save study
sets, and study them in several modes. Study sets are built either by typing cards in by hand or by
uploading a spreadsheet that auto-populates the cards.

## 2. Tech Stack
* **Backend:** Node.js, Express (CommonJS)
* **Database:** PostgreSQL (Neon free tier)
* **Frontend:** Vanilla JS / HTML / CSS, no build step
* **Deployment:** Render (single free Web Service serving both API and frontend)

## 3. Hosting Constraints
Render's free PostgreSQL expires 30 days after creation and is then deleted, so the database lives
on Neon instead. The app is a single Render Web Service that serves both the API and the static
frontend, which keeps the session cookie first-party (Safari and iOS block third-party cookies) and
removes the need for CORS.

Two free-tier limits shape the design:
1. Free Render web services sleep after 15 minutes idle (~1 min cold start). An external pinger
   hits `/healthz` every 10 minutes. 24/7 is ~730 h/month, inside the 750 free instance-hours.
2. `GET /healthz` must never query Postgres. Neon's free plan allows 100 CU-hours/month, which is
   about 400 hours at the 0.25 CU minimum. A ping that touched the database would hold Neon awake
   ~730 h/month and exhaust the quota.

## 4. Accounts
* Open signup with a **username and password**. No email address is collected, so there is nothing
  to verify and no address to look after.
* Usernames are 3 to 30 characters of letters, numbers, dots, hyphens and underscores. They are
  stored with the capitalisation the user chose but matched case-insensitively, so "Mia" and "mia"
  cannot both be registered and either spelling signs in.
* Every study set is private to its owner. There is no sharing.
* Passwords hashed with bcrypt (cost 12).
* Sessions are database-backed and revocable. The cookie holds 32 random bytes; only the SHA-256
  hash of that token is stored, so a database leak yields no usable sessions.
* Cookie is `HttpOnly`, `SameSite=Lax`, `Secure` in production, 30-day expiry slid forward on use.
* No self-serve password reset. An operator runs `npm run reset-password -- <email>`.

## 5. Study Sets
* Fields: title, description, ordered list of cards.
* A card is a term and a definition.
* Caps, to stay inside Neon's 0.5 GB: 500 sets per user, 2000 cards per set, 2000 characters per
  term or definition, 2 MB and 5000 rows per upload.

## 6. Spreadsheet Import
1. The user picks an `.xlsx` or `.csv` file, which is POSTed to `/api/import/parse`.
2. The server parses it in memory (nothing is written to Render's ephemeral disk) and returns the
   sheet names and rows. No database writes happen at this stage.
3. The UI previews the first rows in a table, with a "first row is a header" checkbox that is
   pre-checked when row 1 looks like labels rather than data, and a dropdown per side to choose
   which column is the term and which is the definition.
4. The user targets a new set or appends to an existing one, then confirms. The chosen pairs are
   POSTed as JSON.

Legacy `.xls` is not supported. The upload UI states `.xlsx` or `.csv` and asks for a re-save.

## 7. Study Modes
Modes self-register into a global `STUDY_MODES` array from their own file in `public/modes/`, so a
new mode or study game is one new file plus one `<script>` tag in `index.html`. No changes to
existing modes or to the study screen are needed.

A mode object is:

```js
{
  id: 'flip',
  label: 'Flip cards',
  description: 'Tap to reveal the answer.',
  minCards: 1,
  start(ctx),   // ctx: { cards, root, direction, onResult(cardId, correct), onFinish() }
  stop(),
}
```

Shipped modes:
* **Flip cards** - driven entirely by the four arrow keys: down reveals the answer, up hides it
  again, then left marks it missed and right marks it known. Clicking the card and pressing space
  also flip, but nothing outside the arrow keys is required. Left and right do nothing until the
  answer has been shown, so a stray press cannot score a card that was never read.
* **Type the answer** - the user types the answer; graded with forgiving matching.
* **Multiple choice** - four options, distractors sampled from other cards in the same set.

## 7b. Starring
Any card can be starred from the star in the top-right corner of the card itself while studying,
either by clicking it or by pressing **s**, which writes immediately; or from the star in its row in
the set editor, which is saved with the set. The star's click does not propagate to the card, so
starring never also flips it, and **s** is ignored while focus is in a text field so it cannot eat a
letter meant for a typed answer.

Study modes report the card on screen via `ctx.onCardShown(card)`, called once the card is in the
DOM. The star button is then moved into that card, which keeps starring out of every individual
mode: a new mode gets it by calling that one function.

**Enter** moves to the next card once an answer has been checked or an option picked, which also
skips the auto-advance pause. While an answer is still being typed, Enter submits it instead, and a
focused button keeps its own action so one press cannot both click it and advance. Starring is
a column on `cards` rather than on `card_progress`: sets are private to one owner, so a card has
exactly one user who could star it, and this avoids needing a progress row to exist first.

Editing a set updates the cards that are still listed **in place** rather than deleting and
recreating them, so stars and progress survive an edit. Cards the editor no longer lists are
deleted, and their stars and progress go with them.

Session options: shuffle, missed-cards-only, starred-only, and which side is the question (show the term and
answer with the definition, or the reverse). The mode select screen previews a real card from the
set laid out the chosen way, so the setting is concrete rather than something to infer. The
missed-only and starred-only filters narrow together, so ticking both gives starred cards that have
also been missed. A filter with nothing to offer is disabled and says why in its own label.

## 8. Grading
Answers are normalized before comparison: lowercased, trimmed, whitespace collapsed, punctuation
stripped, and a leading article removed. An exact match after normalization is correct. Otherwise a
Levenshtein similarity of 0.85 or higher counts as correct, and the exact spelling is shown, so a
typo on a term like "countertransference" is not scored wrong.

## 9. Settings
Per-user preferences are stored in a `settings` jsonb column on `users` and reached from the profile
button at the top right of the dashboard. The server whitelists the keys it accepts, so the column
cannot become a dumping ground, and missing keys fall back to their defaults rather than needing a
backfill when a preference is added.

* **autoAdvance** (default on) - whether a correct answer pauses briefly and moves on by itself, or
  waits for a press. A wrong answer always waits, so the correct answer can be read.

Sign out lives on this screen too, rather than on the dashboard.

## 10. Progress
Per-card results are recorded so "study missed cards" and future study games work without a schema
change. A `box` column is reserved for Leitner-style spaced repetition, which is not implemented.

## 11. Screens
`auth` -> `dashboard` -> `settings` / `editor` / `import` / `mode-select` -> `study` -> `results`.

All screens are `.screen` divs in a single `index.html`, toggled by `showScreen(id)`.
