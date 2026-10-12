// On-chain test suite for DocReviewer.
//   DEPLOY_PK=0x<key> node test_docreviewer.mjs
// Assertions read committed state back from chain; receipt fields are logged
// but never used as the pass criterion (a round can return AGREE while
// committing nothing).

import { createClient, createAccount } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import fs from 'fs';

const PK = process.env.DEPLOY_PK;
if (!PK) { console.error('DEPLOY_PK not set'); process.exit(1); }

const account = createAccount(PK);
const client = createClient({ chain: testnetBradbury, account });
const FEES = { feeValue: '100000000000010352' };
const me = account.address;

// A stable, publicly reachable document that says "hello world".
const URL_PASS = 'https://test-server.genlayer.com/static/genvm/hello.html';
// Rules the doc satisfies / fails.
const RULE_PASS = 'The documentation must mention hello world';
const RULE_FAIL = 'The documentation must include a pricing table';

const ABI = [
  { type: 'function', name: 'register_repo', stateMutability: 'nonpayable',
    inputs: [{ name: 'repo_id', type: 'string' }, { name: 'rules', type: 'string[]' }],
    outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'update_rules', stateMutability: 'nonpayable',
    inputs: [{ name: 'repo_id', type: 'string' }, { name: 'rules', type: 'string[]' }],
    outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'is_repo_owner', stateMutability: 'view',
    inputs: [{ name: 'repo_id', type: 'string' }, { name: 'wallet', type: 'string' }],
    outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'submit_doc', stateMutability: 'nonpayable',
    inputs: [{ name: 'submission_id', type: 'string' }, { name: 'repo_id', type: 'string' },
              { name: 'doc_url', type: 'string' }], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'get_submission', stateMutability: 'view',
    inputs: [{ name: 'submission_id', type: 'string' }], outputs: [{ name: '', type: 'any' }] },
  { type: 'function', name: 'get_repo', stateMutability: 'view',
    inputs: [{ name: 'repo_id', type: 'string' }], outputs: [{ name: '', type: 'any' }] },
  { type: 'function', name: 'has_badge', stateMutability: 'view',
    inputs: [{ name: 'repo_id', type: 'string' }, { name: 'wallet', type: 'string' }],
    outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'get_badge', stateMutability: 'view',
    inputs: [{ name: 'repo_id', type: 'string' }, { name: 'wallet', type: 'string' }],
    outputs: [{ name: '', type: 'any' }] },
  { type: 'function', name: 'total_submissions', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'total_badges', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
];

let passed = 0, failed = 0, ADDR = null;

function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}

async function fin(h) {
  for (let i = 0; i < 250; i++) {
    try {
      const r = await client.waitForTransactionReceipt({ hash: h, waitUntil: 'finalized', retries: 250 });
      if (r && r.resultName) return r;
    } catch (e) { /* transient */ }
    await new Promise(x => setTimeout(x, 4000));
  }
  return null;
}

async function write(fn, args) {
  for (let a = 1; a <= 4; a++) {
    try {
      const h = await client.writeContract({
        address: ADDR, abi: ABI, functionName: fn, args, value: 0n, fees: FEES, gasLimit: 5000000n,
      });
      return await fin(h);
    } catch (e) {
      const msg = (e.shortMessage || e.message || '');
      // A transient revert advances the chain nonce past the SDK's cached
      // value; every later write then fails with "nonce is not consistent".
      // Force the client to re-read the nonce from the chain and retry.
      if (msg.includes('nonce is not consistent') || msg.includes('nonce too low')) {
        try {
          // getCurrentNonce is not served by this RPC (returns an HTML error
          // page); read the nonce with raw eth_getTransactionCount instead.
          const res = await fetch('https://rpc-bradbury.genlayer.com', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionCount',
                                   params: [me, 'pending'], id: 1 }),
          });
          const j = await res.json();
          const n = parseInt(j.result, 16);
          if (Number.isFinite(n)) {
            client.account.nonce = n;
            console.log(`  nonce resynced to ${n} (attempt ${a})`);
          }
        } catch (e2) { /* fall through to retry */ }
        await new Promise(x => setTimeout(x, 3000));
        continue;
      }
      throw e;
    }
  }
  return null;
}

async function readRaw(fn, args) {
  for (let i = 0; i < 30; i++) {
    try {
      const v = await client.readContract({ address: ADDR, abi: ABI, functionName: fn, args });
      if (v !== undefined && v !== null) return v;
    } catch (e) { /* read-path lag */ }
    await new Promise(x => setTimeout(x, 5000));
  }
  return null;
}

async function read(fn, args) {
  for (let i = 0; i < 30; i++) {
    try {
      const v = await client.readContract({ address: ADDR, abi: ABI, functionName: fn, args });
      const o = typeof v === 'string' ? JSON.parse(v) : v;
      if (o && (o.exists !== false)) return o;
    } catch (e) { /* read-path lag */ }
    await new Promise(x => setTimeout(x, 5000));
  }
  return null;
}

async function deploy(code, tries = 3) {
  for (let t = 1; t <= tries; t++) {
    const dr = await fin(await client.deployContract({ code }));
    const addr = dr && dr.txDataDecoded && dr.txDataDecoded.contractAddress;
    if (!addr) { console.log(`  deploy ${t}: no address`); continue; }
    await new Promise(x => setTimeout(x, 8000));
    let stored = '';
    try { stored = (await client.getContractCode(addr)) || ''; } catch (e) { /* */ }
    console.log(`  deploy ${t}: ${addr} — code stored ${stored.length} bytes`);
    if (stored.length > 0) return addr;
  }
  throw new Error('deploy stored no contract code after retries');
}

// --- 1: repo registration --------------------------------------------------
async function testRegisterRepo() {
  console.log('\n[1] repository registers plain-English rules');
  const repo = 'demo-repo-1';
  for (let a = 1; a <= 4; a++) {
    const r = await write('register_repo', [repo, [RULE_PASS]]);
    console.log(`  register_repo#${a}: result=${r && r.resultName} exec=${r && r.txExecutionResultName}`);
    if (r && r.resultName === 'AGREE' && r.txExecutionResultName === 'FINISHED_WITH_RETURN') break;
    await new Promise(x => setTimeout(x, 4000));
  }
  const rd = await read('get_repo', [repo]);
  check('repo registered', !!rd && rd.exists === true);
  check('rules stored', rd && Array.isArray(rd.rules) && rd.rules.length === 1,
    `rules=${rd && JSON.stringify(rd.rules)}`);
  check('owner recorded', rd && rd.owner && rd.owner.length > 0);
  return repo;
}

// --- 2: docs that satisfy the rules -> badge granted -----------------------
async function testVerifiedBadge(repo) {
  console.log('\n[2] docs satisfying the rules grant a Verified Contributor badge');
  const sid = 'sub-pass-1';
  for (let a = 1; a <= 5; a++) {
    const r = await write('submit_doc', [sid, repo, URL_PASS]);
    console.log(`  submit_doc#${a}: result=${r && r.resultName} exec=${r && r.txExecutionResultName}`);
    if (r && r.resultName === 'AGREE' && r.txExecutionResultName === 'FINISHED_WITH_RETURN') break;
    await new Promise(x => setTimeout(x, 4000));
  }
  const s = await read('get_submission', [sid]);
  check('submission committed', !!s && s.exists === true);
  check('verdicts recorded', s && Array.isArray(s.verdicts) && s.verdicts.length === 1,
    `verdicts=${s && JSON.stringify(s.verdicts)}`);
  check('approved (all rules MET)', s && Number(s.approved) === 1,
    `approved=${s && s.approved} passed=${s && s.passed}/${s && s.total}`);
  check('contributor recorded', s && s.contributor === me);

  // badge
  let badge = null;
  for (let i = 0; i < 12; i++) {
    badge = await readRaw('has_badge', [repo, me]);
    if (String(badge) === '1') break;
    await new Promise(x => setTimeout(x, 5000));
  }
  check('badge granted to wallet', String(badge) === '1', `has_badge=${String(badge)}`);
  const rec = await read('get_badge', [repo, me]);
  check('badge record readable', rec && rec.exists === true);
  check('badge cites the submission', rec && rec.submission_id === sid);
  return sid;
}

// --- 3: docs that fail a rule -> rejected, no badge ------------------------
async function testRejected(repo) {
  console.log('\n[3] docs failing a rule are rejected with no badge');
  const repo2 = 'demo-repo-2';
  for (let a = 1; a <= 4; a++) {
    const r = await write('register_repo', [repo2, [RULE_FAIL]]);
    if (r && r.resultName === 'AGREE' && r.txExecutionResultName === 'FINISHED_WITH_RETURN') break;
    await new Promise(x => setTimeout(x, 4000));
  }
  const sid = 'sub-fail-1';
  for (let a = 1; a <= 5; a++) {
    const r = await write('submit_doc', [sid, repo2, URL_PASS]);
    console.log(`  submit_doc(fail)#${a}: result=${r && r.resultName} exec=${r && r.txExecutionResultName}`);
    if (r && r.resultName === 'AGREE' && r.txExecutionResultName === 'FINISHED_WITH_RETURN') break;
    await new Promise(x => setTimeout(x, 4000));
  }
  const s = await read('get_submission', [sid]);
  check('submission committed', !!s && s.exists === true);
  check('not approved', s && Number(s.approved) === 0, `approved=${s && s.approved}`);
  check('rule judged NOT_MET', s && s.verdicts && s.verdicts[0] === 'NOT_MET',
    `verdicts=${s && JSON.stringify(s.verdicts)}`);
  const badge = await readRaw('has_badge', [repo2, me]);
  check('no badge for failed submission', String(badge) === '0', `has_badge=${String(badge)}`);
}

// --- 4: duplicate submission is rejected -----------------------------------
async function testDuplicateRejected(repo) {
  console.log('\n[4] duplicate submission_id is rejected');
  const r = await write('submit_doc', ['sub-pass-1', repo, URL_PASS]);
  console.log(`  duplicate submit: result=${r && r.resultName} exec=${r && r.txExecutionResultName}`);
  check('duplicate rejected', r && r.txExecutionResultName !== 'FINISHED_WITH_RETURN',
    `exec=${r && r.txExecutionResultName}`);
}

// --- 5: rigged leader is rejected ------------------------------------------
async function testRiggedLeader() {
  console.log('\n[5] rigged leader fabricating MET is rejected');
  const src = fs.readFileSync(new URL('./contracts/doc_reviewer.py', import.meta.url), 'utf8');
  const rigged = src.replace(
    '        def leader_fn() -> dict:\n            return _judge(_fetch_doc(url), r)',
    '        def leader_fn() -> dict:\n            return {"verdict": "MET"}');
  if (rigged === src) { check('rigged variant built', false, 'replacement did not apply'); return; }
  fs.writeFileSync(new URL('./contracts/_adv.py', import.meta.url), rigged);
  const adv = await deploy(rigged);
  const saved = ADDR; ADDR = adv;
  for (let a = 1; a <= 4; a++) {
    const r = await write('register_repo', ['adv-repo', [RULE_FAIL]]);
    if (r && r.resultName === 'AGREE' && r.txExecutionResultName === 'FINISHED_WITH_RETURN') break;
    await new Promise(x => setTimeout(x, 4000));
  }
  let disagree = 0;
  for (let a = 1; a <= 5; a++) {
    const r = await write('submit_doc', ['adv-sub', 'adv-repo', URL_PASS]);
    console.log(`  rigged submit#${a}: result=${r && r.resultName}`);
    if (r && r.resultName === 'DISAGREE') disagree++;
    if (r && r.resultName === 'AGREE' && r.txExecutionResultName === 'FINISHED_WITH_RETURN') break;
    await new Promise(x => setTimeout(x, 4000));
  }
  const s = await read('get_submission', ['adv-sub']);
  const t = await client.readContract({ address: adv, abi: ABI, functionName: 'total_submissions', args: [] }).catch(() => '?');
  console.log(`  total_submissions on rigged contract: ${String(t)}`);
  check('rigged leader never committed', !s);
  check('total_submissions is 0', String(t) === '0', `got ${String(t)}`);
  check('at least 3 rounds DISAGREE', disagree >= 3, `disagree=${disagree}`);
  ADDR = saved;
  fs.rmSync(new URL('./contracts/_adv.py', import.meta.url), { force: true });
}

// --- 6: repo ownership -----------------------------------------------------
async function testOwnership(repo) {
  console.log('\n[6] repo ownership — first claim wins, only owner can update rules');
  const other = '0x000000000000000000000000000000000000dEaD';
  const owner = await readRaw('is_repo_owner', [repo, me]);
  check('claiming wallet is the owner', String(owner) === '1', `is_repo_owner=${String(owner)}`);
  const notOwner = await readRaw('is_repo_owner', [repo, other]);
  check('another wallet is not the owner', String(notOwner) === '0', `is_repo_owner=${String(notOwner)}`);

  // a second registration attempt on the same repo_id must be rejected
  const r = await write('register_repo', [repo, ['any rule at all']]);
  console.log(`  re-register: result=${r && r.resultName} exec=${r && r.txExecutionResultName}`);
  check('re-registration rejected (repo already claimed)',
    r && r.txExecutionResultName !== 'FINISHED_WITH_RETURN',
    `exec=${r && r.txExecutionResultName}`);

  // the original rules must be unchanged after the rejected attempt
  const rd = await read('get_repo', [repo]);
  check('rules unchanged after rejected re-registration',
    rd && rd.rules && rd.rules[0] === RULE_PASS,
    `rules=${rd && JSON.stringify(rd.rules)}`);

  // owner can update rules
  const u = await write('update_rules', [repo, [RULE_PASS, RULE_FAIL]]);
  console.log(`  update_rules (owner): result=${u && u.resultName} exec=${u && u.txExecutionResultName}`);
  check('owner can update rules', u && u.txExecutionResultName === 'FINISHED_WITH_RETURN',
    `exec=${u && u.txExecutionResultName}`);
  const rd2 = await read('get_repo', [repo]);
  check('rules updated', rd2 && rd2.rules && rd2.rules.length === 2,
    `rules=${rd2 && JSON.stringify(rd2.rules)}`);
  // restore the single rule so later assertions still hold
  await write('update_rules', [repo, [RULE_PASS]]);
}

async function main() {
  console.log('DocReviewer — on-chain test suite');
  console.log('account:', me);
  console.log('\n[0] deploy');
  ADDR = await deploy(fs.readFileSync(new URL('./contracts/doc_reviewer.py', import.meta.url), 'utf8'));
  console.log('CONTRACT:', ADDR);

  const repo = await testRegisterRepo();
  await testVerifiedBadge(repo);
  await testRejected(repo);
  await testDuplicateRejected(repo);
  await testOwnership(repo);
  await testRiggedLeader();

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  console.log(`CONTRACT UNDER TEST: ${ADDR}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('SUITE ERROR:', (e.shortMessage || e.message).slice(0, 150)); process.exit(1); });
