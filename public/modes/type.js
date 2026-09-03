// Write: the answer is typed out and graded with the forgiving matching in grade.js.
//
// Getting one wrong does not just move on. The correct answer is shown and has to be
// typed out before the card is released, because writing it is what makes it stick;
// reading a correction and pressing Next does much less. The score is unaffected by
// the retype: the miss was already recorded, and copying it out is practice, not a
// second attempt.
STUDY_MODES.push({
  id: 'type',
  label: 'Write',
  minCards: 1,

  // A keyboard.
  icon: [
    'M3 7.5h18a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
    'M6 11h.01', 'M9 11h.01', 'M12 11h.01', 'M15 11h.01', 'M18 11h.01',
    'M8 14h8',
  ],

  // How long a correct answer rests on screen before moving on by itself.
  advanceDelay: 1000,
  // Longer when a typo or plural was forgiven, since there is a spelling to read.
  advanceDelayClose: 2200,

  start(ctx) {
    this.ctx = ctx;
    this.index = 0;
    this.resetCard();
    this.advanceTimer = null;
    this.render();

    // Enter moves on once a card is finished. While answering or correcting, the form
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

  // 'asking'     - waiting for a first attempt
  // 'correcting' - got it wrong; the answer is shown and must be typed out
  // 'checked'    - finished with this card
  resetCard() {
    this.state = 'asking';
    this.result = null;       // the graded first attempt, which is what was recorded
    this.answerGiven = '';    // what was typed first
    this.retyped = '';        // what is being typed during the correction
    this.nudge = null;        // shown when a correction does not match yet
    this.corrected = false;   // the answer was successfully typed out
  },

  clearAdvance() {
    if (this.advanceTimer) clearTimeout(this.advanceTimer);
    this.advanceTimer = null;
  },

  // A finished card moves on by itself, if the user has that setting on.
  scheduleAdvance(ms) {
    this.clearAdvance();
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = null;
      this.next();
    }, ms);
  },

  expected() {
    const card = this.ctx.cards[this.index];
    return this.ctx.direction === 'definitionFirst' ? card.term : card.definition;
  },

  finish(delay) {
    this.state = 'checked';
    this.render();
    if (this.ctx.autoAdvance) this.scheduleAdvance(delay);
  },

  submit(typed) {
    if (this.state === 'checked') return this.next();
    if (!typed.trim()) return;                 // ignore an empty submit rather than scoring it

    const card = this.ctx.cards[this.index];
    const expected = this.expected();

    if (this.state === 'asking') {
      this.answerGiven = typed;
      this.result = gradeAnswer(typed, expected);
      this.ctx.onResult(card.id, this.result.correct);

      if (this.result.correct) {
        this.finish(this.result.close ? this.advanceDelayClose : this.advanceDelay);
      } else {
        // Wrong: hold the card and ask for the answer to be written out.
        this.state = 'correcting';
        this.retyped = '';
        this.nudge = null;
        this.render();
      }
      return;
    }

    // state === 'correcting'
    this.retyped = typed;
    if (gradeAnswer(typed, expected).correct) {
      this.corrected = true;
      this.nudge = null;
      this.finish(this.advanceDelay);
    } else {
      // Keep what they typed so a near miss can be fixed rather than retyped whole.
      this.nudge = 'Not quite the same yet — copy the answer above.';
      this.render();
    }
  },

  // Lets the user overrule the grader, which also releases them from the retype.
  // Definitions are wordy and a correct answer phrased differently will not match, so
  // the grader should not be able to force busywork.
  override() {
    if (this.state !== 'correcting') return;
    this.ctx.onResult(this.ctx.cards[this.index].id, true, { override: true });
    this.result.correct = true;
    this.result.overridden = true;
    this.finish(this.advanceDelay);
  },

  next() {
    this.clearAdvance();
    this.index++;
    this.resetCard();
    if (this.index >= this.ctx.cards.length) return this.ctx.onFinish();
    this.render();
  },

  // The headline shown on the card, which doubles as the instruction while correcting.
  cardLabel() {
    const ctx = this.ctx;
    if (this.state === 'asking') {
      return ctx.direction === 'definitionFirst' ? 'Which term is this?' : 'Define this term';
    }
    if (this.state === 'correcting') return 'Not quite — write it out to continue';
    if (this.result.overridden) return 'Counted as correct';
    if (this.corrected) return 'Written out correctly';
    // Covers a typo and a plural alike, so the wording stays true to both.
    if (this.result.close) return 'Correct — the exact wording is';
    return 'Correct';
  },

  render() {
    const ctx = this.ctx;
    const card = ctx.cards[this.index];
    const answering = this.state === 'asking';

    ctx.root.innerHTML = '';
    ctx.root.appendChild(el('p', 'study-counter', `Card ${this.index + 1} of ${ctx.cards.length}`));

    // The result is shown on the card itself rather than in a block underneath. A block
    // appearing below would push the button row down the moment an answer is checked,
    // which is distracting when the next thing you want to press has just moved.
    // Every state renders the same three pieces -- card, input, action row -- so
    // nothing shifts position between answering, correcting and being marked.
    let tint = '';
    if (this.state === 'correcting') tint = ' flashcard-wrong';
    else if (this.state === 'checked') tint = this.result.correct || this.corrected
      ? ' flashcard-right' : ' flashcard-wrong';

    const box = el('div', 'flashcard flashcard-prompt' + tint);
    box.appendChild(el('span', 'flashcard-label', this.cardLabel()));
    box.appendChild(el('p', 'flashcard-text', answering
      ? (ctx.direction === 'definitionFirst' ? card.definition : card.term)
      : this.expected()));
    ctx.root.appendChild(box);
    // Reported after the card is in the DOM, so the star button can be mounted inside it.
    ctx.onCardShown?.(card);

    const form = el('form', 'type-form');
    const input = el('input', 'type-input');
    input.id = 'type-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.autocapitalize = 'none';
    if (this.state === 'asking') {
      input.placeholder = 'Your answer';
    } else if (this.state === 'correcting') {
      input.placeholder = 'Write the answer shown above';
      input.value = this.retyped;
    } else {
      input.value = this.corrected ? this.expected() : this.answerGiven;
      input.disabled = true;
    }
    form.appendChild(input);
    form.onsubmit = e => {
      e.preventDefault();
      this.submit(input.value);
    };
    ctx.root.appendChild(form);

    const actions = el('div', 'study-actions');
    if (this.state === 'checked') {
      const nextBtn = el('button', 'btn btn-knew',
        this.index + 1 >= ctx.cards.length ? 'See results' : 'Next card');
      nextBtn.onclick = () => this.next();
      actions.appendChild(nextBtn);
      actions.appendChild(el('p', 'hint',
        this.index + 1 >= ctx.cards.length ? 'Enter for the results' : 'Enter for the next card'));
      ctx.root.appendChild(actions);
      // Only take focus when a press is actually needed. A card that will advance on
      // its own should not steal focus.
      if (!ctx.autoAdvance) nextBtn.focus();
    } else if (this.state === 'correcting') {
      const iWasRight = el('button', 'btn btn-secondary', 'I was right');
      iWasRight.type = 'button';
      iWasRight.onclick = () => this.override();
      actions.appendChild(iWasRight);

      const check = el('button', 'btn', 'Continue');
      check.type = 'button';
      check.onclick = () => this.submit(input.value);
      actions.appendChild(check);

      actions.appendChild(el('p', 'hint',
        this.nudge || `You wrote "${this.answerGiven.trim()}"`));
      ctx.root.appendChild(actions);
      input.focus();
    } else {
      const submit = el('button', 'btn', 'Check');
      submit.type = 'button';
      submit.onclick = () => this.submit(input.value);
      actions.appendChild(submit);
      actions.appendChild(el('p', 'hint', 'Enter to check'));
      ctx.root.appendChild(actions);
      input.focus();
    }
  },
});
