const INTAKEQ_BASE = 'https://intakeq.com/api/v1';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

const PCP_FIELD_MATCHERS = {
    pcp: [
        /^primary care name$/i,
        /^primary care provider$/i,
        /^primary care provider name$/i,
        /^pcp$/i,
        /^pcp name$/i
    ],
    pcp_phone: [
        /^primary care phone$/i,
        /^primary care provider phone$/i,
        /^pcp phone$/i,
        /^pcp phone number$/i
    ],
    pcp_npi: [
        /^primary care npi$/i,
        /^primary care provider npi$/i,
        /^pcp npi$/i,
        /^pcp npi number$/i
    ]
};

async function safeParseJson(resp, options = {}) {
    const raw = await readLimitedResponseText(resp, options);
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        return { raw };
    }
}

let defaultFetch = null;
let defaultFormData = null;

function __setFetch(fn) { defaultFetch = fn; }
function __setFormData(cls) { defaultFormData = cls; }
function __reset() { defaultFetch = null; defaultFormData = null; }

async function getFetch(injected) {
    if (injected) return injected;
    if (defaultFetch) return defaultFetch;
    return (await import('node-fetch')).default;
}

async function getFormData(injected) {
    if (injected) return injected;
    if (defaultFormData) return defaultFormData;
    return (await import('form-data')).default;
}

function responseLimitError(limit) {
    const err = new Error(`IntakeQ API response exceeded ${limit} bytes`);
    err.code = 'INTAKEQ_RESPONSE_TOO_LARGE';
    err.status = 502;
    err.upstream = 'IntakeQ';
    return err;
}

async function readLimitedResponseText(resp, { maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
    const contentLength = Number(resp.headers && typeof resp.headers.get === 'function'
        ? resp.headers.get('content-length')
        : null);
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
        throw responseLimitError(maxResponseBytes);
    }

    if (!resp.body || typeof resp.body[Symbol.asyncIterator] !== 'function') {
        const raw = await resp.text();
        if (Buffer.byteLength(raw) > maxResponseBytes) throw responseLimitError(maxResponseBytes);
        return raw;
    }

    const chunks = [];
    let total = 0;
    for await (const chunk of resp.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > maxResponseBytes) throw responseLimitError(maxResponseBytes);
        chunks.push(buf);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function createTimeoutSignal(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function request(apiKey, url, init = {}, { fetch: injectedFetch, timeoutMs, maxResponseBytes } = {}) {
    const fetch = await getFetch(injectedFetch);
    const method = init.method || 'GET';
    const headers = Object.assign({ 'X-Auth-Key': apiKey }, init.headers || {});
    const { signal, clear } = createTimeoutSignal(timeoutMs);
    try {
        const resp = await fetch(url, Object.assign({}, init, { headers, signal }));

        if (!resp.ok) {
            const errText = await readLimitedResponseText(resp, { maxResponseBytes });
            const err = new Error(`IntakeQ API Error: ${resp.status} - ${errText}`);
            err.status = resp.status;
            err.body = errText;
            err.method = method;
            err.url = url;
            err.upstream = 'IntakeQ';
            throw err;
        }

        return safeParseJson(resp, { maxResponseBytes });
    } finally {
        clear();
    }
}

async function searchClients(apiKey, name, deps = {}) {
    return request(
        apiKey,
        `${INTAKEQ_BASE}/clients?search=${encodeURIComponent(name)}&includeProfile=true`,
        { method: 'GET' },
        deps
    );
}

function matchingPcpKey(field) {
    const text = String(field && field.Text ? field.Text : '').trim();
    for (const [key, patterns] of Object.entries(PCP_FIELD_MATCHERS)) {
        if (patterns.some(pattern => pattern.test(text))) return key;
    }
    return null;
}

function extractPcpCustomFields(client = {}) {
    const result = {
        pcp: '',
        pcp_phone: '',
        pcp_npi: '',
        fieldIds: {}
    };

    for (const field of client.CustomFields || []) {
        const key = matchingPcpKey(field);
        if (!key || !field.FieldId) continue;
        result[key] = field.Value == null ? '' : String(field.Value);
        result.fieldIds[key] = field.FieldId;
    }

    return result;
}

async function discoverPcpFieldIds(apiKey, clientId, deps = {}) {
    const clients = await searchClients(apiKey, String(clientId), deps);
    const match = Array.isArray(clients)
        ? clients.find(client => String(client.ClientId || client.ClientNumber || '') === String(clientId)) || clients[0]
        : null;
    return extractPcpCustomFields(match || {}).fieldIds;
}

async function updateClientPcpCustomFields(apiKey, clientId, values = {}, deps = {}) {
    const fieldIds = deps.fieldIds || await discoverPcpFieldIds(apiKey, clientId, deps);
    const customFields = [
        ['pcp', values.pcp],
        ['pcp_phone', values.pcp_phone],
        ['pcp_npi', values.pcp_npi]
    ].filter(([key]) => fieldIds[key]).map(([key, value]) => ({
        FieldId: fieldIds[key],
        Value: value == null ? '' : String(value)
    }));

    if (customFields.length === 0) {
        return { skipped: true, reason: 'No matching IntakeQ PCP custom field IDs found' };
    }

    const payload = { ClientId: clientId, CustomFields: customFields };
    if (deps.clientName) {
        const parts = String(deps.clientName).trim().split(/\s+/).filter(Boolean);
        payload.FirstName = parts.shift() || '.';
        payload.LastName = parts.length > 0 ? parts.join(' ') : '.';
    }

    return request(
        apiKey,
        `${INTAKEQ_BASE}/clients`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        },
        deps
    );
}

async function getNotesSummary(apiKey, { clientId, clientName } = {}, deps = {}) {
    if (!clientId && !clientName) {
        throw new Error('getNotesSummary requires clientId or clientName');
    }
    const url = clientId
        ? `${INTAKEQ_BASE}/notes/summary?clientId=${encodeURIComponent(clientId)}`
        : `${INTAKEQ_BASE}/notes/summary?client=${encodeURIComponent(clientName)}`;
    return request(apiKey, url, { method: 'GET' }, deps);
}

async function listFiles(apiKey, clientId, deps = {}) {
    return request(
        apiKey,
        `${INTAKEQ_BASE}/files?clientId=${encodeURIComponent(clientId)}`,
        { method: 'GET' },
        deps
    );
}

async function uploadFile(apiKey, clientId, fileBuffer, filename, deps = {}) {
    const fetch = await getFetch(deps.fetch);
    const FormData = await getFormData(deps.FormData);

    const formData = new FormData();
    formData.append('file', fileBuffer, {
        filename,
        contentType: 'application/pdf'
    });

    const { signal, clear } = createTimeoutSignal(deps.timeoutMs);
    try {
        const resp = await fetch(`${INTAKEQ_BASE}/files/${encodeURIComponent(clientId)}`, {
            method: 'POST',
            headers: Object.assign({ 'X-Auth-Key': apiKey }, formData.getHeaders()),
            body: formData,
            signal
        });

        if (!resp.ok) {
            const errText = await readLimitedResponseText(resp, { maxResponseBytes: deps.maxResponseBytes });
            const err = new Error(`IntakeQ upload failed: ${resp.status} - ${errText}`);
            err.status = resp.status;
            err.body = errText;
            throw err;
        }

        return safeParseJson(resp, { maxResponseBytes: deps.maxResponseBytes });
    } finally {
        clear();
    }
}

module.exports = {
    safeParseJson,
    searchClients,
    extractPcpCustomFields,
    updateClientPcpCustomFields,
    getNotesSummary,
    listFiles,
    uploadFile,
    INTAKEQ_BASE,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_RESPONSE_BYTES,
    readLimitedResponseText,
    __setFetch,
    __setFormData,
    __reset
};
