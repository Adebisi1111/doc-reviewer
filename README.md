# DocReviewer — Open-Source Documentation Reviewer

A GenLayer Intelligent Contract where a repository registers its documentation
rules in plain English, contributors submit a link to their documentation, and
**AI validators independently review the document against each rule**. When
every rule is satisfied, the contributor's wallet receives a permanent
**Verified Contributor** badge for that repository.

**Deployed on Bradbury (chain 4221):** `0x3ED329257B5C8ea353deFaf68Afc041A329C27E4`
**Explorer:** https://explorer-bradbury.genlayer.com/address/0x3ED329257B5C8ea353deFaf68Afc041A329C27E4

---

## What it does

1. `register_repo(repo_id, rules[])` — a repository claims its `repo_id` and
   registers its documentation rules in plain English ("must mention the
   install steps", "must include a licence section", "must state the minimum
   supported version").
2. `submit_doc(submission_id, repo_id, doc_url)` — a contributor submits a link
   to their documentation. For **each rule**, validators independently fetch the
   document and reach consensus on whether it satisfies that rule.
3. On full approval the contributor's wallet is granted a permanent
   **Verified Contributor** badge for that repository.
4. `has_badge(repo_id, wallet)` / `get_badge(repo_id, wallet)` — any contract or
   application can query whether a wallet is verified for a repo.

## How consensus is used

Each rule gets its **own independent** leader/validator round
(`gl.vm.run_nondet`):

```python
def leader_fn() -> dict:
    return _judge(_fetch_doc(url), rule)          # leader judges one rule

def validator_fn(leader_res) -> bool:
    if not isinstance(leader_res, gl.vm.Return):
        return False
    mine = _judge(_fetch_doc(url), rule)          # validator INDEPENDENTLY re-judges
    return mine.get("verdict") == leader_res.calldata.get("verdict")
```

The leader judges one rule against the fetched document; **each validator
independently fetches the same document and re-judges that rule**, agreeing only
if it reproduces the leader's verdict (`MET` / `NOT_MET`). N rules therefore
receive N independent validator-verified judgments. A leader that fabricates a
verdict is caught when a validator's independent judgment disagrees.

This deliberately does **not** use `gl.eq_principle.strict_eq` over an LLM
output: `strict_eq` does not enforce cross-validator equality for
non-deterministic results on this network (verified on-chain — a value that
changes every execution committed under `AGREE`).

## Repository ownership

- **First claim wins.** A `repo_id` can only ever be claimed once, by one
  wallet. This prevents a bad actor from pre-registering someone else's
  repository (e.g. `torvalds/linux`) with trivial rules and issuing Verified
  Contributor badges the real maintainer never authorised.
- `update_rules(repo_id, rules[])` — only the claiming wallet can change a
  repo's rules. Existing badges are unaffected; they were earned against the
  rules in force at the time of the verified submission.
- `is_repo_owner(repo_id, wallet)` — a public check other contracts can consult
  before trusting a badge.

## Why the badge is meaningful

The badge is a durable, consensus-derived credential: it records that N
independent validators each read the same document and agreed it met every rule
the repository's owner specified. Any other contract can gate on
`has_badge(repo_id, wallet)` without re-running the review.

## State model

Parallel `TreeMap[str, scalar]` maps keyed by id — no `@allow_storage`
dataclass, which this GenVM build rejects at deploy time (verified by bisect:
adding any such dataclass to an otherwise-working contract makes the deploy
store no code while still returning `AGREE`).

- Repo registry: `repo_owner`, `repo_rules` (JSON-encoded), `repo_count`
- Submissions: `sub_repo`, `sub_url`, `sub_contributor`, `sub_verdicts` (JSON),
  `sub_passed`, `sub_total`, `sub_approved`, `sub_created`, `sub_count`
- Badges: `badge_record` (JSON, keyed `repo_id|wallet`), `badge_count`

## Verification (on-chain, read back from Bradbury)

**Test suite: 18 assertions, all passing** (`test_docreviewer.mjs`).

| Group | Assertions | Result |
|---|---|---|
| Repository registration | 3 | PASS — rules and owner recorded |
| Verified badge path | 7 | PASS — badge granted, cites the submission |
| Rejected path | 4 | PASS — rule judged NOT_MET, **no badge** granted |
| Duplicate submission | 1 | PASS — `FINISHED_WITH_ERROR`, no overwrite |
| Repo ownership | 5 | PASS — first claim wins, re-registration rejected, rules unchanged, owner can update |
| Rigged leader | 3 | PASS — `DISAGREE` on every round, `total_submissions: 0` |

Adversarial case: a variant whose leader fabricates `MET` regardless of the
document was rejected with `DISAGREE` on all 5 rounds and committed nothing —
the validators independently judged the rule and refused to agree.

## Why no funds are held

The credential is the artifact. The value-moving primitives (`gl.pay`,
`emit_transfer`) do not settle on this network (verified on-chain with a
minimal payable probe that returned `FINISHED_WITH_ERROR` with zero
executions), and a non-monetary reputation primitive does not need them.

## Contract layout

- `contracts/doc_reviewer.py` — the contract (Bradbury pattern:
  `from genlayer import *`, `gl.Contract`, `gl.vm.run_nondet`)
- `deploy.mjs` — deploy script with retry on transient 0-byte stores
- `test_docreviewer.mjs` — on-chain test suite, 18 assertions

## Deploy / test

```bash
DEPLOY_PK=0x<key> node deploy.mjs            # deploy to Bradbury
DEPLOY_PK=0x<key> node test_docreviewer.mjs  # run the on-chain suite
```
