# Flashcards

A flashcard study site with accounts and saved study sets. Cards can be typed in by hand or
auto-populated from a spreadsheet upload.

## Features

* **Accounts** — username and password sign-in, open signup. No email address is collected. Every
  study set is private to its owner.
* **Study sets** — create, edit and delete sets of term/definition cards.
* **Spreadsheet import** — upload an `.xlsx` or `.csv`, preview the rows, and pick which column is
  the term and which is the definition. Handles junk columns, blank rows, multiple sheets, and files
  that were not laid out for this app.
* **Three study modes** — flip cards (playable with just the four arrow keys), type the answer
  (with forgiving typo matching), and multiple choice. Shuffle, "only cards I have missed", and a choice of which side is the question — with a
  preview of a real card from the set so the setting is obvious before starting.
* **Starring** — star a card from the corner of the card while studying (click it or press **s**),
  or from the set editor, then study only starred cards. Editing a set preserves stars and progress
  on the cards that remain.
* **Keyboard driven** — flip cards runs on the four arrow keys, **s** stars, and **Enter** moves to
  the next card once an answer has been given.
* **Progress tracking** — per-card results, so missed cards can be restudied.
* **Per-user settings** — reached from the profile button at the top right. Currently whether a
  correct answer moves on by itself, plus sign out. Settings are stored on the account, so they
  follow the user between devices rather than living in one browser.

## Tech Stack

* **Backend:** Node.js, Express (CommonJS)
* **Database:** PostgreSQL
* **Frontend:** Vanilla JS / HTML / CSS, no build step
* **Deployment:** Render (one free web service) + Neon (free Postgres)

## Running locally

Needs Node 22+ and Docker (for the local database).

```bash
npm install
npm run db:up                 # starts Postgres in Docker on port 55432
cp .env.example .env          # then fill in the values below
npm run migrate
npm run dev                   # http://localhost:3000
```

For local development `.env` should read:

```
DATABASE_URL=postgresql://postgres:devpass@localhost:55432/flashcards
SESSION_SECRET=<any long random string>
NODE_ENV=development
```

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Other commands:

```bash
npm test                      # runs the answer-grading tests
npm run make-fixture          # regenerates test/sample-cards.xlsx and .csv
npm run db:down               # removes the local Postgres container
```

`test/sample-cards.xlsx` is deliberately messy — a header row, a junk numbering column, blank rows
in the middle, and a second sheet — so the import wizard gets exercised properly.

## Deploying

### 1. Database on Neon, not Render

**Render's free PostgreSQL expires 30 days after it is created and is then deleted.** Use
[Neon](https://neon.com) instead, whose free tier runs indefinitely (0.5 GB storage,
100 CU-hours/month).

Create a Neon project and copy the **pooled** connection string from Connect (it has `-pooler` in
the host name).

### 2. Web service on Render

Either point Render at this repo as a Blueprint (it will read `render.yaml`) or create a Web Service
by hand:

| Setting | Value |
|---|---|
| Runtime | Node |
| Build command | `npm ci` |
| Start command | `node server/index.js` |
| Health check path | `/healthz` |

Environment variables:

| Key | Value |
|---|---|
| `DATABASE_URL` | the Neon pooled connection string |
| `SESSION_SECRET` | a long random string (Render can generate one) |
| `NODE_ENV` | `production` |

`NODE_ENV=production` is what marks the session cookie `Secure`, so do not omit it.

### 3. Run the migration once

With `DATABASE_URL` pointed at Neon:

```bash
npm run migrate
```

Safe to re-run; applied migrations are tracked in a `_migrations` table.

### 4. Stop the service falling asleep

Free Render web services sleep after 15 minutes idle and take about a minute to wake, which means a
slow blank screen on first visit. Register a free monitor (cron-job.org, UptimeRobot) to request
`https://<your-app>.onrender.com/healthz` every 10 minutes. Running 24/7 is about 730 hours a month,
inside the 750 free instance-hours.

> **`/healthz` must never query the database.** Neon's free plan allows 100 CU-hours a month, which
> is roughly 400 hours at the minimum compute size. A keep-alive that touched Postgres would hold
> Neon awake around 730 hours a month and exhaust the quota. The handler in `server/index.js`
> deliberately returns a static payload.

## Password resets

There is no self-serve "forgot password" — that would need a transactional email provider. If
someone is locked out, run:

```bash
npm run reset-password -- mia
```

It prompts for a new password without echoing it, and signs out that account's existing sessions.
Run it against production by setting `DATABASE_URL` to the Neon string.

Adding real reset emails later (Resend's free tier is ~3,000/month) only touches `server/auth.js`.

## Adding a user setting

Preferences live in a single `settings` jsonb column on `users`, so a new one needs no migration.

1. Add it to `SETTING_SPEC` in `server/settings.js` with its type and default. The server rejects
   any key not listed there, and `withDefaults` fills in the default for accounts that predate it,
   so no backfill is needed.
2. Add the control to the settings screen in `index.html`, calling
   `saveSetting('<key>', <value>)`.
3. Read it in the client from `currentUser.settings.<key>`.

`PATCH /api/auth/settings` merges server-side (`settings || $2::jsonb`), so two devices changing
different preferences do not overwrite each other.

## Adding a study mode or game

Study modes self-register, so adding one does not mean touching any existing mode.

1. Create `public/modes/<name>.js`:

```js
STUDY_MODES.push({
  id: 'matching',
  label: 'Matching game',
  description: 'Pair each term with its definition.',
  minCards: 4,                  // the mode is greyed out below this, with an explanation
  start(ctx) {
    // ctx.cards      - the cards for this session, already shuffled/filtered
    // ctx.allCards   - every card in the set, for drawing distractors
    // ctx.root       - the element to render into
    // ctx.direction  - 'termFirst' or 'definitionFirst'
    // ctx.autoAdvance - whether a correct answer should move on by itself
    // ctx.onCardShown(card) - call when rendering a card, so the star button tracks it
    // ctx.onResult(cardId, correct)
    // ctx.onFinish()
  },
  stop() {},                    // remove any document-level listeners here
});
```

2. Add one `<script src="modes/<name>.js"></script>` to `index.html`, after `grade.js`.

The mode select screen is built by iterating `STUDY_MODES`, so the new mode appears automatically.
`public/grade.js` provides `gradeAnswer`, `normalizeAnswer` and `shuffled`; `client.js` provides the
`el(tag, className, text)` helper, which sets text via `textContent` so card content is never parsed
as markup.

## Limits

Sized to stay inside Neon's free 0.5 GB, and enforced in `server/limits.js`:

* 500 study sets per user, 2000 cards per set
* Usernames are 3 to 30 characters: letters, numbers, dots, hyphens, underscores
* 2000 characters per term or definition
* 2 MB and 5000 rows per spreadsheet upload
* Legacy `.xls` is not supported — re-save as `.xlsx` or `.csv`
* No images on cards
* Neon's free tier has no backups; run `pg_dump` occasionally if the data matters
