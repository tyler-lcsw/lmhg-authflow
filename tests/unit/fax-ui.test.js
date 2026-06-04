const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('fax layer is global so row-level fax buttons can show it from client history', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
    const generateViewStart = html.indexOf('<section id="view-generate-auth"');
    const mainClose = html.indexOf('</main>');
    const faxLayer = html.indexOf('id="inline-fax-layer"');

    assert.notEqual(generateViewStart, -1);
    assert.notEqual(mainClose, -1);
    assert.notEqual(faxLayer, -1);
    assert.ok(faxLayer > mainClose, 'fax layer should live outside inactive application views');
});

test('authorization tabs hide inactive panes so attachments and actions have separate views', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '../../public/css/style.css'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

    assert.match(html, /data-tab="tab-form"/);
    assert.match(html, /data-tab="tab-attachments"/);
    assert.match(html, /data-tab="tab-actions"/);
    assert.match(css, /\.tab-pane\s*\{[\s\S]*?display:\s*none;/);
    assert.match(css, /\.tab-pane\.active\s*\{[\s\S]*?display:\s*block;/);
    assert.match(js, /container\.querySelectorAll\('\.tab-pane'\)\.forEach\(p => p\.classList\.remove\('active'\)\)/);
});

test('authorization workflow presents numbered steps and queues forward progression', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '../../public/css/style.css'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

    assert.match(html, /<span class="step-number">1<\/span>[\s\S]*Form Data/);
    assert.match(html, /<span class="step-number">2<\/span>[\s\S]*Attachments/);
    assert.match(html, /<span class="step-number">3<\/span>[\s\S]*Actions & History/);
    assert.match(html, /id="auth-flow-error"/);
    assert.match(html, /id="btn-auth-next-attachments"/);
    assert.match(html, /id="btn-auth-next-actions"/);
    assert.match(css, /\.step-number/);
    assert.match(js, /function setAuthStep\(/);
    assert.match(js, /function requireAuthStep\(/);
    assert.match(js, /btn-auth-next-attachments/);
    assert.match(js, /btn-auth-next-actions/);
});

test('authorization tab headers use the same form-validity gate as the Step 2 button', () => {
    const js = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

    assert.match(js, /function canEnterAuthStep\(/);
    assert.match(js, /form\.checkValidity\(\)/);
    assert.match(
        js,
        /header\.addEventListener\('click'[\s\S]*?if \(canEnterAuthStep\(targetTabId\)\) setAuthStep\(targetTabId\)/,
        'tab header clicks must use the shared guided-flow gate'
    );
    assert.match(
        js,
        /btn-auth-next-attachments'[\s\S]*?if \(canEnterAuthStep\('tab-attachments'\)\) setAuthStep\('tab-attachments'\)/,
        'Step 2 button must use the same guided-flow gate as tab headers'
    );
});

test('final authorization screen separates PDF generation from optional faxing steps', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '../../public/css/style.css'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

    assert.match(html, /class="action-step[^"]*"[\s\S]*<span class="step-number">4<\/span>[\s\S]*Generate PDF/);
    assert.match(html, /class="action-step[^"]*optional[\s\S]*<span class="step-number">5<\/span>[\s\S]*Optional[\s\S]*Send via SRFax/);
    assert.match(css, /\.action-step/);
    assert.match(css, /\.action-step\.optional/);
    assert.match(js, /function markAuthGenerated\(/);
    assert.match(js, /authStepQueue\.add\('generate-pdf'\)/);
    assert.match(js, /function requireGeneratedPdfForFax\(/);
    assert.match(js, /Generate the PDF before starting the optional fax step\./);
});

test('authorization attachments reset when entering the workflow', () => {
    const js = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');
    const resetStart = js.indexOf('function resetAuthorizationAttachments()');
    const resetEnd = js.indexOf('// --- IntakeQ Notes Logic ---', resetStart);
    const resetBody = js.slice(resetStart, resetEnd);

    assert.notEqual(resetStart, -1);
    assert.match(resetBody, /uploadedFiles = \[\]/);
    assert.match(resetBody, /intakeqNotes = \[\]/);
    assert.match(resetBody, /intakeqFiles = \[\]/);
    assert.match(resetBody, /selectedIntakeqNotes\.clear\(\)/);
    assert.match(resetBody, /selectedIntakeqFiles\.clear\(\)/);
    assert.match(resetBody, /renderFileList\(\)/);
    assert.match(resetBody, /intakeq-notes-list/);
    assert.match(resetBody, /intakeq-files-list/);
    assert.match(resetBody, /pdf-upload/);
    assert.ok((js.match(/resetAuthorizationAttachments\(\)/g) || []).length >= 4);
});
