const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const appJs = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');

test('IntakeQ primary policy number maps by leading-zero Medicaid convention', () => {
    assert.match(appJs, /function mapImportedPolicyNumber\(/);
    assert.match(appJs, /\^\(00\|000\)/);
    assert.match(appJs, /c_medicaid_id'\)\.value = mappedPolicy\.medicaid_id/);
    assert.match(appJs, /c_mco_id'\)\.value = mappedPolicy\.mco_id/);
    assert.doesNotMatch(appJs, /c_medicaid_id'\)\.value = client\.PrimaryInsurancePolicyNumber/);
});

test('new client insurance and injury selects default to No', () => {
    for (const id of ['c_work_injury', 'c_mva', 'c_other_insurance']) {
        const selectMatch = indexHtml.match(new RegExp(`<select id="${id}"[\\s\\S]*?<\\/select>`));
        assert.ok(selectMatch, `${id} select should exist`);
        assert.match(selectMatch[0], /<option value="no" selected>No<\/option>/);
    }
    assert.match(appJs, /function setInsuranceInjuryDefaults\(\)/);
});

test('client PCP fields auto-select a matching PCP and show PCP found', () => {
    assert.match(appJs, /function findExistingPcpMatch\(\)/);
    assert.match(appJs, /normalizeDigits\(pcp\.npi\) === npi/);
    assert.match(appJs, /normalizeDigits\(pcp\.phone\) === phone/);
    assert.match(appJs, /normalizeLookupText\(pcp\.name\) === name/);
    assert.match(appJs, /fillClientPcpFields\(match, \{ showFound: true \}\)/);
    assert.match(appJs, /PCP found/);
});

test('existing PCP select displays only provider names while retaining full match data elsewhere', () => {
    assert.match(appJs, /option\.value = pcp\.id/);
    assert.match(appJs, /option\.textContent = pcp\.name \|\| ''/);
    assert.doesNotMatch(appJs, /option\.textContent = `\$\{pcp\.name\} \|/);
    assert.match(appJs, /normalizeDigits\(pcp\.phone\) === phone/);
    assert.match(appJs, /normalizeDigits\(pcp\.npi\) === npi/);
});
