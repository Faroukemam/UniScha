// Run all non-browser verification scripts in separate temporary project copies.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts/application-review');
fs.mkdirSync(output, { recursive: true });
const browserTests = new Set(['verify_scheduling_ui.cjs', 'verify_combined_scheduling_ui.cjs']);
const requested = process.argv.slice(2);
const scripts = fs.readdirSync(__dirname).filter((name) => /^verify_.*\.(js|cjs|mjs|py)$/.test(name) && (!requested.length || requested.includes(name))).sort();
const hashData = () => Object.fromEntries(fs.readdirSync(path.join(root, 'server/data')).filter((name) => /\.(json|sqlite)$/.test(name)).map((name) => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'server/data', name))).digest('hex')]));
const before = hashData();
const results = [];
for (const script of scripts) {
  if (browserTests.has(script)) { results.push({ script, status: 'SKIPPED', reason: 'Requires Playwright and a browser; component rendering is verified separately.' }); continue; }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'unisc-process-review-'));
  const started = Date.now();
  try {
    fs.mkdirSync(path.join(temporary, 'server/data'), { recursive: true });
    // Recovery verification needs real records to recover. Use a tiny fixture,
    // never the user's database or assignment snapshot.
    if (script === 'verify_storage_recovery.js') {
      const fixture = { sessions: [{ id: 'S1', date: '2026-11-18', startTime: '09:00', endTime: '10:00', room: 'R1', taNeeded: 1, doctorNeeded: 0 }], invigilators: [{ id: 'I1', staffId: 'A', name: 'Recovery fixture', role: 'TA', maxHours: 0 }], assignments: [] };
      for (const file of ['store.json', 'store.last-good.json']) fs.writeFileSync(path.join(temporary, 'server/data', file), JSON.stringify(fixture));
    }
    fs.mkdirSync(path.join(temporary, 'client'), { recursive: true });
    fs.mkdirSync(path.join(temporary, 'node_modules'), { recursive: true });
    for (const file of fs.readdirSync(path.join(root, 'server')).filter((name) => name.endsWith('.js'))) fs.copyFileSync(path.join(root, 'server', file), path.join(temporary, 'server', file));
    fs.cpSync(path.join(root, 'server/scripts'), path.join(temporary, 'server/scripts'), { recursive: true, filter: (file) => !file.includes('__pycache__') });
    // Nested test servers otherwise replace NODE_PATH with this temporary
    // project's sparse dependency directory. Keep dependency resolution shared.
    for (const file of fs.readdirSync(path.join(temporary, 'server/scripts')).filter((name) => /\.(js|cjs|mjs)$/.test(name))) {
      const location = path.join(temporary, 'server/scripts', file);
      fs.writeFileSync(location, fs.readFileSync(location, 'utf8').replace(/NODE_PATH:\s*path\.join\((?:liveRepoRoot|root|projectRoot),\s*['"]node_modules['"]\)/g, 'NODE_PATH: process.env.NODE_PATH'));
    }
    fs.cpSync(path.join(root, 'client/src'), path.join(temporary, 'client/src'), { recursive: true });
    fs.cpSync(path.join(root, 'node_modules/sql.js'), path.join(temporary, 'node_modules/sql.js'), { recursive: true });
    fs.cpSync(path.join(root, 'node_modules/xlsx'), path.join(temporary, 'node_modules/xlsx'), { recursive: true });
    for (const dir of fs.readdirSync(root).filter((name) => /^sample/.test(name) && fs.statSync(path.join(root, name)).isDirectory())) fs.cpSync(path.join(root, dir), path.join(temporary, dir), { recursive: true });
    const result = spawnSync(script.endsWith('.py') ? 'python' : process.execPath, [path.join(temporary, 'server/scripts', script)], { cwd: temporary, env: { ...process.env, NODE_PATH: [path.join(root, 'node_modules'), path.join(root, 'client/node_modules')].join(path.delimiter) }, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    const log = `${result.stdout || ''}\n${result.stderr || ''}${result.error ? '\n' + result.error.message : ''}`;
    fs.writeFileSync(path.join(output, script + '.log'), log);
    const entry = { script, status: result.status === 0 ? 'PASS' : 'FAIL', seconds: (Date.now() - started) / 1000, exitCode: result.status };
    results.push(entry); console.log(`${entry.status} ${script} (${entry.seconds.toFixed(1)}s)`);
  } catch (error) { results.push({ script, status: 'FAIL', error: error.message }); console.log(`FAIL ${script}: ${error.message}`); }
  finally {
    const resolved = fs.realpathSync(temporary);
    if (!resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) throw new Error('Temporary path escaped intended directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(output, 'verification-results.json'), JSON.stringify({ results, liveDataBefore: before, liveDataAfter: hashData() }, null, 2));
}
const after = hashData();
const summary = { passed: results.filter((row) => row.status === 'PASS').length, failed: results.filter((row) => row.status === 'FAIL').length, skipped: results.filter((row) => row.status === 'SKIPPED').length, liveDataUnchanged: JSON.stringify(before) === JSON.stringify(after) };
fs.writeFileSync(path.join(output, 'verification-results.json'), JSON.stringify({ summary, results, liveDataBefore: before, liveDataAfter: after }, null, 2));
console.log(JSON.stringify(summary));
process.exitCode = summary.failed ? 1 : 0;
