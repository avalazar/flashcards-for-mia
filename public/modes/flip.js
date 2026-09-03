// Flip cards: reveal the back, then say whether you knew it.
//
// A study mode registers itself here and is picked up automatically by the mode
// select screen. To add a new mode or study game, drop a file in this folder and add
// one <script> tag to index.html. Nothing else needs to change.
//
// ctx: { cards, root, direction, onResult(cardId, correct), onFinish() }
//   cards     - already shuffled/filtered by the caller
//   direction - 'termFirst' or 'definitionFirst'
STUDY_MODES.push({
  id: 'flip',
  label: 'Flashcards',
  minCards: 1,

  // Two stacked cards.
  icon: [
    'M6 6h12a2 2 0 0 1 2 2v7',
    'M3.5 9h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 2 17.5v-7A1.5 1.5 0 0 1 3.5 9Z',
  ],

  start(ctx) {
    this.ctx = ctx;
    this.index = 0;
    this.revealed = false;
    this.render();
    // The four arrow keys cover the whole interaction: down reveals, up hides again,
    // then left or right scores the card. Space and Enter still flip for anyone who
    // reaches for them. Every branch preventDefault()s so the arrows do not also
    // scroll the page out from under the card.
    this.onKey = e => {
      switch (e.key) {
        case 'ArrowDown':  e.preventDefault(); this.reveal();     break;
        case 'ArrowUp':    e.preventDefault(); this.hide();       break;
        case 'ArrowRight': e.preventDefault(); this.mark(true);   break;
        case 'ArrowLeft':  e.preventDefault(); this.mark(false);  break;
        case ' ':
        case 'Enter':      e.preventDefault(); this.toggle();     break;
      }
    };
    document.addEventListener('keydown', this.onKey);
  },

  stop() {
    if (this.onKey) document.removeEventListener('keydown', this.onKey);
    this.onKey = null;
  },

  toggle() {
    this.revealed = !this.revealed;
    this.render();
  },

  // Separate from toggle() so that holding down arrow cannot flap the card back and
  // forth: each key has one direction and repeating it is a no-op.
  reveal() {
    if (this.revealed) return;
    this.revealed = true;
    this.render();
  },

  hide() {
    if (!this.revealed) return;
    this.revealed = false;
    this.render();
  },

  mark(correct) {
    // Require a look at the answer first, so a stray arrow key cannot silently
    // score a card the user never saw.
    if (!this.revealed) return;
    const card = this.ctx.cards[this.index];
    this.ctx.onResult(card.id, correct);
    this.index++;
    this.revealed = false;
    if (this.index >= this.ctx.cards.length) return this.ctx.onFinish();
    this.render();
  },

  render() {
    const ctx = this.ctx;
    const card = ctx.cards[this.index];
    const front = ctx.direction === 'definitionFirst' ? card.definition : card.term;
    const back = ctx.direction === 'definitionFirst' ? card.term : card.definition;

    ctx.root.innerHTML = '';
    ctx.root.appendChild(el('p', 'study-counter',
      `Card ${this.index + 1} of ${ctx.cards.length}`));

    const face = el('div', 'flashcard' + (this.revealed ? ' flashcard-back' : ''));
    face.appendChild(el('span', 'flashcard-label', this.revealed ? 'Answer' : 'Prompt'));
    face.appendChild(el('p', 'flashcard-text', this.revealed ? back : front));
    face.onclick = () => this.toggle();
    ctx.root.appendChild(face);
    // Reported after the card is in the DOM, so the star button can be mounted inside it.
    ctx.onCardShown?.(card);

    const actions = el('div', 'study-actions');
    if (!this.revealed) {
      const show = el('button', 'btn', 'Show answer');
      show.onclick = () => this.toggle();
      actions.appendChild(show);
      actions.appendChild(el('p', 'hint', 'Down arrow to show the answer, s to star'));
    } else {
      const missed = el('button', 'btn btn-missed', 'Missed it');
      missed.onclick = () => this.mark(false);
      const knew = el('button', 'btn btn-knew', 'Knew it');
      knew.onclick = () => this.mark(true);
      actions.appendChild(missed);
      actions.appendChild(knew);
      actions.appendChild(el('p', 'hint',
        'Left arrow missed, right arrow knew it, up arrow to hide again'));
    }
    ctx.root.appendChild(actions);
  },
});
