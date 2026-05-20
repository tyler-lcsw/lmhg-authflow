const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Boots the express app on an ephemeral port, backed by an isolated
 * test sqlite file. Returns { baseUrl, close(), db }.
 *
 * Sets DB_PATH before requiring server/db so migrations run fresh on
 * an empty test database. Callers are responsible for seeding whatever
 * rows their tests need (settings, clients, auth_requests, etc).
 */
async function startTestServer() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-forms-test-'));
    process.env.DB_PATH = path.join(tmpDir, 'test.sqlite');

    // Invalidate module cache so a fresh server+db is created per test server
    delete require.cache[require.resolve('../../db')];
    delete require.cache[require.resolve('../../server')];

    const db = require('../../db');
    const app = require('../../server');

    // Wait for migrations to settle (db.js uses serialize())
    await new Promise(resolve => db.run('SELECT 1', resolve));

    const server = await new Promise(resolve => {
        const s = app.listen(0, () => resolve(s));
    });
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    return {
        baseUrl,
        db,
        tmpDir,
        async close() {
            await new Promise(r => server.close(r));
            await new Promise(r => db.close(r));
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
            delete process.env.DB_PATH;
        }
    };
}

function seedSettings(db, values = {}) {
    const cols = Object.keys(values);
    if (cols.length === 0) return Promise.resolve();
    const setClause = cols.map(c => `${c} = ?`).join(', ');
    const args = cols.map(c => values[c]);
    return new Promise((resolve, reject) => {
        db.run(`UPDATE settings SET ${setClause} WHERE id = 1`, args, err => err ? reject(err) : resolve());
    });
}

function insertClient(db, values) {
    const cols = Object.keys(values);
    const placeholders = cols.map(() => '?').join(', ');
    const args = cols.map(c => values[c]);
    return new Promise((resolve, reject) => {
        db.run(`INSERT INTO clients (${cols.join(', ')}) VALUES (${placeholders})`, args, function (err) {
            err ? reject(err) : resolve(this.lastID);
        });
    });
}

function insertAuthRequest(db, values) {
    const cols = Object.keys(values);
    const placeholders = cols.map(() => '?').join(', ');
    const args = cols.map(c => values[c]);
    return new Promise((resolve, reject) => {
        db.run(`INSERT INTO auth_requests (${cols.join(', ')}) VALUES (${placeholders})`, args, function (err) {
            err ? reject(err) : resolve(this.lastID);
        });
    });
}

function selectOne(db, sql, args = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, args, (err, row) => err ? reject(err) : resolve(row));
    });
}

async function callJson(baseUrl, pathSuffix, init = {}) {
    const resp = await fetch(`${baseUrl}${pathSuffix}`, init);
    const raw = await resp.text();
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
    return { ok: resp.ok, status: resp.status, body };
}

module.exports = {
    startTestServer,
    seedSettings,
    insertClient,
    insertAuthRequest,
    selectOne,
    callJson
};
