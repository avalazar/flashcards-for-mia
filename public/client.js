// ── App state ─────────────────────────────────────────────────────────────────
let currentUser  = null;
let sets         = [];      // dashboard list, without card bodies
let currentSetId = null;
let currentSet   = null;    // full set with cards, for the editor and study screens
let importData   = null;    // parsed spreadsheet awaiting a column mapping
let session      = null;    // active study session
let activeMode   = null;
let activeModeId = null;    // remembered so "study the missed cards" reuses the same mode
let pendingMode  = null;    // mode chosen on step one, awaiting the options on step two
let authMode     = 'login';
let importTargetPreset = null;   // set when importing straight into an existing set

// ── Small DOM helpers ─────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

// Builds an icon from a mode's path data. Paths are built as real SVG nodes rather
// than assigned as markup, so nothing in this app ever needs innerHTML.
function iconEl(paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'mode-icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

// Builds an element. Text is set via textContent, never innerHTML, so a card that
// contains something like "<3" or an ampersand renders literally and no user text is
// ever parsed as markup.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  window.scrollTo(0, 0);
}

function showError(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }
function clearError(el)     { el.textContent = ''; el.classList.add('hidden'); }

let toastTimer = null;
function showToast(msg, type = '') {
  clearTimeout(toastTimer);
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast' + (type ? ' toast-' + type : '');
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

// ── API ───────────────────────────────────────────────────────────────────────

// Wraps fetch so every call returns parsed JSON or throws an Error carrying the
// server's message, which is already written for a person to read.
async function api(method, path, body) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, options);
  } catch {
    // Render's free instance sleeps after 15 minutes idle and takes about a minute to
    // wake, so a first request after a break can genuinely time out.
    throw new Error('Could not reach the server. It may be waking up, so please try again in a moment.');
  }

  let data = null;
  try { data = await res.json(); } catch { /* some responses have no body */ }

  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// A session that expired mid-use should land the user back on the sign-in screen
// rather than showing a confusing error.
function handleApiError(err, errorEl) {
  if (err.status === 401 && currentUser) {
    currentUser = null;
    showScreen('auth-screen');
    showToast('Your session expired. Please sign in again.', 'warn');
    return;
  }
  if (errorEl) showError(errorEl, err.message);
  else showToast(err.message, 'warn');
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function setAuthMode(mode) {
  authMode = mode;
  const isSignup = mode === 'signup';
  // The format hints only help while choosing a name; on sign-in they are just noise.
  document.getElementById('auth-username-hint').classList.toggle('hidden', !isSignup);
  document.getElementById('auth-password-hint').classList.toggle('hidden', !isSignup);
  document.getElementById('auth-password').autocomplete = isSignup ? 'new-password' : 'current-password';
  document.getElementById('auth-submit').textContent = isSignup ? 'Create account' : 'Sign in';
  document.getElementById('auth-switch-text').textContent =
    isSignup ? 'Already have an account?' : 'New here?';
  document.getElementById('auth-switch-link').textContent =
    isSignup ? 'Sign in' : 'Create an account';
  clearError(document.getElementById('auth-error'));
}

async function submitAuth(event) {
  event.preventDefault();
  const errorEl = document.getElementById('auth-error');
  const submit = document.getElementById('auth-submit');
  clearError(errorEl);

  const payload = {
    username: document.getElementById('auth-username').value,
    password: document.getElementById('auth-password').value,
  };

  submit.disabled = true;
  submit.textContent = authMode === 'signup' ? 'Creating account…' : 'Signing in…';
  try {
    const { user } = await api('POST', `/api/auth/${authMode}`, payload);
    currentUser = user;
    applyTheme(currentUser.settings.theme);
    document.getElementById('auth-password').value = '';
    await loadDashboard();
  } catch (err) {
    showError(errorEl, err.message);
  } finally {
    submit.disabled = false;
    submit.textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
  }
}

async function signOut() {
  try { await api('POST', '/api/auth/logout'); } catch { /* sign out locally regardless */ }
  currentUser = null;
  sets = [];
  currentSet = null;
  document.getElementById('auth-username').value = '';
  document.getElementById('auth-password').value = '';
  setAuthMode('login');
  showScreen('auth-screen');
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

// Refreshes the cached set list without leaving the current screen.
async function loadSetsQuietly() {
  try {
    const data = await api('GET', '/api/sets');
    sets = data.sets;
  } catch { /* the list is only used for labels and the import target dropdown */ }
}

async function loadDashboard() {
  const data = await api('GET', '/api/sets');
  sets = data.sets;
  renderDashboard();
  showScreen('dashboard-screen');
}

function showDashboard() {
  loadDashboard().catch(err => handleApiError(err));
}

function renderDashboard() {
  renderProfile();

  const list = document.getElementById('set-list');
  list.innerHTML = '';
  document.getElementById('dash-empty').classList.toggle('hidden', sets.length > 0);

  for (const set of sets) {
    const row = el('div', 'set-row');

    const main = el('div', 'set-main');
    main.appendChild(el('h3', 'set-title', set.title));
    const meta = `${set.cardCount} ${set.cardCount === 1 ? 'card' : 'cards'}`;
    main.appendChild(el('p', 'set-meta', set.description ? `${meta} · ${set.description}` : meta));
    row.appendChild(main);

    const actions = el('div', 'set-actions');
    const study = el('button', 'btn btn-small', 'Study');
    // A set with no cards has nothing to study; send her to the editor instead.
    study.disabled = set.cardCount === 0;
    study.onclick = () => openModeSelect(set.id);
    const edit = el('button', 'btn btn-small btn-secondary', 'Edit');
    edit.onclick = () => openEditor(set.id);
    actions.appendChild(study);
    actions.appendChild(edit);
    row.appendChild(actions);

    list.appendChild(row);
  }
}

// ── Theme ─────────────────────────────────────────────────────────────────────

const THEMES = ['garden', 'night'];
const DEFAULT_THEME = 'garden';

// Sets the theme and remembers it locally, so the next load can apply it before the
// first paint rather than waiting for the account settings to arrive.
function applyTheme(theme) {
  const name = THEMES.includes(theme) ? theme : DEFAULT_THEME;
  document.documentElement.dataset.theme = name;
  try {
    localStorage.setItem('theme', name);
  } catch { /* private browsing can refuse writes; the theme still applies for now */ }
}

function currentTheme() {
  if (currentUser && THEMES.includes(currentUser.settings.theme)) return currentUser.settings.theme;
  return document.documentElement.dataset.theme || DEFAULT_THEME;
}

// ── Profile and settings ──────────────────────────────────────────────────────

// The setting the study modes read. Falls back to the default when signed out or when
// the server response predates the setting, so a session never starts undefined.
function autoAdvanceEnabled() {
  return !currentUser || currentUser.settings.autoAdvance !== false;
}

function renderProfile() {
  const initial = currentUser ? currentUser.username.slice(0, 1) : '?';
  const button = document.getElementById('profile-btn');
  button.textContent = initial;
  button.title = currentUser ? `Signed in as ${currentUser.username}` : 'Settings';
}

function showSettings() {
  if (!currentUser) return;
  document.getElementById('settings-avatar').textContent = currentUser.username.slice(0, 1);
  document.getElementById('settings-username').textContent = currentUser.username;
  document.getElementById('opt-auto-advance').checked = autoAdvanceEnabled();
  document.getElementById('opt-theme').value = currentTheme();
  showScreen('settings-screen');
}

// The control that edits each setting, so saveSetting can disable it while saving and
// put it back if the save fails.
const SETTING_CONTROLS = {
  autoAdvance: 'opt-auto-advance',
  theme: 'opt-theme',
};

// Puts a control back in step with what is actually stored.
function repaintSetting(key) {
  const input = document.getElementById(SETTING_CONTROLS[key]);
  if (!input) return;
  if (key === 'autoAdvance') input.checked = autoAdvanceEnabled();
  if (key === 'theme') input.value = currentTheme();
}

// Applies the change straight away, then persists it. On failure the change is undone
// and the control put back, so what is on screen always matches what is saved.
async function saveSetting(key, value) {
  if (!currentUser) return;
  const previous = currentUser.settings[key];
  currentUser.settings[key] = value;
  if (key === 'theme') applyTheme(value);

  const input = document.getElementById(SETTING_CONTROLS[key]);
  if (input) input.disabled = true;
  try {
    const { settings } = await api('PATCH', '/api/auth/settings', { [key]: value });
    currentUser.settings = settings;
    if (key === 'theme') applyTheme(settings.theme);
    showToast('Setting saved.', 'ok');
  } catch (err) {
    currentUser.settings[key] = previous;
    if (key === 'theme') applyTheme(previous);
    repaintSetting(key);
    handleApiError(err);
  } finally {
    if (input) input.disabled = false;
  }
}

// ── Set editor ────────────────────────────────────────────────────────────────

function addEditorRow(term = '', definition = '', focus = false, card = null) {
  const rows = document.getElementById('editor-rows');
  const row = el('div', 'editor-row');
  // Carrying the id back on save is what lets the server update the row in place
  // rather than recreate it, which is what preserves its star and its progress.
  if (card && card.id) row.dataset.cardId = card.id;
  row.dataset.starred = card && card.starred === true ? 'true' : 'false';

  const termInput = el('input', 'editor-input editor-term');
  termInput.type = 'text';
  termInput.value = term;
  termInput.maxLength = 2000;
  termInput.placeholder = 'Term';

  const defInput = el('input', 'editor-input editor-def');
  defInput.type = 'text';
  defInput.value = definition;
  defInput.maxLength = 2000;
  defInput.placeholder = 'Definition';

  // Tab off the last definition field adds a row, so a long set can be typed
  // without reaching for the mouse.
  defInput.onkeydown = e => {
    if (e.key === 'Tab' && !e.shiftKey && row === rows.lastElementChild) {
      e.preventDefault();
      addEditorRow('', '', true);
    }
  };

  // Starring from the editor, so cards can be picked out without studying them first.
  // This only marks the row; it is written when the set is saved.
  const star = el('button', 'star-cell');
  star.type = 'button';
  const paintStar = () => {
    const on = row.dataset.starred === 'true';
    star.classList.toggle('star-on', on);
    star.textContent = on ? '★' : '☆';
    star.title = on ? 'Remove star' : 'Star this card';
    star.setAttribute('aria-pressed', String(on));
    star.setAttribute('aria-label', on ? 'Remove star from this card' : 'Star this card');
  };
  star.onclick = () => {
    row.dataset.starred = row.dataset.starred === 'true' ? 'false' : 'true';
    paintStar();
  };
  paintStar();

  const remove = el('button', 'btn-icon', '×');
  remove.type = 'button';
  remove.title = 'Remove this card';
  remove.onclick = () => {
    row.remove();
    if (rows.children.length === 0) addEditorRow();
  };

  row.appendChild(termInput);
  row.appendChild(defInput);
  row.appendChild(star);
  row.appendChild(remove);
  rows.appendChild(row);
  if (focus) termInput.focus();
}

function collectEditorCards() {
  return [...document.querySelectorAll('#editor-rows .editor-row')].map(row => ({
    id: row.dataset.cardId || null,
    term: row.querySelector('.editor-term').value,
    definition: row.querySelector('.editor-def').value,
    starred: row.dataset.starred === 'true',
  }));
}

function newSet() {
  currentSetId = null;
  currentSet = null;
  document.getElementById('editor-heading').textContent = 'New set';
  document.getElementById('editor-title').value = '';
  document.getElementById('editor-description').value = '';
  document.getElementById('editor-rows').innerHTML = '';
  document.getElementById('editor-delete').classList.add('hidden');
  clearError(document.getElementById('editor-error'));
  for (let i = 0; i < 3; i++) addEditorRow();
  showScreen('editor-screen');
  document.getElementById('editor-title').focus();
}

async function openEditor(setId) {
  try {
    const { set } = await api('GET', `/api/sets/${setId}`);
    currentSetId = set.id;
    currentSet = set;
    document.getElementById('editor-heading').textContent = 'Edit set';
    document.getElementById('editor-title').value = set.title;
    document.getElementById('editor-description').value = set.description;
    document.getElementById('editor-rows').innerHTML = '';
    document.getElementById('editor-delete').classList.remove('hidden');
    clearError(document.getElementById('editor-error'));
    if (set.cards.length === 0) addEditorRow();
    for (const card of set.cards) addEditorRow(card.term, card.definition, false, card);
    showScreen('editor-screen');
  } catch (err) {
    handleApiError(err);
  }
}

async function saveSet() {
  const errorEl = document.getElementById('editor-error');
  clearError(errorEl);

  const title = document.getElementById('editor-title').value.trim();
  const description = document.getElementById('editor-description').value.trim();
  if (!title) return showError(errorEl, 'Please give the set a title.');

  const cards = collectEditorCards();
  // Mirror the server's rule locally so the user gets a pointed message instead of a
  // generic rejection: a row is fine blank, but not half-filled.
  const halfFilled = cards.findIndex(c =>
    (c.term.trim() && !c.definition.trim()) || (!c.term.trim() && c.definition.trim()));
  if (halfFilled !== -1) {
    return showError(errorEl,
      `Card ${halfFilled + 1} has only one side filled in. Add the other side, or clear the row.`);
  }
  const filled = cards.filter(c => c.term.trim() && c.definition.trim());
  if (filled.length === 0) return showError(errorEl, 'Add at least one card.');

  try {
    if (currentSetId) {
      await api('PATCH', `/api/sets/${currentSetId}`, { title, description, cards: filled });
      showToast('Saved.', 'ok');
    } else {
      await api('POST', '/api/sets', { title, description, cards: filled });
      showToast('Set created.', 'ok');
    }
    await loadDashboard();
  } catch (err) {
    handleApiError(err, errorEl);
  }
}

async function deleteSet() {
  if (!currentSetId) return;
  const set = sets.find(s => s.id === currentSetId);
  const label = set ? `"${set.title}"` : 'this set';
  // A delete cascades to the cards and their progress and cannot be undone, so ask.
  if (!window.confirm(`Delete ${label} and all of its cards? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/sets/${currentSetId}`);
    showToast('Set deleted.', 'ok');
    currentSetId = null;
    await loadDashboard();
  } catch (err) {
    handleApiError(err, document.getElementById('editor-error'));
  }
}

// ── Spreadsheet import ────────────────────────────────────────────────────────

function showImport(targetSetId = null) {
  importData = null;
  document.getElementById('import-file').value = '';
  document.getElementById('import-step-file').classList.remove('hidden');
  document.getElementById('import-step-map').classList.add('hidden');
  document.getElementById('import-loading').classList.add('hidden');
  clearError(document.getElementById('import-error'));
  clearError(document.getElementById('import-map-error'));
  importTargetPreset = targetSetId;
  showScreen('import-screen');
}

function cancelImport() {
  // Import is only reachable from the editor now. Showing that screen again, rather
  // than rebuilding it, keeps anything already typed in.
  showScreen('editor-screen');
}

function backToFilePick() {
  importData = null;
  document.getElementById('import-file').value = '';
  document.getElementById('import-step-file').classList.remove('hidden');
  document.getElementById('import-step-map').classList.add('hidden');
  clearError(document.getElementById('import-error'));
}

async function uploadFile(sheetName) {
  const input = document.getElementById('import-file');
  const errorEl = document.getElementById('import-error');
  const loading = document.getElementById('import-loading');
  clearError(errorEl);

  if (!input.files || input.files.length === 0) return;

  const form = new FormData();
  form.append('file', input.files[0]);
  if (sheetName) form.append('sheet', sheetName);

  loading.classList.remove('hidden');
  try {
    importData = await api('POST', '/api/import/parse', form);
    setupMapping();
    document.getElementById('import-step-file').classList.add('hidden');
    document.getElementById('import-step-map').classList.remove('hidden');
  } catch (err) {
    handleApiError(err, errorEl);
  } finally {
    loading.classList.add('hidden');
  }
}

function reparseSheet() {
  uploadFile(document.getElementById('import-sheet').value);
}

function columnLabel(index) {
  // Spreadsheet-style letters, so the dropdown matches what she sees in Excel.
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

function setupMapping() {
  const data = importData;

  // Sheet picker, only when the workbook has more than one sheet.
  const sheetWrap = document.getElementById('import-sheet-wrap');
  if (data.sheetNames && data.sheetNames.length > 1) {
    const select = document.getElementById('import-sheet');
    select.innerHTML = '';
    for (const name of data.sheetNames) {
      const option = el('option', null, name);
      option.value = name;
      if (name === data.activeSheet) option.selected = true;
      select.appendChild(option);
    }
    sheetWrap.classList.remove('hidden');
  } else {
    sheetWrap.classList.add('hidden');
  }

  document.getElementById('import-header').checked = data.headerGuess;

  // Column dropdowns, labelled with the header text when there is one.
  const headerRow = data.rows[0] || [];
  const termSelect = document.getElementById('import-term-col');
  const defSelect = document.getElementById('import-def-col');
  for (const select of [termSelect, defSelect]) {
    select.innerHTML = '';
    for (let i = 0; i < data.columnCount; i++) {
      const heading = data.headerGuess && headerRow[i] ? ` — ${headerRow[i]}` : '';
      const option = el('option', null, `Column ${columnLabel(i)}${heading}`);
      option.value = String(i);
      select.appendChild(option);
    }
  }

  // Guess the columns from the header text, falling back to the first two columns.
  // The fixture's junk "#" column in position A is exactly why this matters.
  const guess = (patterns, fallback) => {
    if (data.headerGuess) {
      for (let i = 0; i < data.columnCount; i++) {
        if (patterns.test(String(headerRow[i] || ''))) return i;
      }
    }
    return fallback;
  };
  const termGuess = guess(/^(term|terms|word|words|question|front|key|concept|concepts)$/i, 0);
  let defGuess = guess(/^(definition|definitions|answer|back|meaning|description)$/i, 1);
  if (defGuess === termGuess) defGuess = termGuess === 0 ? 1 : 0;

  termSelect.value = String(termGuess);
  defSelect.value = String(defGuess);

  // Import target: a new set, or append to one that already exists.
  const target = document.getElementById('import-target');
  target.innerHTML = '';
  const newOption = el('option', null, 'A new set');
  newOption.value = 'new';
  target.appendChild(newOption);
  for (const set of sets) {
    const option = el('option', null, `${set.title} (add to existing)`);
    option.value = set.id;
    target.appendChild(option);
  }
  target.value = importTargetPreset || 'new';

  // Default the title to the sheet name, or the file name with its extension dropped.
  const file = document.getElementById('import-file').files[0];
  const typedTitle = document.getElementById('editor-title').value.trim();
  const fallbackTitle = typedTitle || data.activeSheet
    || (file ? file.name.replace(/\.[^.]+$/, '') : '');
  document.getElementById('import-title').value = fallbackTitle;

  renderTargetTitle();
  renderPreview();
}

function renderTargetTitle() {
  const isNew = document.getElementById('import-target').value === 'new';
  document.getElementById('import-title-wrap').classList.toggle('hidden', !isNew);
}

// The rows that would actually be imported, given the current mapping.
function mappedCards() {
  const data = importData;
  const skipHeader = document.getElementById('import-header').checked;
  const termCol = Number(document.getElementById('import-term-col').value);
  const defCol = Number(document.getElementById('import-def-col').value);

  const cards = [];
  const skipped = [];
  data.rows.slice(skipHeader ? 1 : 0).forEach((row, i) => {
    const term = (row[termCol] || '').trim();
    const definition = (row[defCol] || '').trim();
    if (!term && !definition) return;
    // A row with only one side cannot become a card. Collect these so the preview can
    // say how many will be dropped rather than failing the whole import.
    if (!term || !definition) {
      skipped.push({ rowNumber: i + (skipHeader ? 2 : 1), term, definition });
      return;
    }
    cards.push({ term, definition });
  });
  return { cards, skipped };
}

function renderPreview() {
  const data = importData;
  if (!data) return;

  const skipHeader = document.getElementById('import-header').checked;
  const termCol = Number(document.getElementById('import-term-col').value);
  const defCol = Number(document.getElementById('import-def-col').value);

  const table = document.getElementById('import-preview');
  table.innerHTML = '';

  const head = el('tr');
  head.appendChild(el('th', 'th-num', '#'));
  for (let i = 0; i < data.columnCount; i++) {
    let role = '';
    if (i === termCol) role = ' col-term';
    if (i === defCol) role = ' col-def';
    const label = columnLabel(i) + (i === termCol ? ' · term' : i === defCol ? ' · definition' : '');
    head.appendChild(el('th', 'th-col' + role, label));
  }
  table.appendChild(head);

  data.preview.forEach((row, index) => {
    const isHeaderRow = skipHeader && index === 0;
    const tr = el('tr', isHeaderRow ? 'row-skipped' : null);
    tr.appendChild(el('td', 'th-num', isHeaderRow ? '—' : String(index + (skipHeader ? 0 : 1))));
    for (let i = 0; i < data.columnCount; i++) {
      let role = '';
      if (i === termCol) role = ' col-term';
      if (i === defCol) role = ' col-def';
      tr.appendChild(el('td', 'td-cell' + role, row[i] || ''));
    }
    table.appendChild(tr);
  });

  const { cards, skipped } = mappedCards();
  const hiddenRows = data.rowCount - data.preview.length;
  let summary = `${data.rowCount} row${data.rowCount === 1 ? '' : 's'} found`;
  if (hiddenRows > 0) summary += ` (showing the first ${data.preview.length})`;
  summary += `. This mapping produces ${cards.length} card${cards.length === 1 ? '' : 's'}`;
  if (skipped.length > 0) {
    summary += `, and skips ${skipped.length} row${skipped.length === 1 ? '' : 's'} with only one side filled in`;
  }
  document.getElementById('import-summary').textContent = summary + '.';

  const confirm = document.getElementById('import-confirm');
  confirm.disabled = cards.length === 0;
  confirm.textContent = cards.length === 0
    ? 'Nothing to import'
    : `Import ${cards.length} card${cards.length === 1 ? '' : 's'}`;
}

async function confirmImport() {
  const errorEl = document.getElementById('import-map-error');
  clearError(errorEl);

  const termCol = Number(document.getElementById('import-term-col').value);
  const defCol = Number(document.getElementById('import-def-col').value);
  if (termCol === defCol) {
    return showError(errorEl, 'The term and definition need to come from different columns.');
  }

  const { cards } = mappedCards();
  if (cards.length === 0) return showError(errorEl, 'That mapping produces no cards.');

  const target = document.getElementById('import-target').value;
  const button = document.getElementById('import-confirm');
  button.disabled = true;
  button.textContent = 'Importing…';

  try {
    if (target === 'new') {
      const title = document.getElementById('import-title').value.trim();
      if (!title) throw new Error('Please give the new set a title.');
      await api('POST', '/api/sets', { title, description: '', cards });
      showToast(`Created a set with ${cards.length} cards.`, 'ok');
      importTargetPreset = null;
      await loadDashboard();
    } else {
      await api('POST', `/api/sets/${target}/cards`, { cards });
      showToast(`Added ${cards.length} cards.`, 'ok');
      importTargetPreset = null;
      // Reopen the set so the newly added cards are visible and editable straight away.
      await loadSetsQuietly();
      await openEditor(target);
    }
  } catch (err) {
    handleApiError(err, errorEl);
  } finally {
    button.disabled = false;
    renderPreview();
  }
}

// ── Mode select ───────────────────────────────────────────────────────────────

async function openModeSelect(setId) {
  try {
    const { set } = await api('GET', `/api/sets/${setId}`);
    currentSetId = set.id;
    currentSet = set;
    document.getElementById('mode-set-title').textContent = set.title;
    document.getElementById('mode-set-meta').textContent =
      `${set.cards.length} ${set.cards.length === 1 ? 'card' : 'cards'}`;
    // The study filters live on step two and start clear for each new visit.
    document.getElementById('opt-missed').checked = false;
    document.getElementById('opt-starred').checked = false;
    pendingMode = null;
    cardListEditing = false;
    cardListDraft = null;
    starFilterOn = false;
    clearError(document.getElementById('card-list-error'));
    renderModeList();
    showScreen('mode-screen');
  } catch (err) {
    handleApiError(err);
  }
}

function backToModes() {
  if (currentSetId) openModeSelect(currentSetId);
  else showDashboard();
}

function missedCards() {
  return currentSet.cards.filter(c => c.incorrectCount > 0);
}

function starredCards() {
  return currentSet.cards.filter(c => c.starred === true);
}

// The cards a session will cover, given the filters on step two. The two narrow
// together, so ticking both gives starred cards that have also been missed.
function pooledCards() {
  let base = currentSet.cards;
  if (document.getElementById('opt-missed').checked) {
    base = base.filter(c => c.incorrectCount > 0);
  }
  if (document.getElementById('opt-starred').checked) {
    base = base.filter(c => c.starred === true);
  }
  return base;
}

// The same pool, in the order the session will use.
function selectedCards() {
  const base = pooledCards();
  return document.getElementById('opt-shuffle').checked ? shuffled(base) : base.slice();
}

// Sets a filter's label and disables it when it would select nothing.
function setFilterState(inputId, countId, count, emptyLabel) {
  const input = document.getElementById(inputId);
  document.getElementById(countId).textContent = count > 0 ? `(${count})` : `(${emptyLabel})`;
  if (count === 0) {
    input.checked = false;
    input.disabled = true;
  } else {
    input.disabled = false;
  }
}

// Step one offers the modes against the whole set. Narrowing happens on step two,
// where renderOptions re-checks that enough cards remain for the mode chosen here.
function renderModeList() {
  renderCardList();

  const available = currentSet.cards.length;
  const list = document.getElementById('mode-list');
  list.innerHTML = '';

  for (const mode of STUDY_MODES) {
    const card = el('button', 'mode-card');
    // A mode without an icon simply renders without one, so adding a mode never
    // requires drawing artwork first.
    if (Array.isArray(mode.icon)) card.appendChild(iconEl(mode.icon));
    card.appendChild(el('h4', 'mode-label', mode.label));

    if (available < mode.minCards) {
      card.disabled = true;
      card.classList.add('mode-card-disabled');
      card.appendChild(el('p', 'mode-note',
        `Needs at least ${mode.minCards} cards; this set has ${available}.`));
    } else {
      card.onclick = () => chooseMode(mode);
    }
    list.appendChild(card);
  }
}

// Shows a real card from this set, laid out the way the chosen direction will present
// it, so "which side is the question" does not have to be worked out from the wording.
function renderDirectionSample() {
  const wrap = document.getElementById('direction-sample');
  if (!currentSet || currentSet.cards.length === 0) {
    wrap.classList.add('hidden');
    return;
  }

  // Prefer a card the session would actually include, so the sample is never drawn
  // from a card the filters have excluded.
  const pool = pooledCards();
  const card = pool[0] || currentSet.cards[0];
  const definitionFirst = document.getElementById('opt-direction').value === 'definitionFirst';

  document.getElementById('sample-prompt').textContent = definitionFirst ? card.definition : card.term;
  document.getElementById('sample-answer').textContent = definitionFirst ? card.term : card.definition;
  wrap.classList.remove('hidden');
}

// ── Card list ─────────────────────────────────────────────────────────────────
// Its own view state, separate from the study filters: this decides what is being
// looked at, not what will be studied.

let starFilterOn = false;
let cardListEditing = false;
// While editing, a working copy in *set order*. Display may be sorted differently, but
// the order sent back decides each card's position, so the draft must keep the real
// order or saving would silently reshuffle the set.
let cardListDraft = null;

function toggleStarFilter() {
  starFilterOn = !starFilterOn;
  renderCardList();
}

// The cards shown in the list, filtered and sorted by the list's own controls.
function listedCards() {
  let cards = currentSet.cards.slice();
  if (starFilterOn) cards = cards.filter(c => c.starred === true);

  const sort = document.getElementById('card-sort').value;
  if (sort === 'missed') {
    // Ties keep their position in the set, since the sort is stable and the server
    // returns cards in order.
    cards.sort((a, b) => b.incorrectCount - a.incorrectCount);
  } else if (sort === 'alpha') {
    cards.sort((a, b) => a.term.localeCompare(b.term, undefined, { sensitivity: 'base' }));
  }
  return cards;   // 'order' is the order the server returned
}

function renderStarFilterButton() {
  const button = document.getElementById('star-filter');
  button.classList.toggle('star-on', starFilterOn);
  button.textContent = starFilterOn ? '★' : '☆';
  button.title = starFilterOn ? 'Showing starred only — click to show all' : 'Show starred cards only';
  button.setAttribute('aria-pressed', String(starFilterOn));
  button.setAttribute('aria-label', 'Show starred cards only');
}

function renderCardListActions() {
  const box = document.getElementById('card-list-actions');
  box.innerHTML = '';
  if (!currentSet || currentSet.cards.length === 0) return;

  if (!cardListEditing) {
    const edit = el('button', 'btn btn-small btn-secondary', 'Edit');
    edit.onclick = () => startCardEdit();
    box.appendChild(edit);
    return;
  }

  const picked = cardListDraft.filter(card => card.selected).length;
  const cancel = el('button', 'btn btn-small btn-quiet', 'Cancel');
  cancel.onclick = () => cancelCardEdit();
  const save = el('button', 'btn btn-small',
    picked > 0 ? `Save and delete ${picked}` : 'Save changes');
  if (picked > 0) save.classList.add('btn-danger');
  save.onclick = () => saveCardEdits();
  box.appendChild(cancel);
  box.appendChild(save);
}

function renderCardList() {
  renderCardListActions();
  renderStarFilterButton();

  const note = document.getElementById('card-list-note');
  const list = document.getElementById('card-list');
  const sortWrap = document.getElementById('sort-wrap');
  const starButton = document.getElementById('star-filter');
  list.innerHTML = '';

  // Editing covers the whole set, so the view controls are put away to avoid
  // suggesting that only part of it is being edited.
  sortWrap.classList.toggle('hidden', cardListEditing);
  starButton.classList.toggle('hidden', cardListEditing);

  if (cardListEditing) {
    note.textContent = 'Editing the whole set. Tick a card to remove it, then save.';
    for (const card of cardListDraft) list.appendChild(editableCardRow(card));
    return;
  }

  const cards = listedCards();
  const total = currentSet.cards.length;
  if (starFilterOn) {
    note.textContent = cards.length === 0
      ? 'No starred cards yet. Use the star on a card to mark one.'
      : `${cards.length} starred of ${total}`;
  } else {
    note.textContent = `${total} ${total === 1 ? 'card' : 'cards'}`;
  }
  for (const card of cards) list.appendChild(readOnlyCardRow(card));
}

function readOnlyCardRow(card) {
  const row = el('div', 'card-row');

  const main = el('div', 'card-row-main');
  main.appendChild(el('p', 'card-row-term', card.term));
  main.appendChild(el('p', 'card-row-def', card.definition));
  row.appendChild(main);

  if (card.incorrectCount > 0) {
    row.appendChild(el('span', 'miss-badge',
      `missed ${card.incorrectCount} ${card.incorrectCount === 1 ? 'time' : 'times'}`));
  } else {
    row.appendChild(el('span'));   // keeps the star in the same column on every row
  }

  row.appendChild(starCell(card.starred === true, () =>
    setStar(card, !(card.starred === true)).then(() => renderCardList())));
  return row;
}

function editableCardRow(card) {
  const row = el('div', 'card-row card-row-editing' + (card.selected ? ' card-row-selected' : ''));

  const pick = el('input', 'card-row-pick');
  pick.type = 'checkbox';
  pick.checked = card.selected;
  pick.title = 'Tick to remove this card';
  pick.setAttribute('aria-label', `Remove ${card.term}`);
  pick.onchange = () => {
    card.selected = pick.checked;
    row.classList.toggle('card-row-selected', card.selected);
    renderCardListActions();     // the save button carries the count
  };
  row.appendChild(pick);

  for (const side of ['term', 'definition']) {
    const input = el('input', 'card-row-input');
    input.type = 'text';
    input.value = card[side];
    input.maxLength = 2000;
    input.placeholder = side === 'term' ? 'Term' : 'Definition';
    input.oninput = () => { card[side] = input.value; };
    row.appendChild(input);
  }

  // Starring stays live while editing: it is a separate, immediate write.
  row.appendChild(starCell(card.starred, async () => {
    const next = !card.starred;
    card.starred = next;
    const real = currentSet.cards.find(c => c.id === card.id);
    if (real) await setStar(real, next);
    renderCardList();
  }));
  return row;
}

function starCell(on, onToggle) {
  const star = el('button', 'star-cell');
  star.type = 'button';
  star.classList.toggle('star-on', on);
  star.textContent = on ? '★' : '☆';
  star.title = on ? 'Remove star' : 'Star this card';
  star.setAttribute('aria-pressed', String(on));
  star.setAttribute('aria-label', on ? 'Remove star from this card' : 'Star this card');
  star.onclick = onToggle;
  return star;
}

// ── Card list editing ─────────────────────────────────────────────────────────

function startCardEdit() {
  // Editing always covers the whole set. If the star view filter were applied, the
  // save would send only the visible cards and the reconciling update would treat
  // every other card as deleted.
  starFilterOn = false;
  cardListDraft = currentSet.cards.map(card => ({
    id: card.id,
    term: card.term,
    definition: card.definition,
    starred: card.starred === true,
    incorrectCount: card.incorrectCount,
    selected: false,
  }));
  cardListEditing = true;
  clearError(document.getElementById('card-list-error'));
  renderCardList();
}

function cancelCardEdit() {
  cardListEditing = false;
  cardListDraft = null;
  clearError(document.getElementById('card-list-error'));
  renderCardList();
}

async function saveCardEdits() {
  const errorEl = document.getElementById('card-list-error');
  clearError(errorEl);

  const keep = cardListDraft.filter(card => !card.selected);
  const removed = cardListDraft.length - keep.length;

  const blank = keep.findIndex(card => !card.term.trim() || !card.definition.trim());
  if (blank !== -1) {
    return showError(errorEl,
      `"${keep[blank].term.trim() || keep[blank].definition.trim() || 'One card'}" is missing a side. `
      + 'Fill both in, or tick it for removal.');
  }
  if (keep.length === 0) {
    return showError(errorEl, 'That would remove every card. A set needs at least one.');
  }
  // Removal is the only irreversible part, so that is what gets confirmed, and only
  // when something is actually being removed.
  if (removed > 0 && !window.confirm(
      `Delete ${removed} ${removed === 1 ? 'card' : 'cards'} and save your changes? This cannot be undone.`)) {
    return;
  }

  try {
    await api('PATCH', `/api/sets/${currentSetId}`, {
      cards: keep.map(({ id, term, definition, starred }) => ({ id, term, definition, starred })),
    });
    const { set } = await api('GET', `/api/sets/${currentSetId}`);
    currentSet = set;
    cardListEditing = false;
    cardListDraft = null;
    document.getElementById('mode-set-meta').textContent =
      `${set.cards.length} ${set.cards.length === 1 ? 'card' : 'cards'}`;
    renderModeList();
    loadSetsQuietly();
    showToast(removed > 0
      ? `Saved, and removed ${removed} ${removed === 1 ? 'card' : 'cards'}.`
      : 'Saved.', 'ok');
  } catch (err) {
    handleApiError(err, errorEl);
  }
}

// ── Starring ──────────────────────────────────────────────────────────────────

// The card currently on screen during a session. Modes report this through
// ctx.onCardShown, which keeps the star control out of every individual mode: a new
// mode gets starring simply by calling it.
let shownCard = null;

// The button is moved in and out of the card as it renders. Modes clear #study-root
// between renders, which detaches this node, so the reference is kept here rather than
// looked up each time: a detached element is invisible to getElementById but can still
// be re-appended.
let starButton = null;
function starEl() {
  if (!starButton) starButton = document.getElementById('star-btn');
  return starButton;
}

function renderStarButton() {
  const button = starEl();
  if (!button) return;
  if (!shownCard) {
    button.classList.add('hidden');
    return;
  }
  const on = shownCard.starred === true;
  button.classList.remove('hidden');
  button.classList.toggle('star-on', on);
  button.textContent = on ? '★' : '☆';
  button.title = on ? 'Remove star (s)' : 'Star this card (s)';
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', on ? 'Remove star from this card' : 'Star this card');
}

function onCardShown(card) {
  shownCard = card;
  renderStarButton();
  const face = document.querySelector('#study-root .flashcard');
  const button = starEl();
  if (face && button) face.appendChild(button);
}

// True when a keystroke belongs to whatever the user is typing into, so single-letter
// shortcuts never eat characters meant for an answer.
function isTypingTarget(node) {
  if (!node) return false;
  return node.tagName === 'INPUT' || node.tagName === 'TEXTAREA'
      || node.tagName === 'SELECT' || node.isContentEditable === true;
}

// "s" stars the card on screen. Installed only while a session is running.
function onStudyKey(e) {
  if (e.key !== 's' && e.key !== 'S') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;   // leave cmd+s and friends alone
  if (isTypingTarget(e.target)) return;
  if (!shownCard) return;
  e.preventDefault();
  toggleStar();
}

// Writes a card's star. Applied immediately and rolled back if the write fails, so the
// controls never disagree with what is stored. Shared by the star on the card during a
// session and the stars in the card list.
async function setStar(card, next) {
  if (!card || !currentSetId) return;
  setCardStarred(card.id, next);
  try {
    await api('PATCH', `/api/sets/${currentSetId}/cards/${card.id}`, { starred: next });
  } catch (err) {
    setCardStarred(card.id, !next);
    handleApiError(err);
  }
}

// Flips the star on whichever card is showing during a session.
function toggleStar() {
  if (!shownCard) return Promise.resolve();
  return setStar(shownCard, !(shownCard.starred === true));
}

// Keeps every copy of the card in step: the cached set, the live session list, and the
// object the mode is holding are all separate references to the same card.
function setCardStarred(cardId, starred) {
  const lists = [currentSet && currentSet.cards, session && session.cards];
  for (const list of lists) {
    if (!list) continue;
    for (const card of list) {
      if (card.id === cardId) card.starred = starred;
    }
  }
  if (shownCard && shownCard.id === cardId) shownCard.starred = starred;
  renderStarButton();
}

// ── Session options (step two) ────────────────────────────────────────────────

function chooseMode(mode) {
  pendingMode = mode;
  document.getElementById('options-mode-label').textContent = mode.label;
  renderOptions();
  showScreen('options-screen');
}

// The filters live on this step, which means they can narrow the selection below what
// the chosen mode needs. Rather than let the user press Start and be bounced back, say
// so here and disable it.
function renderOptions() {
  if (!pendingMode || !currentSet) return;
  setFilterState('opt-missed', 'opt-missed-count', missedCards().length, 'none yet');
  setFilterState('opt-starred', 'opt-starred-count', starredCards().length, 'none starred');
  renderDirectionSample();

  const available = selectedCards().length;
  document.getElementById('options-meta').textContent =
    `${currentSet.title} · ${available} ${available === 1 ? 'card' : 'cards'}`;

  const note = document.getElementById('options-note');
  const start = document.getElementById('start-btn');
  if (available === 0) {
    showError(note, 'That leaves no cards to study. Untick a filter to widen the selection.');
    start.disabled = true;
  } else if (available < pendingMode.minCards) {
    showError(note, `${pendingMode.label} needs at least ${pendingMode.minCards} cards, and this `
      + `selection has ${available}. Untick a filter, or go back and choose another mode.`);
    start.disabled = true;
  } else {
    clearError(note);
    start.disabled = false;
  }
}

function beginSession() {
  if (!pendingMode) return backToModes();
  // A backstop for the check in renderOptions, so a stale click can never start a
  // session the mode cannot actually run.
  if (selectedCards().length < pendingMode.minCards) return renderOptions();
  startSession(pendingMode);
}

// ── Study session ─────────────────────────────────────────────────────────────

function startSession(mode) {
  const cards = selectedCards();
  if (cards.length === 0) return showToast('There are no cards to study.', 'warn');

  session = {
    mode,
    cards,
    direction: document.getElementById('opt-direction').value,
    results: [],
  };
  activeMode = mode;
  activeModeId = mode.id;

  document.getElementById('study-title').textContent = currentSet.title;
  document.getElementById('study-mode-label').textContent = mode.label;
  const root = document.getElementById('study-root');
  root.innerHTML = '';
  updateProgress();
  showScreen('study-screen');

  mode.start({
    cards,
    // The full set, so multiple choice can draw distractors from every card even when
    // the session itself is a short "missed cards only" run.
    allCards: currentSet.cards,
    root,
    direction: session.direction,
    autoAdvance: autoAdvanceEnabled(),
    onCardShown,
    onResult: recordResult,
    onFinish: finishSession,
  });
  document.addEventListener('keydown', onStudyKey);
}

function recordResult(cardId, correct, opts) {
  if (!session) return;
  // An override revises the answer already given for this card rather than adding a
  // second one, so the card is not counted twice.
  if (opts && opts.override) {
    for (let i = session.results.length - 1; i >= 0; i--) {
      if (session.results[i].cardId === cardId) {
        session.results[i].correct = correct;
        break;
      }
    }
  } else {
    session.results.push({ cardId, correct });
  }
  updateProgress();
}

function updateProgress() {
  if (!session) return;
  const answered = new Set(session.results.map(r => r.cardId)).size;
  const pct = session.cards.length === 0 ? 0 : (answered / session.cards.length) * 100;
  document.getElementById('study-progress-bar').style.width = `${pct}%`;
}

function stopActiveMode() {
  if (activeMode && typeof activeMode.stop === 'function') activeMode.stop();
  activeMode = null;
  document.removeEventListener('keydown', onStudyKey);
  shownCard = null;
  renderStarButton();
  // Park the button back outside the card, so the next session starts from a known place.
  const button = starEl();
  if (button) document.getElementById('study-screen').appendChild(button);
}

// Send the session's results in one request. Failure is not fatal: the session still
// happened and the user should see their score either way.
async function flushResults() {
  if (!session || session.results.length === 0) return;
  try {
    await api('POST', '/api/progress', { results: session.results });
  } catch {
    showToast('Your score could not be saved, but your session still counted.', 'warn');
  }
}

async function finishSession() {
  stopActiveMode();
  const finished = session;
  await flushResults();
  renderResults(finished);
  session = null;
  showScreen('results-screen');
  // Refresh the cached set so the missed-cards filter reflects this session.
  api('GET', `/api/sets/${currentSetId}`).then(({ set }) => { currentSet = set; }).catch(() => {});
}

async function quitStudy() {
  if (!session) return showDashboard();
  const answered = new Set(session.results.map(r => r.cardId)).size;
  if (answered > 0 && answered < session.cards.length) {
    if (!window.confirm(`End the session after ${answered} of ${session.cards.length} cards? Your answers so far will be saved.`)) return;
  }
  stopActiveMode();
  const finished = session;
  await flushResults();
  session = null;
  if (answered === 0) {
    showDashboard();
    return;
  }
  renderResults(finished);
  showScreen('results-screen');
  api('GET', `/api/sets/${currentSetId}`).then(({ set }) => { currentSet = set; }).catch(() => {});
}

// ── Results ───────────────────────────────────────────────────────────────────

let lastMissedIds = [];

function renderResults(finished) {
  // A card can be answered more than once in a session; the final answer is the one
  // that counts for the summary.
  const finalAnswer = new Map();
  for (const r of finished.results) finalAnswer.set(r.cardId, r.correct);

  const total = finalAnswer.size;
  const right = [...finalAnswer.values()].filter(Boolean).length;
  const pct = total === 0 ? 0 : Math.round((right / total) * 100);

  document.getElementById('results-score').textContent = `${right} of ${total} correct · ${pct}%`;

  const note = document.getElementById('results-note');
  if (total < finished.cards.length) {
    note.textContent = `You answered ${total} of the ${finished.cards.length} cards in this session.`;
  } else if (pct === 100) {
    note.textContent = 'Every card correct.';
  } else {
    note.textContent = '';
  }

  const missedIds = [...finalAnswer.entries()].filter(([, ok]) => !ok).map(([id]) => id);
  lastMissedIds = missedIds;

  const byId = new Map(finished.cards.map(c => [c.id, c]));
  const wrap = document.getElementById('results-missed-wrap');
  const list = document.getElementById('results-missed');
  list.innerHTML = '';

  if (missedIds.length === 0) {
    wrap.classList.add('hidden');
    document.getElementById('results-restudy').classList.add('hidden');
    return;
  }

  for (const id of missedIds) {
    const card = byId.get(id);
    if (!card) continue;
    const row = el('div', 'missed-row');
    row.appendChild(el('p', 'missed-term', card.term));
    row.appendChild(el('p', 'missed-def', card.definition));
    list.appendChild(row);
  }
  wrap.classList.remove('hidden');
  document.getElementById('results-restudy').classList.remove('hidden');
}

// Restudy just the cards missed in the session that produced this results screen,
// which is narrower than the "missed before" filter on the mode screen.
function restudyMissed() {
  if (lastMissedIds.length === 0) return;
  const ids = new Set(lastMissedIds);
  const cards = currentSet.cards.filter(c => ids.has(c.id));
  if (cards.length === 0) return showToast('Those cards are no longer in this set.', 'warn');

  const mode = STUDY_MODES.find(m => m.id === activeModeId) || STUDY_MODES[0];
  const usable = cards.length >= mode.minCards ? mode : STUDY_MODES[0];

  session = { mode: usable, cards, direction: document.getElementById('opt-direction').value, results: [] };
  activeMode = usable;
  document.getElementById('study-title').textContent = currentSet.title;
  document.getElementById('study-mode-label').textContent = `${usable.label} · missed cards`;
  const root = document.getElementById('study-root');
  root.innerHTML = '';
  updateProgress();
  showScreen('study-screen');
  usable.start({
    cards,
    allCards: currentSet.cards,
    root,
    direction: session.direction,
    autoAdvance: autoAdvanceEnabled(),
    onCardShown,
    onResult: recordResult,
    onFinish: finishSession,
  });
  document.addEventListener('keydown', onStudyKey);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  // The card itself flips when clicked in some modes, so a click on the star must not
  // reach it. Attached once rather than inline, since it needs the event object.
  starEl().addEventListener('click', e => {
    e.stopPropagation();
    toggleStar();
  });

  setAuthMode('login');
  try {
    const { user } = await api('GET', '/api/auth/me');
    currentUser = user;
    applyTheme(currentUser.settings.theme);
    await loadDashboard();
  } catch {
    // Not signed in, or the server is still waking. Either way, show the sign-in form.
    showScreen('auth-screen');
  }
}

boot();
