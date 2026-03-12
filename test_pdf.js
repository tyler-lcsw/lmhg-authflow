const fs = require('fs');
const ejs = require('ejs');
const puppeteer = require('puppeteer');
const path = require('path');

async function testPdf() {
    const formData = {
        date: "2026-03-11",
        mco_id: "12345",
        member_name: "John Doe",
        medicaid_id: "999999",
        dob: "1990-01-01",
        pregnant: "no",
        pcp: "Dr. Smith",
        other_insurance: "no",
        insurer: "",
        medicare: [],
        requesting_provider: "Dr. Req",
        req_provider_phone: "555-1111",
        req_provider_npi: "1111111",
        req_provider_fax: "555-2222",
        servicing_provider: "Dr. Serv",
        serv_provider_npi: "2222222",
        servicing_facility: "Facility XYZ",
        service_type: ["behavioral_health"]
    };

    const html = await ejs.renderFile(path.join(__dirname, 'views/form_template.ejs'), { data: formData });
    
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    // Take a screenshot instead of PDF so I can view it
    await page.screenshot({ path: path.join(__dirname, 'test_render.png'), fullPage: true });
    await browser.close();
    console.log("Screenshot saved to test_render.png");
}

testPdf().catch(console.error);
