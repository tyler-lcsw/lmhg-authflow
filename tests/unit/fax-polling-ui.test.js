const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const appJs = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

test('global fax log removes sent rows from the background polling set', () => {
    assert.match(
        appJs,
        /item\.fax_status === 'Sent' \|\| item\.fax_status === 'Success'[\s\S]*?pendingFaxesToPoll\.delete\(item\.id\)/,
        'renderFaxLogTable must delete terminal sent faxes from pendingFaxesToPoll'
    );
});

test('background fax polling removes terminal statuses without waiting for a render', () => {
    assert.match(
        appJs,
        /pendingFaxesToPoll\.delete\(authId\)/,
        'polling loop must remove auth ids after terminal fax statuses'
    );
});

test('background fax polling replaces checking indicator with fax sent pill on confirmed delivery', () => {
    assert.match(
        appJs,
        /function setFaxPollingIndicator\(state\)/,
        'polling UI should centralize the global indicator state'
    );
    assert.match(
        appJs,
        /setFaxPollingIndicator\('checking'\)/,
        'polling should show checking state only while status requests are active'
    );
    assert.match(
        appJs,
        /setFaxPollingIndicator\('sent'\)/,
        'polling should show a sent confirmation pill when delivery is confirmed'
    );
    assert.doesNotMatch(
        appJs,
        /setTimeout\(\(\) => \{ if \(syncIndicator\) syncIndicator\.style\.display = 'none'; \}, 5000\)/,
        'polling indicator should not linger for a fixed timeout after terminal responses'
    );
});

test('authorization history uses the shared pollable fax status predicate', () => {
    assert.match(
        appJs,
        /else if \(isPollableFaxStatus\(item\.fax_status\)\)[\s\S]*?pendingFaxesToPoll\.add\(item\.id\)/,
        'auth history should poll every status recognized by isPollableFaxStatus'
    );
});

test('background fax polling runs every two minutes', () => {
    assert.match(
        appJs,
        /faxPollInterval = setInterval\([\s\S]*?, 120000\);/,
        'background fax polling should use a two minute interval'
    );
    assert.doesNotMatch(
        appJs,
        /}, 60000\);/,
        'background fax polling should not run every minute'
    );
});
