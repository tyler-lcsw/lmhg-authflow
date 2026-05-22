#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const cwd = process.cwd();
const source = path.join(cwd, process.env.DB_PATH || 'database.sqlite');
const backupDir = path.join(cwd, '.local-backups');
const timestamp = process.env.AUTH_FORMS_BACKUP_TIMESTAMP || new Date().toISOString().replace(/[:]/g, '-');
const backupPath = path.join(backupDir, `database-${timestamp}.sqlite`);

if (!fs.existsSync(source)) {
    console.error(`No local database found at ${path.relative(cwd, source) || source}`);
    process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true });
fs.copyFileSync(source, backupPath, fs.constants.COPYFILE_EXCL);

console.log(`Local database backup created: ${path.relative(cwd, backupPath)}`);
