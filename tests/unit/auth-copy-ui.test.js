const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const appJs = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

function functionBody(name) {
    const start = appJs.indexOf(`window.${name} = async`);
    const next = appJs.indexOf('\nwindow.', start + 1);
    return appJs.slice(start, next === -1 ? undefined : next);
}

test('copyAuth does not block immutable authorizations', () => {
    const copyBody = functionBody('copyAuth');
    assert.doesNotMatch(copyBody, /This authorization is immutable/);
    assert.doesNotMatch(copyBody, /isImmutableAuth\(auth\)/);
});

test('copyAuth strips the source auth id after populating copied form data', () => {
    const copyBody = functionBody('copyAuth');
    assert.match(copyBody, /delete data\.auth_id/);
    assert.match(
        copyBody,
        /populateAuthForm\(data\)[\s\S]*?authIdInput[\s\S]*?authIdInput\.value = ''/,
        'copyAuth must clear hidden auth_id after populateAuthForm runs'
    );
});

test('editAuth blocks immutable authorizations', () => {
    const editBody = functionBody('editAuth');
    assert.match(editBody, /This authorization is immutable/);
    assert.match(editBody, /isImmutableAuth\(auth\)/);
});
