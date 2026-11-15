'use strict';
/*
 * Maranggi Guard — wallet transaction & approval screening agent.
 * Node 22, standard library only. Deterministic rule engine, fail closed.
 *
 * Endpoints:
 *   GET  /healthz  -> {"ok": true, "service": "maranggi-guard", "version": "1.0.0"}
 *   GET  /         -> human-readable landing page (HTML)
 *   POST /screen   -> screen a proposed agent-wallet action
 */

const http = require('http');

const SERVICE = 'maranggi-guard';
const VERSION = '1.0.0';
const PORT = Number(process.env.PORT || 8791);

/* ------------------------------------------------------------------ */
/* Screening rule engine                                               */
/* ------------------------------------------------------------------ */

const REQUIRED_FIELDS = ['chain', 'from', 'to', 'valueWei', 'asset', 'simulation'];

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function parseWei(v) {
  // valueWei / approvalAmount arrive as decimal strings; "unlimited" handled by caller.
  if (typeof v !== 'string') return null;
  if (!/^\d+$/.test(v)) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

function screenAction(body) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  const reject = (reason_code, summary) => ({
    decision: 'REJECT',
    reason_code,
    checks,
    summary,
  });
  const review = (reason_code, summary) => ({
    decision: 'REVIEW',
    reason_code,
    checks,
    summary,
  });

  // --- Structural validation: missing/unknown data -> REVIEW (fail closed)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    add('payload_shape', false, 'Request body must be a JSON object.');
    return review('INSUFFICIENT_DATA', 'Payload is not a JSON object; a human must review.');
  }

  const missing = REQUIRED_FIELDS.filter((f) => {
    if (f === 'simulation') return body.simulation === null || typeof body.simulation !== 'object';
    return !isNonEmptyString(body[f]);
  });
  if (missing.length > 0) {
    add('required_fields', false, `Missing or invalid required field(s): ${missing.join(', ')}.`);
    return review(
      'INSUFFICIENT_DATA',
      `Cannot screen safely without: ${missing.join(', ')}. Sent to human review.`
    );
  }
  add('required_fields', true, 'All required fields present.');

  const valueWei = parseWei(body.valueWei);
  if (valueWei === null) {
    add('value_format', false, 'valueWei is not a valid non-negative integer string.');
    return review('INSUFFICIENT_DATA', 'valueWei is malformed; a human must review.');
  }
  add('value_format', true, `valueWei = ${body.valueWei}.`);

  if (typeof body.simulation.success !== 'boolean') {
    add('simulation_shape', false, 'simulation.success must be a boolean.');
    return review('INSUFFICIENT_DATA', 'Simulation result is malformed; a human must review.');
  }

  // --- Rule 1: simulation must succeed
  if (body.simulation.success === false) {
    add('simulation', false, 'Pre-flight simulation reverted or failed.');
    return reject(
      'SIMULATION_FAILED',
      'The transaction simulation failed. A failed simulation is never signed.'
    );
  }
  add('simulation', true, 'Pre-flight simulation succeeded.');

  // --- Rule 2: no blind Permit signatures
  if (body.isPermit === true) {
    add('permit', false, 'Action is an off-chain Permit signature (blind signing risk).');
    return reject(
      'PERMIT_SIGNATURE',
      'Permit signatures are rejected: they grant spending rights without an on-chain transaction to inspect.'
    );
  }
  add('permit', true, 'Not a Permit signature.');

  // --- Rule 3: no unlimited approvals
  if (body.approvalAmount !== undefined && body.approvalAmount !== null) {
    if (body.approvalAmount === 'unlimited') {
      add('approval_scope', false, 'Approval amount is unlimited (uint256 max).');
      return reject(
        'UNLIMITED_APPROVAL',
        'Unlimited token approvals are rejected. Approve the exact amount needed instead.'
      );
    }
    const approval = parseWei(body.approvalAmount);
    if (approval === null) {
      add('approval_scope', false, 'approvalAmount is neither "unlimited" nor a valid integer string.');
      return review('INSUFFICIENT_DATA', 'approvalAmount is malformed; a human must review.');
    }
    add('approval_scope', true, `Approval is bounded to ${body.approvalAmount}.`);
  } else {
    add('approval_scope', true, 'No approval requested by this action.');
  }

  // --- Rule 4: recipient must match the expected recipient
  if (body.expectedRecipient !== undefined && body.expectedRecipient !== null) {
    if (!isNonEmptyString(body.expectedRecipient)) {
      add('recipient', false, 'expectedRecipient is malformed.');
      return review('INSUFFICIENT_DATA', 'expectedRecipient is malformed; a human must review.');
    }
    if (body.expectedRecipient.toLowerCase() !== body.to.toLowerCase()) {
      add('recipient', false, `Recipient ${body.to} does not match expected ${body.expectedRecipient}.`);
      return reject(
        'RECIPIENT_MISMATCH',
        'The destination differs from the intended recipient. Possible drainer redirect; rejected.'
      );
    }
    add('recipient', true, 'Recipient matches the expected recipient.');
  } else {
    add('recipient', true, 'No expected recipient supplied; nothing to compare.');
  }

  // --- Rule 5: amount must match the expected amount
  if (body.expectedAmountWei !== undefined && body.expectedAmountWei !== null) {
    const expected = parseWei(body.expectedAmountWei);
    if (expected === null) {
      add('amount', false, 'expectedAmountWei is malformed.');
      return review('INSUFFICIENT_DATA', 'expectedAmountWei is malformed; a human must review.');
    }
    if (expected !== valueWei) {
      add('amount', false, `valueWei ${body.valueWei} does not match expected ${body.expectedAmountWei}.`);
      return reject(
        'AMOUNT_MISMATCH',
        'The value differs from the intended amount. Rejected rather than signed as-is.'
      );
    }
    add('amount', true, 'Amount matches the expected amount.');
  } else {
    add('amount', true, 'No expected amount supplied; nothing to compare.');
  }

  // --- Rule 6: a "free" claim must actually be free
  if (body.claimFree === true) {
    if (valueWei > 0n) {
      add('free_claim', false, `Action claims to be free but carries value ${body.valueWei} wei.`);
      return reject(
        'VALUE_ON_FREE_CLAIM',
        'The action was presented as a free (gas-only) claim but demands payment. Rejected.'
      );
    }
    add('free_claim', true, 'Free claim carries zero value, as expected.');
  }

  return {
    decision: 'APPROVE',
    reason_code: 'ALL_CHECKS_PASSED',
    checks,
    summary: 'Simulation passed, no Permit, no unlimited approval, recipient and amount match the intent, and any free claim is genuinely free.',
  };
}

/* ------------------------------------------------------------------ */
/* Landing page                                                        */
/* ------------------------------------------------------------------ */

const EXAMPLE_REQUEST = {
  chain: 'bsc',
  from: '0x1111111111111111111111111111111111111111',
  to: '0x2222222222222222222222222222222222222222',
  valueWei: '0',
  asset: 'NFT',
  claimFree: true,
  simulation: { success: true, balanceChanges: [{ asset: 'NFT', change: '+1' }] },
  expectedRecipient: '0x2222222222222222222222222222222222222222',
  expectedAmountWei: '0',
};

const EXAMPLE_RESPONSE = {
  decision: 'APPROVE',
  reason_code: 'ALL_CHECKS_PASSED',
  checks: [{ name: 'simulation', pass: true, detail: 'Pre-flight simulation succeeded.' }],
  summary: 'All screening checks passed.',
};

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Maranggi Guard — Wallet Transaction &amp; Approval Screening Agent</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; line-height: 1.55; color: #1c2430; }
  h1 { font-size: 1.7rem; } h2 { margin-top: 1.8rem; font-size: 1.15rem; }
  code, pre { background: #f2f4f7; border-radius: 6px; }
  code { padding: 0.1em 0.35em; } pre { padding: 0.9rem; overflow-x: auto; font-size: 0.85rem; }
  .badge { display: inline-block; background: #0f7b4d; color: #fff; border-radius: 999px; padding: 0.1rem 0.7rem; font-size: 0.8rem; }
  table { border-collapse: collapse; } td, th { border: 1px solid #d5dbe3; padding: 0.35rem 0.6rem; text-align: left; font-size: 0.92rem; }
</style>
</head>
<body>
<h1>🛡️ Maranggi Guard <span class="badge">live</span></h1>
<p><strong>A screening agent for agentic wallets.</strong> Before an AI agent signs a transaction
or grants a token approval, Maranggi Guard inspects the proposed action and returns a
deterministic verdict: <code>APPROVE</code>, <code>REJECT</code>, or <code>REVIEW</code> — with a
reason code and a per-check audit trail.</p>

<h2>Who it helps</h2>
<p>Anyone who lets an AI agent operate a crypto wallet — participants in agent-ID wallet
programs, airdrop farmers running automated free-mint watchers, and teams wiring LLM agents to
on-chain funds. The dominant loss pattern for these users is not bad trading; it is one bad
signature: an unlimited approval, a Permit, or a transaction quietly redirected to a drainer.</p>

<h2>What it screens</h2>
<table>
<tr><th>Check</th><th>Verdict when it fails</th></tr>
<tr><td>Pre-flight simulation succeeded</td><td>REJECT · SIMULATION_FAILED</td></tr>
<tr><td>Not a blind Permit signature</td><td>REJECT · PERMIT_SIGNATURE</td></tr>
<tr><td>Approval is not unlimited</td><td>REJECT · UNLIMITED_APPROVAL</td></tr>
<tr><td>Recipient matches the intended recipient</td><td>REJECT · RECIPIENT_MISMATCH</td></tr>
<tr><td>Amount matches the intended amount</td><td>REJECT · AMOUNT_MISMATCH</td></tr>
<tr><td>A "free" claim carries zero value</td><td>REJECT · VALUE_ON_FREE_CLAIM</td></tr>
<tr><td>Missing or malformed data</td><td>REVIEW · INSUFFICIENT_DATA (fail closed)</td></tr>
</table>

<h2>Try it</h2>
<p><code>POST /screen</code> with a JSON description of the proposed action:</p>
<pre>${JSON.stringify(EXAMPLE_REQUEST, null, 2)}</pre>
<p>Response:</p>
<pre>${JSON.stringify(EXAMPLE_RESPONSE, null, 2)}</pre>
<p>Health check: <code>GET /healthz</code>. Full documentation, sample payloads and design notes
are in the project README.</p>
</body>
</html>`;

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, service: SERVICE, version: VERSION });
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(LANDING_HTML);
  }

  if (req.method === 'POST' && url.pathname === '/screen') {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return sendJson(res, 200, {
          decision: 'REVIEW',
          reason_code: 'INSUFFICIENT_DATA',
          checks: [{ name: 'payload_shape', pass: false, detail: 'Request body is not valid JSON.' }],
          summary: 'Body is not valid JSON; a human must review.',
        });
      }
      return sendJson(res, 200, screenAction(body));
    });
    return;
  }

  return sendJson(res, 404, { ok: false, error: 'not_found' });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`${SERVICE} v${VERSION} listening on http://localhost:${PORT}`);
  });
}

module.exports = { screenAction, server };
