#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const apply = process.argv.includes('--apply');
const cwd = process.cwd();

const generatedDirs = ['output', 'uploads'];
const generatedFiles = [
    'test_render.png'
];
const generatedExtensions = new Set([
    '.log',
    '.pdf',
    '.png',
    '.jpg',
    '.jpeg'
]);
const protectedExtensions = new Set([
    '.sqlite',
    '.sqlite3',
    '.db'
]);

function listFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.flatMap(entry => {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return listFiles(entryPath);
        if (entry.isFile()) return [entryPath];
        return [];
    });
}

function relative(filePath) {
    return path.relative(cwd, filePath);
}

function shouldDelete(filePath) {
    const rel = relative(filePath);
    if (rel.startsWith(`.local-backups${path.sep}`)) return false;
    if (protectedExtensions.has(path.extname(filePath).toLowerCase())) return false;
    if (generatedFiles.includes(rel)) return true;
    if (rel.startsWith(`logs${path.sep}`) && path.extname(filePath).toLowerCase() === '.log') return true;
    return generatedExtensions.has(path.extname(filePath).toLowerCase())
        && generatedDirs.some(dir => rel.startsWith(`${dir}${path.sep}`));
}

const allFiles = listFiles(cwd);
const protectedData = allFiles
    .filter(filePath => protectedExtensions.has(path.extname(filePath).toLowerCase()))
    .filter(filePath => !relative(filePath).startsWith(`node_modules${path.sep}`));
const deleteTargets = allFiles.filter(shouldDelete);

console.log(`Protected local data: ${protectedData.length} database file(s) preserved.`);
for (const filePath of protectedData) {
    console.log(`  keep ${relative(filePath)}`);
}

if (!apply) {
    console.log('Dry run only. Re-run with --apply to delete generated artifacts.');
}

for (const filePath of deleteTargets) {
    console.log(`${apply ? 'delete' : 'would delete'} ${relative(filePath)}`);
    if (apply) fs.rmSync(filePath, { force: true });
}

console.log(`${apply ? 'Deleted' : 'Would delete'} ${deleteTargets.length} generated artifact(s).`);
