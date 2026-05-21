const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
    startTestServer,
    selectOne,
    callJson
} = require('../helpers/testServer');

function clientPayload(overrides = {}) {
    return {
        name: 'Jane Doe',
        dob: '1990-01-01',
        medicaid_id: '',
        mco_id: 'MCO-12345',
        pcp: 'Eric Hospital Primary Care',
        pcp_phone: '5025550101',
        pcp_npi: '1234567890',
        pregnant: '',
        work_injury: '',
        mva: '',
        other_insurance: '',
        insurer: '',
        medicare_a: false,
        medicare_b: false,
        ...overrides
    };
}

function createOldDb(dbPath) {
    const db = new sqlite3.Database(dbPath);
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run(`
                CREATE TABLE clients (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    medicaid_id TEXT,
                    mco_id TEXT,
                    dob TEXT,
                    pregnant TEXT,
                    pcp TEXT,
                    pcp_phone TEXT,
                    pcp_npi TEXT,
                    work_injury TEXT,
                    mva TEXT,
                    other_insurance TEXT,
                    insurer TEXT,
                    medicare_a BOOLEAN,
                    medicare_b BOOLEAN
                )
            `);
            db.run(`
                INSERT INTO clients (name, medicaid_id, mco_id, pcp, pcp_phone, pcp_npi)
                VALUES
                    ('Needs Medicaid Migration', '', '0008841791', 'Clinic', '5025550101', '1234567890'),
                    ('Needs MCO Migration', 'MCO-98765', '', 'Clinic', '5025550101', '1234567890'),
                    ('Duplicate Medicaid', '0008841791', '0008841791', 'Clinic', '5025550101', '1234567890'),
                    ('Already Correct', '00011111', 'MCO-22222', 'Clinic', '5025550101', '1234567890')
            `);
            db.close(err => err ? reject(err) : resolve());
        });
    });
}

test('database startup classifies imported IDs by the leading-zero Medicaid convention', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-forms-migration-'));
    const dbPath = path.join(tmpDir, 'test.sqlite');
    await createOldDb(dbPath);

    process.env.DB_PATH = dbPath;
    delete require.cache[require.resolve('../../db')];
    const db = require('../../db');
    try {
        await new Promise(resolve => db.run('SELECT 1', resolve));
        const medicaidMigrated = await selectOne(db, 'SELECT medicaid_id, mco_id FROM clients WHERE name = ?', ['Needs Medicaid Migration']);
        const mcoMigrated = await selectOne(db, 'SELECT medicaid_id, mco_id FROM clients WHERE name = ?', ['Needs MCO Migration']);
        const duplicate = await selectOne(db, 'SELECT medicaid_id, mco_id FROM clients WHERE name = ?', ['Duplicate Medicaid']);
        const unchanged = await selectOne(db, 'SELECT medicaid_id, mco_id FROM clients WHERE name = ?', ['Already Correct']);

        assert.equal(medicaidMigrated.medicaid_id, '0008841791');
        assert.equal(medicaidMigrated.mco_id, '');
        assert.equal(mcoMigrated.medicaid_id, '');
        assert.equal(mcoMigrated.mco_id, 'MCO-98765');
        assert.equal(duplicate.medicaid_id, '0008841791');
        assert.equal(duplicate.mco_id, '');
        assert.equal(unchanged.medicaid_id, '00011111');
        assert.equal(unchanged.mco_id, 'MCO-22222');
    } finally {
        await new Promise(resolve => db.close(resolve));
        delete process.env.DB_PATH;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('client create stores PCP phone in canonical 1 (###) ###-#### format and preserves PCP string fields', async () => {
    const srv = await startTestServer();
    try {
        const created = await callJson(srv.baseUrl, '/api/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload())
        });

        assert.equal(created.status, 200);
        const row = await selectOne(
            srv.db,
            'SELECT medicaid_id, mco_id, pcp, pcp_phone, pcp_npi, primary_care_provider_id FROM clients WHERE id = ?',
            [created.body.id]
        );

        assert.equal(row.medicaid_id, '');
        assert.equal(row.mco_id, 'MCO-12345');
        assert.equal(row.pcp, 'Eric Hospital Primary Care');
        assert.equal(row.pcp_phone, '1 (502) 555-0101');
        assert.equal(row.pcp_npi, '1234567890');
        assert.ok(row.primary_care_provider_id);
    } finally {
        await srv.close();
    }
});

test('client saves classify imported IDs by the leading-zero Medicaid convention and remove same-value duplicates', async () => {
    const srv = await startTestServer();
    try {
        const medicaidOnly = await callJson(srv.baseUrl, '/api/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload({ medicaid_id: '', mco_id: '0008841791' }))
        });
        const mcoOnly = await callJson(srv.baseUrl, '/api/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload({ name: 'MCO Patient', medicaid_id: 'ABC123', mco_id: '' }))
        });
        const duplicate = await callJson(srv.baseUrl, '/api/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload({ name: 'Duplicate Patient', medicaid_id: '0008841791', mco_id: '0008841791' }))
        });

        assert.equal(medicaidOnly.status, 200);
        assert.equal(mcoOnly.status, 200);
        assert.equal(duplicate.status, 200);

        const medicaidRow = await selectOne(srv.db, 'SELECT medicaid_id, mco_id FROM clients WHERE id = ?', [medicaidOnly.body.id]);
        const mcoRow = await selectOne(srv.db, 'SELECT medicaid_id, mco_id FROM clients WHERE id = ?', [mcoOnly.body.id]);
        const duplicateRow = await selectOne(srv.db, 'SELECT medicaid_id, mco_id FROM clients WHERE id = ?', [duplicate.body.id]);

        assert.equal(medicaidRow.medicaid_id, '0008841791');
        assert.equal(medicaidRow.mco_id, '');
        assert.equal(mcoRow.medicaid_id, '');
        assert.equal(mcoRow.mco_id, 'ABC123');
        assert.equal(duplicateRow.medicaid_id, '0008841791');
        assert.equal(duplicateRow.mco_id, '');
    } finally {
        await srv.close();
    }
});

test('phone and fax endpoints normalize accepted numbers and reject invalid numbers', async () => {
    const srv = await startTestServer();
    try {
        const provider = await callJson(srv.baseUrl, '/api/pcp-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Family Clinic', phone: '(502) 555-0101', npi: '1234567890' })
        });
        assert.equal(provider.status, 200);

        const listedProviders = await callJson(srv.baseUrl, '/api/pcp-directory');
        assert.equal(listedProviders.body[0].phone, '1 (502) 555-0101');

        const settings = await callJson(srv.baseUrl, '/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                requesting_provider: 'Provider',
                req_provider_phone: '5025550102',
                req_provider_fax: '15025550103',
                completed_by: 'Staff',
                completed_by_phone: '(502) 555-0104',
                srfax_access_id: 'AID',
                srfax_access_pwd: 'PWD',
                srfax_caller_id: '5025550105',
                srfax_sender_email: 'test@example.com',
                intakeq_api_key: ''
            })
        });
        assert.equal(settings.status, 200);

        const storedSettings = await callJson(srv.baseUrl, '/api/settings');
        assert.equal(storedSettings.body.req_provider_phone, '1 (502) 555-0102');
        assert.equal(storedSettings.body.req_provider_fax, '1 (502) 555-0103');
        assert.equal(storedSettings.body.completed_by_phone, '1 (502) 555-0104');
        assert.equal(storedSettings.body.srfax_caller_id, '1 (502) 555-0105');

        const directory = await callJson(srv.baseUrl, '/api/mco-fax-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mco_name: 'Test MCO', fax_number: '5025550101' })
        });
        assert.equal(directory.status, 200);

        const listedDirectory = await callJson(srv.baseUrl, '/api/mco-fax-directory');
        assert.equal(listedDirectory.body[0].fax_number, '1 (502) 555-0101');

        const invalid = await callJson(srv.baseUrl, '/api/pcp-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Bad Phone', phone: '555', npi: '1234567890' })
        });
        assert.equal(invalid.status, 400);
        assert.match(invalid.body.error, /phone/i);
    } finally {
        await srv.close();
    }
});
