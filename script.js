// ── Supabase config ───────────────────────────────────────────────────────────
// Fill these in after creating your Supabase project.
const SUPABASE_URL = 'https://sztatmknjyzzyzngvpff.supabase.co';
const SUPABASE_KEY = 'sb_publishable_GvPXZ8AVgix3aZ2UDS0YRQ_ktlLvMtB';

// ── State ─────────────────────────────────────────────────────────────────────
let db          = null;
let bugs        = [];
let teamMembers = [];
let currentUser = null;

const STATUSES = ['open', 'features-open', 'questions', 'in-progress', 'in-review', 'closed'];

const STATUS_LABELS = {
  'open':          'Bugs',
  'features-open': 'Features',
  'questions':     'Questions',
  'in-progress':   'In Progress',
  'in-review':     'Review',
  'closed':        'Closed',
};

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
  await loadTeamMembers();
  await loadBugs();
});

document.getElementById('loginPassword').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('loginBtn').click();
});

document.getElementById('signOutBtn').addEventListener('click', async () => {
  await db.auth.signOut();
  currentUser = null;
  bugs = [];
  teamMembers = [];
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

// ── Team Members ──────────────────────────────────────────────────────────────

async function loadTeamMembers() {
  const { data, error } = await db.from('team_members').select('*').order('name');
  if (error) { console.warn('Could not load team members:', error.message); return; }
  teamMembers = data;
  populateAssigneeDropdowns();
}

function populateAssigneeDropdowns() {
  const options = `<option value="">Unassigned</option>` +
    teamMembers.map(m => `<option value="${escHtml(m.name)}">${escHtml(m.name)}</option>`).join('');
  document.getElementById('bugAssignedTo').innerHTML   = options;
  document.getElementById('editAssignedTo').innerHTML  = options;
  // Filter dropdown
  document.getElementById('assigneeFilter').innerHTML =
    `<option value="">All Assignees</option>` +
    teamMembers.map(m => `<option value="${escHtml(m.name)}">${escHtml(m.name)}</option>`).join('');
}

// ── Bugs CRUD ─────────────────────────────────────────────────────────────────

async function loadBugs() {
  const { data, error } = await db.from('bugs').select('*').order('created_at');
  if (error) { setStatus('Error loading bugs: ' + error.message); return; }
  bugs = data;
  renderAll();
  setStatus('Connected');
}

async function addBug(bug) {
  const { data, error } = await db.from('bugs').insert(bug).select().single();
  if (error) { alert('Error adding bug: ' + error.message); return; }
  bugs.push(data);
  renderAll();
}

async function updateBug(id, changes) {
  const { error } = await db.from('bugs').update(changes).eq('id', id);
  if (error) { alert('Error updating bug: ' + error.message); return; }
  const idx = bugs.findIndex(b => b.id === id);
  if (idx !== -1) Object.assign(bugs[idx], changes);
  renderAll();
}

async function deleteBug(id) {
  if (!confirm('Delete this bug?')) return;
  const { error } = await db.from('bugs').delete().eq('id', id);
  if (error) { alert('Error deleting bug: ' + error.message); return; }
  bugs = bugs.filter(b => b.id !== id);
  renderAll();
}

// ── Render ────────────────────────────────────────────────────────────────────

const SEVERITY_CLASS = {
  Critical: 'severity-critical',
  High:     'severity-high',
  Medium:   'severity-medium',
  Low:      'severity-low',
};

function filteredBugs() {
  const q        = document.getElementById('searchInput').value.toLowerCase();
  const severity = document.getElementById('severityFilter').value;
  const category = document.getElementById('categoryFilter').value;
  const assignee = document.getElementById('assigneeFilter').value;
  return bugs.filter(b => {
    if (severity && b.severity !== severity) return false;
    if (category && (b.category || '') !== category) return false;
    if (assignee && b.assigned_to !== assignee) return false;
    if (q && !b.title.toLowerCase().includes(q) &&
             !(b.notes || '').toLowerCase().includes(q) &&
             !(b.steps || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderAll() {
  const list = filteredBugs();

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

function bugCard(b) {
  const categoryLabel = b.category
    ? `<span class="badge badge-category">${escHtml(b.category)}</span>`
    : '';
  const assignedLabel = b.assigned_to
    ? `<span class="badge badge-assignee">${escHtml(b.assigned_to)}</span>`
    : `<span class="badge badge-unassigned">Unassigned</span>`;
  const reporterLabel = b.reporter
    ? `<span class="badge badge-reporter">${escHtml(b.reporter)}</span>`
    : '';
  return `
    <div class="bug-card" draggable="true" data-id="${escHtml(b.id)}">
      <div class="bug-title">${escHtml(b.title)}</div>
      <div class="bug-meta">
        ${categoryLabel}
        <span class="badge ${SEVERITY_CLASS[b.severity] || 'severity-medium'}">${escHtml(b.severity)}</span>
        ${assignedLabel}
        ${reporterLabel}
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
  const editBtn   = e.target.closest('.edit-btn');
  const deleteBtn = e.target.closest('.delete-btn');
  if (editBtn)   openEditModal(editBtn.dataset.id);
  if (deleteBtn) deleteBug(deleteBtn.dataset.id);
});

// Double-click (or double-tap) anywhere on a card opens it for editing
document.getElementById('board').addEventListener('dblclick', e => {
  const card = e.target.closest('.bug-card');
  if (!card) return;
  if (e.target.closest('.bug-actions')) return; // buttons/dropdown keep their own behavior
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
  const hint = document.getElementById('newBugAttachHint');
  const orig = 'from Photos, or paste a copied screenshot';
  hint.textContent = msg;
  setTimeout(() => { hint.textContent = orig; }, 3000);
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
    severity:    document.getElementById('bugSeverity').value,
    status:      document.getElementById('bugStatus').value,
    assigned_to: document.getElementById('bugAssignedTo').value,
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
  document.getElementById('bugSeverity').value  = 'Medium';
  document.getElementById('bugStatus').value    = 'open';
  document.getElementById('bugAssignedTo').value = '';
  if (!TOUCH_DEVICE) document.getElementById('bugTitle').focus();
});

document.getElementById('bugTitle').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('addBugBtn').click();
});

// ── Filters ───────────────────────────────────────────────────────────────────

document.getElementById('searchInput').addEventListener('input', renderAll);
document.getElementById('severityFilter').addEventListener('change', renderAll);
document.getElementById('categoryFilter').addEventListener('change', renderAll);
document.getElementById('assigneeFilter').addEventListener('change', renderAll);

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

function openEditModal(id) {
  const b = bugs.find(b => b.id === id);
  if (!b) return;
  editingBugId = id;
  editingAttachments = Array.isArray(b.attachments) ? [...b.attachments] : [];
  document.getElementById('editTitle').value      = b.title;
  document.getElementById('editCategory').value   = b.category || '';
  document.getElementById('editSeverity').value   = b.severity;
  document.getElementById('editStatus').value     = b.status;
  document.getElementById('editAssignedTo').value = b.assigned_to || '';
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
    severity:    document.getElementById('editSeverity').value,
    status:      document.getElementById('editStatus').value,
    assigned_to: document.getElementById('editAssignedTo').value,
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
    await loadTeamMembers();
    await loadBugs();
  }
})();
