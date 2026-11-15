# Maranggi Guard

**A wallet transaction & approval screening agent for agentic wallets.**

Before an AI agent signs a transaction or grants a token approval, Maranggi Guard inspects the
proposed action and returns a deterministic verdict — `APPROVE`, `REJECT`, or `REVIEW` — with a
machine-readable reason code and a per-check audit trail. It is the "look before you sign" layer
that sits between an autonomous agent and the wallet's signing key.

Built for the **zkVerify Agent Games — Wildcard track**. Node.js standard library only: no
dependencies, no build step.

---

## The problem

Agentic wallets are going mainstream: AI agents now hold wallet credentials and act on-chain on
their users' behalf — minting, claiming, swapping, approving. The dominant loss pattern for these
users is not bad strategy. It is **one bad signature**:

- An **unlimited approval** (`uint256.max`) quietly granted to a malicious contract, drained days later.
- A **Permit** signature — signed off-chain, invisible in any transaction preview — that hands a
  spender full rights over a token balance.
- A transaction whose **recipient or amount was silently changed** between what the user (or the
  agent's plan) intended and what is actually about to be signed.
- A "free mint" that turns out to carry a **hidden payment**.
- A transaction that was **never simulated**, signed blind, and reverts — or worse, succeeds at
  doing something nobody checked.

Humans miss these because wallet UIs bury them. Agents miss them because most agent stacks sign
whatever the planner produced. Maranggi Guard exists so that *neither* has to rely on attention:
the screening rules are deterministic, run on every single action, and fail closed.

## Who it helps

- **Users of agentic wallets** (e.g. agent-ID wallets on BNB Chain) who delegate signing to an AI
  agent and need a guarantee that the agent cannot exceed its mandate.
- **Airdrop farmers and free-mint watchers** running automated agents, where a single drainer
  approval can erase an entire wallet that took months to build.
- **Teams wiring LLM agents to real funds**, who need an auditable, testable gate between
  "the model decided" and "the wallet signed".

## How it works

The agent (or its operator) describes the proposed action as JSON and POSTs it to `/screen`
*before* signing. The description carries both the action itself and the **intent** it is checked
against: the expected recipient, the expected amount, whether the action was promised to be free.

```json
POST /screen
{
  "chain": "bsc",
  "from": "0x1111...1111",
  "to": "0x2222...2222",
  "valueWei": "0",
  "asset": "NFT",
  "claimFree": true,
  "simulation": { "success": true, "balanceChanges": [{ "asset": "NFT", "change": "+1" }] },
  "expectedRecipient": "0x2222...2222",
  "expectedAmountWei": "0"
}
```

```json
{
  "decision": "APPROVE",
  "reason_code": "ALL_CHECKS_PASSED",
  "checks": [
    { "name": "simulation", "pass": true, "detail": "Pre-flight simulation succeeded." },
    { "name": "recipient",  "pass": true, "detail": "Recipient matches the expected recipient." }
  ],
  "summary": "Simulation passed, no Permit, no unlimited approval, recipient and amount match the intent..."
}
```

### The rules (fail closed, in order)

| # | Rule | Verdict |
|---|------|---------|
| 1 | Missing or malformed required data | `REVIEW` · `INSUFFICIENT_DATA` |
| 2 | Pre-flight simulation (`eth_call`-style) failed | `REJECT` · `SIMULATION_FAILED` |
| 3 | Action is an off-chain Permit signature | `REJECT` · `PERMIT_SIGNATURE` |
| 4 | Approval amount is `unlimited` | `REJECT` · `UNLIMITED_APPROVAL` |
| 5 | Recipient ≠ expected recipient | `REJECT` · `RECIPIENT_MISMATCH` |
| 6 | Amount ≠ expected amount | `REJECT` · `AMOUNT_MISMATCH` |
| 7 | `claimFree: true` but `valueWei > 0` | `REJECT` · `VALUE_ON_FREE_CLAIM` |
| — | Everything passes | `APPROVE` · `ALL_CHECKS_PASSED` |

`REVIEW` is a first-class outcome, not an error: when the screener cannot prove an action is safe
*or* dangerous, it refuses to guess and hands the action to a human. That is the fail-closed
principle — **uncertainty never resolves toward signing**.

## Endpoints

| Method & path | Description |
|---|---|
| `GET /healthz` | `{"ok": true, "service": "maranggi-guard", "version": "1.0.0"}` |
| `GET /` | Human-readable landing page: what it screens, who it helps, a live example |
| `POST /screen` | Screen one proposed action; returns decision, reason code, checks, summary |

## Key design decisions

1. **Deterministic rules, no LLM in the verdict path.** A safety gate must be reproducible: the
   same action must always produce the same verdict, and every verdict must be explainable from
   the `checks` array. An LLM may *propose* actions; it must never be the thing that *approves*
   them.
2. **Intent is an input, not an assumption.** Recipient and amount checks only work because the
   caller declares what it *meant* to do (`expectedRecipient`, `expectedAmountWei`). Screening
   compares the action against the intent — this is exactly the comparison that catches drainer
   redirects and UI/agent mismatches.
3. **Simulate first, always.** Rule 2 encodes the hardest-won operational lesson of running an
   agentic wallet: never trust a web UI's claim about what a contract will do; simulate the call
   and let the chain answer.
4. **Exact approvals by default.** Unlimited approvals are rejected outright rather than warned
   about. Bounded approvals pass and are reported in the audit trail.
5. **Zero dependencies.** The whole service is one Node.js file on the standard library. A security
   component should have the smallest possible supply chain — ideally none.
6. **Amounts as strings + `BigInt`.** Wei values exceed `Number.MAX_SAFE_INTEGER`; all comparisons
   are exact integer comparisons, never floats.

## Limitations (honest list)

- **Rule-based, not a guarantee.** Maranggi Guard catches the known, high-frequency drain patterns
  listed above. It does not audit contract bytecode, detect novel exploit logic inside a
  *simulated-successful* call, or judge whether a fairly-priced action is a good idea.
- **It trusts its inputs.** If the caller supplies a forged simulation result or a wrong
  "expected" value, the verdict is only as honest as that input. In production, the simulation and
  intent should come from trusted components of the agent stack, not from the counterparty.
- **Screening is advisory to the signer.** The guard returns a verdict; the wallet integration must
  actually refuse to sign on `REJECT`/`REVIEW`. (In our own stack, that refusal is a hard rule, not
  a suggestion.)
- **No state across requests.** Each call is screened independently; cross-action patterns (e.g.
  many small approvals to the same spender) are out of scope for this version.

## Run it

```bash
# Requires Node.js 22 (any recent Node works)
PORT=8791 node server.js
# -> maranggi-guard v1.0.0 listening on http://localhost:8791
```

Try the samples:

```bash
curl -s localhost:8791/healthz
curl -s -X POST localhost:8791/screen \
  -H 'Content-Type: application/json' \
  -d @examples/clean-free-mint.json
```

Run the test suite (starts the server, exercises all three samples plus `/healthz` and `/`,
asserts the decisions):

```bash
node test.js
```

## Sample payloads

| File | Scenario | Expected verdict |
|---|---|---|
| `examples/clean-free-mint.json` | Gas-only free NFT mint, simulation passes, recipient/amount match | `APPROVE` |
| `examples/unlimited-approval.json` | Token approval with `approvalAmount: "unlimited"` | `REJECT` · `UNLIMITED_APPROVAL` |
| `examples/recipient-mismatch.json` | Payment redirected to an address ≠ expected recipient | `REJECT` · `RECIPIENT_MISMATCH` |

## Why zkVerify fits (optional verifiability note)

A screening verdict is a claim: *"this action was checked against these rules at this time."*
Today that claim lives in the `checks` array of the response. The natural next step is to make
each verdict independently checkable — committing a hash of (action, rule-set version, verdict) so
anyone can later verify that a given signature was preceded by a passing screen, without exposing
the user's full transaction history. That is precisely the kind of claim zkVerify exists to make
portable and provable, and it is the direction we would take this agent next.

## License

MIT
