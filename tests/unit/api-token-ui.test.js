const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('only the dashboard legacy path enables browser proxy authentication', () => {
    const configJs = fs.readFileSync(path.join(__dirname, '../../public/js/config.js'), 'utf8');

    assert.match(configJs, /window\.AUTH_FORMS_PROXY_AUTH = authFormsLegacyPath;/);
    assert.doesNotMatch(configJs, /authFormsLocalhost|location\.hostname/);
});

test('dashboard proxy auth is authoritative and never falls back to a browser token', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

    assert.match(appJs, /function usesDashboardProxyAuth\(\)/);
    assert.match(appJs, /return window\.AUTH_FORMS_PROXY_AUTH === true/);
    assert.doesNotMatch(appJs, /window\.AUTH_FORMS_PROXY_AUTH === true &&/);
    const proxyBranchStart = appJs.indexOf('if (usesDashboardProxyAuth()) {');
    const proxyBranchEnd = appJs.indexOf('} else {', proxyBranchStart);
    const proxyBranch = appJs.slice(proxyBranchStart, proxyBranchEnd);
    assert.match(proxyBranch, /headers\.delete\('x-auth-token'\)/);
    assert.match(proxyBranch, /sessionStorage\.removeItem\(API_TOKEN_STORAGE_KEY\)/);
});

test('API token capture does not rely on unsupported browser prompt dialogs', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

    assert.doesNotMatch(appJs, /window\.prompt\(/);
    assert.match(appJs, /function requestApiTokenViaDialog/);
    assert.match(appJs, /api-token-dialog/);
});

test('frontend does not ask for a token before the server requires one', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

    assert.match(appJs, /const storedToken = sessionStorage\.getItem\(API_TOKEN_STORAGE_KEY\) \|\| ''/);
    assert.match(appJs, /if \(storedToken\) \{[\s\S]*headers\.set\('x-auth-token', storedToken\)/);
    assert.doesNotMatch(appJs, /headers\.set\('x-auth-token', await getApiToken\(\)\)/);
    assert.match(appJs, /response\.status === 401[\s\S]*requestApiTokenViaDialog/);
});

test('local token dialog exposes modal labels, keyboard cancellation, and focus management', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

    assert.match(appJs, /setAttribute\('role', 'dialog'\)/);
    assert.match(appJs, /setAttribute\('aria-modal', 'true'\)/);
    assert.match(appJs, /setAttribute\('aria-labelledby', title\.id\)/);
    assert.match(appJs, /setAttribute\('aria-describedby', copy\.id\)/);
    assert.match(appJs, /label\.htmlFor = input\.id/);
    assert.match(appJs, /e\.key === 'Escape'/);
    assert.match(appJs, /e\.key !== 'Tab'/);
    assert.match(appJs, /previouslyFocusedElement[\s\S]*\.focus\(\)/);
});

test('automatic token retry is limited to replay-safe requests', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

    assert.match(appJs, /function isReplaySafeRequest/);
    assert.match(appJs, /\['GET', 'HEAD', 'OPTIONS'\]\.includes/);
    assert.match(appJs, /if \(!retryToken \|\| !isReplaySafeRequest\(input, requestInit\)\) return response/);
});

test('concurrent local authentication failures share one token dialog promise', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

    assert.match(appJs, /if \(apiTokenDialogPromise\) return apiTokenDialogPromise/);
    assert.match(appJs, /apiTokenDialogPromise = null/);
});

test('standalone diagnostics honors proxy mode and uses the accessible local fallback', () => {
    const diagnosticsHtml = fs.readFileSync(path.join(__dirname, '../../public/test-apis.html'), 'utf8');

    assert.match(diagnosticsHtml, /function usesDashboardProxyAuth\(\)/);
    const proxyBranchStart = diagnosticsHtml.indexOf('if (usesDashboardProxyAuth()) {');
    const proxyBranchEnd = diagnosticsHtml.indexOf('} else {', proxyBranchStart);
    const proxyBranch = diagnosticsHtml.slice(proxyBranchStart, proxyBranchEnd);
    assert.match(proxyBranch, /headers\.delete\('x-auth-token'\)/);
    assert.match(proxyBranch, /sessionStorage\.removeItem\(API_TOKEN_STORAGE_KEY\)/);
    assert.match(diagnosticsHtml, /function requestApiTokenViaDialog/);
    assert.doesNotMatch(diagnosticsHtml, /window\.prompt\(/);
    assert.match(diagnosticsHtml, /setAttribute\('role', 'dialog'\)/);
    assert.match(diagnosticsHtml, /setAttribute\('aria-modal', 'true'\)/);
    assert.match(diagnosticsHtml, /e\.key === 'Escape'/);
    assert.match(diagnosticsHtml, /e\.key !== 'Tab'/);
    assert.match(diagnosticsHtml, /if \(!retryToken \|\| !isReplaySafeMethod\(requestInit\.method\)\) return result/);
});
