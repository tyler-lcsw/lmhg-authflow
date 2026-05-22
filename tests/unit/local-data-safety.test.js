const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');

function makeTempWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'auth-forms-safety-'));
}

test('generated cleanup preserves local SQLite and DB files', () => {
    const cwd = makeTempWorkspace();
    try {
        fs.mkdirSync(path.join(cwd, 'output'));
        fs.mkdirSync(path.join(cwd, 'uploads'));
        fs.mkdirSync(path.join(cwd, 'logs'));
        fs.writeFileSync(path.join(cwd, 'database.sqlite'), 'live data');
        fs.writeFileSync(path.join(cwd, 'runtime.db'), 'runtime data');
        fs.writeFileSync(path.join(cwd, 'output', 'auth.pdf'), 'generated pdf');
        fs.writeFileSync(path.join(cwd, 'logs', 'auth-forms-trace.log'), 'logs');

        const result = spawnSync(process.execPath, [
            path.join(repoRoot, 'scripts', 'clean-generated.js'),
            '--apply'
        ], {
            cwd,
            encoding: 'utf8'
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(fs.readFileSync(path.join(cwd, 'database.sqlite'), 'utf8'), 'live data');
        assert.equal(fs.readFileSync(path.join(cwd, 'runtime.db'), 'utf8'), 'runtime data');
        assert.equal(fs.existsSync(path.join(cwd, 'output', 'auth.pdf')), false);
        assert.match(result.stdout, /Protected local data/i);
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('database backup script creates a timestamped copy without printing contents', () => {
    const cwd = makeTempWorkspace();
    try {
        fs.writeFileSync(path.join(cwd, 'database.sqlite'), 'sensitive local database bytes');

        const result = spawnSync(process.execPath, [
            path.join(repoRoot, 'scripts', 'backup-local-db.js')
        ], {
            cwd,
            encoding: 'utf8',
            env: {
                ...process.env,
                AUTH_FORMS_BACKUP_TIMESTAMP: '2026-05-22T12-00-00-000Z'
            }
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /\.local-backups\/database-2026-05-22T12-00-00-000Z\.sqlite/);
        assert.doesNotMatch(result.stdout, /sensitive local database bytes/);

        const backupPath = path.join(cwd, '.local-backups', 'database-2026-05-22T12-00-00-000Z.sqlite');
        assert.equal(fs.readFileSync(backupPath, 'utf8'), 'sensitive local database bytes');
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
