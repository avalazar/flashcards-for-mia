// Multiple choice: distractors are sampled from other cards in the same set, which
// keeps the wrong answers plausible and on-topic.
const CHOICE_COUNT = 4;

STUDY_MODES.push({
  id: 'choice',
  label: 'Multiple choice',
  // Needs enough cards to build distractors from.
  minCards: CHOICE_COUNT,
  description: 'Pick the right answer from four options.',

  // How long a correct pick rests on screen before moving on by itself.
  advanceDelay: 1000,

  start(ctx) {
    this.ctx = ctx;
    this.index = 0;
    this.picked = null;
    this.advanceTimer = null;
    this.buildOptions();
    this.render();

    // Enter moves on once an option has been picked. A focused button is left to its
    // own action so one press cannot both click it and advance.
    this.onKey = e => {
      if (e.key !== 'Enter' || this.picked === null) return;
      if (e.target && e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      this.next();
    };
    document.addEventListener('keydown', this.onKey);
  },

  stop() {
    // Ending the session must cancel a pending advance, or it would fire after the
    // mode has been torn down and push the user into a card that is no longer there.
    this.clearAdvance();
    if (this.onKey) document.removeEventListener('keydown', this.onKey);
    this.onKey = null;
  },

  clearAdvance() {
    if (this.advanceTimer) clearTimeout(this.advanceTimer);
    this.advanceTimer = null;
  },

  // A right answer moves on by itself. A wrong one waits, so the revealed answer
  // can actually be read.
  scheduleAdvance(ms) {
    this.clearAdvance();
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = null;
      this.next();
    }, ms);
  },

  buildOptions() {
    const ctx = this.ctx;
    const card = ctx.cards[this.index];
    const answerOf = c => ctx.direction === 'definitionFirst' ? c.term : c.definition;
    const correct = answerOf(card);

    // Pull distractors from the whole set, not just this session's selection, so a
    // short "missed cards only" run still has plausible options. De-duplicate by text
    // so an identical definition on two cards cannot appear as its own distractor.
    const pool = (ctx.allCards || ctx.cards)
      .filter(c => c.id !== card.id)
      .map(answerOf)
      .filter(text => normalizeAnswer(text) !== normalizeAnswer(correct));

    const seen = new Set();
    const unique = [];
    for (const text of shuffled(pool)) {
      const key = normalizeAnswer(text);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(text);
      if (unique.length >= CHOICE_COUNT - 1) break;
    }

    this.options = shuffled([correct, ...unique]);
    this.correctAnswer = correct;
  },

  pick(option) {
    if (this.picked !== null) return;   // already answered; ignore further clicks
    this.picked = option;
    const isRight = normalizeAnswer(option) === normalizeAnswer(this.correctAnswer);
    this.ctx.onResult(this.ctx.cards[this.index].id, isRight);
    this.render();
    if (isRight && this.ctx.autoAdvance) this.scheduleAdvance(this.advanceDelay);
  },

  next() {
    this.clearAdvance();
    this.index++;
    this.picked = null;
    if (this.index >= this.ctx.cards.length) return this.ctx.onFinish();
    this.buildOptions();
    this.render();
  },

  render() {
    const ctx = this.ctx;
    const card = ctx.cards[this.index];
    const prompt = ctx.direction === 'definitionFirst' ? card.definition : card.term;

    ctx.root.innerHTML = '';
    ctx.root.appendChild(el('p', 'study-counter', `Card ${this.index + 1} of ${ctx.cards.length}`));

    const box = el('div', 'flashcard flashcard-prompt');
    box.appendChild(el('span', 'flashcard-label',
      ctx.direction === 'definitionFirst' ? 'Which term is this?' : 'Define this term'));
    box.appendChild(el('p', 'flashcard-text', prompt));
    ctx.root.appendChild(box);
    // Reported after the card is in the DOM, so the star button can be mounted inside it.
    ctx.onCardShown?.(card);

    const list = el('div', 'choice-list');
    for (const option of this.options) {
      const btn = el('button', 'choice', option);
      if (this.picked !== null) {
        const isCorrect = normalizeAnswer(option) === normalizeAnswer(this.correctAnswer);
        const isPicked = option === this.picked;
        // Always reveal the right answer, and mark the wrong pick, so a mistake
        // teaches rather than just scoring.
        if (isCorrect) btn.classList.add('choice-right');
        else if (isPicked) btn.classList.add('choice-wrong');
        btn.disabled = true;
      } else {
        btn.onclick = () => this.pick(option);
      }
      list.appendChild(btn);
    }
    ctx.root.appendChild(list);

    if (this.picked !== null) {
      const actions = el('div', 'study-actions');
      const nextBtn = el('button', 'btn btn-knew',
        this.index + 1 >= ctx.cards.length ? 'See results' : 'Next card');
      nextBtn.onclick = () => this.next();
      actions.appendChild(nextBtn);
      ctx.root.appendChild(actions);
      // Only take focus when a press is actually needed.
      const wasRight = normalizeAnswer(this.picked) === normalizeAnswer(this.correctAnswer);
      if (!wasRight || !this.ctx.autoAdvance) nextBtn.focus();
    }
  },
});
