// === APP STATE ===
let clients = [];
let currentClient = null;
let settings = {};
let facilities = [];
let pcpDirectory = [];
let mcoDirectory = [];
let faxLogData = [];
let uploadedFiles = []; // Array of File objects
let pendingFaxAuthId = null; // Auth ID for the fax modal
let pendingFaxesToPoll = new Set(); // Track in-progress faxes for polling
let authAutoSaveTimeout = null;
let currentCalendarDate = new Date();
let allAuthsForCalendar = [];
let authStepQueue = new Set(['tab-form']);

// Sorting State
let clientsSortField = 'name';
let clientsSortDir = 'asc';
let faxLogSortField = 'fax_sent_date';
let faxLogSortDir = 'desc';

function isPollableFaxStatus(status) {
    return status === 'In Progress' || status === 'Queued';
}

let faxPollingIndicatorTimeout = null;
function setFaxPollingIndicator(state) {
    const syncIndicator = document.getElementById('sync-indicator');
    if (!syncIndicator) return;

    if (faxPollingIndicatorTimeout) {
        clearTimeout(faxPollingIndicatorTimeout);
        faxPollingIndicatorTimeout = null;
    }

    syncIndicator.classList.remove('sent', 'checking');
    if (state === 'checking') {
        syncIndicator.classList.add('checking');
        syncIndicator.innerHTML = '<i class="ph ph-arrows-clockwise ph-spin"></i> Checking fax statuses...';
        syncIndicator.style.display = 'flex';
    } else if (state === 'sent') {
        syncIndicator.classList.add('sent');
        syncIndicator.innerHTML = '<i class="ph ph-check-circle"></i> Fax sent';
        syncIndicator.style.display = 'flex';
        faxPollingIndicatorTimeout = setTimeout(() => {
            syncIndicator.style.display = 'none';
        }, 5000);
    } else {
        syncIndicator.style.display = 'none';
    }
}

// === DOM ELEMENTS ===
const views = document.querySelectorAll('.view');
const navLinks = document.querySelectorAll('.nav-link');
const loadingOverlay = document.getElementById('loading-overlay');
const darkModeToggle = document.getElementById('dark-mode-toggle');

// --- Dark Mode ---
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    if (darkModeToggle) {
        darkModeToggle.checked = savedTheme === 'dark';
    }
}

if (darkModeToggle) {
    darkModeToggle.addEventListener('change', (e) => {
        const theme = e.target.checked ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
    });
}
initTheme();


// --- Navigation ---
function switchView(viewId) {
    views.forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${viewId}`).classList.add('active');

    // Update sidebar nav
    navLinks.forEach(l => {
        if (l.dataset.view) {
            l.classList.toggle('active', l.dataset.view === viewId);
        }
    });

    // Handle view-specific logic
    if (viewId === 'dashboard') loadClients();
    if (viewId === 'settings') loadSettings();
    if (viewId === 'facilities') loadFacilities();
    if (viewId === 'pcp-directory') loadPcpDirectory();
    if (viewId === 'fax-log') loadFaxLog();
    if (viewId === 'calendar') loadCalendar();
}

// Event Listeners for Navigation
document.querySelectorAll('[data-view]').forEach(el => {
    el.addEventListener('click', (e) => {
        e.preventDefault();
        switchView(e.currentTarget.dataset.view);
    });
});

document.querySelectorAll('.nav-back').forEach(el => {
    el.addEventListener('click', (e) => {
        switchView(e.currentTarget.dataset.target);
    });
});

function setAuthFlowError(message = '') {
    const error = document.getElementById('auth-flow-error');
    if (!error) return;
    error.textContent = message;
    error.style.display = message ? 'block' : 'none';
}

function setAuthStep(targetTabId) {
    const pane = document.getElementById(targetTabId);
    const header = document.querySelector(`.tab-header[data-tab="${targetTabId}"]`);
    const container = header && header.closest('.tabs-container');
    if (!pane || !container) return false;

    container.querySelectorAll('.tab-header').forEach(h => h.classList.remove('active'));
    container.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    header.classList.add('active');
    pane.classList.add('active');
    authStepQueue.add(targetTabId);
    setAuthFlowError('');
    return true;
}

function resetAuthStepQueue() {
    authStepQueue = new Set(['tab-form']);
    document.getElementById('auth-generate-step')?.classList.remove('completed');
    document.getElementById('auth-fax-step')?.classList.remove('completed');
    setAuthStep('tab-form');
}

function markAuthGenerated(authId = '') {
    if (authId) {
        const form = document.getElementById('auth-generate-form');
        let input = document.getElementById('auth_id_input');
        if (!input && form) {
            input = document.createElement('input');
            input.type = 'hidden';
            input.id = 'auth_id_input';
            input.name = 'auth_id';
            form.appendChild(input);
        }
        if (input) input.value = authId;
    }
    authStepQueue.add('generate-pdf');
    document.getElementById('auth-generate-step')?.classList.add('completed');
    setAuthFlowError('');
}

function requireGeneratedPdfForFax() {
    const authId = document.getElementById('auth_id_input')?.value;
    if (!authStepQueue.has('generate-pdf') || !authId) {
        setAuthFlowError('Generate the PDF before starting the optional fax step.');
        return false;
    }
    return true;
}

function requireAuthStep(targetTabId) {
    const required = {
        'tab-attachments': ['tab-form'],
        'tab-actions': ['tab-form', 'tab-attachments']
    }[targetTabId] || [];
    const missing = required.find(step => !authStepQueue.has(step));
    if (missing) {
        setAuthStep(missing);
        setAuthFlowError('Complete the authorization workflow in order: 1 Form Data, 2 Attachments, 3 Actions & History.');
        return false;
    }
    return true;
}

function canEnterAuthStep(targetTabId) {
    const form = document.getElementById('auth-generate-form');
    if (targetTabId === 'tab-attachments' || targetTabId === 'tab-actions') {
        if (form && !form.checkValidity()) {
            setAuthStep('tab-form');
            setAuthFlowError('Finish required form data before moving to attachments.');
            setTimeout(() => form.reportValidity(), 50);
            return false;
        }
    }
    return requireAuthStep(targetTabId);
}

// Tab Switching Logic
document.querySelectorAll('.tab-header').forEach(header => {
    header.addEventListener('click', (e) => {
        const targetTabId = e.currentTarget.dataset.tab;
        if (canEnterAuthStep(targetTabId)) setAuthStep(targetTabId);
    });
});

// --- UnitedHealthcare Logic ---
window.checkUhcStatus = () => {
    const mcoSelect = document.querySelector('select[name="mco"]');
    const warning = document.getElementById('uhc-portal-warning');
    const faxBtn = document.getElementById('btn-send-fax');

    if (!mcoSelect) return;

    if (mcoSelect.value === 'united') {
        if (warning) warning.style.display = 'block';
        if (faxBtn) faxBtn.style.display = 'none';
        const layer = document.getElementById('inline-fax-layer');
        if (layer) layer.style.display = 'none';
    } else {
        if (warning) warning.style.display = 'none';
        if (faxBtn) faxBtn.style.display = 'inline-flex';
    }
};
document.querySelector('select[name="mco"]')?.addEventListener('change', window.checkUhcStatus);

document.getElementById('btn-add-client').addEventListener('click', () => {
    document.getElementById('client-form').reset();
    document.getElementById('client_id').value = '';
    setInsuranceInjuryDefaults();
    clearPcpMatchStatus();
    const hiddenIqId = document.getElementById('c_intakeq_client_id');
    if (hiddenIqId) hiddenIqId.value = '';
    ['c_intakeq_pcp_field_id', 'c_intakeq_pcp_phone_field_id', 'c_intakeq_pcp_npi_field_id'].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.value = '';
    });
    document.getElementById('client-form-title').innerText = 'New Client';
    ensurePcpDirectoryLoaded().then(() => {
        populateClientPcpSelect();
        switchView('client-form');
    });
});

// === API CALLS & DATA HANDLING ===
const API_BASE = '/api';

// --- Clients ---
async function loadClients() {
    try {
        const res = await fetch(`${API_BASE}/clients`);
        clients = await res.json();
        renderClientsTable(clients);
    } catch (err) {
        console.error("Error loading clients:", err);
    }
}

function renderClientsTable(data) {
    const tbody = document.querySelector('#clients-table tbody');
    tbody.replaceChildren();

    if (data.length === 0) {
        appendEmptyRow(tbody, 5, 'No clients found. Add one to get started.');
        return;
    }

    data.forEach(client => {
        const tr = document.createElement('tr');
        appendTextCell(tr, client.name || '--', { fontWeight: '600' });
        appendTextCell(tr, client.medicaid_id || '--');
        appendTextCell(tr, client.mco_id || '--');
        appendTextCell(tr, client.dob || '--');
        const actions = appendActionsCell(tr);
        actions.appendChild(createIconButton('View', 'ph ph-eye', () => viewClient(client.id)));
        actions.appendChild(createIconButton('Edit', 'ph ph-pencil-simple', () => editClient(client.id)));
        actions.appendChild(createIconButton('Delete', 'ph ph-trash', () => deleteClient(client.id), { danger: true }));
        tbody.appendChild(tr);
    });
}

function appendEmptyRow(tbody, colspan, message) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = colspan;
    td.style.textAlign = 'center';
    td.style.color = '#666';
    td.textContent = message;
    tr.appendChild(td);
    tbody.appendChild(tr);
}

function appendTextCell(row, value, styles = {}) {
    const cell = document.createElement('td');
    cell.textContent = value == null || value === '' ? '--' : String(value);
    Object.assign(cell.style, styles);
    row.appendChild(cell);
    return cell;
}

function appendActionsCell(row) {
    const cell = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.gap = '4px';
    wrap.style.alignItems = 'center';
    cell.appendChild(wrap);
    row.appendChild(cell);
    return wrap;
}

function createIconButton(title, iconClass, onClick, options = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost';
    button.title = title;
    if (options.danger) button.style.color = 'var(--danger)';
    const icon = document.createElement('i');
    icon.className = iconClass;
    button.appendChild(icon);
    if (options.text) {
        button.appendChild(document.createTextNode(` ${options.text}`));
    }
    button.addEventListener('click', onClick);
    return button;
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function ensurePcpDirectoryLoaded() {
    if (pcpDirectory.length === 0) {
        await loadPcpDirectory();
    }
}

function populateClientPcpSelect(selectedId = '') {
    const select = document.getElementById('c_pcp_existing');
    if (!select) return;
    select.innerHTML = '<option value="">Select existing PCP...</option>';
    pcpDirectory.forEach(pcp => {
        const option = document.createElement('option');
        option.value = pcp.id;
        option.textContent = pcp.name || '';
        option.selected = String(pcp.id) === String(selectedId);
        select.appendChild(option);
    });
}

function normalizeDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizeLookupText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function setInsuranceInjuryDefaults() {
    ['c_work_injury', 'c_mva', 'c_other_insurance'].forEach(id => {
        const select = document.getElementById(id);
        if (select) select.value = 'no';
    });
}

function setPcpMatchStatus(message = '') {
    const status = document.getElementById('pcp-match-status');
    if (status) status.textContent = message;
}

function clearPcpMatchStatus() {
    setPcpMatchStatus('');
    ['c_pcp_existing', 'c_pcp', 'c_pcp_phone', 'c_pcp_npi'].forEach(id => {
        document.getElementById(id)?.classList.remove('pcp-found-highlight');
    });
}

function fillClientPcpFields(pcp, { showFound = false } = {}) {
    if (!pcp) return;
    const select = document.getElementById('c_pcp_existing');
    if (select) {
        select.value = pcp.id;
        select.classList.toggle('pcp-found-highlight', showFound);
    }
    document.getElementById('c_pcp').value = pcp.name || '';
    document.getElementById('c_pcp_phone').value = pcp.phone || '';
    document.getElementById('c_pcp_npi').value = pcp.npi || '';
    ['c_pcp', 'c_pcp_phone', 'c_pcp_npi'].forEach(id => {
        document.getElementById(id)?.classList.toggle('pcp-found-highlight', showFound);
    });
    setPcpMatchStatus(showFound ? 'PCP found' : '');
}

function findExistingPcpMatch() {
    const npi = normalizeDigits(document.getElementById('c_pcp_npi')?.value);
    const phone = normalizeDigits(document.getElementById('c_pcp_phone')?.value);
    const name = normalizeLookupText(document.getElementById('c_pcp')?.value);

    if (npi) {
        const match = pcpDirectory.find(pcp => normalizeDigits(pcp.npi) === npi);
        if (match) return match;
    }
    if (phone.length >= 7) {
        const match = pcpDirectory.find(pcp => normalizeDigits(pcp.phone) === phone);
        if (match) return match;
    }
    if (name) {
        const match = pcpDirectory.find(pcp => normalizeLookupText(pcp.name) === name);
        if (match) return match;
    }
    return null;
}

async function checkForExistingPcp() {
    await ensurePcpDirectoryLoaded();
    const match = findExistingPcpMatch();
    if (match) {
        fillClientPcpFields(match, { showFound: true });
    } else {
        const selectedId = document.getElementById('c_pcp_existing')?.value;
        if (!selectedId) clearPcpMatchStatus();
    }
}

document.getElementById('c_pcp_existing')?.addEventListener('change', (e) => {
    const pcp = pcpDirectory.find(item => String(item.id) === String(e.target.value));
    if (!pcp) {
        clearPcpMatchStatus();
        return;
    }
    fillClientPcpFields(pcp);
});

['c_pcp', 'c_pcp_phone', 'c_pcp_npi'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', checkForExistingPcp);
    document.getElementById(id)?.addEventListener('blur', checkForExistingPcp);
});

window.sortClients = (field) => {
    if (clientsSortField === field) {
        clientsSortDir = clientsSortDir === 'asc' ? 'desc' : 'asc';
    } else {
        clientsSortField = field;
        clientsSortDir = 'asc';
    }
    
    clients.sort((a, b) => {
        let valA = a[field] || '';
        let valB = b[field] || '';
        if (typeof valA === 'string') {
            valA = valA.toLowerCase();
            valB = valB.toLowerCase();
        }
        if (valA < valB) return clientsSortDir === 'asc' ? -1 : 1;
        if (valA > valB) return clientsSortDir === 'asc' ? 1 : -1;
        return 0;
    });
    
    renderClientsTable(clients);
};

// Client Search
document.getElementById('client-search').addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase();
    const filtered = clients.filter(c => c.name.toLowerCase().includes(term) || (c.medicaid_id && c.medicaid_id.includes(term)));
    renderClientsTable(filtered);
});

// --- Fax Log ---
async function loadFaxLog() {
    try {
        const res = await fetch(`${API_BASE}/fax-log`);
        faxLogData = await res.json();
        renderFaxLogTable(faxLogData);
    } catch (err) {
        console.error("Error loading fax log:", err);
    }
}

function renderFaxLogTable(data) {
    const tbody = document.getElementById('fax-log-body');
    if (!tbody) return;
    tbody.replaceChildren();

    if (!Array.isArray(data) || data.length === 0) {
        appendEmptyRow(tbody, 5, 'No fax history found.');
        return;
    }

    data.forEach(item => {
        const date = new Date(item.fax_sent_date || item.date_created).toLocaleString();
        
        // Status Badge
        let statusBadge = '';
        if (item.fax_status === 'Sent' || item.fax_status === 'Success') {
            statusBadge = '<span style="background:#22c55e;color:#fff;padding:2px 8px;border-radius:12px;font-size:0.75rem;">✓ Sent</span>';
            pendingFaxesToPoll.delete(item.id);
        } else if (isPollableFaxStatus(item.fax_status)) {
            statusBadge = '<span style="background:#f59e0b;color:#fff;padding:2px 8px;border-radius:12px;font-size:0.75rem;"><i class="ph ph-spinner ph-spin pulse-glow"></i> Polling</span>';
            pendingFaxesToPoll.add(item.id);
        } else if (item.fax_status === 'Failed' || item.fax_status?.includes('Error')) {
            statusBadge = '<span style="background:#ef4444;color:#fff;padding:4px 10px;border-radius:12px;font-size:0.8rem;font-weight:bold;border:2px solid #7f1d1d;text-transform:uppercase;">🚨 Failed</span>';
            pendingFaxesToPoll.delete(item.id);
        } else {
            statusBadge = '<span style="background:#94a3b8;color:#fff;padding:2px 8px;border-radius:12px;font-size:0.75rem;">' + escapeHtml(item.fax_status || 'Unknown') + '</span>';
            pendingFaxesToPoll.delete(item.id);
        }

        const tr = document.createElement('tr');
        appendTextCell(tr, item.client_name || '--', { fontWeight: '600' });
        appendTextCell(tr, date);
        appendTextCell(tr, item.fax_to_number || '--');
        const statusCell = document.createElement('td');
        statusCell.innerHTML = statusBadge;
        tr.appendChild(statusCell);
        const actions = appendActionsCell(tr);
        actions.appendChild(createIconButton('View Client Row', 'ph ph-eye', () => viewClient(item.client_id), { text: 'View Client Row' }));
        tbody.appendChild(tr);
    });
}

// Fax Log Sorting
window.sortFaxLog = (field) => {
    if (faxLogSortField === field) {
        faxLogSortDir = faxLogSortDir === 'asc' ? 'desc' : 'asc';
    } else {
        faxLogSortField = field;
        faxLogSortDir = 'asc';
    }
    
    faxLogData.sort((a, b) => {
        let valA = a[field] || '';
        let valB = b[field] || '';
        if (typeof valA === 'string' && field !== 'fax_sent_date') {
            valA = valA.toLowerCase();
            valB = valB.toLowerCase();
        }
        if (valA < valB) return faxLogSortDir === 'asc' ? -1 : 1;
        if (valA > valB) return faxLogSortDir === 'asc' ? 1 : -1;
        return 0;
    });
    
    renderFaxLogTable(faxLogData);
};

// === Feature #2: Sync from IntakeQ ===
document.getElementById('btn-sync-intakeq').addEventListener('click', async () => {
    const nameInput = document.getElementById('c_name');
    const searchName = nameInput.value.trim();

    if (!searchName) {
        alert("Enter a client name first, then click Sync from IntakeQ to find matching clients.");
        return;
    }

    const panel = document.getElementById('intakeq-sync-panel');
    const results = document.getElementById('intakeq-sync-results');
    const loader = document.getElementById('intakeq-sync-loading');
    const errDiv = document.getElementById('intakeq-sync-error');

    panel.style.display = 'block';
    results.innerHTML = '';
    errDiv.style.display = 'none';
    loader.style.display = 'block';

    try {
        const res = await fetch(`${API_BASE}/intakeq/client-search?name=${encodeURIComponent(searchName)}`);
        const raw = await res.text();
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }

        if (!res.ok) {
            const parts = [data.error || `Failed to search IntakeQ (HTTP ${res.status})`];
            if (data.upstreamStatus) parts.push(`IntakeQ HTTP ${data.upstreamStatus}`);
            if (data.detail) parts.push(data.detail);
            if (data.traceId) parts.push(`Trace ${data.traceId}`);
            throw new Error(parts.join(' - '));
        }

        loader.style.display = 'none';

        if (!Array.isArray(data) || data.length === 0) {
            results.innerHTML = '<li style="color:#666; padding: 8px 0;">No matching clients found in IntakeQ.</li>';
            return;
        }

        data.forEach(client => {
            const dob = client.DateOfBirth ? new Date(client.DateOfBirth).toLocaleDateString() : 'N/A';
            const displayName = client.Name || `${client.FirstName || ''} ${client.LastName || ''}`.trim();
            const li = document.createElement('li');
            li.style.cssText = 'border: 1px solid rgba(99,102,241,0.3); border-radius:8px; padding:10px 14px; margin-bottom:8px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; background:rgba(99,102,241,0.04);';
            li.innerHTML = `
                <div>
                    <strong>${escapeHtml(displayName)}</strong>
                    <span style="font-size:0.8rem; color:#666; margin-left:8px;">DOB: ${escapeHtml(dob)}</span>
                    ${client.PrimaryInsuranceCompany ? `<span style="font-size:0.8rem; color:#666; margin-left:8px;">Ins: ${escapeHtml(client.PrimaryInsuranceCompany)}</span>` : ''}
                </div>
                <button class="btn btn-secondary btn-sm">Import <i class="ph ph-arrow-right"></i></button>
            `;
            li.addEventListener('click', () => applyIntakeqClientData(client));
            results.appendChild(li);
        });

    } catch (err) {
        loader.style.display = 'none';
        errDiv.textContent = 'Error: ' + err.message;
        errDiv.style.display = 'block';
    }
});

function mapImportedPolicyNumber(policyNumber) {
    const value = String(policyNumber || '').trim();
    if (!value) return { medicaid_id: '', mco_id: '' };
    return /^(00|000)/.test(value)
        ? { medicaid_id: value, mco_id: '' }
        : { medicaid_id: '', mco_id: value };
}

function applyIntakeqClientData(client) {
    // Map IntakeQ fields to local client form fields
    const name = client.Name || `${client.FirstName || ''} ${client.LastName || ''}`.trim();
    if (name) document.getElementById('c_name').value = name;

    // DOB: IntakeQ returns Unix timestamp in ms
    if (client.DateOfBirth) {
        const dob = new Date(client.DateOfBirth);
        const dobStr = dob.toISOString().split('T')[0]; // yyyy-MM-dd
        document.getElementById('c_dob').value = dobStr;
    }

    // Insurance
    if (client.PrimaryInsuranceCompany) {
        document.getElementById('c_insurer').value = client.PrimaryInsuranceCompany;
        document.getElementById('c_other_insurance').value = 'yes';
    }
    // Policy # — classify by the local leading-zero Medicaid convention.
    if (client.PrimaryInsurancePolicyNumber) {
        const mappedPolicy = mapImportedPolicyNumber(client.PrimaryInsurancePolicyNumber);
        document.getElementById('c_medicaid_id').value = mappedPolicy.medicaid_id;
        document.getElementById('c_mco_id').value = mappedPolicy.mco_id;
    }

    const pcpCustomFields = extractPcpCustomFields(client);
    if (pcpCustomFields.pcp) document.getElementById('c_pcp').value = pcpCustomFields.pcp;
    if (pcpCustomFields.pcp_phone) document.getElementById('c_pcp_phone').value = pcpCustomFields.pcp_phone;
    if (pcpCustomFields.pcp_npi) document.getElementById('c_pcp_npi').value = pcpCustomFields.pcp_npi;
    checkForExistingPcp();

    // Store the IntakeQ sequential client number in a hidden field for persistence
    const iqClientId = client.ClientId || client.ClientNumber || '';
    let hiddenIqId = document.getElementById('c_intakeq_client_id');
    if (!hiddenIqId) {
        hiddenIqId = document.createElement('input');
        hiddenIqId.type = 'hidden';
        hiddenIqId.id = 'c_intakeq_client_id';
        document.getElementById('client-form').appendChild(hiddenIqId);
    }
    hiddenIqId.value = iqClientId;
    setHiddenValue('c_intakeq_pcp_field_id', pcpCustomFields.fieldIds.pcp || '');
    setHiddenValue('c_intakeq_pcp_phone_field_id', pcpCustomFields.fieldIds.pcp_phone || '');
    setHiddenValue('c_intakeq_pcp_npi_field_id', pcpCustomFields.fieldIds.pcp_npi || '');

    // Collapse the panel after import
    const panel = document.getElementById('intakeq-sync-panel');
    panel.style.display = 'none';

    // Flash notice
    const formTitle = document.getElementById('client-form-title');
    const prev = formTitle.innerText;
    formTitle.style.color = '#22c55e';
    formTitle.textContent = `Data imported from IntakeQ${iqClientId ? ' (IQ#' + iqClientId + ')' : ''}!`;
    setTimeout(() => {
        formTitle.style.color = '';
        formTitle.innerText = prev;
    }, 3000);
}

function setHiddenValue(id, value) {
    let input = document.getElementById(id);
    if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.id = id;
        document.getElementById('client-form').appendChild(input);
    }
    input.value = value;
}

function extractPcpCustomFields(client) {
    const result = {
        pcp: '',
        pcp_phone: '',
        pcp_npi: '',
        fieldIds: {}
    };
    const matchers = {
        pcp: [/^primary care name$/i, /^primary care provider$/i, /^primary care provider name$/i, /^pcp$/i, /^pcp name$/i],
        pcp_phone: [/^primary care phone$/i, /^primary care provider phone$/i, /^pcp phone$/i, /^pcp phone number$/i],
        pcp_npi: [/^primary care npi$/i, /^primary care provider npi$/i, /^pcp npi$/i, /^pcp npi number$/i]
    };

    (client.CustomFields || []).forEach(field => {
        const text = String(field.Text || '').trim();
        const key = Object.keys(matchers).find(k => matchers[k].some(pattern => pattern.test(text)));
        if (!key || !field.FieldId) return;
        result[key] = field.Value == null ? '' : String(field.Value);
        result.fieldIds[key] = field.FieldId;
    });

    return result;
}

// === Feature #6: Upload Auth PDF to IntakeQ EMR ===
window.uploadAuthToIntakeq = async (authId) => {
    if (!confirm("This will upload the generated Auth PDF to the matching client's IntakeQ file gallery. Proceed?")) return;

    try {
        const res = await fetch(`${API_BASE}/intakeq/upload-auth/${authId}`, { method: 'POST' });
        const raw = await res.text();
        let result = {};
        try { result = raw ? JSON.parse(raw) : {}; } catch { result = { raw }; }

        if (res.ok && result.success) {
            alert(`✓ ${result.message}`);
        } else if (res.ok) {
            alert(`✓ Uploaded (server returned non-standard body).`);
            console.warn("IntakeQ upload raw body:", raw);
        } else {
            alert("Error: " + (result.error || `Upload failed (HTTP ${res.status}).`));
        }
    } catch (err) {
        console.error("IntakeQ upload error:", err);
        alert("Network error: " + err.message);
    }
};


// Save Client Forms
document.getElementById('client-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const clientData = {
        name: document.getElementById('c_name').value,
        dob: document.getElementById('c_dob').value,
        medicaid_id: document.getElementById('c_medicaid_id').value,
        mco_id: document.getElementById('c_mco_id').value,
        primary_care_provider_id: document.getElementById('c_pcp_existing')?.value || null,
        pcp: document.getElementById('c_pcp').value,
        pcp_phone: document.getElementById('c_pcp_phone').value,
        pcp_npi: document.getElementById('c_pcp_npi').value,
        pregnant: document.getElementById('c_pregnant').value,
        work_injury: document.getElementById('c_work_injury').value,
        mva: document.getElementById('c_mva').value,
        other_insurance: document.getElementById('c_other_insurance').value,
        insurer: document.getElementById('c_insurer').value,
        medicare_a: document.getElementById('c_medicare_a').checked,
        medicare_b: document.getElementById('c_medicare_b').checked,
        intakeq_client_id: (document.getElementById('c_intakeq_client_id')?.value || currentClient?.intakeq_client_id || null),
        pcp_custom_field_ids: {
            pcp: document.getElementById('c_intakeq_pcp_field_id')?.value || '',
            pcp_phone: document.getElementById('c_intakeq_pcp_phone_field_id')?.value || '',
            pcp_npi: document.getElementById('c_intakeq_pcp_npi_field_id')?.value || ''
        }
    };

    const id = document.getElementById('client_id').value;
    const method = id ? 'PUT' : 'POST';
    const url = id ? `${API_BASE}/clients/${id}` : `${API_BASE}/clients`;

    try {
        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientData)
        });

        const result = await res.json();
        if (res.ok) {
            if (result.intakeq_pcp_sync && result.intakeq_pcp_sync.success === false) {
                alert("Client saved locally, but IntakeQ PCP sync failed: " + result.intakeq_pcp_sync.error);
            }
            await loadClients();
            if (!id) {
                viewClient(result.id);
            } else {
                viewClient(id);
            }
        } else {
            alert("Error: " + (result.error || "Failed to save client"));
        }
    } catch (err) {
        console.error("Error saving client:", err);
        alert("Network error saving client.");
    }
});

// Edit Client
window.editClient = (id) => {
    const client = clients.find(c => c.id === id);
    if (!client) return;
    
    document.getElementById('client_id').value = client.id;
    document.getElementById('c_name').value = client.name || '';
    document.getElementById('c_dob').value = client.dob || '';
    document.getElementById('c_medicaid_id').value = client.medicaid_id || '';
    document.getElementById('c_mco_id').value = client.mco_id || '';
    document.getElementById('c_pcp').value = client.pcp || '';
    document.getElementById('c_pcp_phone').value = client.pcp_phone || '';
    document.getElementById('c_pcp_npi').value = client.pcp_npi || '';
    document.getElementById('c_pregnant').value = client.pregnant || '';
    document.getElementById('c_work_injury').value = client.work_injury || 'no';
    document.getElementById('c_mva').value = client.mva || 'no';
    document.getElementById('c_other_insurance').value = client.other_insurance || 'no';
    document.getElementById('c_insurer').value = client.insurer || '';
    document.getElementById('c_medicare_a').checked = client.medicare_a == 1;
    document.getElementById('c_medicare_b').checked = client.medicare_b == 1;
    populateClientPcpSelect(client.primary_care_provider_id || '');

    let hiddenIqId = document.getElementById('c_intakeq_client_id');
    if (!hiddenIqId) {
        hiddenIqId = document.createElement('input');
        hiddenIqId.type = 'hidden';
        hiddenIqId.id = 'c_intakeq_client_id';
        document.getElementById('client-form').appendChild(hiddenIqId);
    }
    hiddenIqId.value = client.intakeq_client_id || '';
    ['c_intakeq_pcp_field_id', 'c_intakeq_pcp_phone_field_id', 'c_intakeq_pcp_npi_field_id'].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.value = '';
    });
    clearPcpMatchStatus();

    document.getElementById('client-form-title').innerText = 'Edit Client';
    ensurePcpDirectoryLoaded().then(() => {
        populateClientPcpSelect(client.primary_care_provider_id || '');
        switchView('client-form');
    });
};

// Delete Client
window.deleteClient = async (id) => {
    if (!confirm('Are you sure you want to delete this client? This will remove all their auth history.')) return;
    
    try {
        const res = await fetch(`${API_BASE}/clients/${id}`, { method: 'DELETE' });
        if (res.ok) {
            loadClients();
        } else {
            const result = await res.json();
            alert("Error: " + (result.error || "Failed to delete client"));
        }
    } catch (err) {
        console.error("Error deleting client:", err);
    }
};

// View Client Details
window.viewClient = async (id) => {
    try {
        const res = await fetch(`${API_BASE}/clients/${id}`);
        currentClient = await res.json();

        document.getElementById('cd_name').innerText = currentClient.name;
        document.getElementById('cd_medicaid').innerText = currentClient.medicaid_id || 'N/A';
        document.getElementById('cd_dob').innerText = currentClient.dob || 'N/A';

        // Show IntakeQ badge if the client is linked
        const badge = document.getElementById('cd_intakeq_badge');
        const numSpan = document.getElementById('cd_intakeq_num');
        if (currentClient.intakeq_client_id) {
            numSpan.innerText = currentClient.intakeq_client_id;
            badge.style.display = 'inline';
        } else {
            badge.style.display = 'none';
        }

        loadAuthHistory(id);
        switchView('client-details');
    } catch (err) {
        console.error("Error loading client:", err);
    }
};

document.getElementById('btn-edit-client').addEventListener('click', () => {
    if (!currentClient) return;
    document.getElementById('client-form-title').innerText = 'Edit Client';

    // Populate form
    document.getElementById('client_id').value = currentClient.id;
    document.getElementById('c_name').value = currentClient.name || '';
    document.getElementById('c_dob').value = currentClient.dob || '';
    document.getElementById('c_medicaid_id').value = currentClient.medicaid_id || '';
    document.getElementById('c_mco_id').value = currentClient.mco_id || '';
    document.getElementById('c_pcp').value = currentClient.pcp || '';
    document.getElementById('c_pcp_phone').value = currentClient.pcp_phone || '';
    document.getElementById('c_pcp_npi').value = currentClient.pcp_npi || '';
    document.getElementById('c_pregnant').value = currentClient.pregnant || '';
    document.getElementById('c_work_injury').value = currentClient.work_injury || 'no';
    document.getElementById('c_mva').value = currentClient.mva || 'no';
    document.getElementById('c_other_insurance').value = currentClient.other_insurance || 'no';
    document.getElementById('c_insurer').value = currentClient.insurer || '';
    document.getElementById('c_medicare_a').checked = currentClient.medicare_a == 1;
    document.getElementById('c_medicare_b').checked = currentClient.medicare_b == 1;
    populateClientPcpSelect(currentClient.primary_care_provider_id || '');

    // Populate hidden IntakeQ client ID field so it persists on re-save
    let hiddenIqId = document.getElementById('c_intakeq_client_id');
    if (!hiddenIqId) {
        hiddenIqId = document.createElement('input');
        hiddenIqId.type = 'hidden';
        hiddenIqId.id = 'c_intakeq_client_id';
        document.getElementById('client-form').appendChild(hiddenIqId);
    }
    hiddenIqId.value = currentClient.intakeq_client_id || '';
    ['c_intakeq_pcp_field_id', 'c_intakeq_pcp_phone_field_id', 'c_intakeq_pcp_npi_field_id'].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.value = '';
    });
    clearPcpMatchStatus();

    ensurePcpDirectoryLoaded().then(() => {
        populateClientPcpSelect(currentClient.primary_care_provider_id || '');
        switchView('client-form');
    });
});

// --- Settings ---
async function loadSettings() {
    try {
        const res = await fetch(`${API_BASE}/settings`);
        settings = await res.json();

        // Populate settings form
        document.getElementById('s_req_provider').value = settings.requesting_provider || '';
        document.getElementById('s_req_npi').value = settings.req_provider_npi || '';
        document.getElementById('s_req_phone').value = settings.req_provider_phone || '';
        document.getElementById('s_req_fax').value = settings.req_provider_fax || '';


        document.getElementById('s_comp_by').value = settings.completed_by || '';
        document.getElementById('s_comp_phone').value = settings.completed_by_phone || '';

        // SRFax fields
        document.getElementById('s_srfax_id').value = settings.srfax_access_id || '';
        document.getElementById('s_srfax_pwd').value = settings.srfax_access_pwd || '';
        document.getElementById('s_srfax_caller').value = settings.srfax_caller_id || '';
        document.getElementById('s_srfax_email').value = settings.srfax_sender_email || '';

        // IntakeQ field
        document.getElementById('s_intakeq_key').value = settings.intakeq_api_key || '';

        // Load MCO directory when settings page opens
        loadMcoDirectory();

    } catch (err) {
        console.error("Error loading settings:", err);
    }
}

document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newSettings = {
        requesting_provider: document.getElementById('s_req_provider').value.trim(),
        req_provider_npi: document.getElementById('s_req_npi').value.trim(),
        req_provider_phone: document.getElementById('s_req_phone').value.trim(),
        req_provider_fax: document.getElementById('s_req_fax').value.trim(),
        completed_by: document.getElementById('s_comp_by').value.trim(),
        completed_by_phone: document.getElementById('s_comp_phone').value.trim(),
        srfax_access_id: document.getElementById('s_srfax_id').value.trim(),
        srfax_access_pwd: document.getElementById('s_srfax_pwd').value.trim(),
        srfax_caller_id: document.getElementById('s_srfax_caller').value.trim(),
        srfax_sender_email: document.getElementById('s_srfax_email').value.trim(),
        intakeq_api_key: document.getElementById('s_intakeq_key').value.trim()
    };

    // Validation
    if (!newSettings.requesting_provider) { alert("Requesting Provider Name is required."); return; }
    
    if (newSettings.srfax_caller_id) {
        const cleanCaller = newSettings.srfax_caller_id.replace(/\D/g, '');
        if (cleanCaller.length !== 10) {
            alert("SRFax Caller ID must be exactly 10 digits (no country code). Found: " + cleanCaller.length);
            return;
        }
        newSettings.srfax_caller_id = cleanCaller; // Save cleaned version
    }

    try {
        const res = await fetch(`${API_BASE}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newSettings)
        });
        const result = await res.json();
        if (res.ok) {
            settings = newSettings;
            alert("Settings saved successfully!");
        } else {
            alert("Error: " + (result.error || "Failed to save settings"));
        }
    } catch (err) {
        console.error("Error saving settings:", err);
        alert("Failed to save settings");
    }
});

// Send Test Fax
document.getElementById('btn-test-fax').addEventListener('click', async () => {
    const callerId = document.getElementById('s_srfax_caller').value.trim();
    if (!callerId) { alert("Please enter and save a Caller ID first."); return; }
    
    if (!confirm("This will send a test fax to " + (callerId.length === 10 ? '1' + callerId : callerId) + ". Proceed?")) return;
    
    const btn = document.getElementById('btn-test-fax');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Sending Test...';

    try {
        const res = await fetch(`${API_BASE}/send-test-fax`, { method: 'POST' });
        const result = await res.json();
        if (res.ok && result.success) {
            alert(result.message);
        } else {
            alert("Error: " + (result.error || "Failed to send test fax"));
        }
    } catch (err) {
        console.error("Error sending test fax:", err);
        alert("Network error sending test fax.");
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
});

// --- Facilities ---
async function loadFacilities() {
    try {
        const res = await fetch(`${API_BASE}/facilities`);
        facilities = await res.json();
        renderFacilitiesTable(facilities);
    } catch (err) {
        console.error("Error loading facilities:", err);
    }
}

function renderFacilitiesTable(data) {
    const tbody = document.querySelector('#facilities-table tbody');
    if (!tbody) return;
    tbody.replaceChildren();

    if (!Array.isArray(data) || data.length === 0) {
        appendEmptyRow(tbody, 4, 'No provider presets found. Add one to get started.');
        return;
    }

    data.forEach(fac => {
        const tr = document.createElement('tr');
        appendTextCell(tr, fac.name || '--', { fontWeight: '600' });
        appendTextCell(tr, fac.requesting_provider || '--');
        appendTextCell(tr, fac.servicing_provider || '--');
        const actions = appendActionsCell(tr);
        actions.appendChild(createIconButton('Edit', 'ph ph-pencil-simple', () => editFacility(fac.id), { text: 'Edit' }));
        actions.appendChild(createIconButton('Delete', 'ph ph-trash', () => deleteFacility(fac.id), { danger: true }));
        tbody.appendChild(tr);
    });
}

document.getElementById('btn-add-facility').addEventListener('click', () => {
    document.getElementById('facility-form').reset();
    document.getElementById('fac_id').value = '';
    document.getElementById('facility-form-title').innerText = 'New Provider Preset';
    switchView('facility-form');
});

document.getElementById('facility-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const facData = {
        name: document.getElementById('fac_name').value.trim(),
        
        requesting_provider: document.getElementById('fac_req_provider').value.trim(),
        req_provider_npi: document.getElementById('fac_req_npi').value.trim(),
        req_provider_phone: document.getElementById('fac_req_phone').value.trim(),
        req_provider_fax: document.getElementById('fac_req_fax').value.trim(),

        servicing_provider: document.getElementById('fac_serv_provider').value.trim(),
        serv_provider_npi: document.getElementById('fac_serv_npi').value.trim(),
        serv_provider_tax_id: document.getElementById('fac_serv_tax').value.trim(),
        serv_provider_address: document.getElementById('fac_serv_addr').value.trim(),
        serv_provider_city: document.getElementById('fac_serv_city').value.trim(),
        serv_provider_state: document.getElementById('fac_serv_state').value.trim(),
        serv_provider_zip: document.getElementById('fac_serv_zip').value.trim(),
        serv_provider_phone: document.getElementById('fac_serv_phone').value.trim(),
        serv_provider_fax: document.getElementById('fac_serv_fax').value.trim()
    };

    if (!facData.name) {
        alert("Provider Preset Name is required.");
        return;
    }

    const id = document.getElementById('fac_id').value;
    const method = id ? 'PUT' : 'POST';
    const url = id ? `${API_BASE}/facilities/${id}` : `${API_BASE}/facilities`;

    try {
        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(facData)
        });

        const result = await res.json();
        if (res.ok) {
            await loadFacilities();
            switchView('facilities');
        } else {
            alert("Error: " + (result.error || "Failed to save facility"));
        }
    } catch (err) {
        console.error("Error saving facility:", err);
        alert("Network error saving facility.");
    }
});

window.editFacility = (id) => {
    const fac = facilities.find(f => f.id === id);
    if (!fac) return;
    document.getElementById('facility-form-title').innerText = 'Edit Provider Preset';
    document.getElementById('fac_id').value = fac.id;
    document.getElementById('fac_name').value = fac.name || '';

    document.getElementById('fac_req_provider').value = fac.requesting_provider || '';
    document.getElementById('fac_req_npi').value = fac.req_provider_npi || '';
    document.getElementById('fac_req_phone').value = fac.req_provider_phone || '';
    document.getElementById('fac_req_fax').value = fac.req_provider_fax || '';

    document.getElementById('fac_serv_provider').value = fac.servicing_provider || '';
    document.getElementById('fac_serv_npi').value = fac.serv_provider_npi || '';
    document.getElementById('fac_serv_tax').value = fac.serv_provider_tax_id || '';
    document.getElementById('fac_serv_addr').value = fac.serv_provider_address || '';
    document.getElementById('fac_serv_city').value = fac.serv_provider_city || '';
    document.getElementById('fac_serv_state').value = fac.serv_provider_state || '';
    document.getElementById('fac_serv_zip').value = fac.serv_provider_zip || '';
    document.getElementById('fac_serv_phone').value = fac.serv_provider_phone || '';
    document.getElementById('fac_serv_fax').value = fac.serv_provider_fax || '';

    switchView('facility-form');
};

window.deleteFacility = async (id) => {
    if (!confirm("Are you sure you want to delete this provider preset?")) return;
    try {
        const res = await fetch(`${API_BASE}/facilities/${id}`, { method: 'DELETE' });
        if (res.ok) {
            await loadFacilities();
        } else {
            const result = await res.json();
            alert("Error: " + (result.error || "Failed to delete facility"));
        }
    } catch (err) {
        console.error("Error deleting facility", err);
    }
};

// --- PCP Directory ---
async function loadPcpDirectory() {
    try {
        const res = await fetch(`${API_BASE}/pcp-directory`);
        pcpDirectory = await res.json();
        renderPcpDirectoryTable(pcpDirectory);
        populateClientPcpSelect(document.getElementById('c_pcp_existing')?.value || '');
    } catch (err) {
        console.error("Error loading PCP directory:", err);
    }
}

async function loadPcpAssignableClients() {
    try {
        const res = await fetch(`${API_BASE}/pcp-directory/clients`);
        const clientsForAssignment = await res.json();
        const select = document.getElementById('pcp_assign_client');
        if (!select) return;
        select.innerHTML = '<option value="">Select client...</option>';
        clientsForAssignment.forEach(client => {
            const option = document.createElement('option');
            option.value = client.id;
            option.textContent = (client.name || '') + (client.dob ? ' | DOB ' + client.dob : '');
            select.appendChild(option);
        });
    } catch (err) {
        console.error("Error loading clients for PCP assignment:", err);
    }
}

function renderPcpDirectoryTable(data) {
    const tbody = document.querySelector('#pcp-directory-table tbody');
    if (!tbody) return;
    tbody.replaceChildren();

    if (!Array.isArray(data) || data.length === 0) {
        appendEmptyRow(tbody, 5, 'No PCP records found. Add one to get started.');
        return;
    }

    data.forEach(pcp => {
        const tr = document.createElement('tr');
        appendTextCell(tr, pcp.name || '--', { fontWeight: '600' });
        appendTextCell(tr, pcp.phone || '--');
        appendTextCell(tr, pcp.npi || '--');
        appendTextCell(tr, pcp.client_count || 0);
        const actions = appendActionsCell(tr);
        actions.appendChild(createIconButton('Edit', 'ph ph-pencil-simple', () => editPcp(pcp.id)));
        actions.appendChild(createIconButton('Delete', 'ph ph-trash', () => deletePcp(pcp.id), { danger: true }));
        tbody.appendChild(tr);
    });
}

document.getElementById('btn-add-pcp').addEventListener('click', () => {
    document.getElementById('pcp-form').reset();
    document.getElementById('pcp_id').value = '';
    document.getElementById('pcp-form-title').innerText = 'New PCP';
    loadPcpAssignableClients();
    switchView('pcp-form');
});

document.getElementById('pcp-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const pcpData = {
        name: document.getElementById('pcp_name').value.trim(),
        phone: document.getElementById('pcp_phone').value.trim(),
        npi: document.getElementById('pcp_npi').value.trim()
    };

    if (!pcpData.name || !pcpData.phone || !pcpData.npi) {
        alert("PCP name, phone, and NPI are required.");
        return;
    }

    const id = document.getElementById('pcp_id').value;
    const method = id ? 'PUT' : 'POST';
    const url = id ? `${API_BASE}/pcp-directory/${id}` : `${API_BASE}/pcp-directory`;

    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pcpData)
        });
        const result = await res.json();
        if (res.ok) {
            await loadPcpDirectory();
            await loadClients();
            switchView('pcp-directory');
        } else {
            alert("Error: " + (result.error || "Failed to save PCP"));
        }
    } catch (err) {
        console.error("Error saving PCP:", err);
        alert("Network error saving PCP.");
    }
});

window.editPcp = (id) => {
    const pcp = pcpDirectory.find(item => item.id === id);
    if (!pcp) return;

    document.getElementById('pcp-form-title').innerText = 'Edit PCP';
    document.getElementById('pcp_id').value = pcp.id;
    document.getElementById('pcp_name').value = pcp.name || '';
    document.getElementById('pcp_phone').value = pcp.phone || '';
    document.getElementById('pcp_npi').value = pcp.npi || '';
    loadPcpAssignableClients();
    switchView('pcp-form');
};

document.getElementById('btn-assign-pcp-client').addEventListener('click', async () => {
    const pcpId = document.getElementById('pcp_id').value;
    const clientId = document.getElementById('pcp_assign_client').value;

    if (!pcpId) {
        alert("Save this PCP before assigning clients.");
        return;
    }
    if (!clientId) {
        alert("Select a client to assign.");
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/pcp-directory/${pcpId}/clients/${clientId}`, { method: 'PUT' });
        const result = await res.json();
        if (res.ok) {
            await loadPcpDirectory();
            await loadClients();
            await loadPcpAssignableClients();
            alert("Client assigned to PCP.");
        } else {
            alert("Error: " + (result.error || "Failed to assign client"));
        }
    } catch (err) {
        console.error("Error assigning client to PCP:", err);
        alert("Network error assigning client.");
    }
});

window.deletePcp = async (id) => {
    if (!confirm("Are you sure you want to delete this PCP?")) return;
    try {
        const res = await fetch(`${API_BASE}/pcp-directory/${id}`, { method: 'DELETE' });
        const result = await res.json();
        if (res.ok) {
            await loadPcpDirectory();
        } else {
            alert("Error: " + (result.error || "Failed to delete PCP"));
        }
    } catch (err) {
        console.error("Error deleting PCP:", err);
        alert("Network error deleting PCP.");
    }
};

// --- Generate Auth ---
document.getElementById('btn-new-auth').addEventListener('click', async () => {
    if (!currentClient) return;

    // Ensure settings are loaded before generation
    if (Object.keys(settings).length === 0) {
        await loadSettings();
    }

    // Ensure facilities are loaded to populate dropdown
    if (facilities.length === 0) {
        await loadFacilities();
    }
    const facSelect = document.getElementById('auth_facility_select');
    facSelect.innerHTML = '<option value="">Select a Facility/Provider...</option>';
    facilities.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.id;
        opt.textContent = f.name;
        facSelect.appendChild(opt);
    });
    const lastFacId = localStorage.getItem('lastFacilityId');
    if (lastFacId) facSelect.value = lastFacId;

    document.getElementById('gen_client_name').innerText = currentClient.name;
    document.getElementById('auth-generate-form').reset();

    // Clear any existing auth_id for new ones
    let authIdInput = document.getElementById('auth_id_input');
    if (authIdInput) authIdInput.value = '';

    // Clear Record Number display for new ones
    const recNumSpan = document.getElementById('gen_record_number');
    if (recNumSpan) recNumSpan.innerText = 'New Record';

    // AUTO-COPY: Check for prior authorization to pre-fill
    try {
        const res = await fetch(`${API_BASE}/clients/${currentClient.id}/auth-requests`);
        const history = await res.json();
        if (Array.isArray(history) && history.length > 0) {
            // Use the most recent one (already sorted by date DESC in backend)
            const latest = history[0];
            const data = JSON.parse(latest.form_data || '{}');
            populateAuthForm(data);
            console.log(`Auto-copied data from prior Auth Record #${latest.record_number}`);
        }
    } catch (err) {
        console.error("Error pre-filling from history:", err);
    }
    
    window.checkUhcStatus();

    // Set today's date (this will override any copied date, which is usually desired for new auths)
    document.getElementById('auth-generate-form').elements['date'].value = new Date().toISOString().split('T')[0];

    // Clear files
    uploadedFiles = [];
    renderFileList();

    switchView('generate-auth');
    resetAuthStepQueue();
});

function isImmutableAuth(item) {
    return item && Boolean(item.intakeq_uploaded_at);
}

async function readErrorMessage(res) {
    try {
        const body = await res.json();
        return body.error || `Server responded with ${res.status}`;
    } catch {
        return `Server responded with ${res.status}`;
    }
}

// Auth History
async function loadAuthHistory(clientId) {
    try {
        const res = await fetch(`${API_BASE}/clients/${clientId}/auth-requests`);
        const history = await res.json();
        
        const list = document.getElementById('auth-history-list');
        const tabTableBody = document.getElementById('auth-history-tab-body');
        if (list) list.innerHTML = '';
        if (tabTableBody) tabTableBody.innerHTML = '';

        if (!res.ok) {
            console.error("Error loading auth history:", history.error);
            if (list) list.innerHTML = '<li style="color:var(--danger);">Error loading history.</li>';
            if (tabTableBody) tabTableBody.innerHTML = '<tr><td colspan="4" style="color:var(--danger);">Error loading history.</td></tr>';
            return;
        }

        if (!Array.isArray(history) || history.length === 0) {
            if (list) list.innerHTML = '<li style="color:#666;">No previous authorization requests.</li>';
            if (tabTableBody) tabTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#666;">No previous authorization requests.</td></tr>';
            return;
        }

        history.forEach(item => {
            let formData = {};
            try {
                formData = JSON.parse(item.form_data || '{}');
            } catch (e) {
                console.error("Error parsing form_data for auth", item.id, e);
            }
            const immutable = isImmutableAuth(item);

            const formatDateShort = (dateStr) => {
                if (!dateStr || dateStr === 'Unknown') return '??-??-??';
                const d = new Date(dateStr + 'T12:00:00'); // Use mid-day to avoid TZ issues
                if (isNaN(d)) return '??-??-??';
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                const yy = String(d.getFullYear()).slice(-2);
                return `${mm}-${dd}-${yy}`;
            };

            const startDate = formData.start_date_1 || 'Unknown';
            const stopDate = formData.stop_date_1 || 'Unknown';
            const authTitle = `Authorization ${formatDateShort(startDate)} to ${formatDateShort(stopDate)}`;
            const units = formData.units_1 || '0';
            const unitsText = `${units} Units`;
            const safeAuthTitle = escapeHtml(authTitle);
            const safeUnitsText = escapeHtml(unitsText);
            
            // Fax status badge
            let badgeHtml = '';
            let clinicalBadgeHtml = '';
            
            // Clinical status badge (only show if changed from default or if specifically requested)
            if (item.clinical_status === 'Granted') {
                clinicalBadgeHtml = '<span style="background:#059669;color:#fff;padding:2px 8px;border-radius:12px;font-size:0.75rem;margin-left:4px;">Granted</span>';
            } else if (item.clinical_status === 'Denied') {
                clinicalBadgeHtml = '<span style="background:#dc2626;color:#fff;padding:2px 8px;border-radius:12px;font-size:0.75rem;margin-left:4px;">Denied</span>';
            } else if (item.clinical_status === 'Pending') {
                clinicalBadgeHtml = '<span style="background:#9333ea;color:#fff;padding:2px 8px;border-radius:12px;font-size:0.75rem;margin-left:4px;">Pending</span>';
            } else if (item.clinical_status === 'In Review') {
                clinicalBadgeHtml = '<span style="background:#3b82f6;color:#fff;padding:2px 8px;border-radius:12px;font-size:0.75rem;margin-left:4px;">In Review</span>';
            }

            if (item.is_draft) {
                badgeHtml = '<span style="background:#6366f1;color:#fff;padding:2px 8px;border-radius:12px;font-size:0.75rem;margin-left:8px;">Draft</span>';
                pendingFaxesToPoll.delete(item.id);
            } else if (item.fax_status === 'Sent' || item.fax_status === 'Success') {
                badgeHtml = '<span style="background:#22c55e;color:#fff;padding:2px 8px;border-radius:12px;font-size:0.75rem;margin-left:8px;">✓ Faxed</span>' + clinicalBadgeHtml;
                pendingFaxesToPoll.delete(item.id);
            } else if (isPollableFaxStatus(item.fax_status)) {
                badgeHtml = '<span style="background:#f59e0b;color:#fff;padding:2px 8px;border-radius:12px;font-size:0.75rem;margin-left:8px;"><i class="ph ph-spinner ph-spin pulse-glow"></i> Polling</span>' + clinicalBadgeHtml;
                pendingFaxesToPoll.add(item.id);
            } else if (item.fax_status === 'Failed' || item.fax_status?.includes('Error')) {
                badgeHtml = '<span style="background:#ef4444;color:#fff;padding:4px 10px;border-radius:12px;font-size:0.8rem;margin-left:8px;font-weight:bold;border:2px solid #7f1d1d;text-transform:uppercase;">🚨 Failed</span>' + clinicalBadgeHtml;
                pendingFaxesToPoll.delete(item.id);
            } else {
                badgeHtml = '<span style="background:#94a3b8;color:#fff;padding:2px 8px;border-radius:12px;font-size:0.75rem;margin-left:8px;">Not Faxed</span>' + clinicalBadgeHtml;
                pendingFaxesToPoll.delete(item.id);
            }

            // Fax action button
            let faxBtn = item.is_draft ? '' : `<button class="btn btn-ghost" onclick="openFaxModal(${item.id})"><i class="ph ph-paper-plane-tilt"></i> Fax</button>`;
            let refreshBtn = '';
            if (item.fax_details_id && item.fax_status !== 'Sent' && !item.is_draft) {
                refreshBtn = `<button class="btn btn-ghost" onclick="refreshFaxStatus(${item.id})"><i class="ph ph-arrows-clockwise"></i></button>`;
            }

            // IntakeQ upload button — only for finalised auths with a PDF
            let uploadIntakeqBtn = (!item.is_draft) ? `<button class="btn btn-ghost" title="Upload PDF to IntakeQ EMR" onclick="uploadAuthToIntakeq(${item.id})"><i class="ph ph-cloud-arrow-up"></i> IntakeQ</button>` : '';

            const dateLabel = (item.fax_status === 'Sent' || item.fax_status === 'Success') ? 'Date Faxed' : (item.is_draft ? 'Last Saved' : 'Created');
            const displayDate = (item.fax_status === 'Sent' || item.fax_status === 'Success') ? item.fax_sent_date : (item.last_updated || item.date_created);
            const displayDateTime = new Date(displayDate).toLocaleString();
            const displayDateShort = new Date(displayDate).toLocaleDateString();

            if (list) {
                list.innerHTML += `
                    <li style="display:flex; justify-content:space-between; align-items:center; padding-bottom: 8px; border-bottom: 1px solid rgba(0,0,0,0.1); margin-bottom: 8px;">
                        <div>
                            <span style="display:block; font-weight: 500;"><i class="ph ph-file-pdf"></i> ${safeAuthTitle}${badgeHtml}</span>
                            <span style="display:block; font-size: 0.9rem; color: var(--primary); font-weight: 600;">${safeUnitsText}</span>
                            <span style="font-size:0.8rem;color:#666;">${escapeHtml(dateLabel)}: ${escapeHtml(displayDateTime)}</span>
                            <div style="margin-top:4px;">
                                <label style="font-size:0.75rem; color:#666;">Status: </label>
                                <select onchange="updateClinicalStatus(${item.id}, this.value)" style="font-size:0.75rem; padding: 2px 4px; border-radius: 4px; border: 1px solid #ddd;">
                                    <option value="In Review" ${item.clinical_status === 'In Review' ? 'selected' : ''}>In Review</option>
                                    <option value="Pending" ${item.clinical_status === 'Pending' ? 'selected' : ''}>Pending</option>
                                    <option value="Granted" ${item.clinical_status === 'Granted' ? 'selected' : ''}>Granted</option>
                                    <option value="Denied" ${item.clinical_status === 'Denied' ? 'selected' : ''}>Denied</option>
                                </select>
                            </div>
                        </div>
                        <div style="display:flex; gap:2px; align-items:center;">
                            <button class="btn btn-ghost" onclick="previewAuth(${item.id})"><i class="ph ph-eye"></i> Preview</button>
                            ${faxBtn}${refreshBtn}
                            ${uploadIntakeqBtn}
                            ${immutable || item.fax_status === 'Sent' || item.fax_status === 'Success' 
                                ? `<button class="btn btn-ghost" onclick="copyAuth(${item.id})"><i class="ph ph-copy"></i> Copy</button>`
                                : `<button class="btn btn-ghost" onclick="editAuth(${item.id})"><i class="ph ph-pencil-simple"></i> Edit</button>`
                            }
                            ${immutable || item.fax_status === 'Sent' || item.fax_status === 'Success' 
                                ? '' 
                                : `<button class="btn btn-ghost" style="color:var(--danger);" onclick="deleteAuth(${item.id})"><i class="ph ph-trash"></i></button>`
                            }
                        </div>
                    </li>
                `;
            }

            if (tabTableBody) {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="font-weight:500;">
                        IQ${item.record_number || item.id} ${formatDateShort(startDate)} to ${formatDateShort(stopDate)}
                        <br><small style="color:var(--primary);">${safeUnitsText}</small>
                    </td>
                    <td>${escapeHtml(displayDateShort)}</td>
                    <td>
                        ${badgeHtml}
                    </td>
                    <td>
                        <div style="display:flex; gap:2px; align-items:center;">
                            <button class="btn btn-ghost" onclick="previewAuth(${item.id})" title="Preview"><i class="ph ph-eye"></i></button>
                            ${faxBtn ? `<span title="Fax">${faxBtn}</span>` : ''}
                            ${uploadIntakeqBtn ? `<span title="Upload to IntakeQ">${uploadIntakeqBtn}</span>` : ''}
                            ${immutable || item.fax_status === 'Sent' || item.fax_status === 'Success' 
                                ? `<button class="btn btn-ghost" onclick="copyAuth(${item.id})" title="Copy"><i class="ph ph-copy"></i></button>`
                                : `<button class="btn btn-ghost" onclick="editAuth(${item.id})" title="Edit"><i class="ph ph-pencil-simple"></i></button>`
                            }
                            ${immutable || item.fax_status === 'Sent' || item.fax_status === 'Success' 
                                ? '' 
                                : `<button class="btn btn-ghost" style="color:var(--danger);" onclick="deleteAuth(${item.id})" title="Delete"><i class="ph ph-trash"></i></button>`
                            }
                        </div>
                    </td>
                `;
                tabTableBody.appendChild(tr);
            }
        });
    } catch (err) {
        console.error("Error loading auth history", err);
    }
}

// --- Auto-Save Drafts ---
async function autoSaveDraft() {
    if (!currentClient || !document.getElementById('view-generate-auth').classList.contains('active')) return;
    
    clearTimeout(authAutoSaveTimeout);
    
    const draftStatus = document.getElementById('draft-status');
    if (draftStatus) draftStatus.innerText = 'Drafting...';

    authAutoSaveTimeout = setTimeout(async () => {
        const form = document.getElementById('auth-generate-form');
        if (!form) return;

        if (draftStatus) draftStatus.innerText = 'Auto-saving...';

        const formData = new FormData(form);
        const dataObj = Object.fromEntries(formData.entries());

        // Handle service_type checkboxes
        const serviceTypeChecks = document.querySelectorAll('input[name="service_type"]:checked');
        dataObj.service_type = Array.from(serviceTypeChecks).map(cb => cb.value);

        const authId = document.getElementById('auth_id_input')?.value;

        try {
            const res = await fetch(`${API_BASE}/save-auth-draft`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: currentClient.id,
                    auth_id: authId,
                    form_data: dataObj
                })
            });
            const result = await res.json();
            if (res.ok && result.id) {
                // Set the authId if it was a new draft
                let input = document.getElementById('auth_id_input');
                if (!input) {
                    input = document.createElement('input');
                    input.type = 'hidden';
                    input.id = 'auth_id_input';
                    input.name = 'auth_id';
                    form.appendChild(input);
                }
                input.value = result.id;
                
                if (draftStatus) draftStatus.innerText = 'Draft saved';
                setTimeout(() => { 
                    if (draftStatus.innerText === 'Draft saved') draftStatus.innerText = ''; 
                }, 3000);
            } else if (res.status === 409) {
                if (draftStatus) draftStatus.innerText = result.error || 'Immutable - copy to edit';
            }
        } catch (err) {
            console.error("Auto-save failed:", err);
            if (draftStatus) draftStatus.innerText = 'Auto-save failed';
        }
    }, 2000);
}

// Attach Auto-Save Listeners
document.getElementById('auth-generate-form').addEventListener('input', autoSaveDraft);
document.getElementById('auth-generate-form').addEventListener('change', autoSaveDraft);

document.getElementById('btn-auth-next-attachments')?.addEventListener('click', () => {
    if (canEnterAuthStep('tab-attachments')) setAuthStep('tab-attachments');
});

document.getElementById('btn-auth-next-actions')?.addEventListener('click', () => {
    if (canEnterAuthStep('tab-actions')) setAuthStep('tab-actions');
});

document.getElementById('btn-save-draft').addEventListener('click', async () => {
    clearTimeout(authAutoSaveTimeout);
    const form = document.getElementById('auth-generate-form');
    if (!currentClient || !form) {
        alert("Cannot save: No client selected or form missing.");
        return;
    }

    const draftStatus = document.getElementById('draft-status');
    if (draftStatus) draftStatus.innerText = 'Saving immediately...';
    
    try {
        const formData = new FormData(form);
        const dataObj = Object.fromEntries(formData.entries());
        
        const serviceTypeChecks = document.querySelectorAll('input[name="service_type"]:checked');
        dataObj.service_type = Array.from(serviceTypeChecks).map(cb => cb.value);

        const mergedData = {
            ...currentClient,
            ...dataObj,
            client_id: currentClient.id
        };

        const authIdInput = document.getElementById('auth_id_input');
        const existingAuthId = authIdInput ? authIdInput.value : null;

        const payload = {
            client_id: currentClient.id,
            form_data: JSON.stringify(mergedData),
            status: 'draft',
            auth_id: existingAuthId
        };

        const res = await fetch(`${API_BASE}/save-auth-draft`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error(await readErrorMessage(res));
        
        const result = await res.json();
        if (result.id && (!authIdInput || !authIdInput.value)) {
            let idInput = document.getElementById('auth_id_input');
            if (!idInput) {
                idInput = document.createElement('input');
                idInput.type = 'hidden';
                idInput.id = 'auth_id_input';
                idInput.name = 'auth_id';
                form.appendChild(idInput);
            }
            idInput.value = result.id;
        }
        
        if (draftStatus) draftStatus.innerText = 'Record saved successfully';
        alert("Record saved successfully!");
        
        setTimeout(() => { 
            if (draftStatus.innerText === 'Record saved successfully') draftStatus.innerText = ''; 
        }, 3000);
        
    } catch (err) {
        console.error("Save failed:", err);
        if (draftStatus) draftStatus.innerText = 'Save failed';
        alert(err.message || "Failed to save record. See console for details.");
    }
});

window.downloadAuth = (id) => {
    window.location.href = `${API_BASE}/auth-requests/${id}/download`;
};

window.previewAuth = (id) => {
    console.log('[PREVIEW] Opening for ID:', id);
    if (!id || id === 'undefined') {
        alert('Invalid Auth ID for preview.');
        return;
    }
    const modal = document.getElementById('preview-modal');
    const iframe = document.getElementById('preview-iframe');
    if (!modal || !iframe) {
        console.error('[PREVIEW] Modal or iframe elements not found');
        return;
    }
    iframe.src = `${API_BASE}/auth-requests/${id}/preview`;
    modal.classList.add('active');
};

window.closePreview = () => {
    const modal = document.getElementById('preview-modal');
    const iframe = document.getElementById('preview-iframe');
    iframe.src = '';
    modal.classList.remove('active');
};

window.deleteAuth = async (id) => {
    if (!confirm("Are you sure you want to delete this auth request?")) return;
    try {
        const res = await fetch(`${API_BASE}/auth-requests/${id}`, { method: 'DELETE' });
        if (res.ok && currentClient) {
            loadAuthHistory(currentClient.id);
        } else if (!res.ok) {
            alert(await readErrorMessage(res));
        }
    } catch (err) {
        console.error("Error deleting auth history", err);
    }
};

window.updateAuthData = async (id, formData) => {
    try {
        const res = await fetch(`${API_BASE}/auth-requests/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ form_data: formData })
        });
        if (!res.ok) throw new Error(`Server responded with ${res.status}`);
        return await res.json();
    } catch (err) {
        console.error("Error updating auth:", err);
        return null;
    }
};

function populateAuthForm(data) {
    for (const [key, val] of Object.entries(data)) {
        const elems = document.getElementsByName(key);
        if (elems.length > 0) {
            if (elems[0].type === 'radio') {
                for (let i = 0; i < elems.length; i++) {
                    if (elems[i].value === val) elems[i].checked = true;
                }
            } else if (elems[0].type === 'checkbox') {
                if (Array.isArray(val)) {
                    for (let i = 0; i < elems.length; i++) {
                        elems[i].checked = val.includes(elems[i].value);
                    }
                } else {
                    elems[0].checked = Boolean(val);
                }
            } else {
                elems[0].value = val;
            }
        }
    }
    window.checkUhcStatus();
}

// --- Update Clinical Status ---
window.updateClinicalStatus = async (id, status) => {
    try {
        const res = await fetch(`${API_BASE}/auth-requests/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clinical_status: status })
        });
        if (!res.ok) throw new Error("Failed to update status");
        
        // Refresh history to show new badge
        if (currentClient) loadAuthHistory(currentClient.id);
        
        console.log(`Auth ${id} status updated to ${status}`);
    } catch (err) {
        console.error("Error updating status:", err);
        alert("Failed to update status.");
    }
};

// --- Copy Authorization (Start new request from existing) ---
window.copyAuth = async (id) => {
    try {
        const res = await fetch(`${API_BASE}/auth-requests/${id}`);
        const auth = await res.json();

        if (!currentClient || currentClient.id !== auth.client_id) {
            await window.viewClient(auth.client_id);
        }

        // Ensure facilities are loaded
        if (facilities.length === 0) await loadFacilities();

        // Populate dropdown
        const facSelect = document.getElementById('auth_facility_select');
        facSelect.innerHTML = '<option value="">Select a Facility/Provider...</option>';
        facilities.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.id;
            opt.textContent = f.name;
            facSelect.appendChild(opt);
        });

        document.getElementById('auth-generate-form').reset();

        const data = JSON.parse(auth.form_data);
        delete data.auth_id;
        
        const recNumSpan = document.getElementById('gen_record_number');
        if (recNumSpan) recNumSpan.innerText = '(New Copy)';

        populateAuthForm(data);

        // Ensure no ID is set so it saves as a NEW record. This must run after
        // populateAuthForm because older saved form_data may include auth_id.
        let authIdInput = document.getElementById('auth_id_input');
        if (authIdInput) authIdInput.value = '';

        uploadedFiles = [];
        renderFileList();

        document.getElementById('gen_client_name').innerText = currentClient.name;
        switchView('generate-auth');
    } catch (err) {
        console.error("Error copying auth:", err);
    }
};

window.editAuth = async (id) => {
    try {
        const res = await fetch(`${API_BASE}/auth-requests/${id}`);
        const auth = await res.json();

        if (isImmutableAuth(auth)) {
            alert("This authorization is immutable. Use Copy to create a new editable authorization.");
            return;
        }

        if (!currentClient || currentClient.id !== auth.client_id) {
            await window.viewClient(auth.client_id);
        }

        // Ensure facilities are loaded
        if (facilities.length === 0) await loadFacilities();

        // Populate dropdown
        const facSelect = document.getElementById('auth_facility_select');
        facSelect.innerHTML = '<option value="">Select a Facility/Provider...</option>';
        facilities.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.id;
            opt.textContent = f.name;
            facSelect.appendChild(opt);
        });

        document.getElementById('auth-generate-form').reset();

        const data = JSON.parse(auth.form_data);

        // Set hidden ID
        let authIdInput = document.getElementById('auth_id_input');
        if (!authIdInput) {
            authIdInput = document.createElement('input');
            authIdInput.type = 'hidden';
            authIdInput.id = 'auth_id_input';
            authIdInput.name = 'auth_id';
            document.getElementById('auth-generate-form').appendChild(authIdInput);
        }
        authIdInput.value = id;

        // Set Record Number display
        const recNumSpan = document.getElementById('gen_record_number');
        if (recNumSpan) recNumSpan.innerText = auth.record_number ? `Record #${auth.record_number}` : '';

        populateAuthForm(data);

        uploadedFiles = [];
        renderFileList();

        document.getElementById('gen_client_name').innerText = currentClient.name;
        switchView('generate-auth');
    } catch (err) {
        console.error("Error editing auth:", err);
    }
};


// --- File Upload Handling ---
const fileDropArea = document.getElementById('file-drop-area');
const fileInput = document.getElementById('pdf-upload');

fileDropArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    fileDropArea.classList.add('dragover');
});

fileDropArea.addEventListener('dragleave', () => {
    fileDropArea.classList.remove('dragover');
});

fileDropArea.addEventListener('drop', (e) => {
    e.preventDefault();
    fileDropArea.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
    }
});

fileInput.addEventListener('change', function () {
    if (this.files.length) {
        handleFiles(this.files);
    }
});

function handleFiles(files) {
    for (const file of files) {
        if (file.type === "application/pdf") {
            uploadedFiles.push(file);
        } else {
            alert(`${file.name} is not a PDF file.`);
        }
    }
    renderFileList();
    fileInput.value = ''; // reset
}

function renderFileList() {
    const list = document.getElementById('file-list');
    list.innerHTML = '';
    uploadedFiles.forEach((file, index) => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span><i class="ph ph-file-pdf text-red-500"></i> ${escapeHtml(file.name)}</span>
            <i class="ph ph-x-circle remove-file" onclick="removeFile(${index})"></i>
        `;
        list.appendChild(li);
    });
}

window.removeFile = (index) => {
    uploadedFiles.splice(index, 1);
    renderFileList();
};

// --- IntakeQ Notes Logic ---
let intakeqNotes = []; // Stores notes fetched from API
let selectedIntakeqNotes = new Set();

document.getElementById('btn-load-intakeq-notes').addEventListener('click', async () => {
    if (!currentClient || !currentClient.name) {
        alert("No client selected.");
        return;
    }

    const loader = document.getElementById('intakeq-notes-loading');
    const list = document.getElementById('intakeq-notes-list');
    const btn = document.getElementById('btn-load-intakeq-notes');
    
    loader.style.display = 'block';
    list.innerHTML = '';
    btn.disabled = true;

    try {
        // Prefer direct IntakeQ client ID for fast, unambiguous lookup
        const iqId = currentClient.intakeq_client_id;
        const notesUrl = iqId
            ? `${API_BASE}/intakeq/notes?intakeqClientId=${encodeURIComponent(iqId)}`
            : `${API_BASE}/intakeq/notes?clientName=${encodeURIComponent(currentClient.name)}`;

        const res = await fetch(notesUrl);
        const data = await res.json();
        
        if (!res.ok) {
            throw new Error(data.error || "Failed to fetch from IntakeQ");
        }

        intakeqNotes = data;
        selectedIntakeqNotes.clear();
        
        if (!Array.isArray(intakeqNotes) || intakeqNotes.length === 0) {
            list.innerHTML = '<li style="color:#666; font-size:0.9rem;">No locked treatment notes found for this client.</li>';
            return;
        }

        // Sort by Date DESC
        intakeqNotes.sort((a, b) => b.Date - a.Date);

        intakeqNotes.forEach(note => {
            const dateStr = new Date(note.Date).toLocaleDateString();
            const li = document.createElement('li');
            li.style.display = 'flex';
            li.style.alignItems = 'center';
            li.style.gap = '10px';
            
            li.innerHTML = `
                <label class="custom-checkbox" style="margin:0; width:100%;">
                    <input type="checkbox" value="${escapeHtml(note.Id)}" class="intakeq-note-cb">
                    <span class="checkmark"></span>
                    <i class="ph ph-file-pdf" style="color:var(--primary); margin: 0 5px;"></i>
                    <strong>${escapeHtml(note.NoteName || 'Treatment Note')}</strong> - ${escapeHtml(dateStr)}
                    <span style="font-size:0.8rem; color:#666; margin-left:auto;">(Locked)</span>
                </label>
            `;
            list.appendChild(li);
        });

        // Add event listeners to checkboxes
        document.querySelectorAll('.intakeq-note-cb').forEach(cb => {
            cb.addEventListener('change', (e) => {
                if (e.target.checked) {
                    selectedIntakeqNotes.add(e.target.value);
                } else {
                    selectedIntakeqNotes.delete(e.target.value);
                }
            });
        });

    } catch (err) {
        console.error("IntakeQ Notes Error:", err);
        list.innerHTML = `<li style="color:var(--danger); font-size:0.9rem;"><i class="ph ph-warning-circle"></i> Error: ${escapeHtml(err.message)}</li>`;
    } finally {
        loader.style.display = 'none';
        btn.disabled = false;
    }
});

// --- IntakeQ Client Files Logic ---
let intakeqFiles = []; // Stores files fetched from API
let selectedIntakeqFiles = new Set();

document.getElementById('btn-load-intakeq-files').addEventListener('click', async () => {
    if (!currentClient || !currentClient.name) {
        alert("No client selected.");
        return;
    }

    const loader = document.getElementById('intakeq-files-loading');
    const list = document.getElementById('intakeq-files-list');
    const btn = document.getElementById('btn-load-intakeq-files');
    
    loader.style.display = 'block';
    list.innerHTML = '';
    btn.disabled = true;

    try {
        const iqId = currentClient.intakeq_client_id;
        if (!iqId) {
            list.innerHTML = '<li style="color:#666; font-size:0.9rem;">No IntakeQ Client ID linked. Sync from IntakeQ first.</li>';
            return;
        }

        const filesUrl = `${API_BASE}/intakeq/files?intakeqClientId=${encodeURIComponent(iqId)}`;
        const res = await fetch(filesUrl);
        const data = await res.json();
        
        if (!res.ok) {
            throw new Error(data.error || "Failed to fetch from IntakeQ");
        }

        intakeqFiles = data;
        selectedIntakeqFiles.clear();
        
        if (!Array.isArray(intakeqFiles) || intakeqFiles.length === 0) {
            list.innerHTML = '<li style="color:#666; font-size:0.9rem;">No uploaded files found for this client in IntakeQ.</li>';
            return;
        }

        intakeqFiles.forEach(file => {
            const li = document.createElement('li');
            li.style.display = 'flex';
            li.style.alignItems = 'center';
            li.style.gap = '10px';
            
            li.innerHTML = `
                <label class="custom-checkbox" style="margin:0; width:100%;">
                    <input type="checkbox" value="${escapeHtml(file.Id)}" class="intakeq-file-cb">
                    <span class="checkmark"></span>
                    <i class="ph ph-file" style="color:var(--primary); margin: 0 5px;"></i>
                    <strong>${escapeHtml(file.FileName || 'Document')}</strong>
                    <span style="font-size:0.8rem; color:#666; margin-left:auto;">(${escapeHtml(file.ContentType || 'Unknown')})</span>
                </label>
            `;
            list.appendChild(li);
        });

        // Add event listeners to checkboxes
        document.querySelectorAll('.intakeq-file-cb').forEach(cb => {
            cb.addEventListener('change', (e) => {
                if (e.target.checked) {
                    selectedIntakeqFiles.add(e.target.value);
                } else {
                    selectedIntakeqFiles.delete(e.target.value);
                }
            });
        });

    } catch (err) {
        console.error("IntakeQ Files Error:", err);
        list.innerHTML = `<li style="color:var(--danger); font-size:0.9rem;"><i class="ph ph-warning-circle"></i> Error: ${escapeHtml(err.message)}</li>`;
    } finally {
        loader.style.display = 'none';
        btn.disabled = false;
    }
});

// --- Submit Generation Request ---
document.getElementById('btn-generate-pdf').addEventListener('click', async () => {
    if (!requireAuthStep('tab-actions') || !authStepQueue.has('tab-actions')) {
        setAuthFlowError('Generate the PDF from step 3 after reviewing attachments and actions/history.');
        return;
    }

    const form = document.getElementById('auth-generate-form');
    if (!form.checkValidity()) {
        // Switch to the form tab to show the browser's validation bubble
        document.querySelector('.tab-header[data-tab="tab-form"]').click();
        setTimeout(() => form.reportValidity(), 50);
        return;
    }

    if (!currentClient) {
        alert("No client selected.");
        return;
    }

    loadingOverlay.classList.add('active');
    clearTimeout(authAutoSaveTimeout);

    // Gather form data
    const formData = new FormData(form);
    const dataObj = Object.fromEntries(formData.entries());

    // Handle array multiple checkboxes (service_type)
    const serviceTypeChecks = document.querySelectorAll('input[name="service_type"]:checked');
    dataObj.service_type = Array.from(serviceTypeChecks).map(cb => cb.value);

    // Override settings with selected facility
    let selectedFacData = {};
    if (dataObj.facility_id) {
        localStorage.setItem('lastFacilityId', dataObj.facility_id);
        const fac = facilities.find(f => f.id == dataObj.facility_id);
        if (fac) {
            // copy fac data excluding id and name so it merges nicely with settings
            const { id, name, ...restFac } = fac;
            selectedFacData = restFac;
        }
    }

    // Add client demographics and settings to the payload
    // The EJS template expects a unified object `data` that contains everything.
    const mergedData = {
        ...settings,            // Provider settings
        ...selectedFacData,     // Selected facility data (overrides settings for servicing provider/facility)
        ...currentClient,       // Client demographics
        ...dataObj,             // Auth form specific inputs
        client_id: currentClient.id,
        member_name: currentClient.name, // Template expects member_name
        // Map medicare_a/medicare_b booleans to medicare array for EJS template
        medicare: [
            currentClient.medicare_a ? 'part_a' : null,
            currentClient.medicare_b ? 'part_b' : null
        ].filter(Boolean)
    };

    const submitFormData = new FormData();
    submitFormData.append('formData', JSON.stringify(mergedData));

    // Append IntakeQ Note IDs if any
    if (selectedIntakeqNotes.size > 0) {
        submitFormData.append('intakeqNotes', JSON.stringify(Array.from(selectedIntakeqNotes)));
    }

    // Append IntakeQ Client File IDs if any
    if (selectedIntakeqFiles.size > 0) {
        submitFormData.append('intakeqFiles', JSON.stringify(Array.from(selectedIntakeqFiles)));
    }

    // Append attachments
    uploadedFiles.forEach(file => {
        submitFormData.append('attachments', file);
    });

    try {
        const res = await fetch(`${API_BASE}/generate-auth`, {
            method: 'POST',
            body: submitFormData
        });

        if (!res.ok) throw new Error(await readErrorMessage(res));

        const generatedAuthId = res.headers.get('X-Auth-Request-Id') || document.getElementById('auth_id_input')?.value || '';

        // Trigger download
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        const disp = res.headers.get('Content-Disposition');
        let filename = `AuthRequest_${currentClient.name.replace(/ /g, '_')}.pdf`;
        if (disp && disp.indexOf('attachment') !== -1) {
            const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
            const matches = filenameRegex.exec(disp);
            if (matches != null && matches[1]) {
                filename = matches[1].replace(/['"]/g, '');
            }
        }
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);

        markAuthGenerated(generatedAuthId);

        // Reset auto-save auth ID
        const draftStatus = document.getElementById('draft-status');
        if (draftStatus) draftStatus.innerText = 'PDF generated';

        // Reload authorization history to show newly created one
        loadAuthHistory(currentClient.id);

    } catch (err) {
        console.error("PDF Generation Error:", err);
        alert("Failed to generate PDF. Check console for details.");
    } finally {
        loadingOverlay.classList.remove('active');
    }
});



// === MCO Fax Directory ===
async function loadMcoDirectory() {
    try {
        const res = await fetch(`${API_BASE}/mco-fax-directory`);
        mcoDirectory = await res.json();
        renderMcoTable();
    } catch (err) {
        console.error("Error loading MCO directory:", err);
    }
}

function renderMcoTable() {
    const tbody = document.querySelector('#mco-fax-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (mcoDirectory.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#666;">No MCO fax numbers saved yet.</td></tr>';
        return;
    }
    mcoDirectory.forEach(entry => {
        const tr = document.createElement('tr');
        appendTextCell(tr, entry.mco_name || '--');
        appendTextCell(tr, entry.fax_number || '--');
        const actions = appendActionsCell(tr);
        actions.appendChild(createIconButton('Delete', 'ph ph-trash', () => deleteMcoEntry(entry.id), { danger: true }));
        tbody.appendChild(tr);
    });
}

document.getElementById('btn-add-mco').addEventListener('click', async () => {
    const name = document.getElementById('mco_new_name').value.trim();
    const fax = document.getElementById('mco_new_fax').value.trim();
    if (!name || !fax) { alert('MCO name and fax number are required.'); return; }
    
    const cleanFax = fax.replace(/\D/g, '');
    if (cleanFax.length !== 11) {
        alert("MCO Fax Number must be exactly 11 digits (e.g. 15021234567). Found: " + cleanFax.length);
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/mco-fax-directory`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mco_name: name, fax_number: cleanFax })
        });
        const result = await res.json();
        if (res.ok) {
            document.getElementById('mco_new_name').value = '';
            document.getElementById('mco_new_fax').value = '';
            loadMcoDirectory();
        } else {
            alert("Error: " + (result.error || "Failed to add MCO entry"));
        }
    } catch (err) {
        console.error("Error adding MCO entry:", err);
    }
});

window.deleteMcoEntry = async (id) => {
    if (!confirm('Delete this MCO fax entry?')) return;
    try {
        await fetch(`${API_BASE}/mco-fax-directory/${id}`, { method: 'DELETE' });
        loadMcoDirectory();
    } catch (err) {
        console.error("Error deleting MCO entry:", err);
    }
};

// === Fax Layer & Send Logic ===
function showFaxLayer() {
    const layer = document.getElementById('inline-fax-layer');
    layer.style.display = 'flex';
    layer.classList.add('active');
}

function hideFaxLayer() {
    const layer = document.getElementById('inline-fax-layer');
    layer.classList.remove('active');
    layer.style.display = 'none';
}

document.getElementById('btn-send-fax').addEventListener('click', async () => {
    if (!requireAuthStep('tab-actions') || !requireGeneratedPdfForFax()) return;

    // If we're on the Actions tab, we can open the fax layer
    const layer = document.getElementById('inline-fax-layer');
    if (layer.classList.contains('active')) {
        hideFaxLayer();
        return;
    }

    // Determine the current pending auth ID (assuming from URL or current screen context)
    // The previous implementation used window.openFaxModal(authId) from the table, but the 
    // top button 'btn-send-fax' needs to know the context. It should be the currently generated PDF auth.
    const authIdInput = document.getElementById('auth_id_input');
    if (!authIdInput || !authIdInput.value) {
        alert("No saved Record ID found. Please Save Record or Generate PDF first.");
        return;
    }
    
    pendingFaxAuthId = authIdInput.value;
    
    // UHC Check
    const mcoSelect = document.querySelector('select[name="mco"]');
    if (mcoSelect && mcoSelect.value === 'united') {
        alert("UnitedHealthcare does not accept faxes. Please submit via their portal.");
        return;
    }
    
    // Reset and Show Layer
    document.getElementById('fax_to_number').value = '';
    const errDiv = document.getElementById('fax-layer-error');
    errDiv.style.display = 'none';
    
    // Populate Directory Select
    const dirSelect = document.getElementById('fax_directory_select');
    dirSelect.innerHTML = '<option value="">-- Choose from Directory --</option>';
    
    if (mcoDirectory.length === 0) await loadMcoDirectory();
    mcoDirectory.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.fax_number.replace(/\D/g, ''); // Extract just digits for value
        opt.textContent = `${m.mco_name} (${m.fax_number})`;
        dirSelect.appendChild(opt);
    });

    dirSelect.onchange = (e) => {
        if (e.target.value) {
            document.getElementById('fax_to_number').value = e.target.value;
        }
    };

    // Auto-fill from selected MCO in form data
    try {
        const formDataStr = document.getElementById('auth-generate-form') ? new FormData(document.getElementById('auth-generate-form')) : null;
        if(formDataStr) {
             const mcoVal = formDataStr.get('mco');
             const match = mcoDirectory.find(m => m.mco_name.toLowerCase().includes(mcoVal) || mcoVal.includes(m.mco_name.toLowerCase()));
             if (match) {
                 const cleanFax = match.fax_number.replace(/\D/g, '');
                 dirSelect.value = cleanFax;
                 document.getElementById('fax_to_number').value = cleanFax;
             }
        }
    } catch(e) {}

    showFaxLayer();
});

// We keep this for the "Fax" button in the Past Authorizations table row.
window.openFaxModal = async (authId) => {
    pendingFaxAuthId = authId;
    const layer = document.getElementById('inline-fax-layer');
    
    // Reset and Show Layer
    document.getElementById('fax_to_number').value = '';
    const errDiv = document.getElementById('fax-layer-error');
    errDiv.style.display = 'none';
    
    // Populate Directory Select
    const dirSelect = document.getElementById('fax_directory_select');
    dirSelect.innerHTML = '<option value="">-- Choose from Directory --</option>';
    
    if (mcoDirectory.length === 0) await loadMcoDirectory();
    mcoDirectory.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.fax_number.replace(/\D/g, '');
        opt.textContent = `${m.mco_name} (${m.fax_number})`;
        dirSelect.appendChild(opt);
    });

    dirSelect.onchange = (e) => {
        if (e.target.value) {
            document.getElementById('fax_to_number').value = e.target.value;
        }
    };

    try {
        const res = await fetch(`${API_BASE}/auth-requests/${authId}`);
        const auth = await res.json();
        if (auth.form_data) {
            const data = JSON.parse(auth.form_data);
            if (data.mco === 'united') {
                alert("UnitedHealthcare does not accept faxes. Please submit via their portal.");
                return;
            }
            const mcoVal = data.mco;
            const match = mcoDirectory.find(m => m.mco_name.toLowerCase().includes(mcoVal) || mcoVal.includes(m.mco_name.toLowerCase()));
            if (match) {
                 const cleanFax = match.fax_number.replace(/\D/g, '');
                 dirSelect.value = cleanFax;
                 document.getElementById('fax_to_number').value = cleanFax;
            }
        }
    } catch (e) { /* ignore */ }

    showFaxLayer();
};

document.getElementById('btn-close-fax-layer').addEventListener('click', () => {
    hideFaxLayer();
    pendingFaxAuthId = null;
});

document.getElementById('fax-layer-send').addEventListener('click', async () => {
    const toNumber = document.getElementById('fax_to_number').value.trim();
    const errDiv = document.getElementById('fax-layer-error');
    errDiv.style.display = 'none';

    const cleanTo = toNumber.replace(/\D/g, '');
    if (cleanTo.length !== 11) {
        errDiv.textContent = 'Recipient Fax must be exactly 11 digits (e.g. 15021234567). Found: ' + cleanTo.length;
        errDiv.style.display = 'block';
        return;
    }

    const sendBtn = document.getElementById('fax-layer-send');
    const originalText = sendBtn.innerHTML;
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Dispatched...';

    try {
        const res = await fetch(`${API_BASE}/send-fax/${pendingFaxAuthId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toFaxNumber: cleanTo })
        });
        const result = await res.json();

        if (res.ok && result.success) {
            alert('Fax queued successfully! SRFax ID: ' + result.faxDetailsId);
            hideFaxLayer();
            authStepQueue.add('send-fax');
            document.getElementById('auth-fax-step')?.classList.add('completed');
            pendingFaxesToPoll.add(pendingFaxAuthId);
            pollPendingFaxStatuses();
            pendingFaxAuthId = null;
            if (currentClient) loadAuthHistory(currentClient.id);
        } else {
            errDiv.textContent = result.error || 'Failed to send fax.';
            errDiv.style.display = 'block';
        }
    } catch (err) {
        errDiv.textContent = 'Network error: ' + err.message;
        errDiv.style.display = 'block';
    } finally {
        sendBtn.disabled = false;
        sendBtn.innerHTML = originalText;
    }
});

// === Background Fax Polling ===
let faxPollInterval = null;
async function pollPendingFaxStatuses() {
    if (pendingFaxesToPoll.size === 0) {
        setFaxPollingIndicator('hidden');
        return;
    }

    setFaxPollingIndicator('checking');

    let needsRefresh = false;
    let confirmedSent = false;
    for (let authId of Array.from(pendingFaxesToPoll)) {
         try {
             const res = await fetch(`${API_BASE}/check-fax-status/${authId}`, { method: 'POST' });
             if (res.ok) {
                 const contentType = res.headers.get("content-type");
                 if (contentType && contentType.indexOf("application/json") !== -1) {
                     const result = await res.json();
                     if (result.success && !isPollableFaxStatus(result.faxStatus) && result.faxStatus !== 'Unknown') {
                         pendingFaxesToPoll.delete(authId);
                         confirmedSent = result.faxStatus === 'Sent' || result.faxStatus === 'Success';
                         needsRefresh = true;
                     }
                 }
             }
         } catch(e) { 
             console.error(`Background poll error for auth ${authId}:`, e);
         }
    }

    if (confirmedSent) {
        setFaxPollingIndicator('sent');
    } else {
        setFaxPollingIndicator('hidden');
    }
    
    // Reset spinners
    setTimeout(() => {
        document.querySelectorAll('.ph-spinner').forEach(s => s.style.textShadow = 'none');
    }, 2000);

    if (needsRefresh) {
        if (currentClient && document.getElementById('tab-actions').classList.contains('active')) {
            loadAuthHistory(currentClient.id);
        }
        if (document.getElementById('tab-fax-log') && document.getElementById('tab-fax-log').classList.contains('active')) {
            loadFaxLog();
        }
        // Also refresh if the global fax log view is active
        if (document.getElementById('view-fax-log').classList.contains('active')) {
            loadFaxLog();
        }
    }
}

function startFaxPolling() {
    if (faxPollInterval) clearInterval(faxPollInterval);
    // Poll every 2 minutes
    faxPollInterval = setInterval(async () => {
        await pollPendingFaxStatuses();
    }, 120000);
}

window.refreshFaxStatus = async (authId) => {
    try {
        const res = await fetch(`${API_BASE}/check-fax-status/${authId}`, { method: 'POST' });
        
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
            const result = await res.json();
            if (res.ok && result.success) {
                alert('Fax status: ' + result.faxStatus);
                if (currentClient) loadAuthHistory(currentClient.id);
            } else {
                alert(result.error || 'Could not check fax status.');
            }
        } else {
            // Not JSON - likely an HTML error page from the server
            const text = await res.text();
            console.error('Non-JSON response received:', text);
            alert(`Server Error: Received unexpected response format (HTTP ${res.status}). Check server logs.`);
        }
    } catch (err) {
        console.error('Error checking fax status:', err);
        alert('Network error: ' + err.message);
    }
};
// --- Calendar ---
async function loadCalendar() {
    try {
        const res = await fetch(`${API_BASE}/auth-requests/all`);
        allAuthsForCalendar = await res.json();
        renderCalendar();
    } catch (err) {
        console.error("Error loading calendar data:", err);
    }
}

function renderCalendar() {
    const grid = document.getElementById('calendar-grid');
    const monthYear = document.getElementById('calendar-month-year');
    if (!grid || !monthYear) return;

    grid.innerHTML = '';
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    
    monthYear.innerText = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(currentCalendarDate);

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();

    // Fill previous month days
    for (let i = firstDay - 1; i >= 0; i--) {
        const dayDiv = document.createElement('div');
        dayDiv.className = 'calendar-day not-current-month';
        dayDiv.innerHTML = `<span class="calendar-day-num">${prevMonthDays - i}</span>`;
        grid.appendChild(dayDiv);
    }

    // Fill current month days
    for (let d = 1; d <= daysInMonth; d++) {
        const dayDiv = document.createElement('div');
        dayDiv.className = 'calendar-day';
        dayDiv.innerHTML = `<span class="calendar-day-num">${d}</span>`;
        
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dayEvents = getEventsForDate(dateStr);
        
        if (dayEvents.length > 0) {
            const eventContainer = document.createElement('div');
            eventContainer.className = 'event-container';
            
            dayEvents.forEach(ev => {
                const indicator = document.createElement('div');
                indicator.className = `calendar-event-indicator ${ev.type === 'start' ? 'event-begins' : 'event-expires'}`;
                eventContainer.appendChild(indicator);
            });
            
            dayDiv.appendChild(eventContainer);
            
            // Tooltip
            dayDiv.onmouseenter = (e) => showCalendarTooltip(e, dayEvents);
            dayDiv.onmouseleave = hideCalendarTooltip;
            
            // Click details
            dayDiv.onclick = () => showCalendarDetails(dateStr, dayEvents);
        } else {
            dayDiv.onclick = () => showCalendarDetails(dateStr, []);
        }
        
        grid.appendChild(dayDiv);
    }
    
    // Fill next month days
    const totalSlots = grid.children.length;
    const remaining = 42 - totalSlots; // 6 rows
    for (let i = 1; i <= remaining; i++) {
        const dayDiv = document.createElement('div');
        dayDiv.className = 'calendar-day not-current-month';
        dayDiv.innerHTML = `<span class="calendar-day-num">${i}</span>`;
        grid.appendChild(dayDiv);
    }
}

function getEventsForDate(dateStr) {
    const events = [];
    allAuthsForCalendar.forEach(auth => {
        let data = {};
        try { data = JSON.parse(auth.form_data || '{}'); } catch(e) {}
        
        if (data.start_date_1 === dateStr) {
            events.push({ type: 'start', client: auth.client_name, authId: auth.id });
        }
        if (data.stop_date_1 === dateStr) {
            events.push({ type: 'stop', client: auth.client_name, authId: auth.id });
        }
    });
    return events;
}

function showCalendarTooltip(e, events) {
    let tooltip = document.getElementById('calendar-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'calendar-tooltip';
        tooltip.className = 'calendar-tooltip';
        document.body.appendChild(tooltip);
    }
    
    tooltip.innerHTML = events.map(ev => `<strong>${ev.type === 'start' ? 'Begins' : 'Expires'}:</strong> ${escapeHtml(ev.client)}`).join('<br>');
    tooltip.style.display = 'block';
    
    const rect = e.target.getBoundingClientRect();
    tooltip.style.left = `${rect.left + rect.width / 2}px`;
    tooltip.style.top = `${rect.top}px`;
}

function hideCalendarTooltip() {
    const tooltip = document.getElementById('calendar-tooltip');
    if (tooltip) tooltip.style.display = 'none';
}

function showCalendarDetails(dateStr, events) {
    const label = document.getElementById('selected-date-label');
    const list = document.getElementById('calendar-events-list');
    if (!label || !list) return;
    
    const dateObj = new Date(dateStr + 'T12:00:00');
    label.innerText = `Events for ${dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
    
    list.innerHTML = '';
    if (events.length === 0) {
        list.innerHTML = '<li style="color:#666; font-style:italic;">No events scheduled for this day.</li>';
        return;
    }
    
    events.forEach(ev => {
        const li = document.createElement('li');
        li.className = 'event-detail-item';
        li.style.borderLeft = `4px solid ${ev.type === 'start' ? '#22c55e' : '#ef4444'}`;
        li.innerHTML = `
            <div>
                <strong style="display:block;">${escapeHtml(ev.client)}</strong>
                <span style="font-size:0.8rem; color:#666;">Authorization ${ev.type === 'start' ? 'Begins' : 'Expires'}</span>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="viewClientDetailFromCalendar(${allAuthsForCalendar.find(a => a.id === ev.authId).client_id})"><i class="ph ph-eye"></i> View</button>
        `;
        list.appendChild(li);
    });
}

window.viewClientDetailFromCalendar = (clientId) => {
    viewClient(clientId);
};

window.prevMonth = () => {
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
    renderCalendar();
};

window.nextMonth = () => {
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
    renderCalendar();
};

// Initialize Application Data
async function initApp() {
    await loadClients();
    await loadFacilities();
    await loadMcoDirectory();
    await loadSettings();
    await loadFaxLog();
}

// Initialize app polling on load
initApp();
startFaxPolling();
