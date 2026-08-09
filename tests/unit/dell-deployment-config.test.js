const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const composePath = path.resolve(__dirname, '../../deploy/dell/compose.yaml');

test('Dell publishes Authorization Manager on host loopback with an internal token-protected listener', () => {
    const compose = fs.readFileSync(composePath, 'utf8');

    assert.match(compose, /^\s+HOST:\s*["']?0\.0\.0\.0["']?\s*$/m);
    assert.match(compose, /^\s+-\s*["']127\.0\.0\.1:3100:3000["']\s*$/m);
    assert.doesNotMatch(compose, /100\.70\.222\.25:3100:3000/);
    assert.match(compose, /AUTH_FORMS_API_TOKEN_FILE:\s*\/run\/secrets\/auth_manager_api_token/);
});
