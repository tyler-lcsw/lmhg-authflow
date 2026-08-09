const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3').verbose();

function openDatabase(filePath) {
    return new sqlite3.Database(filePath);
}

function execSql(db, sql) {
    return new Promise((resolve, reject) => db.exec(sql, err => err ? reject(err) : resolve()));
}

function allRows(db, sql) {
    return new Promise((resolve, reject) => db.all(sql, [], (err, rows) => err ? reject(err) : resolve(rows)));
}

function closeDatabase(db) {
    return new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
}

test('startup migration removes legacy PHI-bearing deletion audit columns and storage', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-forms-deletion-migration-'));
    const dbPath = path.join(tmpDir, 'legacy.sqlite');
    const syntheticPhiMarker = 'SYNTHETIC-PHI-MARKER-DO-NOT-RETAIN-9f5e08a8';
    const previousDbPath = process.env.DB_PATH;
    let migratedDb;

    try {
        const legacyDb = openDatabase(dbPath);
        await execSql(legacyDb, `
            CREATE TABLE auth_request_deletions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                auth_request_id INTEGER NOT NULL,
                client_id INTEGER,
                deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                record_number INTEGER,
                clinical_status TEXT,
                fax_status TEXT,
                fax_details_id TEXT,
                fax_sent_date TEXT,
                fax_to_number TEXT,
                intakeq_uploaded_at TEXT,
                pdf_path TEXT,
                form_data TEXT,
                trace_id TEXT,
                request_ip TEXT,
                user_agent TEXT
            );
            INSERT INTO auth_request_deletions (
                auth_request_id, client_id, form_data, pdf_path, trace_id
            ) VALUES (
                41, 77, '${syntheticPhiMarker}', '/synthetic/${syntheticPhiMarker}.pdf', 'trace-41'
            );
        `);
        await closeDatabase(legacyDb);

        process.env.DB_PATH = dbPath;
        delete require.cache[require.resolve('../../db')];
        migratedDb = require('../../db');
        if (migratedDb.migrationReady) await migratedDb.migrationReady;
        else await allRows(migratedDb, 'SELECT 1');

        const columns = await allRows(migratedDb, 'PRAGMA table_info(auth_request_deletions)');
        assert.deepEqual(columns.map(column => column.name), ['id', 'auth_request_id', 'deleted_at', 'trace_id']);

        const auditRows = await allRows(migratedDb, 'SELECT * FROM auth_request_deletions');
        assert.deepEqual(auditRows.map(row => ({
            id: row.id,
            auth_request_id: row.auth_request_id,
            trace_id: row.trace_id
        })), [{ id: 1, auth_request_id: 41, trace_id: null }]);

        await closeDatabase(migratedDb);
        migratedDb = undefined;

        assert.equal(fs.readFileSync(dbPath).includes(Buffer.from(syntheticPhiMarker)), false);
        for (const suffix of ['-wal', '-journal']) {
            const residualPath = `${dbPath}${suffix}`;
            if (fs.existsSync(residualPath)) {
                assert.equal(fs.readFileSync(residualPath).includes(Buffer.from(syntheticPhiMarker)), false);
            }
        }
    } finally {
        if (migratedDb) await closeDatabase(migratedDb);
        if (previousDbPath === undefined) delete process.env.DB_PATH;
        else process.env.DB_PATH = previousDbPath;
        delete require.cache[require.resolve('../../db')];
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('production server does not listen when deletion-audit migration fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-forms-failed-migration-'));
    const dbPath = path.join(tmpDir, 'legacy.sqlite');
    try {
        const legacyDb = openDatabase(dbPath);
        await execSql(legacyDb, `
            CREATE TABLE auth_request_deletions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                form_data TEXT
            );
            INSERT INTO auth_request_deletions (form_data)
            VALUES ('SYNTHETIC-MIGRATION-FAILURE');
        `);
        await closeDatabase(legacyDb);

        const result = spawnSync(process.execPath, ['server.js'], {
            cwd: path.resolve(__dirname, '../..'),
            env: {
                ...process.env,
                NODE_ENV: 'production',
                HOST: '127.0.0.1',
                PORT: '0',
                DB_PATH: dbPath,
                AUTH_FORMS_API_TOKEN: 'synthetic-test-token',
                AUTH_FORMS_TRACE_LOG: path.join(tmpDir, 'trace.log')
            },
            encoding: 'utf8',
            timeout: 1500
        });

        assert.notEqual(result.status, 0);
        assert.match(`${result.stderr}\n${result.stdout}`, /database migration failed/i);
        assert.doesNotMatch(result.stdout, /listening/i);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
