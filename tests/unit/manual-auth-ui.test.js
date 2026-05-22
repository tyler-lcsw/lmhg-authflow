const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('client details expose a manual authorization status entry action', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

    assert.match(html, /id="btn-manual-auth"/);
    assert.match(html, /id="manual-auth-modal"/);
    assert.match(html, /id="manual-auth-form"/);
    assert.match(html, /name="start_date"/);
    assert.match(html, /name="stop_date"/);
    assert.match(html, /name="status"[\s\S]*Granted[\s\S]*Denied[\s\S]*Pending[\s\S]*In Review/);
    assert.match(js, /btn-manual-auth/);
    assert.match(js, /\/auth-requests\/manual/);
});

test('manual authorization history rows are treated as monitoring records without PDF actions', () => {
    const js = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

    assert.match(js, /formData\.manual_entry/);
    assert.match(js, /Manual Entry/);
    assert.match(js, /editManualAuth\(\$\{item\.id\}\)/);
    assert.match(js, /const canPreview = !item\.is_draft && !formData\.manual_entry/);
});
