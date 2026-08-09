const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const js = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

test('delete controls are rendered only when the static deletion capability is enabled', () => {
    assert.match(js, /let deletionsEnabled = false/);
    assert.match(js, /await loadCapabilities\(\)/);
    assert.match(js, /if \(deletionsEnabled\)[\s\S]*?deleteClient/);
    assert.match(js, /if \(deletionsEnabled\)[\s\S]*?deleteFacility/);
    assert.match(js, /if \(deletionsEnabled\)[\s\S]*?deletePcp/);
    assert.match(js, /if \(deletionsEnabled\)[\s\S]*?deleteMcoEntry/);
    assert.match(js, /deletionsEnabled && !successfullyFaxed/);
});

test('direct UI deletion functions stop before issuing a request while the hold is active', () => {
    for (const name of ['deleteClient', 'deleteFacility', 'deletePcp', 'deleteAuth', 'deleteMcoEntry']) {
        const start = js.indexOf(`window.${name} = async`);
        assert.notEqual(start, -1, `${name} must exist`);
        const body = js.slice(start, js.indexOf('\n};', start) + 3);
        assert.match(body, /if \(!requireDeletionCapability\(\)\) return/);
        assert.ok(body.indexOf('requireDeletionCapability') < body.indexOf("method: 'DELETE'"), `${name} must gate before DELETE fetch`);
    }
});
