// ── Supabase config ───────────────────────────────────────────────────────────
// Fill these in after creating your Supabase project.
const SUPABASE_URL = 'https://sztatmknjyzzyzngvpff.supabase.co';
const SUPABASE_KEY = 'sb_publishable_GvPXZ8AVgix3aZ2UDS0YRQ_ktlLvMtB';

// ── State ─────────────────────────────────────────────────────────────────────
let db          = null;
let bugs        = [];
let teamMembers = [];
let currentUser = null;

const STATUSES = ['open', 'in-progress', 'in-review', 'closed'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
}

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
  const assignee = document.getElementById('assigneeFilter').value;
  return bugs.filter(b => {
    if (severity && b.severity !== severity) return false;
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
  document.getElementById('statInProgress').textContent = bugs.filter(b => b.status === 'in-progress').length;
  document.getElementById('statClosed').textContent     = bugs.filter(b => b.status === 'closed').length;

  // Columns
  for (const status of STATUSES) {
    const col   = document.getElementById(`col-${status}`);
    const count = document.getElementById(`count-${status}`);
    const items = list.filter(b => b.status === status);
    count.textContent = items.length;
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
        <span class="badge ${SEVERITY_CLASS[b.severity] || 'severity-medium'}">${escHtml(b.severity)}</span>
        ${assignedLabel}
        ${reporterLabel}
      </div>
      ${b.steps ? `<div class="bug-steps">${escHtml(b.steps)}</div>` : ''}
      ${b.notes ? `<div class="bug-notes">${escHtml(b.notes)}</div>` : ''}
      <div class="bug-actions">
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

// ── Add Bug ───────────────────────────────────────────────────────────────────

document.getElementById('addBugBtn').addEventListener('click', async () => {
  const title = document.getElementById('bugTitle').value.trim();
  if (!title) { document.getElementById('bugTitle').focus(); return; }

  const bug = {
    id:          uid(),
    title,
    severity:    document.getElementById('bugSeverity').value,
    status:      document.getElementById('bugStatus').value,
    assigned_to: document.getElementById('bugAssignedTo').value,
    reporter:    currentUser?.email || '',
    steps:       '',
    notes:       '',
    created_at:  new Date().toISOString(),
  };

  await addBug(bug);

  document.getElementById('bugTitle').value = '';
  document.getElementById('bugSeverity').value = 'Medium';
  document.getElementById('bugStatus').value   = 'open';
  document.getElementById('bugAssignedTo').value = '';
  document.getElementById('bugTitle').focus();
});

document.getElementById('bugTitle').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('addBugBtn').click();
});

// ── Filters ───────────────────────────────────────────────────────────────────

document.getElementById('searchInput').addEventListener('input', renderAll);
document.getElementById('severityFilter').addEventListener('change', renderAll);
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

function openEditModal(id) {
  const b = bugs.find(b => b.id === id);
  if (!b) return;
  editingBugId = id;
  document.getElementById('editTitle').value      = b.title;
  document.getElementById('editSeverity').value   = b.severity;
  document.getElementById('editStatus').value     = b.status;
  document.getElementById('editAssignedTo').value = b.assigned_to || '';
  document.getElementById('editReporter').value   = b.reporter   || '';
  document.getElementById('editSteps').value      = b.steps      || '';
  document.getElementById('editNotes').value      = b.notes      || '';
  document.getElementById('editModalBackdrop').classList.add('open');
  document.getElementById('editTitle').focus();
}

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
    severity:    document.getElementById('editSeverity').value,
    status:      document.getElementById('editStatus').value,
    assigned_to: document.getElementById('editAssignedTo').value,
    reporter:    document.getElementById('editReporter').value.trim(),
    steps:       document.getElementById('editSteps').value.trim(),
    notes:       document.getElementById('editNotes').value.trim(),
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
