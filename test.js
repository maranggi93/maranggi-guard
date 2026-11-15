'use strict';
/*
 * Maranggi Guard — end-to-end test.
 * Starts the server on a local test port, runs the sample payloads in
 * examples/, asserts the expected decisions, and shuts the server down.
 *
 * Usage: node test.js
 */

const fs = require('fs');
const path = require('path');

process.env.PORT = process.env.PORT || '18791';
const BASE = `http://127.0.0.1:${process.env.PORT}`;

const { server } = require('./server');

const CASES = [
  { file: 'clean-free-mint.json', decision: 'APPROVE', reason: 'ALL_CHECKS_PASSED' },
  { file: 'unlimited-approval.json', decision: 'REJECT', reason: 'UNLIMITED_APPROVAL' },
  { file: 'recipient-mismatch.json', decision: 'REJECT', reason: 'RECIPIENT_MISMATCH' },
];

async function main() {
  await new Promise((resolve) => server.listen(Number(process.env.PORT), resolve));
  let failures = 0;

  try {
    // /healthz
    const health = await (await fetch(`${BASE}/healthz`)).json();
    const healthOk = health.ok === true && health.service === 'maranggi-guard';
    console.log(`${healthOk ? 'PASS' : 'FAIL'}  GET /healthz -> ${JSON.stringify(health)}`);
    if (!healthOk) failures++;

    // / landing page
    const landing = await (await fetch(`${BASE}/`)).text();
    const landingOk = landing.includes('Maranggi Guard');
    console.log(`${landingOk ? 'PASS' : 'FAIL'}  GET / serves the landing page`);
    if (!landingOk) failures++;

    // /screen sample cases
    for (const c of CASES) {
      const payload = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'examples', c.file), 'utf8')
      );
      const res = await fetch(`${BASE}/screen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const out = await res.json();
      const ok = out.decision === c.decision && out.reason_code === c.reason;
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${c.file} -> ${out.decision} / ${out.reason_code} (expected ${c.decision} / ${c.reason})`
      );
      if (!ok) failures++;
    }
  } finally {
    server.close();
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
