// Playwright on NODE_PATH; a running client is required. All API writes are mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const XLSX = require('xlsx');

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], writes = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let reserveAssigned = false;
  const session = { id: 'S', room: 'R1', courseName: 'Exam 101', date: '2026-11-06', startTime: '09:00', endTime: '11:00', durationMinutes: 120, taNeeded: 1, doctorNeeded: 0, taRemaining: 1, doctorRemaining: 0, taAssignments: [], doctorAssignments: [] };
  await page.route('**/api/**', async (route) => {
    const req = route.request(), url = new URL(req.url());
    const reply = (json) => route.fulfill({ json });
    if (url.pathname === '/api/scheduling/combined') return reply({ sessions: [session], taInvigilators: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }], doctorInvigilators: [], onCall: { periods: [{ periodKey: '2026-11-06|09:00|11:00', date: '2026-11-06', startTime: '09:00', endTime: '11:00', durationMinutes: 120, onCallTANeeded: 1, onCallDoctorNeeded: 0, onCallTARemaining: reserveAssigned ? 0 : 1, onCallDoctorRemaining: 0, taAssignments: reserveAssigned ? [{ id: 'OC', invigilatorId: 'B', role: 'TA', invigilator: { name: 'B' } }] : [], doctorAssignments: [] }] } });
    if (url.pathname === '/api/on-call/eligible') return reply({ eligibleTAs: [{ id: 'B', name: 'B', projectedMinutes: 120 }], eligibleDoctors: [] });
    if (url.pathname.endsWith('/eligible')) return reply({ eligibleTAs: [{ id: 'A', name: 'A', projectedMinutes: 120 }], eligibleDoctors: [] });
    if (req.method() !== 'GET') {
      const body = req.postData() ? req.postDataJSON() : null;
      writes.push({ route: url.pathname, body, method: req.method() });
      if (url.pathname === '/api/on-call/assign') { reserveAssigned = true; return reply({ id: 'OC' }); }
      if (url.pathname === '/api/on-call/assign/OC') { reserveAssigned = false; return reply({ success: true }); }
      if (url.pathname === '/api/scheduling/assign') return reply({ success: true });
      if (url.pathname === '/api/scheduling/combined/preview') return reply({ combined: true, dryRun: true, planToken: 'exact-plan', policyMode: body.policyMode, shortageExcludedInvigilatorIds: body.shortageExcludedInvigilatorIds || [], shortageExcludedStaff: (body.shortageExcludedInvigilatorIds || []).map(id => ({ StaffID: id, Name: id })), shortageStaff: [{id: 'A', staffId: 'A', name: 'A', role: 'TA', newDuties: 1, overrides: 0}, {id: 'B', staffId: 'B', name: 'B', role: 'TA', newDuties: body.shortageExcludedInvigilatorIds?.includes('B') ? 0 : 1, overrides: 1}], policyOverrides: [{StaffID: 'B', Name: 'B', Rule: 'Unavailable', Detail: 'Requested day off'}], previewMode: body.mode, roleScope: body.roleScope, dutyScope: body.dutyScope, currentTotalShortage: 2, previewTotalShortage: 0, sessionShortage: 0, onCallShortage: 0, assignmentsWouldCreate: 2, assignmentsWouldKeep: 0, assignmentsWouldRemove: 0, duties: [{ DutyType: 'Session', StaffID: 'A' }, { DutyType: 'On-call', StaffID: 'B' }], staffLoads: [{ staffId: 'A', name: 'A', role: 'TA', currentHours: 0, sessionHours: 2, onCallHours: 0, otherHours: 0, totalHours: 2, targetHours: 2 }, { staffId: 'B', name: 'B', role: 'TA', currentHours: 0, sessionHours: 0, onCallHours: 2, otherHours: 0, totalHours: 2, targetHours: 2 }] });
      if (url.pathname === '/api/scheduling/combined/apply') return reply({ combined: true, status: 'COMBINED_FEASIBLE', placed: 2, shortageRemaining: 0 });
      throw new Error('Unexpected API write: ' + url.pathname);
    }
    return route.continue();
  });
  const output = path.resolve(__dirname, '../../artifacts/combined-scheduling-feature');
  fs.mkdirSync(output, { recursive: true });
  try {
    await page.goto((process.env.UI_BASE_URL || 'http://localhost:5173') + '/scheduling');
    await page.getByRole('heading', { name: 'Browse sessions', exact: true }).waitFor();
    await page.getByLabel('Duty type', { exact: true }).selectOption('on_call');
    await page.getByRole('button', { name: 'Manage On-call reserve on 2026-11-06 at 09:00', exact: true }).click();
    const side = page.locator('.schedule-detail-sidebar');
    await side.getByRole('option', { name: 'B (2.0h after)', exact: true }).waitFor({ state: 'attached' });
    await side.locator('select').first().selectOption('B');
    await side.getByRole('button', { name: 'Assign TA', exact: true }).click();
    await side.getByRole('button', { name: 'Remove', exact: true }).waitFor();
    assert.equal(writes[0].route, '/api/on-call/assign');
    assert.equal(await side.getByRole('button', { name: 'Lock', exact: true }).count(), 0);
    await side.getByRole('button', { name: 'Remove', exact: true }).click();
    assert.ok(writes.some((item) => item.route === '/api/on-call/assign/OC' && item.method === 'DELETE'));
    await page.getByLabel('Duty type', { exact: true }).selectOption('sessions');
    await page.getByRole('button', { name: 'Manage R1 on 2026-11-06 at 09:00', exact: true }).click();
    await side.getByRole('option', { name: 'A (2.0h after)', exact: true }).waitFor({ state: 'attached' });
    await side.locator('select').first().selectOption('A');
    await side.getByRole('button', { name: 'Assign TA', exact: true }).click();
    assert.ok(writes.some((item) => item.route === '/api/scheduling/assign'));
    await page.getByRole('navigation', { name: 'Scheduling views' }).getByRole('button', { name: 'Build schedule Preview & save' }).click();
    assert.equal(await page.getByLabel('Which duties should be planned?').inputValue(), 'combined');
    assert.equal(await page.getByLabel('Policy rules', { exact: true }).inputValue(), 'strict');
    await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
    const save = page.getByRole('button', { name: 'Save reviewed plan', exact: true });
    await save.waitFor();
    assert.ok(await page.getByText('Combined hours by staff', { exact: true }).isVisible());
    assert.ok(await page.getByText('Session gaps', { exact: true }).isVisible());
    await page.locator('.toast button').evaluateAll((buttons) => buttons.forEach((button) => button.click()));
    await page.getByText('Combined hours by staff', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'combined-preview.png'), fullPage: true });
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export reviewed plan', exact: true }).click();
    const downloaded = await downloadEvent;
    const workbook = XLSX.readFile(await downloaded.path());
    assert.ok(workbook.Sheets.CombinedAssignments && workbook.Sheets.StaffHours);
    assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets.CombinedAssignments)[1].DutyType, 'On-call');
    await save.click();
    await page.getByRole('heading', { name: 'Browse sessions', exact: true }).waitFor();
    assert.deepEqual(writes.find((item) => item.route === '/api/scheduling/combined/apply').body, { planToken: 'exact-plan' });
    assert.equal(writes.filter((item) => item.route === '/api/scheduling/auto-schedule').length, 0);
    await page.getByRole('navigation', { name: 'Scheduling views' }).getByRole('button', { name: 'Build schedule Preview & save' }).click();
    await page.getByLabel('Policy rules', { exact: true }).selectOption('cover_shortage');
    await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
    await page.getByLabel('Shortage choice for B', { exact: true }).selectOption('exclude');
    assert.ok(await page.getByRole('button', { name: 'Save reviewed plan', exact: true }).isDisabled());
    await page.getByRole('button', { name: 'Recalculate shortage filling', exact: true }).click();
    await page.getByRole('button', { name: 'Save reviewed plan', exact: true }).waitFor();
    assert.deepEqual(writes.filter(w=>w.route.endsWith('/preview')).at(-1).body.shortageExcludedInvigilatorIds, ['B']);
    assert.equal(await page.getByLabel('Shortage choice for B', { exact: true }).inputValue(), 'exclude');
    assert.ok(await page.getByRole('button', { name: 'Save reviewed plan', exact: true }).isEnabled());
    const overrideDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export reviewed plan', exact: true }).click();
    const overrideBook = XLSX.readFile(await (await overrideDownload).path());
    assert.ok(overrideBook.Sheets.PolicyOverrides && overrideBook.Sheets.ShortageExclusions);
    await page.screenshot({ path: path.join(output, 'shortage-staff-review.png'), fullPage: true });
    await page.getByRole('navigation', { name: 'Scheduling views' }).getByRole('button', { name: 'Schedule Browse & assign' }).click();
    await page.getByLabel('Duty type', { exact: true }).selectOption('all');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(350);
    await page.locator('.toast button').evaluateAll((buttons) => buttons.forEach((button) => button.click()));
    await page.locator('.content-area').evaluate((element) => { element.scrollTop = element.querySelector('.schedule-toolbar').offsetTop - element.offsetTop; });
    await page.screenshot({ path: path.join(output, 'combined-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(errors, []);
    console.log('PASS: manual duties, strict default, combined preview, Keep/Exclude after preview, save disabled until recalculation, exclusions and exceptions export, exact apply, mobile layout. All writes intercepted.');
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
