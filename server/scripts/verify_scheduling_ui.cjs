// Requires Playwright on NODE_PATH and a running client (UI_BASE_URL defaults to localhost:5173).
// All scheduling data and write requests are intercepted; the user's schedule is never changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const XLSX = require('xlsx');

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const writes = [];
  let eligibilityRequests = 0;
  const session = { id: 'S1', date: '2026-11-06', room: 'S201', courseName: 'GE104', startTime: '09:30', endTime: '11:30', durationMinutes: 120, taNeeded: 1, doctorNeeded: 1, taRemaining: 1, doctorRemaining: 1, taAssignments: [], doctorAssignments: [] };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (data) => route.fulfill({ json: data });
    if (['/api/scheduling', '/api/scheduling/combined'].includes(url.pathname) && request.method() === 'GET') return reply({ sessions: [session, { ...session, id: 'S2', room: 'S202' }], taInvigilators: [{ id: 'TA', name: 'Test TA' }], doctorInvigilators: [{ id: 'DR', name: 'Test Doctor' }], onCall: { periods: [] } });
    if (/\/api\/scheduling\/session\/.*\/eligible/.test(url.pathname)) {
      eligibilityRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return reply({ eligibleTAs: [{ id: 'TA', name: 'Test TA', projectedMinutes: 120 }], eligibleDoctors: [] });
    }
    if (request.method() !== 'GET') {
      const body = request.postDataJSON();
      writes.push({ route: url.pathname, body });
      if (url.pathname === '/api/scheduling/auto-schedule-preview') return reply({ planToken: 'session-test-plan', previewMode: body.mode, roleScope: body.roleScope, dryRun: true, currentTotalShortage: 4, previewTotalShortage: 0, assignmentsWouldCreate: 4, assignmentsWouldRemove: 0, assignmentsWouldKeep: 0, placedDuties: 4 });
      if (url.pathname === '/api/scheduling/auto-schedule') return reply({ status: 'FEASIBLE', placed: 4, shortageRemaining: 0 });
      if (url.pathname === '/api/scheduling/import/committee-assignments') return reply({ dryRun: true, rowsRead: 1, expandedAssignments: 1, sessionsMatched: 1, assignmentsToAdd: 1, assignmentsToRemove: 0, duplicatesSkipped: 0, rejected: 0 });
      throw new Error(`Unexpected write: ${url.pathname}`);
    }
    return route.continue();
  });
  const output = path.resolve(__dirname, '../../artifacts/scheduling-review');
  fs.mkdirSync(output, { recursive: true });
  try {
    await page.goto((process.env.UI_BASE_URL || 'http://localhost:5173') + '/scheduling');
    await page.getByRole('heading', { name: 'Browse sessions', exact: true }).waitFor();
    const nav = page.getByRole('navigation', { name: 'Scheduling views' });
    assert.equal(await page.getByRole('heading', { name: 'Scheduling Import' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Save reviewed plan', exact: true }).count(), 0);
    await page.screenshot({ path: path.join(output, 'schedule-desktop.png'), fullPage: true });
    await page.getByRole('button', { name: 'Manage S201 on 2026-11-06 at 09:30', exact: true }).click();
    await page.getByText('Test TA (2.0h after)', { exact: true }).waitFor({ state: 'attached' });
    await page.waitForTimeout(400);
    assert.equal(eligibilityRequests, 1, 'Candidate request must not cancel or restart itself.');
    assert.equal(await page.getByText('Checking staff availability and hour policies…').count(), 0);
    assert.ok(await page.getByRole('button', { name: 'Assign Doctor', exact: true }).isDisabled(), 'Empty eligibility must not fall back to all staff.');
    await page.getByRole('button', { name: 'Close session', exact: true }).click();
    await nav.getByRole('button', { name: 'Build schedule Preview & save' }).click();
    await page.getByLabel('Which duties should be planned?').selectOption('sessions');
    await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
    const save = page.getByRole('button', { name: 'Save reviewed plan', exact: true });
    await save.waitFor();
    assert.ok(await save.isEnabled());
    assert.equal(await page.getByText('Top Staff Over Target', { exact: true }).isVisible(), false, 'Detailed diagnostics start collapsed.');
    await page.screenshot({ path: path.join(output, 'build-desktop.png'), fullPage: true });
    await page.getByLabel('Who should be scheduled?').selectOption('ta_only');
    assert.equal(await save.count(), 0, 'Changing settings invalidates the preview.');
    await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
    await save.waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('scheduler:data-changed')));
    await page.waitForTimeout(100);
    assert.equal(await save.count(), 0, 'Data edits invalidate the preview.');
    await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
    await save.waitFor();
    await save.click();
    await page.getByRole('heading', { name: 'Browse sessions', exact: true }).waitFor();
    assert.equal(writes.filter((item) => item.route === '/api/scheduling/auto-schedule').length, 1);
    assert.deepEqual(writes.find((item) => item.route === '/api/scheduling/auto-schedule').body, { planToken: 'session-test-plan' });
    await nav.getByRole('button', { name: 'Excel Import & export' }).click();
    await page.getByLabel('Workbook format').selectOption('committee');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ SessionID: 'S1', StaffID: 'TA', Role: 'TA' }]), 'CommitteeAssignments');
    await page.locator('input[type=file]').setInputFiles({ name: 'committee.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) });
    const apply = page.getByRole('button', { name: 'Apply Committee Import', exact: true });
    await apply.waitFor();
    assert.ok(await apply.isDisabled(), 'Import requires confirmation text.');
    await page.getByPlaceholder('IMPORT', { exact: true }).fill('IMPORT');
    assert.ok(await apply.isEnabled());
    await page.getByLabel('Committee Import Mode').selectOption('replace_matching_sessions');
    assert.equal(await apply.count(), 0, 'A changed import mode requires a fresh review.');
    await nav.getByRole('button', { name: 'Advanced Locks & backup' }).click();
    assert.equal(await page.getByRole('button', { name: 'Remove all session assignments', exact: true }).isVisible(), false);
    await nav.getByRole('button', { name: 'Schedule Browse & assign' }).click();
    await page.getByRole('button', { name: 'Timeline', exact: true }).click();
    await page.locator('.calendar-session-card').first().focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Close session', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close session', exact: true }).click();
    await page.getByRole('button', { name: 'Session list', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(350);
    assert.equal(await page.locator('.app-layout.sidebar-hidden').count(), 1, 'Mobile navigation must start closed.');
    await page.getByRole('button', { name: 'Show navigation', exact: true }).filter({ visible: true }).click();
    await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
    await page.locator('.toast button').evaluateAll((buttons) => buttons.forEach((button) => button.click()));
    await page.locator('.content-area').evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(output, 'schedule-mobile.png'), fullPage: true });
    await page.locator('.content-area').evaluate((element) => {
      const toolbar = element.querySelector('.schedule-toolbar');
      element.scrollTop = toolbar.offsetTop - element.offsetTop;
    });
    await page.screenshot({ path: path.join(output, 'schedule-mobile-sessions.png'), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, 'Mobile page should not overflow horizontally.');
    assert.deepEqual(errors, []);
    console.log('PASS: desktop/mobile layout, isolated views, eligibility loading, empty candidates, preview/save sequencing, invalidation, confirmed imports, mode changes, keyboard access. Screenshots: ' + output);
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
