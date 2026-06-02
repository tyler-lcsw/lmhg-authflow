const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const diagnosticsHtml = fs.readFileSync(path.join(__dirname, '../../public/test-apis.html'), 'utf8');
const appHtml = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

test('diagnostics polling does not render API response data with innerHTML', () => {
    const pollStart = diagnosticsHtml.indexOf('async function pollStatus()');
    const nextFunction = diagnosticsHtml.indexOf('\nasync function searchClient()', pollStart);
    const pollBody = diagnosticsHtml.slice(pollStart, nextFunction);

    assert.doesNotMatch(pollBody, /innerHTML\s*=/);
    assert.match(pollBody, /textContent|replaceChildren|createElement/);
});

test('main app has separate Preferences and Diagnostics screens', () => {
    assert.match(appHtml, /data-view="preferences"/);
    assert.match(appHtml, /data-view="diagnostics"/);
    assert.match(appHtml, /id="view-preferences"/);
    assert.match(appHtml, /id="view-diagnostics"/);
    assert.doesNotMatch(appHtml, /data-view="settings"/);
});

test('Diagnostics screen exposes an API interface with safe response rendering', () => {
    assert.match(appHtml, /id="api-interface-form"/);
    assert.match(appHtml, /id="api-response-output"/);
    assert.match(appJs, /function renderApiResponse\(/);
    assert.match(appJs, /api-response-output/);
    assert.match(appJs, /replaceChildren\(\)/);
    assert.doesNotMatch(appJs, /apiResponseOutput\.innerHTML\s*=/);
});
