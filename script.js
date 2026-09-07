// ── Supabase config ───────────────────────────────────────────────────────────
// Fill these in after creating your Supabase project.
const SUPABASE_URL = 'https://jmmtuiwylzgqdstqztkx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_W8tvd0SLZDVUX6RtuIf87w_XxfgyGnW';

// ── State ─────────────────────────────────────────────────────────────────────
let db          = null;
let bugs        = [];
let currentUser = null;

const STATUSES = ['open', 'features-open', 'questions', 'in-progress', 'in-review', 'parked', 'closed'];

const STATUS_LABELS = {
  'open':          'Bugs',
  'features-open': 'Features',
  'questions':     'Questions',
  'in-progress':   'In Progress',
  'in-review':     'Review',
  'parked':        'Parked',
  'closed':        'Closed',
};

// Every live card belongs to exactly one of these. The database fills a blank
// from the column (Review -> Steve, Bugs/Features/In Progress -> Bots, Questions
// -> Steve) and re-derives it when a card changes column, so the board never has
// to guess — it only has to show it and let you override.
const ASSIGNEES = ['Steve', 'Davis', 'Bots'];
const ASSIGNEE_ORDER = { Steve: 0, Davis: 1, Bots: 2 };
const SEVERITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };

// Workflow fields shown as labeled sections on cards (when filled in)
const CARD_SECTIONS = [
  ['question',      'Question'],
  ['answer',        'Answer'],
  ['what_was_done', 'What was done'],
  ['how_to_test',   'How to test'],
  ['feedback',      'Feedback'],
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
}

// On touch devices, auto-focusing a field pops the keyboard over the whole
// screen — only auto-focus where a physical keyboard is likely.
const TOUCH_DEVICE = window.matchMedia('(hover: none), (pointer: coarse)').matches;

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setStatus(msg) {
  document.getElementById('syncStatus').textContent = msg;
}

// "3 min ago", "2 hr ago", "yesterday", "Aug 3" — short enough for a card badge
function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1)    return 'just now';
  if (mins < 60)   return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)    return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1)  return 'yesterday';
  if (days < 7)    return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Who made the change: an email shows as its name part, API keys show as "API"
function actorLabel(actor) {
  if (!actor) return '';
  if (actor.includes('@')) return actor.split('@')[0];
  if (actor === 'service_role' || actor === 'anon' || actor === 'api') return 'API';
  return actor;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function showApp() {
  document.getElementById('loginOverlay').classList.add('hidden');
}

function showLogin(msg) {
  document.getElementById('loginOverlay').classList.remove('hidden');
  const err = document.getElementById('loginError');
  if (msg) { err.textContent = msg; err.style.display = 'block'; }
  else       { err.style.display = 'none'; }
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  const btn      = document.getElementById('loginBtn');
  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!email || !password) { showLogin('Enter your email and password.'); return; }
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  const { data, error } = await db.auth.signInWithPassword({ email, password });
  btn.disabled = false;
  btn.textContent = 'Sign In';
  if (error) { showLogin(error.message); return; }
  currentUser = data.user;
  document.getElementById('userLabel').textContent = currentUser.email;
  showApp();
  await loadBugs();
  await loadLastActivity();
  await loadLastDeploy();
  startActivityTimers();
});

document.getElementById('loginPassword').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('loginBtn').click();
});

document.getElementById('signOutBtn').addEventListener('click', async () => {
  await db.auth.signOut();
  currentUser = null;
  bugs = [];
  renderAll();
  showLogin();
});

// ── Supabase init ─────────────────────────────────────────────────────────────

async function initSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    setStatus('Supabase not configured — add credentials to script.js');
    showLogin('Supabase not configured.');
    return false;
  }
  try {
    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data: { session } } = await db.auth.getSession();
    if (!session) { showLogin(); return false; }
    currentUser = session.user;
    document.getElementById('userLabel').textContent = currentUser.email;
    showApp();
    setStatus('Connected');
    return true;
  } catch (e) {
    console.warn('Supabase error:', e.message);
    setStatus('Connection error');
    showLogin('Connection error: ' + e.message);
    return false;
  }
}

// ── Bugs CRUD ─────────────────────────────────────────────────────────────────

async function loadBugs() {
  const { data, error } = await db.from('bugs').select('*').order('created_at');
  if (error) { setStatus('Error loading bugs: ' + error.message); return; }
  bugs = data;
  renderAll();
  renderDeployBar();   // the "newer than this build" count depends on the board
  setStatus('Connected');
}

// ── Last activity ─────────────────────────────────────────────────────────────
// Fed by a Postgres trigger on `bugs`, so it captures every change regardless of
// where it came from — this UI, or Claude hitting the API directly.

let lastActivity   = null;   // most recent bug_activity row
let activityTicker = null;

async function loadLastActivity() {
  const { data, error } = await db
    .from('bug_activity')
    .select('*')
    .order('at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { console.warn('Activity load failed:', error.message); return null; }
  lastActivity = data;
  renderActivityBar();
  return data;
}

function renderActivityBar() {
  const dotEl     = document.getElementById('activityDot');
  const timeEl    = document.getElementById('activityTime');
  const summaryEl = document.getElementById('activitySummary');

  if (!lastActivity) {
    dotEl.className          = 'status-dot activity stale';
    timeEl.textContent       = 'none recorded yet';
    summaryEl.textContent    = '';
    return;
  }

  const ageMin = (Date.now() - new Date(lastActivity.at).getTime()) / 60000;
  // Claude runs every 30 min, so an hour of silence is worth noticing
  const freshness = ageMin < 60 ? 'fresh' : ageMin < 360 ? 'warm' : 'stale';
  dotEl.className     = `status-dot activity ${freshness}`;
  timeEl.textContent  = relativeTime(lastActivity.at);
  timeEl.title        = new Date(lastActivity.at).toLocaleString();

  const who = actorLabel(lastActivity.actor);
  summaryEl.textContent = (who ? `${who}: ` : '') + lastActivity.summary;
  summaryEl.title       = summaryEl.textContent;
}

// ── Last production deploy ────────────────────────────────────────────────────
// The `check-deploy` edge function reads the EAS Update currently live on the
// production channel — i.e. what your phone gets when it restarts the app.

let lastDeploy = null;

async function loadLastDeploy() {
  try {
    const { data, error } = await db.functions.invoke('check-deploy');
    if (error) throw error;
    lastDeploy = data?.latest || null;
  } catch (e) {
    console.warn('Deploy check failed:', e.message || e);
    // Fall back to the table directly, in case the function is unreachable
    const { data } = await db.from('deployments')
      .select('*').order('published_at', { ascending: false }).limit(1).maybeSingle();
    lastDeploy = data || null;
  }
  renderDeployBar();
}

function renderDeployBar() {
  const dotEl  = document.getElementById('deployDot');
  const timeEl = document.getElementById('deployTime');
  const noteEl = document.getElementById('deployNote');

  if (!lastDeploy) {
    dotEl.className       = 'status-dot deploy stale';
    timeEl.textContent    = 'no deploy recorded yet';
    noteEl.textContent    = '';
    return;
  }

  const published = lastDeploy.published_at;
  const ageHrs    = (Date.now() - new Date(published).getTime()) / 3600000;
  dotEl.className    = `status-dot deploy ${ageHrs < 24 ? 'fresh' : ageHrs < 72 ? 'warm' : 'stale'}`;
  timeEl.textContent = relativeTime(published);
  timeEl.title       = `EAS Update ${lastDeploy.update_id || ''}\nPublished ${new Date(published).toLocaleString()}`;

  // Anything moved to Review after this build shipped isn't testable yet —
  // that's the thing worth knowing before you pick up the phone.
  const pending = bugs.filter(b =>
    b.status === 'in-review' &&
    (b.updated_at || b.created_at) &&
    new Date(b.updated_at || b.created_at).getTime() > new Date(published).getTime()
  ).length;

  noteEl.textContent = pending
    ? `${pending} Review item${pending === 1 ? '' : 's'} newer than this build`
    : 'Review column is covered by this build';
  noteEl.classList.toggle('warn', pending > 0);
}

// Poll for new activity. If something changed, pull the board fresh too —
// unless a card is open for editing, which we don't want to yank out from under.
async function pollActivity() {
  if (!db || !currentUser) return;
  const prevId = lastActivity?.id ?? null;
  const latest = await loadLastActivity();
  if (latest && latest.id !== prevId && !editingBugId) await loadBugs();
}

function startActivityTimers() {
  if (activityTicker) return;
  // Refresh relative times every 30s (no network, no board re-render), poll every 60s
  activityTicker = setInterval(() => {
    renderActivityBar();
    renderDeployBar();
    refreshCardTimestamps();
  }, 30000);
  setInterval(pollActivity, 60000);
  // Deploys are far less frequent than board edits — check every 5 min
  setInterval(loadLastDeploy, 300000);
}

document.getElementById('activityRefresh').addEventListener('click', async () => {
  const btn = document.getElementById('activityRefresh');
  btn.classList.add('spinning');
  await Promise.all([loadBugs(), loadLastActivity(), loadLastDeploy()]);
  btn.classList.remove('spinning');
});

async function addBug(bug) {
  const { data, error } = await db.from('bugs').insert(bug).select().single();
  if (error) { alert('Error adding bug: ' + error.message); return; }
  bugs.push(data);
  renderAll();
  loadLastActivity();
}

async function updateBug(id, changes) {
  // Select the row back so we pick up the trigger-set updated_at
  const { data, error } = await db.from('bugs').update(changes).eq('id', id).select().single();
  if (error) { alert('Error updating bug: ' + error.message); return; }
  const idx = bugs.findIndex(b => b.id === id);
  if (idx !== -1) Object.assign(bugs[idx], data || changes);
  renderAll();
  loadLastActivity();
}

async function deleteBug(id) {
  if (!confirm('Delete this bug?')) return;
  const { error } = await db.from('bugs').delete().eq('id', id);
  if (error) { alert('Error deleting bug: ' + error.message); return; }
  bugs = bugs.filter(b => b.id !== id);
  renderAll();
  loadLastActivity();
}

// ── Render ────────────────────────────────────────────────────────────────────

function assigneeKey(b) {
  return ASSIGNEES.includes(b.assigned_to) ? b.assigned_to : '';
}

// Comparators for the Sort control. Each falls back to created order so the
// board is stable when two cards tie.
const SORTERS = {
  created:  (a, b) => (a.created_at || '').localeCompare(b.created_at || ''),
  updated:  (a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''),
  assignee: (a, b) => ((ASSIGNEE_ORDER[assigneeKey(a)] ?? 9) - (ASSIGNEE_ORDER[assigneeKey(b)] ?? 9))
                      || SORTERS.created(a, b),
  severity: (a, b) => ((SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
                      || SORTERS.created(a, b),
};

function filteredBugs() {
  const q        = document.getElementById('searchInput').value.toLowerCase();
  const category = document.getElementById('categoryFilter').value;
  const assignee = document.getElementById('assigneeFilter').value;
  const sortKey  = document.getElementById('sortSelect').value;
  const list = bugs.filter(b => {
    if (category && (b.category || '') !== category) return false;
    if (assignee === '__none') { if (assigneeKey(b)) return false; }
    else if (assignee && assigneeKey(b) !== assignee) return false;
    if (q) {
      // "#42", "42" and free text all search; an exact number match wins
      const needle = q.replace(/^#/, '');
      const matchesRef = b.ref != null && String(b.ref) === needle;
      if (!matchesRef &&
          !b.title.toLowerCase().includes(q) &&
          !(b.notes || '').toLowerCase().includes(q) &&
          !(b.steps || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });
  return list.sort(SORTERS[sortKey] || SORTERS.created);
}

// "Davis (4)" in the filter menu: how many live cards each person owns right
// now, so the count is visible before you filter — and Unassigned shows up
// only if the database rule ever lets one through.
function renderAssigneeCounts() {
  const sel = document.getElementById('assigneeFilter');
  const live = bugs.filter(b => b.status !== 'closed');
  for (const opt of sel.options) {
    if (!opt.value) { opt.textContent = `Everyone (${live.length})`; continue; }
    const n = opt.value === '__none'
      ? live.filter(b => !assigneeKey(b)).length
      : live.filter(b => assigneeKey(b) === opt.value).length;
    opt.textContent = `${opt.value === '__none' ? 'Unassigned' : opt.value} (${n})`;
    opt.hidden = opt.value === '__none' && n === 0;
  }
}

function renderAll() {
  const list = filteredBugs();
  renderAssigneeCounts();

  // Stats
  document.getElementById('statTotal').textContent      = bugs.length;
  document.getElementById('statOpen').textContent       = bugs.filter(b => b.status === 'open').length;
  document.getElementById('statFeaturesOpen').textContent = bugs.filter(b => b.status === 'features-open').length;
  document.getElementById('statQuestions').textContent  = bugs.filter(b => b.status === 'questions').length;
  document.getElementById('statInProgress').textContent = bugs.filter(b => b.status === 'in-progress').length;
  document.getElementById('statClosed').textContent     = bugs.filter(b => b.status === 'closed').length;

  // Columns
  for (const status of STATUSES) {
    const col   = document.getElementById(`col-${status}`);
    const count = document.getElementById(`count-${status}`);
    const items = list.filter(b => b.status === status);
    count.textContent = items.length;
    const tabCount = document.getElementById(`tab-count-${status}`);
    if (tabCount) tabCount.textContent = items.length;
    col.innerHTML = items.length === 0
      ? `<div class="empty-state">No bugs</div>`
      : items.map(bugCard).join('');
  }

  // Re-attach drag events
  document.querySelectorAll('.bug-card').forEach(card => {
    card.addEventListener('dragstart', onDragStart);
    card.addEventListener('dragend',   onDragEnd);
  });
}

// Update the "updated X ago" badges in place, without rebuilding the board
function refreshCardTimestamps() {
  document.querySelectorAll('.badge-updated').forEach(el => {
    const ts = el.dataset.ts;
    if (!ts) return;
    el.textContent = relativeTime(ts);
    el.classList.toggle('recent', (Date.now() - new Date(ts).getTime()) < 3600000);
  });
}

function bugCard(b) {
  const categoryLabel = b.category
    ? `<span class="badge badge-category">${escHtml(b.category)}</span>`
    : '';
  const reporterLabel = b.reporter
    ? `<span class="badge badge-reporter">${escHtml(b.reporter)}</span>`
    : '';
  const owner = assigneeKey(b);
  const assigneeLabel = owner
    ? `<span class="badge badge-assignee assignee-${owner.toLowerCase()}" title="Assigned to ${owner}">${owner}</span>`
    : (b.status === 'closed' ? '' : `<span class="badge badge-assignee assignee-none" title="Nobody owns this yet">Unassigned</span>`);
  const touched      = b.updated_at || b.created_at;
  const isRecent     = touched && (Date.now() - new Date(touched).getTime()) < 3600000;
  const updatedLabel = touched
    ? `<span class="badge badge-updated${isRecent ? ' recent' : ''}" data-ts="${escHtml(touched)}" title="Last changed ${escHtml(new Date(touched).toLocaleString())}">${escHtml(relativeTime(touched))}</span>`
    : '';
  return `
    <div class="bug-card" draggable="true" data-id="${escHtml(b.id)}">
      <div class="bug-title">
        <button type="button" class="bug-ref" data-ref="${escHtml(b.ref ?? '')}" title="Copy #${escHtml(b.ref ?? '')} to clipboard">#${escHtml(b.ref ?? '?')}</button>
        <span class="bug-title-text">${escHtml(b.title)}</span>
      </div>
      <div class="bug-meta">
        ${assigneeLabel}
        ${categoryLabel}
        ${b.loe ? `<span class="badge badge-loe loe-${escHtml(String(b.loe).toLowerCase())}">LOE: ${escHtml(b.loe)}</span>` : ''}
        ${reporterLabel}
        ${updatedLabel}
      </div>
      ${b.steps ? `<div class="bug-steps">${escHtml(b.steps)}</div>` : ''}
      ${b.notes ? `<div class="bug-notes">${escHtml(b.notes)}</div>` : ''}
      ${CARD_SECTIONS.filter(([key]) => b[key]).map(([key, label]) => `
        <div class="bug-section section-${key}">
          <span class="bug-section-label">${label}</span>
          <div class="bug-section-text">${escHtml(b[key])}</div>
        </div>`).join('')}
      ${(b.attachments && b.attachments.length) ? `<div class="bug-attachments">${b.attachments.map(u => `<img src="${escHtml(u)}" alt="attachment" />`).join('')}</div>` : ''}
      <div class="bug-actions">
        <select class="card-status-select" data-id="${escHtml(b.id)}" title="Move to…">
          ${STATUSES.map(s => `<option value="${s}"${s === b.status ? ' selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
        </select>
        <button class="btn btn-icon edit-btn" data-id="${escHtml(b.id)}" title="Edit">&#9998;</button>
        <button class="btn btn-icon-danger delete-btn" data-id="${escHtml(b.id)}" title="Delete">&#10005;</button>
      </div>
    </div>`;
}

// ── Event delegation ──────────────────────────────────────────────────────────

document.getElementById('board').addEventListener('click', e => {
  const refBtn    = e.target.closest('.bug-ref');
  const editBtn   = e.target.closest('.edit-btn');
  const deleteBtn = e.target.closest('.delete-btn');
  if (refBtn)    { e.stopPropagation(); copyBugRef(refBtn); return; }
  if (editBtn)   openEditModal(editBtn.dataset.id);
  if (deleteBtn) deleteBug(deleteBtn.dataset.id);
});

// Tap the number to copy "#42" — the handle you quote when talking to Claude
async function copyBugRef(btn) {
  const ref = btn.dataset.ref;
  if (!ref) return;
  try {
    await navigator.clipboard.writeText('#' + ref);
    const orig = btn.textContent;
    btn.textContent = 'copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1200);
  } catch {
    // Clipboard blocked (common in iOS standalone) — select it so it can be
    // copied by hand rather than failing silently
    const r = document.createRange();
    r.selectNodeContents(btn);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
}

// Double-click (or double-tap) anywhere on a card opens it for editing
document.getElementById('board').addEventListener('dblclick', e => {
  const card = e.target.closest('.bug-card');
  if (!card) return;
  if (e.target.closest('.bug-actions, .bug-ref')) return; // these keep their own behavior
  openEditModal(card.dataset.id);
});

// Per-card status dropdown (mobile-friendly alternative to drag & drop)
document.getElementById('board').addEventListener('change', async e => {
  const sel = e.target.closest('.card-status-select');
  if (sel) await updateBug(sel.dataset.id, { status: sel.value });
});

// ── Mobile status tabs ────────────────────────────────────────────────────────

document.getElementById('mobileTabs').addEventListener('click', e => {
  const tab = e.target.closest('.mobile-tab');
  if (!tab) return;
  document.querySelectorAll('.mobile-tab').forEach(t => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.column').forEach(c =>
    c.classList.toggle('mobile-active', c.dataset.status === tab.dataset.status));
});

// Collapsible "Report a Bug" form (collapsed by default on mobile)
document.getElementById('formToggle').addEventListener('click', () => {
  document.getElementById('formBar').classList.toggle('open');
});

// ── New-bug attachments (staged in the Report a Bug form) ────────────────────

let newBugAttachments = [];
let pendingBugId = null; // pre-generated so uploads land under the bug's storage folder

function renderNewBugAttachments(extraHtml = '') {
  const list = document.getElementById('newBugAttachmentsList');
  list.innerHTML = newBugAttachments.map((url, i) => `
    <div class="attachment-thumb">
      <img src="${escHtml(url)}" alt="attachment" />
      <button type="button" class="attachment-remove" data-idx="${i}" title="Remove">&times;</button>
    </div>`).join('') + extraHtml;
}

async function handleNewBugFiles(files) {
  const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
  if (imageFiles.length === 0) return;
  if (!pendingBugId) pendingBugId = uid();
  renderNewBugAttachments(imageFiles.map(() => `<div class="attachment-uploading">Uploading…</div>`).join(''));
  const urls = await Promise.all(imageFiles.map(f => uploadAttachmentFile(f, pendingBugId)));
  urls.filter(Boolean).forEach(u => newBugAttachments.push(u));
  renderNewBugAttachments();
}

document.getElementById('newBugAttachmentInput').addEventListener('change', async e => {
  await handleNewBugFiles(e.target.files);
  e.target.value = '';
});

document.getElementById('newBugAttachmentsList').addEventListener('click', e => {
  const removeBtn = e.target.closest('.attachment-remove');
  if (!removeBtn) return;
  newBugAttachments.splice(parseInt(removeBtn.dataset.idx, 10), 1);
  renderNewBugAttachments();
});

// Read image(s) off the system clipboard via the async Clipboard API.
// On iOS this is the only reliable way to paste a copied screenshot —
// tapping the button triggers the system's paste-permission bubble.
async function readClipboardImages() {
  if (!navigator.clipboard || !navigator.clipboard.read) return null;
  const items = await navigator.clipboard.read();
  const files = [];
  for (const item of items) {
    const type = item.types.find(t => t.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    files.push(new File([blob], `pasted.${type.split('/')[1] || 'png'}`, { type }));
  }
  return files;
}

function flashAttachHint(msg) {
  // The hint row is empty by default so it takes no space — it only appears
  // to carry a transient message, then clears itself.
  const hint = document.getElementById('newBugAttachHint');
  hint.textContent = msg;
  setTimeout(() => { hint.textContent = ''; }, 3000);
}

document.getElementById('newBugPasteBtn').addEventListener('click', async () => {
  try {
    const files = await readClipboardImages();
    if (files === null) { flashAttachHint('Pasting not supported in this browser — use Add screenshots'); return; }
    if (files.length === 0) { flashAttachHint('No image on the clipboard — copy a screenshot first'); return; }
    await handleNewBugFiles(files);
  } catch (e) {
    flashAttachHint('Clipboard access was blocked — use Add screenshots instead');
  }
});

document.getElementById('editPasteBtn').addEventListener('click', async () => {
  try {
    const files = await readClipboardImages();
    if (files && files.length) await handleAttachmentFiles(files);
    else alert(files === null ? 'Pasting not supported in this browser.' : 'No image on the clipboard — copy a screenshot first.');
  } catch (e) {
    alert('Clipboard access was blocked — use the file picker instead.');
  }
});

// Paste a screenshot anywhere in the form bar to stage it on the new bug
document.getElementById('formBar').addEventListener('paste', async e => {
  const cd = e.clipboardData;
  if (!cd) return;
  const files = [];
  for (const f of (cd.files || [])) {
    if (f.type.startsWith('image/')) files.push(f);
  }
  if (files.length === 0) {
    for (const it of (cd.items || [])) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (files.length) {
    e.preventDefault();
    await handleNewBugFiles(files);
  }
});

// ── Add Bug ───────────────────────────────────────────────────────────────────

document.getElementById('addBugBtn').addEventListener('click', async () => {
  const title = document.getElementById('bugTitle').value.trim();
  if (!title) { document.getElementById('bugTitle').focus(); return; }

  const bug = {
    id:          pendingBugId || uid(),
    title,
    category:    document.getElementById('bugCategory').value,
    status:      document.getElementById('bugStatus').value,
    // Blank means "let the column decide" — the database fills it in.
    assigned_to: document.getElementById('bugAssignee').value || null,
    reporter:    currentUser?.email || '',
    steps:       '',
    notes:       '',
    attachments: newBugAttachments,
    created_at:  new Date().toISOString(),
  };

  await addBug(bug);

  newBugAttachments = [];
  pendingBugId = null;
  renderNewBugAttachments();
  document.getElementById('bugTitle').value = '';
  document.getElementById('bugCategory').value  = '';
  document.getElementById('bugStatus').value    = 'open';
  document.getElementById('bugAssignee').value  = '';
  if (!TOUCH_DEVICE) document.getElementById('bugTitle').focus();
});

document.getElementById('bugTitle').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('addBugBtn').click();
});

// ── Filters ───────────────────────────────────────────────────────────────────

document.getElementById('searchInput').addEventListener('input', renderAll);
document.getElementById('categoryFilter').addEventListener('change', renderAll);

// The assignee filter and sort stick per device (Davis's phone stays on
// "Davis"), and can be preset from the URL so Stevo HQ can deep-link straight
// to one person's cards: ?assignee=Davis, ?sort=assignee, ?ref=42.
const VIEW_PREFS = 'bugtracker.view';

function loadViewPrefs() {
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(VIEW_PREFS) || '{}'); } catch { /* ignore */ }
  const params = new URLSearchParams(location.search);
  const assignee = params.get('assignee') ?? prefs.assignee ?? '';
  const sort     = params.get('sort')     ?? prefs.sort     ?? 'created';
  const ref      = params.get('ref');
  const assigneeSel = document.getElementById('assigneeFilter');
  const sortSel     = document.getElementById('sortSelect');
  if ([...assigneeSel.options].some(o => o.value === assignee)) assigneeSel.value = assignee;
  if (SORTERS[sort]) sortSel.value = sort;
  if (ref) {
    // A link to one card: show it regardless of who owns it
    assigneeSel.value = '';
    document.getElementById('searchInput').value = '#' + ref.replace(/^#/, '');
  }
}

function saveViewPrefs() {
  try {
    localStorage.setItem(VIEW_PREFS, JSON.stringify({
      assignee: document.getElementById('assigneeFilter').value,
      sort:     document.getElementById('sortSelect').value,
    }));
  } catch { /* private mode etc. */ }
}

document.getElementById('assigneeFilter').addEventListener('change', () => { saveViewPrefs(); renderAll(); });
document.getElementById('sortSelect').addEventListener('change',     () => { saveViewPrefs(); renderAll(); });
loadViewPrefs();

// ── Drag & drop ───────────────────────────────────────────────────────────────

let draggedId = null;

function onDragStart(e) {
  draggedId = e.currentTarget.dataset.id;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  draggedId = null;
}

document.querySelectorAll('.column').forEach(col => {
  col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
  col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
  col.addEventListener('drop', async e => {
    e.preventDefault();
    col.classList.remove('drag-over');
    if (!draggedId) return;
    const newStatus = col.dataset.status;
    const bug = bugs.find(b => b.id === draggedId);
    if (bug && bug.status !== newStatus) await updateBug(draggedId, { status: newStatus });
  });
});

// ── Edit Modal ────────────────────────────────────────────────────────────────

let editingBugId = null;
let editingAttachments = [];

// Auto-size modal textareas to fit their content — no inner scrollbars,
// no manual resizing. The modal itself scrolls if a card is very long.
const MODAL_TEXTAREAS = ['editSteps', 'editNotes', 'editQuestion', 'editAnswer', 'editWhatWasDone', 'editHowToTest', 'editFeedback'];

function autosizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = (el.scrollHeight + 2) + 'px';
}

MODAL_TEXTAREAS.forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener('input', () => autosizeTextarea(el));
});

function openEditModal(id) {
  const b = bugs.find(b => b.id === id);
  if (!b) return;
  editingBugId = id;
  editingAttachments = Array.isArray(b.attachments) ? [...b.attachments] : [];
  document.getElementById('editModalTitle').textContent =
    b.ref != null ? `Edit #${b.ref}` : 'Edit Bug';
  document.getElementById('editTitle').value      = b.title;
  document.getElementById('editCategory').value   = b.category || '';
  document.getElementById('editLoe').value        = b.loe || '';
  document.getElementById('editStatus').value     = b.status;
  document.getElementById('editAssignee').value   = assigneeKey(b) || (b.status === 'closed' ? 'Steve' : 'Bots');
  document.getElementById('editReporter').value   = b.reporter   || '';
  document.getElementById('editSteps').value      = b.steps      || '';
  document.getElementById('editNotes').value      = b.notes      || '';
  document.getElementById('editQuestion').value    = b.question      || '';
  document.getElementById('editAnswer').value      = b.answer        || '';
  document.getElementById('editWhatWasDone').value = b.what_was_done || '';
  document.getElementById('editHowToTest').value   = b.how_to_test   || '';
  document.getElementById('editFeedback').value    = b.feedback      || '';
  document.getElementById('editAttachmentInput').value = '';
  renderEditAttachments();
  document.getElementById('editModalBackdrop').classList.add('open');
  // Size the textareas to their content now that the modal is visible
  MODAL_TEXTAREAS.forEach(fieldId => autosizeTextarea(document.getElementById(fieldId)));
  if (!TOUCH_DEVICE) document.getElementById('editTitle').focus();
}

function renderEditAttachments(extraHtml = '') {
  const list = document.getElementById('editAttachmentsList');
  const thumbs = editingAttachments.map((url, i) => `
    <div class="attachment-thumb">
      <img src="${escHtml(url)}" alt="attachment" data-full="${escHtml(url)}" />
      <button type="button" class="attachment-remove" data-idx="${i}" title="Remove">&times;</button>
    </div>`).join('');
  list.innerHTML = thumbs + extraHtml;
}

async function uploadAttachmentFile(file, ownerId) {
  if (!file || !file.type.startsWith('image/')) return null;
  const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const path = `${ownerId || editingBugId || 'new'}/${Date.now()}-${uid()}.${ext}`;
  const { error } = await db.storage.from('bug-attachments').upload(path, file, {
    contentType: file.type,
    upsert: false,
  });
  if (error) { alert('Upload failed: ' + error.message); return null; }
  const { data } = db.storage.from('bug-attachments').getPublicUrl(path);
  return data.publicUrl;
}

async function handleAttachmentFiles(files) {
  const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
  if (imageFiles.length === 0) return;
  // Show placeholder thumbs while uploading
  const placeholders = imageFiles.map(() => `<div class="attachment-uploading">Uploading…</div>`).join('');
  renderEditAttachments(placeholders);
  const urls = await Promise.all(imageFiles.map(uploadAttachmentFile));
  urls.filter(Boolean).forEach(u => editingAttachments.push(u));
  renderEditAttachments();
}

document.getElementById('editAttachmentInput').addEventListener('change', async e => {
  await handleAttachmentFiles(e.target.files);
  e.target.value = '';
});

document.getElementById('editModalBackdrop').addEventListener('paste', async e => {
  if (!editingBugId) return;
  const cd = e.clipboardData;
  if (!cd) return;
  const files = [];
  // Prefer .files (more reliable in modern browsers)
  for (const f of (cd.files || [])) {
    if (f.type.startsWith('image/')) files.push(f);
  }
  // Fallback to .items
  if (files.length === 0) {
    for (const it of (cd.items || [])) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (files.length) {
    e.preventDefault();
    await handleAttachmentFiles(files);
  }
});

document.getElementById('editAttachmentsList').addEventListener('click', e => {
  const removeBtn = e.target.closest('.attachment-remove');
  if (removeBtn) {
    const idx = parseInt(removeBtn.dataset.idx, 10);
    editingAttachments.splice(idx, 1);
    renderEditAttachments();
    return;
  }
  const img = e.target.closest('img[data-full]');
  if (img) window.open(img.dataset.full, '_blank');
});

function closeEditModal() {
  document.getElementById('editModalBackdrop').classList.remove('open');
  editingBugId = null;
}

document.getElementById('editModalCloseBtn').addEventListener('click', closeEditModal);
document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);
document.getElementById('editModalBackdrop').addEventListener('click', e => {
  if (e.target === document.getElementById('editModalBackdrop')) closeEditModal();
});

document.getElementById('editSaveBtn').addEventListener('click', async () => {
  if (!editingBugId) return;
  const title = document.getElementById('editTitle').value.trim();
  if (!title) { document.getElementById('editTitle').focus(); return; }
  await updateBug(editingBugId, {
    title,
    category:    document.getElementById('editCategory').value,
    loe:         document.getElementById('editLoe').value,
    status:      document.getElementById('editStatus').value,
    assigned_to: document.getElementById('editAssignee').value,
    reporter:    document.getElementById('editReporter').value.trim(),
    steps:       document.getElementById('editSteps').value.trim(),
    notes:       document.getElementById('editNotes').value.trim(),
    question:      document.getElementById('editQuestion').value.trim(),
    answer:        document.getElementById('editAnswer').value.trim(),
    what_was_done: document.getElementById('editWhatWasDone').value.trim(),
    how_to_test:   document.getElementById('editHowToTest').value.trim(),
    feedback:      document.getElementById('editFeedback').value.trim(),
    attachments: editingAttachments,
  });
  closeEditModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeEditModal();
});

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  const authed = await initSupabase();
  if (authed) {
    await loadBugs();
    await loadLastActivity();
    await loadLastDeploy();
    startActivityTimers();
  }
})();
