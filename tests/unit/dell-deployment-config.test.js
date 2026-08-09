const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const composePath = path.resolve(__dirname, '../../deploy/dell/compose.yaml');
const dockerfilePath = path.resolve(__dirname, '../../Dockerfile');

test('Dell publishes Authorization Manager on host loopback with an internal token-protected listener', () => {
    const compose = fs.readFileSync(composePath, 'utf8');

    assert.match(compose, /^\s+HOST:\s*["']?0\.0\.0\.0["']?\s*$/m);
    assert.match(compose, /^\s+-\s*["']127\.0\.0\.1:3100:3000["']\s*$/m);
    assert.doesNotMatch(compose, /100\.70\.222\.25:3100:3000/);
    assert.match(compose, /AUTH_FORMS_API_TOKEN_FILE:\s*\/run\/secrets\/auth_manager_api_token/);
    assert.match(compose, /VCS_REF:\s*\$\{AUTH_FORMS_VCS_REF:-unknown\}/);
});

test('Dell image embeds the exact source revision as OCI metadata', () => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');

    assert.match(dockerfile, /ARG VCS_REF=unknown/);
    assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$VCS_REF"/);
});
