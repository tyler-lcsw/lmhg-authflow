const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const ejs = require('ejs');
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./db');
const { sendFax, checkFaxStatus } = require('./srfax');
const intakeq = require('./intakeq');
const {
    createErrorLogger,
    createRequestTracer,
    installProcessErrorLogging,
    DEFAULT_LOG_FILE
} = require('./tracing');

const app = express();
const port = 3000;
const apiToken = process.env.AUTH_FORMS_API_TOKEN || crypto.randomBytes(24).toString('hex');

const CLIENT_SELECT = `
    SELECT
        c.id, c.name, c.medicaid_id, c.mco_id, c.dob, c.pregnant,
        COALESCE(p.name, c.pcp) AS pcp,
        COALESCE(p.phone, c.pcp_phone) AS pcp_phone,
        COALESCE(p.npi, c.pcp_npi) AS pcp_npi,
        c.work_injury, c.mva, c.other_insurance, c.insurer,
        c.medicare_a, c.medicare_b, c.intakeq_client_id,
        c.primary_care_provider_id
    FROM clients c
    LEFT JOIN primary_care_providers p ON p.id = c.primary_care_provider_id
`;

function requireField(value, label) {
    if (!String(value || '').trim()) {
        return `${label} is required`;
    }
    return null;
}

function phoneFaxError(value, label) {
    if (!String(value || '').trim()) return null;
    const digits = String(value).replace(/\D/g, '');
    if (digits.length === 10) return null;
    if (digits.length === 11 && digits.startsWith('1')) return null;
    return `${label} must be a 10-digit US number or 11 digits starting with 1.`;
}

function normalizePhoneFax(value) {
    if (!String(value || '').trim()) return value || '';
    const digits = String(value).replace(/\D/g, '');
    const normalized = digits.length === 10 ? `1${digits}` : digits;
    if (normalized.length !== 11 || !normalized.startsWith('1')) return String(value).trim();
    return `1 (${normalized.slice(1, 4)}) ${normalized.slice(4, 7)}-${normalized.slice(7)}`;
}

function toSrfaxCallerId(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function toDialableFaxNumber(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length === 10 ? `1${digits}` : digits;
}

function firstConfiguredValue(...values) {
    for (const value of values) {
        const text = String(value || '').trim();
        if (text) return text;
    }
    return '';
}

function providedSecretValue(value) {
    const text = String(value || '').trim();
    return text ? text : null;
}

function serializeSettings(row = {}) {
    const copy = Object.assign({}, row);
    for (const key of ['srfax_access_id', 'srfax_access_pwd', 'intakeq_api_key']) {
        copy[`${key}_configured`] = Boolean(copy[key]);
        delete copy[key];
    }
    return copy;
}

function tokensMatch(provided, expected) {
    const providedBuffer = Buffer.from(String(provided || ''));
    const expectedBuffer = Buffer.from(String(expected || ''));
    return providedBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function requireApiToken(req, res, next) {
    if (process.env.AUTH_FORMS_TEST_BYPASS_AUTH === '1') return next();

    const headerToken = req.get('x-auth-token') || '';
    const authHeader = req.get('authorization') || '';
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : '';
    const provided = headerToken || bearerToken;

    if (!tokensMatch(provided, apiToken)) {
        return res.status(401).json({ error: "API token required" });
    }
    return next();
}

function applyServicingFacilityDefaults(formData, settings = {}) {
    const env = process.env;
    Object.assign(formData, {
        servicing_facility: firstConfiguredValue(formData.servicing_facility, settings.servicing_facility, env.AUTH_FORMS_FACILITY_NAME),
        serv_facility_npi: firstConfiguredValue(formData.serv_facility_npi, settings.serv_facility_npi, env.AUTH_FORMS_FACILITY_NPI),
        serv_facility_tax_id: firstConfiguredValue(formData.serv_facility_tax_id, settings.serv_facility_tax_id, env.AUTH_FORMS_FACILITY_TAX_ID),
        serv_facility_address: firstConfiguredValue(formData.serv_facility_address, settings.serv_facility_address, env.AUTH_FORMS_FACILITY_ADDRESS),
        serv_facility_city: firstConfiguredValue(formData.serv_facility_city, settings.serv_facility_city, env.AUTH_FORMS_FACILITY_CITY),
        serv_facility_state: firstConfiguredValue(formData.serv_facility_state, settings.serv_facility_state, env.AUTH_FORMS_FACILITY_STATE),
        serv_facility_zip: firstConfiguredValue(formData.serv_facility_zip, settings.serv_facility_zip, env.AUTH_FORMS_FACILITY_ZIP),
        serv_facility_phone: firstConfiguredValue(formData.serv_facility_phone, settings.serv_facility_phone, env.AUTH_FORMS_FACILITY_PHONE),
        serv_facility_fax: firstConfiguredValue(formData.serv_facility_fax, settings.serv_facility_fax, env.AUTH_FORMS_FACILITY_FAX)
    });
}

function normalizeClientInsuranceIds(data) {
    const copy = Object.assign({}, data);
    let medicaidId = String(copy.medicaid_id || '').trim();
    let mcoId = String(copy.mco_id || '').trim();

    if (medicaidId && mcoId && medicaidId === mcoId) {
        if (/^(00|000)/.test(medicaidId)) {
            mcoId = '';
        } else {
            medicaidId = '';
        }
    }

    if (!medicaidId && /^(00|000)/.test(mcoId)) {
        medicaidId = mcoId;
        mcoId = '';
    }

    if (!mcoId && medicaidId && !/^(00|000)/.test(medicaidId)) {
        mcoId = medicaidId;
        medicaidId = '';
    }

    copy.medicaid_id = medicaidId;
    copy.mco_id = mcoId;
    return copy;
}

function validatePhoneFaxFields(data, fields) {
    for (const [key, label] of fields) {
        const err = phoneFaxError(data[key], label);
        if (err) return err;
    }
    return null;
}

function normalizePhoneFaxFields(data, fields) {
    const copy = Object.assign({}, data);
    for (const key of fields) {
        copy[key] = normalizePhoneFax(copy[key]);
    }
    return copy;
}

function validateClientData(data) {
    if (data.primary_care_provider_id) return requireField(data.name, 'Client Name');
    return (
        requireField(data.name, 'Client Name') ||
        requireField(data.pcp, 'PCP name') ||
        requireField(data.pcp_phone, 'PCP phone') ||
        requireField(data.pcp_npi, 'PCP NPI') ||
        phoneFaxError(data.pcp_phone, 'PCP phone')
    );
}

function runDb(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function getDb(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}

async function rollbackQuietly() {
    try { await runDb('ROLLBACK'); } catch {}
}

const TERMINAL_FAX_STATUSES = new Set(['Sent', 'Success', 'Failed', 'Error']);

function isImmutableAuthorization(auth) {
    return auth && Boolean(auth.intakeq_uploaded_at);
}

function sendImmutableAuthorizationResponse(res) {
    return res.status(409).json({
        error: "Authorization is immutable. Copy the existing authorization to make changes."
    });
}

function isTerminalFaxStatus(status) {
    return TERMINAL_FAX_STATUSES.has(status) || String(status || '').includes('Error');
}

async function findOrCreatePrimaryCareProvider(data) {
    if (data.primary_care_provider_id) {
        const row = await getDb(
            "SELECT id, name, phone, npi FROM primary_care_providers WHERE id = ?",
            [data.primary_care_provider_id]
        );
        if (!row) {
            const err = new Error("Selected PCP was not found.");
            err.status = 400;
            throw err;
        }
        return row;
    }

    const provider = {
        name: String(data.pcp || '').trim(),
        phone: normalizePhoneFax(data.pcp_phone),
        npi: String(data.pcp_npi || '').trim()
    };

    const existingByNpi = await getDb(
        "SELECT id, name, phone, npi FROM primary_care_providers WHERE npi = ?",
        [provider.npi]
    );
    if (existingByNpi) {
        if (existingByNpi.name !== provider.name || existingByNpi.phone !== provider.phone) {
            await runDb(
                "UPDATE primary_care_providers SET name = ?, phone = ? WHERE id = ?",
                [provider.name, provider.phone, existingByNpi.id]
            );
            await runDb(
                "UPDATE clients SET pcp = ?, pcp_phone = ?, pcp_npi = ? WHERE primary_care_provider_id = ?",
                [provider.name, provider.phone, provider.npi, existingByNpi.id]
            );
        }
        return { id: existingByNpi.id, ...provider };
    }

    const result = await runDb(
        "INSERT INTO primary_care_providers (name, phone, npi) VALUES (?, ?, ?)",
        [provider.name, provider.phone, provider.npi]
    );

    return { id: result.lastID, ...provider };
}

async function getIntakeqApiKey() {
    const row = await getDb("SELECT intakeq_api_key FROM settings WHERE id = 1");
    return row && row.intakeq_api_key ? row.intakeq_api_key : '';
}

async function syncPcpToIntakeq(data, provider) {
    return {
        skipped: true,
        reason: 'PCP data is local-only; IntakeQ client writes are disabled for local saves.'
    };
}

/**
 * Re-saves a PDF buffer through pdf-lib to normalize the format for SRFax compatibility.
 * SRFax's converter can't handle PDFs with certain features Puppeteer outputs by default.
 */
async function normalizePdfForFax(inputBuffer) {
    const pdfDoc = await PDFDocument.load(inputBuffer, { ignoreEncryption: true });
    const normalizedBytes = await pdfDoc.save();
    return Buffer.from(normalizedBytes);
}

function getNextRecordNumber() {
    return new Promise((resolve, reject) => {
        db.get("SELECT MAX(record_number) as maxNum FROM auth_requests", (err, row) => {
            if (err) reject(err);
            else resolve((row && row.maxNum ? row.maxNum : 0) + 1);
        });
    });
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(createRequestTracer());
app.use(express.static('public')); // serve frontend
app.use('/api', requireApiToken);
app.set('view engine', 'ejs');

// Multer setup for handling PDF uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
function isPdfUpload(file) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    return ext === '.pdf' && file.mimetype === 'application/pdf';
}

const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024, files: 10 },
    fileFilter: (req, file, cb) => {
        if (!isPdfUpload(file)) {
            const err = new Error("Attachments must be PDF files.");
            err.status = 400;
            return cb(err);
        }
        cb(null, true);
    }
});

function cleanupUploadedFiles(files = []) {
    for (const file of files) {
        if (file && file.path && fs.existsSync(file.path)) {
            try { fs.unlinkSync(file.path); } catch {}
        }
    }
}

function uploadAuthAttachments(req, res, next) {
    upload.array('attachments', 10)(req, res, (err) => {
        if (!err) return next();
        cleanupUploadedFiles(req.files);
        const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 400 : 500);
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? "Attachments must be 20 MB or smaller."
            : err.message;
        return res.status(status).json({ error: message });
    });
}

// Ensure directories exist
fs.mkdirSync('uploads', { recursive: true });
fs.mkdirSync('output', { recursive: true });

// === API ROUTES ===

// --- Clients ---
app.get('/api/clients', (req, res) => {
    db.all(`${CLIENT_SELECT} ORDER BY c.name`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/clients/:id', (req, res) => {
    db.get(`${CLIENT_SELECT} WHERE c.id = ?`, [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Client not found" });
        res.json(row);
    });
});

app.post('/api/clients', async (req, res) => {
    const data = normalizeClientInsuranceIds(req.body || {});
    const validationError = validateClientData(data);
    if (validationError) return res.status(400).json({ error: validationError });

    try {
        const provider = await findOrCreatePrimaryCareProvider(data);
        const result = await runDb(`
            INSERT INTO clients (
                name, medicaid_id, mco_id, dob, pregnant, pcp, pcp_phone, pcp_npi,
                primary_care_provider_id,
                work_injury, mva, other_insurance, insurer, medicare_a, medicare_b, intakeq_client_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            data.name, data.medicaid_id, data.mco_id, data.dob, data.pregnant,
            provider.name, provider.phone, provider.npi, provider.id,
            data.work_injury, data.mva, data.other_insurance, data.insurer,
            data.medicare_a, data.medicare_b, data.intakeq_client_id || null
        ]);
        const intakeqPcpSync = await syncPcpToIntakeq(data, provider);
        res.json({ id: result.lastID, primary_care_provider_id: provider.id, intakeq_pcp_sync: intakeqPcpSync });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

app.put('/api/clients/:id', async (req, res) => {
    const data = normalizeClientInsuranceIds(req.body || {});
    const validationError = validateClientData(data);
    if (validationError) return res.status(400).json({ error: validationError });

    try {
        const provider = await findOrCreatePrimaryCareProvider(data);
        const result = await runDb(`
            UPDATE clients SET
                name=?, medicaid_id=?, mco_id=?, dob=?, pregnant=?, pcp=?, pcp_phone=?, pcp_npi=?,
                primary_care_provider_id=?,
                work_injury=?, mva=?, other_insurance=?, insurer=?, medicare_a=?, medicare_b=?,
                intakeq_client_id=COALESCE(?, intakeq_client_id)
            WHERE id=?
        `, [
            data.name, data.medicaid_id, data.mco_id, data.dob, data.pregnant,
            provider.name, provider.phone, provider.npi, provider.id,
            data.work_injury, data.mva, data.other_insurance, data.insurer,
            data.medicare_a, data.medicare_b, data.intakeq_client_id || null,
            req.params.id
        ]);
        const intakeqPcpSync = await syncPcpToIntakeq(data, provider);
        res.json({ changes: result.changes, primary_care_provider_id: provider.id, intakeq_pcp_sync: intakeqPcpSync });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

app.delete('/api/clients/:id', (req, res) => {
    db.all("SELECT pdf_path FROM auth_requests WHERE client_id = ?", [req.params.id], async (selectErr, rows = []) => {
        if (selectErr) return res.status(500).json({ error: selectErr.message });

        try {
            await runDb('BEGIN');
            await runDb("DELETE FROM auth_requests WHERE client_id = ?", [req.params.id]);
            const result = await runDb("DELETE FROM clients WHERE id = ?", [req.params.id]);
            await runDb('COMMIT');

            for (const row of rows) {
                if (row.pdf_path && fs.existsSync(row.pdf_path)) {
                    try { fs.unlinkSync(row.pdf_path); } catch {}
                }
            }
            res.json({ changes: result.changes });
        } catch (err) {
            await rollbackQuietly();
            res.status(500).json({ error: err.message });
        }
    });
});

// --- PCP Directory ---
function validatePcpDirectoryData(data) {
    return (
        requireField(data.name, 'PCP name') ||
        requireField(data.phone, 'PCP phone') ||
        requireField(data.npi, 'PCP NPI') ||
        phoneFaxError(data.phone, 'PCP phone')
    );
}

function cleanPcpDirectoryData(data) {
    return {
        name: String(data.name || '').trim(),
        phone: normalizePhoneFax(data.phone),
        npi: String(data.npi || '').trim()
    };
}

function logIntakeqCustomFieldLabels(clients) {
    const seen = new Map();
    for (const client of clients || []) {
        for (const field of client.CustomFields || []) {
            if (!field.FieldId || !field.Text) continue;
            seen.set(field.FieldId, field.Text);
        }
    }
    if (seen.size > 0) {
        console.log('[IntakeQ CustomFields]', JSON.stringify(
            Array.from(seen.entries()).map(([fieldId, text]) => ({ fieldId, text }))
        ));
    } else {
        console.log('[IntakeQ CustomFields] No CustomFields returned in client-search response.');
    }
}

app.get('/api/pcp-directory', (req, res) => {
    db.all(`
        SELECT
            p.id,
            p.name,
            p.phone,
            p.npi,
            COUNT(c.id) AS client_count
        FROM primary_care_providers p
        LEFT JOIN clients c ON c.primary_care_provider_id = p.id
        GROUP BY p.id
        ORDER BY p.name
    `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/pcp-directory/clients', (req, res) => {
    db.all(`
        SELECT
            id,
            name,
            medicaid_id,
            dob,
            primary_care_provider_id
        FROM clients
        ORDER BY name
    `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/pcp-directory', async (req, res) => {
    const validationError = validatePcpDirectoryData(req.body || {});
    if (validationError) return res.status(400).json({ error: validationError });

    const data = cleanPcpDirectoryData(req.body);
    try {
        const existing = await getDb("SELECT id FROM primary_care_providers WHERE npi = ?", [data.npi]);
        if (existing) {
            return res.status(409).json({ error: "A PCP with this NPI already exists." });
        }
        const result = await runDb(
            "INSERT INTO primary_care_providers (name, phone, npi) VALUES (?, ?, ?)",
            [data.name, data.phone, data.npi]
        );
        res.json({ id: result.lastID });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT') {
            return res.status(409).json({ error: "A PCP with this name, phone, and NPI already exists." });
        }
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/pcp-directory/:id', async (req, res) => {
    const validationError = validatePcpDirectoryData(req.body || {});
    if (validationError) return res.status(400).json({ error: validationError });

    const data = cleanPcpDirectoryData(req.body);
    try {
        const duplicate = await getDb(
            "SELECT id FROM primary_care_providers WHERE npi = ? AND id <> ?",
            [data.npi, req.params.id]
        );
        if (duplicate) {
            return res.status(409).json({ error: "A PCP with this NPI already exists." });
        }
        await runDb('BEGIN');
        const result = await runDb(
            "UPDATE primary_care_providers SET name = ?, phone = ?, npi = ? WHERE id = ?",
            [data.name, data.phone, data.npi, req.params.id]
        );
        await runDb(
            "UPDATE clients SET pcp = ?, pcp_phone = ?, pcp_npi = ? WHERE primary_care_provider_id = ?",
            [data.name, data.phone, data.npi, req.params.id]
        );
        await runDb('COMMIT');
        res.json({ changes: result.changes });
    } catch (err) {
        await rollbackQuietly();
        if (err.code === 'SQLITE_CONSTRAINT') {
            return res.status(409).json({ error: "A PCP with this NPI already exists." });
        }
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/pcp-directory/:id', async (req, res) => {
    try {
        const usage = await getDb(
            "SELECT COUNT(*) AS count FROM clients WHERE primary_care_provider_id = ?",
            [req.params.id]
        );
        if (usage.count > 0) {
            const label = usage.count === 1 ? 'client' : 'clients';
            return res.status(409).json({ error: `This PCP is assigned to ${usage.count} ${label}. Reassign those clients before deleting it.` });
        }

        const result = await runDb("DELETE FROM primary_care_providers WHERE id = ?", [req.params.id]);
        res.json({ changes: result.changes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/pcp-directory/:pcpId/clients/:clientId', async (req, res) => {
    try {
        const provider = await getDb(
            "SELECT id, name, phone, npi FROM primary_care_providers WHERE id = ?",
            [req.params.pcpId]
        );
        if (!provider) return res.status(404).json({ error: "PCP not found" });

        const result = await runDb(`
            UPDATE clients
            SET primary_care_provider_id = ?, pcp = ?, pcp_phone = ?, pcp_npi = ?
            WHERE id = ?
        `, [provider.id, provider.name, provider.phone, provider.npi, req.params.clientId]);

        if (result.changes === 0) return res.status(404).json({ error: "Client not found" });
        res.json({ changes: result.changes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Settings ---
app.get('/api/settings', (req, res) => {
    db.get("SELECT * FROM settings WHERE id = 1", [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(serializeSettings(row || {}));
    });
});

app.put('/api/settings', (req, res) => {
    const data = normalizePhoneFaxFields(req.body || {}, [
        'req_provider_phone',
        'req_provider_fax',
        'completed_by_phone',
        'srfax_caller_id'
    ]);
    
    // Basic validation
    if (!data.requesting_provider) return res.status(400).json({ error: "Requesting Provider Name is required" });
    const validationError = validatePhoneFaxFields(data, [
        ['req_provider_phone', 'Requesting provider phone'],
        ['req_provider_fax', 'Requesting provider fax'],
        ['completed_by_phone', 'Completed by phone'],
        ['srfax_caller_id', 'SRFax Caller ID']
    ]);
    if (validationError) return res.status(400).json({ error: validationError });

    db.get(
        "SELECT srfax_access_id, srfax_access_pwd, intakeq_api_key FROM settings WHERE id = 1",
        [],
        (readErr, existing = {}) => {
            if (readErr) return res.status(500).json({ error: readErr.message });

            const stmt = db.prepare(`
                UPDATE settings SET
                    requesting_provider=?, req_provider_phone=?, req_provider_npi=?, req_provider_fax=?,
                    completed_by=?, completed_by_phone=?,
                    srfax_access_id=?, srfax_access_pwd=?, srfax_caller_id=?, srfax_sender_email=?,
                    intakeq_api_key=?
                WHERE id=1
            `);
            stmt.run(
                [
                    data.requesting_provider, data.req_provider_phone, data.req_provider_npi, data.req_provider_fax,
                    data.completed_by, data.completed_by_phone,
                    providedSecretValue(data.srfax_access_id) || existing.srfax_access_id || '',
                    providedSecretValue(data.srfax_access_pwd) || existing.srfax_access_pwd || '',
                    data.srfax_caller_id, data.srfax_sender_email,
                    providedSecretValue(data.intakeq_api_key) || existing.intakeq_api_key || ''
                ],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ changes: this.changes });
                }
            );
            stmt.finalize();
        }
    );
});

// --- Provider Presets (Still mapped to /api/facilities for now) ---
app.get('/api/facilities', (req, res) => {
    db.all("SELECT * FROM provider_presets", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/facilities', (req, res) => {
    const data = normalizePhoneFaxFields(req.body || {}, [
        'req_provider_phone',
        'req_provider_fax',
        'serv_provider_phone',
        'serv_provider_fax'
    ]);
    if (!data.name) return res.status(400).json({ error: "Provider Preset Name is required" });
    const validationError = validatePhoneFaxFields(data, [
        ['req_provider_phone', 'Requesting provider phone'],
        ['req_provider_fax', 'Requesting provider fax'],
        ['serv_provider_phone', 'Servicing provider phone'],
        ['serv_provider_fax', 'Servicing provider fax']
    ]);
    if (validationError) return res.status(400).json({ error: validationError });

    const stmt = db.prepare(`
        INSERT INTO provider_presets (
            name, requesting_provider, req_provider_npi, req_provider_phone, req_provider_fax,
            servicing_provider, serv_provider_npi, serv_provider_tax_id,
            serv_provider_address, serv_provider_city, serv_provider_state,
            serv_provider_zip, serv_provider_phone, serv_provider_fax
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
        [
            data.name, data.requesting_provider, data.req_provider_npi, data.req_provider_phone, data.req_provider_fax,
            data.servicing_provider, data.serv_provider_npi, data.serv_provider_tax_id,
            data.serv_provider_address, data.serv_provider_city, data.serv_provider_state,
            data.serv_provider_zip, data.serv_provider_phone, data.serv_provider_fax
        ],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        }
    );
    stmt.finalize();
});

app.put('/api/facilities/:id', (req, res) => {
    const data = normalizePhoneFaxFields(req.body || {}, [
        'req_provider_phone',
        'req_provider_fax',
        'serv_provider_phone',
        'serv_provider_fax'
    ]);
    if (!data.name) return res.status(400).json({ error: "Provider Preset Name is required" });
    const validationError = validatePhoneFaxFields(data, [
        ['req_provider_phone', 'Requesting provider phone'],
        ['req_provider_fax', 'Requesting provider fax'],
        ['serv_provider_phone', 'Servicing provider phone'],
        ['serv_provider_fax', 'Servicing provider fax']
    ]);
    if (validationError) return res.status(400).json({ error: validationError });

    const stmt = db.prepare(`
        UPDATE provider_presets SET
            name=?, requesting_provider=?, req_provider_npi=?, req_provider_phone=?, req_provider_fax=?,
            servicing_provider=?, serv_provider_npi=?, serv_provider_tax_id=?,
            serv_provider_address=?, serv_provider_city=?, serv_provider_state=?,
            serv_provider_zip=?, serv_provider_phone=?, serv_provider_fax=?
        WHERE id=?
    `);
    stmt.run(
        [
            data.name, data.requesting_provider, data.req_provider_npi, data.req_provider_phone, data.req_provider_fax,
            data.servicing_provider, data.serv_provider_npi, data.serv_provider_tax_id,
            data.serv_provider_address, data.serv_provider_city, data.serv_provider_state,
            data.serv_provider_zip, data.serv_provider_phone, data.serv_provider_fax,
            req.params.id
        ],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ changes: this.changes });
        }
    );
    stmt.finalize();
});

app.delete('/api/facilities/:id', (req, res) => {
    db.run("DELETE FROM provider_presets WHERE id = ?", [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ changes: this.changes });
    });
});

// --- Auth Requests & PDF Generation ---
app.get('/api/clients/:id/auth-requests', (req, res) => {
    db.all("SELECT id, date_created, last_updated, is_draft, fax_status, fax_to_number, fax_details_id, form_data, record_number, clinical_status, fax_sent_date, intakeq_uploaded_at FROM auth_requests WHERE client_id = ? ORDER BY COALESCE(last_updated, date_created) DESC", [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/auth-requests/all', (req, res) => {
    const query = `
        SELECT 
            a.id, 
            a.client_id,
            a.form_data,
            a.clinical_status,
            a.intakeq_uploaded_at,
            a.is_draft,
            c.name as client_name
        FROM auth_requests a
        JOIN clients c ON a.client_id = c.id
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/fax-log', (req, res) => {
    const query = `
        SELECT 
            a.id, 
            a.client_id,
            a.date_created, 
            a.fax_status, 
            a.fax_sent_date, 
            a.fax_to_number, 
            c.name as client_name
        FROM auth_requests a
        JOIN clients c ON a.client_id = c.id
        WHERE a.fax_sent_date IS NOT NULL
        ORDER BY a.fax_sent_date DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/save-auth-draft', async (req, res) => {
    const { client_id, auth_id, form_data } = req.body;
    if (!client_id || !form_data) return res.status(400).json({ error: "Client ID and form data required" });

    const formDataStr = typeof form_data === 'string' ? form_data : JSON.stringify(form_data);

    if (auth_id) {
        try {
            const existing = await getDb("SELECT id, intakeq_uploaded_at FROM auth_requests WHERE id = ?", [auth_id]);
            if (!existing) return res.status(404).json({ error: "Not found" });
            if (isImmutableAuthorization(existing)) return sendImmutableAuthorizationResponse(res);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }

        db.run(
            "UPDATE auth_requests SET form_data = ?, is_draft = 1, last_updated = datetime('now') WHERE id = ?",
            [formDataStr, auth_id],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ id: auth_id, success: true });
            }
        );
    } else {
        getNextRecordNumber().then(num => {
            db.run(
                "INSERT INTO auth_requests (client_id, form_data, is_draft, last_updated, record_number, clinical_status) VALUES (?, ?, 1, datetime('now'), ?, 'Draft')",
                [client_id, formDataStr, num],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ id: this.lastID, record_number: num, success: true });
                }
            );
        }).catch(err => res.status(500).json({ error: err.message }));
    }
});

const MANUAL_AUTH_STATUSES = new Set(['In Review', 'Pending', 'Granted', 'Denied']);

function buildManualAuthFormData(data) {
    return {
        manual_entry: true,
        date: data.date || new Date().toISOString().slice(0, 10),
        start_date_1: data.start_date,
        stop_date_1: data.stop_date,
        units_1: data.units || '',
        procedure_code_1: data.procedure_code || '',
        requested_service_1: data.requested_service || '',
        additional_info: data.notes || ''
    };
}

function validateManualAuthPayload(data) {
    if (!data.client_id) return "Client ID is required";
    if (!data.start_date || !data.stop_date) return "Start date and stop date are required";
    if (!MANUAL_AUTH_STATUSES.has(data.status)) return "A valid authorization status is required";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(data.stop_date)) {
        return "Start date and stop date must use YYYY-MM-DD format";
    }
    if (data.stop_date < data.start_date) return "Stop date must be on or after start date";
    return null;
}

app.post('/api/auth-requests/manual', async (req, res) => {
    const data = req.body || {};
    const validationError = validateManualAuthPayload(data);
    if (validationError) return res.status(400).json({ error: validationError });

    try {
        const client = await getDb("SELECT id FROM clients WHERE id = ?", [data.client_id]);
        if (!client) return res.status(404).json({ error: "Client not found" });

        const formDataStr = JSON.stringify(buildManualAuthFormData(data));
        const num = await getNextRecordNumber();
        const result = await runDb(
            `INSERT INTO auth_requests (
                client_id, form_data, is_draft, last_updated, record_number, clinical_status
            ) VALUES (?, ?, 0, datetime('now'), ?, ?)`,
            [data.client_id, formDataStr, num, data.status]
        );

        res.json({ id: result.lastID, record_number: num, success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth-requests/:id', (req, res) => {
    db.get("SELECT * FROM auth_requests WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Not found" });
        res.json(row);
    });
});

app.get('/api/auth-requests/:id/download', (req, res) => {
    db.get("SELECT pdf_path FROM auth_requests WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row || !fs.existsSync(row.pdf_path)) return res.status(404).json({ error: "Not found" });
        res.download(row.pdf_path);
    });
});

app.get('/api/auth-requests/:id/preview', (req, res) => {
    const id = req.params.id;
    console.log(`[PREVIEW] Request received for ID: ${id}`);
    
    db.get("SELECT pdf_path FROM auth_requests WHERE id = ?", [id], (err, row) => {
        if (err) {
            console.error(`[PREVIEW] DB Error for ID ${id}:`, err);
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            console.warn(`[PREVIEW] No auth record found for ID: ${id}`);
            return res.status(404).json({ error: "Auth request not found" });
        }
        if (!row.pdf_path || !fs.existsSync(row.pdf_path)) {
            console.warn(`[PREVIEW] PDF file not found at path: ${row.pdf_path}`);
            return res.status(404).json({ error: "PDF file not found. Ensure the authorization has been generated." });
        }
        
        console.log(`[PREVIEW] Serving file: ${row.pdf_path}`);
        res.sendFile(row.pdf_path);
    });
});

app.delete('/api/auth-requests/:id', (req, res) => {
    db.get("SELECT pdf_path, intakeq_uploaded_at FROM auth_requests WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Not found" });
        if (isImmutableAuthorization(row)) return sendImmutableAuthorizationResponse(res);
        if (row && row.pdf_path && fs.existsSync(row.pdf_path)) {
            try { fs.unlinkSync(row.pdf_path); } catch (e) { }
        }
        db.run("DELETE FROM auth_requests WHERE id = ?", [req.params.id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ changes: this.changes });
        });
    });
});

app.put('/api/auth-requests/:id', (req, res) => {
    const { form_data, clinical_status } = req.body;
    if (form_data) {
        db.get("SELECT intakeq_uploaded_at FROM auth_requests WHERE id = ?", [req.params.id], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: "Not found" });
            if (isImmutableAuthorization(row)) return sendImmutableAuthorizationResponse(res);
            updateAuthRequest();
        });
    } else {
        updateAuthRequest();
    }

    function updateAuthRequest() {
    let query = "UPDATE auth_requests SET ";
    let params = [];
    if (form_data) {
        query += "form_data = ?, ";
        params.push(typeof form_data === 'string' ? form_data : JSON.stringify(form_data));
    }
    if (clinical_status) {
        query += "clinical_status = ?, ";
        params.push(clinical_status);
    }
    query = query.slice(0, -2); // Remove trailing comma
    query += " WHERE id = ?";
    params.push(req.params.id);

    db.run(query, params, function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: "Not found" });
        res.json({ changes: this.changes });
    });
    }
});

app.post('/api/generate-auth', uploadAuthAttachments, async (req, res) => {
    try {
        const formDataStr = req.body.formData;
        if (!formDataStr) {
            return res.status(400).json({ error: "No form data provided" });
        }

        const formData = JSON.parse(formDataStr);
        const clientId = formData.client_id;
        const authId = formData.auth_id;

        if (authId) {
            const existing = await getDb("SELECT id, intakeq_uploaded_at FROM auth_requests WHERE id = ?", [authId]);
            if (!existing) return res.status(404).json({ error: "Not found" });
            if (isImmutableAuthorization(existing)) return sendImmutableAuthorizationResponse(res);
        }

        const facilitySettings = await getDb(`
            SELECT servicing_facility, serv_facility_npi, serv_facility_tax_id,
                   serv_facility_address, serv_facility_city, serv_facility_state,
                   serv_facility_zip, serv_facility_phone, serv_facility_fax
            FROM settings
            WHERE id = 1
        `);
        applyServicingFacilityDefaults(formData, facilitySettings || {});

        // Fetch client and settings to merge with form data (optional, frontend might send it all)
        // Assume frontend sends everything needed for the EJS template inside formData.

        // 1. Render HTML
        const html = await ejs.renderFile(path.join(__dirname, 'views/form_template.ejs'), { data: formData });

        // 2. Generate PDF from HTML using Puppeteer
        const browser = await puppeteer.launch({ headless: 'new' });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const formPdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } });
        await browser.close();

        // 3. Merge with attachments using pdf-lib
        const mergedPdf = await PDFDocument.create();
        const mainDoc = await PDFDocument.load(formPdfBuffer);
        const mainPages = await mergedPdf.copyPages(mainDoc, mainDoc.getPageIndices());
        mainPages.forEach(page => mergedPdf.addPage(page));

        // 3a. Merge IntakeQ Notes if requested
        if (req.body.intakeqNotes) {
            try {
                const noteIds = JSON.parse(req.body.intakeqNotes);
                if (Array.isArray(noteIds) && noteIds.length > 0) {
                    
                    // Fetch API key
                    const settings = await new Promise((resolve, reject) => {
                        db.get("SELECT intakeq_api_key FROM settings WHERE id = 1", (err, row) => {
                            if (err) reject(err); else resolve(row || {});
                        });
                    });

                    if (settings.intakeq_api_key) {
                        const fetch = (await import('node-fetch')).default;
                        
                        for (const noteId of noteIds) {
                            const response = await fetch(`https://intakeq.com/api/v1/notes/${noteId}/pdf`, {
                                method: 'GET',
                                headers: { 'X-Auth-Key': settings.intakeq_api_key }
                            });
                            
                            if (response.ok) {
                                const arrayBuffer = await response.arrayBuffer();
                                const notePdfBuffer = Buffer.from(arrayBuffer);
                                
                                const noteDoc = await PDFDocument.load(notePdfBuffer);
                                const notePages = await mergedPdf.copyPages(noteDoc, noteDoc.getPageIndices());
                                notePages.forEach(page => mergedPdf.addPage(page));
                            } else {
                                console.error(`Failed to fetch IntakeQ PDF for note ${noteId}: ${response.status}`);
                            }
                        }
                    }
                }
            } catch (err) {
                console.error("Error processing IntakeQ notes attachment:", err);
            }
        }

        // 3c. Merge IntakeQ Client Files if requested
        if (req.body.intakeqFiles) {
            try {
                const fileIds = JSON.parse(req.body.intakeqFiles);
                if (Array.isArray(fileIds) && fileIds.length > 0) {
                    
                    const settings = await new Promise((resolve, reject) => {
                        db.get("SELECT intakeq_api_key FROM settings WHERE id = 1", (err, row) => {
                            if (err) reject(err); else resolve(row || {});
                        });
                    });

                    if (settings.intakeq_api_key) {
                        const fetch = (await import('node-fetch')).default;
                        
                        for (const fileId of fileIds) {
                            const response = await fetch(`https://intakeq.com/api/v1/files/${fileId}`, {
                                method: 'GET',
                                headers: { 'X-Auth-Key': settings.intakeq_api_key }
                            });
                            
                            if (response.ok) {
                                const arrayBuffer = await response.arrayBuffer();
                                const filePdfBuffer = Buffer.from(arrayBuffer);
                                
                                const fileDoc = await PDFDocument.load(filePdfBuffer, { ignoreEncryption: true });
                                const filePages = await mergedPdf.copyPages(fileDoc, fileDoc.getPageIndices());
                                filePages.forEach(page => mergedPdf.addPage(page));
                            } else {
                                console.error(`Failed to fetch IntakeQ File ${fileId}: ${response.status}`);
                            }
                        }
                    }
                }
            } catch (err) {
                console.error("Error processing IntakeQ client files attachment:", err);
            }
        }

        // 3b. Merge Local File Attachments
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const attachmentBuffer = fs.readFileSync(file.path);
                const attachDoc = await PDFDocument.load(attachmentBuffer);
                const attachPages = await mergedPdf.copyPages(attachDoc, attachDoc.getPageIndices());
                attachPages.forEach(page => mergedPdf.addPage(page));
                // Clean up uploaded file
                fs.unlinkSync(file.path);
            }
        }

        const finalPdfBytes = await mergedPdf.save();
        const filename = `auth_request_client_${clientId}_${Date.now()}.pdf`;
        const filepath = path.join(__dirname, 'output', filename);
        fs.writeFileSync(filepath, finalPdfBytes);

        // 4. Save record to DB
        let savedAuthId = authId || '';
        if (authId) {
            const row = await getDb("SELECT pdf_path FROM auth_requests WHERE id = ?", [authId]);
            if (row && row.pdf_path && fs.existsSync(row.pdf_path)) {
                try { fs.unlinkSync(row.pdf_path); } catch (e) { }
            }
            await runDb("UPDATE auth_requests SET form_data = ?, pdf_path = ?, is_draft = 0, clinical_status = 'In Review', last_updated = datetime('now'), date_created = CURRENT_TIMESTAMP WHERE id = ?",
                [formDataStr, filepath, authId]
            );
        } else {
            const num = await getNextRecordNumber();
            const result = await runDb("INSERT INTO auth_requests (client_id, form_data, pdf_path, is_draft, last_updated, record_number, clinical_status) VALUES (?, ?, ?, 0, datetime('now'), ?, 'In Review')",
                [clientId, formDataStr, filepath, num]
            );
            savedAuthId = String(result.lastID);
        }

        // 5. Send file to client
        res.setHeader('X-Auth-Request-Id', savedAuthId);
        res.download(filepath);

    } catch (err) {
        cleanupUploadedFiles(req.files);
        console.error("PDF Generation Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- SRFax Integration ---
app.post('/api/send-fax/:authId', async (req, res) => {
    try {
        const authId = req.params.authId;
        const { toFaxNumber } = req.body;

        if (!toFaxNumber) return res.status(400).json({ error: "Recipient fax number is required" });
        const toFaxValidationError = phoneFaxError(toFaxNumber, 'Recipient fax number');
        if (toFaxValidationError) return res.status(400).json({ error: toFaxValidationError });
        const normalizedToFaxNumber = normalizePhoneFax(toFaxNumber);

        // Get SRFax credentials from settings
        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT srfax_access_id, srfax_access_pwd, srfax_caller_id, srfax_sender_email FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        if (!settings.srfax_access_id || !settings.srfax_access_pwd) {
            return res.status(400).json({ error: "SRFax credentials not configured. Go to Settings to set them up." });
        }
        if (!settings.srfax_caller_id) {
            return res.status(400).json({ error: "SRFax Caller ID (sender fax number) not configured in Settings." });
        }

        // Get auth request PDF path
        const auth = await new Promise((resolve, reject) => {
            db.get("SELECT pdf_path FROM auth_requests WHERE id = ?", [authId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!auth || !auth.pdf_path || !fs.existsSync(auth.pdf_path)) {
            return res.status(404).json({ error: "PDF not found for this auth request. Regenerate it first." });
        }

        // Read PDF and send fax
        const pdfBuffer = fs.readFileSync(auth.pdf_path);
        const fileName = path.basename(auth.pdf_path);

        const creds = {
            access_id: settings.srfax_access_id,
            access_pwd: settings.srfax_access_pwd,
            caller_id: settings.srfax_caller_id,
            sender_email: settings.srfax_sender_email || 'noreply@authforms.local'
        };

        const normalizedBuffer = await normalizePdfForFax(pdfBuffer);
        const result = await sendFax(creds, normalizedToFaxNumber, fileName, normalizedBuffer);

        if (result.Status === 'Success') {
            // Store fax details in DB
            db.run(
                "UPDATE auth_requests SET fax_details_id = ?, fax_status = 'In Progress', fax_sent_date = datetime('now'), fax_to_number = ?, clinical_status = 'Pending' WHERE id = ?",
                [result.Result, normalizedToFaxNumber, authId]
            );
            res.json({ success: true, faxDetailsId: result.Result, message: "Fax queued successfully" });
        } else {
            // Log failure in DB
            db.run(
                "UPDATE auth_requests SET fax_status = 'Failed', fax_sent_date = datetime('now'), fax_to_number = ? WHERE id = ?",
                [normalizedToFaxNumber, authId]
            );
            res.status(400).json({ error: `SRFax error: ${result.Result}` });
        }

    } catch (err) {
        console.error("Send Fax Error:", err);
        // Also log unexpected errors to database
        db.run(
            "UPDATE auth_requests SET fax_status = 'Error', fax_sent_date = datetime('now') WHERE id = ?",
            [req.params.authId]
        );
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/check-fax-status/:authId', async (req, res) => {
    try {
        const authId = req.params.authId;
        console.log(`[FAX STATUS] Checking for Auth ID: ${authId}`);

        // Get fax_details_id from auth
        const auth = await new Promise((resolve, reject) => {
            db.get("SELECT fax_details_id, fax_status FROM auth_requests WHERE id = ?", [authId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!auth) {
            console.warn(`[FAX STATUS] Auth request ${authId} not found.`);
            return res.status(404).json({ error: "Authorization request not found." });
        }

        if (!auth.fax_details_id) {
            console.warn(`[FAX STATUS] No fax_details_id for Auth request ${authId}.`);
            return res.status(400).json({ error: "No fax has been sent for this auth request." });
        }

        if (isTerminalFaxStatus(auth.fax_status)) {
            return res.json({
                success: true,
                faxStatus: auth.fax_status,
                skipped: true,
                message: "Fax already has a terminal local status."
            });
        }

        // Get SRFax credentials
        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT srfax_access_id, srfax_access_pwd FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        if (!settings.srfax_access_id || !settings.srfax_access_pwd) {
            console.error(`[FAX STATUS] SRFax credentials missing in settings.`);
            return res.status(400).json({ error: "SRFax credentials not configured." });
        }

        const creds = {
            access_id: settings.srfax_access_id,
            access_pwd: settings.srfax_access_pwd
        };

        console.log(`[FAX STATUS] Querying SRFax for DetailsID: ${auth.fax_details_id}`);
        const result = await checkFaxStatus(creds, auth.fax_details_id);
        console.log(`[FAX STATUS] SRFax Response: ${JSON.stringify(result)}`);

        if (result.Status === 'Success') {
            const sentStatus = result.Result.SentStatus || 'Unknown';
            db.run("UPDATE auth_requests SET fax_status = ? WHERE id = ?", [sentStatus, authId]);
            res.json({ success: true, faxStatus: sentStatus, details: result.Result });
        } else {
            console.error(`[FAX STATUS] SRFax API Error: ${result.Result}`);
            res.status(400).json({ error: `SRFax error: ${result.Result}` });
        }

    } catch (err) {
        console.error("Check Fax Status Error:", err);
        res.status(500).json({ error: err.message || "Internal server error" });
    }
});

// --- MCO Fax Directory ---
app.get('/api/mco-fax-directory', (req, res) => {
    db.all("SELECT * FROM mco_fax_directory ORDER BY mco_name", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/mco-fax-directory', (req, res) => {
    const { mco_name, fax_number } = req.body;
    if (!mco_name || !fax_number) return res.status(400).json({ error: "MCO name and fax number required" });
    const validationError = phoneFaxError(fax_number, 'MCO fax number');
    if (validationError) return res.status(400).json({ error: validationError });
    const normalizedFax = normalizePhoneFax(fax_number);

    db.run("INSERT INTO mco_fax_directory (mco_name, fax_number) VALUES (?, ?)", [mco_name, normalizedFax], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID });
    });
});

app.put('/api/mco-fax-directory/:id', (req, res) => {
    const { mco_name, fax_number } = req.body;
    if (!mco_name || !fax_number) return res.status(400).json({ error: "MCO name and fax number required" });
    const validationError = phoneFaxError(fax_number, 'MCO fax number');
    if (validationError) return res.status(400).json({ error: validationError });
    db.run("UPDATE mco_fax_directory SET mco_name = ?, fax_number = ? WHERE id = ?", [mco_name, normalizePhoneFax(fax_number), req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ changes: this.changes });
    });
});

app.delete('/api/mco-fax-directory/:id', (req, res) => {
    db.run("DELETE FROM mco_fax_directory WHERE id = ?", [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ changes: this.changes });
    });
});
app.post('/api/send-test-fax', async (req, res) => {
    try {
        // 1. Get Settings
        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT srfax_access_id, srfax_access_pwd, srfax_caller_id, srfax_sender_email FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        if (!settings.srfax_access_id || !settings.srfax_access_pwd || !settings.srfax_caller_id) {
            return res.status(400).json({ error: "SRFax credentials or Caller ID not configured." });
        }

        // 2. Generate small Test PDF
        const browser = await puppeteer.launch({ headless: 'new' });
        const page = await browser.newPage();
        await page.setContent("<h1>SRFax Test Page</h1><p>This is a test fax sent from the Auth Flow application.</p><p>Sent back to the configured Caller ID.</p>", { waitUntil: 'networkidle0' });
        const testPdfBuffer = await page.pdf({ format: 'A4' });
        await browser.close();

        // 3. Determine destination — explicit override or loopback to caller ID
        const callerId = toSrfaxCallerId(settings.srfax_caller_id);
        const overrideRaw = toDialableFaxNumber(req.body && req.body.toFax ? req.body.toFax : '');
        let toFax;
        if (overrideRaw) {
            toFax = overrideRaw;
            if (toFax.length !== 11) {
                return res.status(400).json({ error: `Invalid test destination: ${req.body.toFax}. Must be 10 or 11 digits.` });
            }
        } else {
            toFax = callerId.length === 10 ? '1' + callerId : callerId;
        }

        console.log(`[TEST FAX] Sending to: ${toFax} | Caller ID: ${callerId} | AccessID: ${settings.srfax_access_id} | Override: ${overrideRaw || 'none'}`);

        const creds = {
            access_id: settings.srfax_access_id,
            access_pwd: settings.srfax_access_pwd,
            caller_id: callerId,
            sender_email: settings.srfax_sender_email || 'test@authforms.local'
        };

        const normalizedTestBuffer = await normalizePdfForFax(testPdfBuffer);
        const result = await sendFax(creds, toFax, 'test_fax.pdf', normalizedTestBuffer);
        console.log(`[TEST FAX] SRFax raw response:`, JSON.stringify(result));

        if (result.Status === 'Success') {
            res.json({ success: true, faxDetailsId: result.Result, toFax, callerId, message: `Test fax queued successfully to ${toFax}. FaxID: ${result.Result}` });
        } else {
            res.status(400).json({ error: `SRFax error: ${result.Result}`, raw: result, toFax, callerId });
        }
    } catch (err) {
        console.error("Test Fax Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- Standalone fax status check (no auth record linkage, for test faxes and diagnostics) ---
app.post('/api/fax-status', async (req, res) => {
    try {
        const { faxDetailsId } = req.body || {};
        if (!faxDetailsId) return res.status(400).json({ error: 'faxDetailsId is required' });

        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT srfax_access_id, srfax_access_pwd FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        if (!settings.srfax_access_id || !settings.srfax_access_pwd) {
            return res.status(400).json({ error: 'SRFax credentials not configured.' });
        }

        const result = await checkFaxStatus(
            { access_id: settings.srfax_access_id, access_pwd: settings.srfax_access_pwd },
            faxDetailsId
        );

        if (result.Status === 'Success') {
            res.json({ success: true, faxStatus: (result.Result && result.Result.SentStatus) || 'Unknown', details: result.Result });
        } else {
            res.status(400).json({ error: `SRFax error: ${result.Result}`, raw: result });
        }
    } catch (err) {
        console.error('Fax Status Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Fax Diagnostic ---
app.post('/api/diag-fax', async (req, res) => {
    try {
        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT srfax_access_id, srfax_access_pwd, srfax_caller_id, srfax_sender_email FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        const callerId = toSrfaxCallerId(settings.srfax_caller_id);
        const toFax = callerId.length === 10 ? '1' + callerId : callerId;

        res.json({
            access_id: settings.srfax_access_id ? settings.srfax_access_id.substring(0,4) + '****' : 'NOT SET',
            access_pwd: settings.srfax_access_pwd ? '****' : 'NOT SET',
            caller_id_raw: settings.srfax_caller_id,
            caller_id_cleaned: callerId,
            caller_id_length: callerId.length,
            to_fax_would_be: toFax,
            to_fax_length: toFax.length,
            sender_email: settings.srfax_sender_email || 'NOT SET',
            all_valid: !!(settings.srfax_access_id && settings.srfax_access_pwd && callerId.length === 10 && toFax.length === 11)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- IntakeQ Integration ---
app.get('/api/intakeq/notes', async (req, res) => {
    try {
        const clientName = req.query.clientName;
        const intakeqClientId = req.query.intakeqClientId;

        if (!clientName && !intakeqClientId) {
            return res.status(400).json({ error: "Either clientName or intakeqClientId query parameter is required" });
        }

        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT intakeq_api_key FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        if (!settings.intakeq_api_key) {
            return res.status(400).json({ error: "IntakeQ API Key not configured in Settings." });
        }

        const notes = await intakeq.getNotesSummary(
            settings.intakeq_api_key,
            { clientId: intakeqClientId, clientName }
        );
        res.json(notes);
    } catch (err) {
        console.error("IntakeQ Notes Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- IntakeQ: Client Search (for Auto-Sync) ---
app.get('/api/intakeq/client-search', async (req, res) => {
    try {
        const name = req.query.name;
        if (!name) return res.status(400).json({ error: "name query parameter is required" });

        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT intakeq_api_key FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        if (!settings.intakeq_api_key) {
            return res.status(400).json({ error: "IntakeQ API Key not configured in Settings." });
        }

        const clients = await intakeq.searchClients(settings.intakeq_api_key, name);
        logIntakeqCustomFieldLabels(clients);
        res.json(clients);
    } catch (err) {
        console.error("IntakeQ Client Search Error:", err);
        if (err.upstream === 'IntakeQ') {
            return res.status(502).json({
                error: "IntakeQ client search failed",
                detail: err.body || err.message,
                upstreamStatus: err.status || null,
                traceId: req.traceId || null
            });
        }
        res.status(500).json({ error: err.message, traceId: req.traceId || null });
    }
});

// --- IntakeQ: Upload Auth PDF to EMR (Feature #6) ---
app.post('/api/intakeq/upload-auth/:authId', async (req, res) => {
    try {
        const authId = req.params.authId;

        const auth = await new Promise((resolve, reject) => {
            db.get("SELECT a.pdf_path, a.client_id, c.name as client_name, c.intakeq_client_id FROM auth_requests a JOIN clients c ON a.client_id = c.id WHERE a.id = ?", [authId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!auth || !auth.pdf_path || !fs.existsSync(auth.pdf_path)) {
            return res.status(404).json({ error: "PDF not found for this auth request. Generate it first." });
        }

        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT intakeq_api_key FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        if (!settings.intakeq_api_key) {
            return res.status(400).json({ error: "IntakeQ API Key not configured in Settings." });
        }

        let intakeqClientId = auth.intakeq_client_id;

        if (!intakeqClientId) {
            const matchedClients = await intakeq.searchClients(settings.intakeq_api_key, auth.client_name);

            if (!Array.isArray(matchedClients) || matchedClients.length === 0) {
                return res.status(404).json({ error: `No client named "${auth.client_name}" found in IntakeQ. Use Sync from IntakeQ first to link this client.` });
            }

            const intakeqClient = matchedClients[0];
            intakeqClientId = intakeqClient.ClientId || intakeqClient.ClientNumber;

            if (!intakeqClientId) {
                return res.status(404).json({ error: "Could not determine IntakeQ Client ID from search results." });
            }

            db.run("UPDATE clients SET intakeq_client_id = ? WHERE id = ?", [String(intakeqClientId), auth.client_id]);
        }

        const pdfBuffer = fs.readFileSync(auth.pdf_path);
        const filename = `AuthRequest_${auth.client_name.replace(/ /g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;

        const uploadResult = await intakeq.uploadFile(
            settings.intakeq_api_key,
            intakeqClientId,
            pdfBuffer,
            filename
        );

        if (uploadResult && uploadResult.raw !== undefined) {
            console.warn("[IntakeQ Upload] Non-JSON success body:", uploadResult.raw);
        }

        await runDb("UPDATE auth_requests SET intakeq_uploaded_at = datetime('now') WHERE id = ?", [authId]);

        res.json({
            success: true,
            message: `Auth PDF uploaded to IntakeQ for "${auth.client_name}" (IntakeQ Client #${intakeqClientId})`,
            file: uploadResult
        });
    } catch (err) {
        console.error("IntakeQ Upload Auth Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- IntakeQ: Get Client Files ---
app.get('/api/intakeq/files', async (req, res) => {
    try {
        const intakeqClientId = req.query.intakeqClientId;
        if (!intakeqClientId) {
            return res.status(400).json({ error: "intakeqClientId query parameter is required" });
        }

        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT intakeq_api_key FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        if (!settings.intakeq_api_key) {
            return res.status(400).json({ error: "IntakeQ API Key not configured in Settings." });
        }

        const files = await intakeq.listFiles(settings.intakeq_api_key, intakeqClientId);
        res.json(files);
    } catch (err) {
        console.error("IntakeQ Get Files Error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.use(createErrorLogger());

// --- Server Start ---
if (require.main === module) {
    installProcessErrorLogging();
    app.listen(port, () => {
        console.log(`Auth Forms app listening at http://localhost:${port}`);
        if (!process.env.AUTH_FORMS_API_TOKEN) {
            console.log(`API token for this session: ${apiToken}`);
            console.log('Set AUTH_FORMS_API_TOKEN to use a stable token.');
        }
        console.log(`Trace log: ${DEFAULT_LOG_FILE}`);
    });
}

module.exports = app;
