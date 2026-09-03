// Type the answer: graded with the forgiving matching in grade.js.
STUDY_MODES.push({
  id: 'type',
  label: 'Type the answer',
  description: 'Write the answer out. Small typos are forgiven.',
  minCards: 1,

  // How long a correct answer rests on screen before moving on by itself.
  advanceDelay: 1000,
  // Longer when a typo or plural was forgiven, since there is a spelling to read.
  advanceDelayClose: 2200,

  start(ctx) {
    this.ctx = ctx;
    this.index = 0;
    this.state = 'asking';   // 'asking' or 'checked'
    this.result = null;
    this.advanceTimer = null;
    this.render();

    // Enter moves on once an answer has been checked. While still answering, the form
    // owns Enter and submits instead, and a focused button is left to its own action so
    // one press cannot both click it and advance.
    this.onKey = e => {
      if (e.key !== 'Enter' || this.state !== 'checked') return;
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

  // A right answer moves on by itself. Long enough to register the tick, short enough
  // that it does not feel like waiting.
  scheduleAdvance(ms) {
    this.clearAdvance();
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = null;
      this.next();
    }, ms);
  },

  check() {
    if (this.state === 'checked') return this.next();
    const input = this.ctx.root.querySelector('#type-input');
    const typed = input ? input.value : '';
    if (!typed.trim()) return;   // ignore an empty submit rather than scoring it wrong

    const card = this.ctx.cards[this.index];
    const expected = this.ctx.direction === 'definitionFirst' ? card.term : card.definition;
    this.result = gradeAnswer(typed, expected);
    this.state = 'checked';
    this.ctx.onResult(card.id, this.result.correct);
    this.render();

    // Honour the user's preference: with auto-advance off, a correct answer waits for
    // a press just as a wrong one does.
    if (this.result.correct && this.ctx.autoAdvance) {
      // A forgiven typo shows the real spelling, which is worth a beat longer to read.
      this.scheduleAdvance(this.result.close ? this.advanceDelayClose : this.advanceDelay);
    }
  },

  // Let the user overrule the grader. Definitions are wordy and a correct answer
  // phrased differently will not match, so the score should not be the last word.
  override() {
    if (this.state !== 'checked' || this.result.correct) return;
    this.ctx.onResult(this.ctx.cards[this.index].id, true, { override: true });
    this.result.correct = true;
    this.result.overridden = true;
    this.render();
    if (this.ctx.autoAdvance) this.scheduleAdvance(this.advanceDelay);
  },

  next() {
    this.clearAdvance();
    this.index++;
    this.state = 'asking';
    this.result = null;
    if (this.index >= this.ctx.cards.length) return this.ctx.onFinish();
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

    const form = el('form', 'type-form');
    const input = el('input', 'type-input');
    input.id = 'type-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = 'Your answer';
    if (this.state === 'checked') {
      input.value = this.answerGiven || '';
      input.disabled = true;
    }
    form.appendChild(input);
    form.onsubmit = e => {
      e.preventDefault();
      this.answerGiven = input.value;
      this.check();
    };
    ctx.root.appendChild(form);

    if (this.state === 'checked') {
      const verdict = el('div', 'verdict ' + (this.result.correct ? 'verdict-right' : 'verdict-wrong'));
      if (this.result.overridden) {
        verdict.appendChild(el('p', 'verdict-head', 'Counted as correct'));
      } else if (this.result.correct && this.result.close) {
        // Covers a typo and a plural alike, so the wording stays true to both.
        verdict.appendChild(el('p', 'verdict-head', 'Correct — the exact wording is'));
      } else if (this.result.correct) {
        verdict.appendChild(el('p', 'verdict-head', 'Correct'));
      } else {
        verdict.appendChild(el('p', 'verdict-head', 'Not quite'));
      }
      verdict.appendChild(el('p', 'verdict-expected', this.result.expected));
      ctx.root.appendChild(verdict);

      const actions = el('div', 'study-actions');
      if (!this.result.correct) {
        const iWasRight = el('button', 'btn btn-secondary', 'I was right');
        iWasRight.onclick = () => this.override();
        actions.appendChild(iWasRight);
      }
      const nextBtn = el('button', 'btn btn-knew',
        this.index + 1 >= ctx.cards.length ? 'See results' : 'Next card');
      nextBtn.onclick = () => this.next();
      actions.appendChild(nextBtn);
      ctx.root.appendChild(actions);
      // Only take focus when a press is actually needed. A correct answer that will
      // advance on its own should not steal focus.
      if (!this.result.correct || !this.ctx.autoAdvance) nextBtn.focus();
    } else {
      const actions = el('div', 'study-actions');
      const submit = el('button', 'btn', 'Check');
      submit.onclick = () => { this.answerGiven = input.value; this.check(); };
      actions.appendChild(submit);
      actions.appendChild(el('p', 'hint', 'Enter to check'));
      ctx.root.appendChild(actions);
      input.focus();
    }
  },
});
