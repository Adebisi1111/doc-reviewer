# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""DocReviewer — open-source documentation review by AI validators.

A repository registers its documentation rules in plain English. A contributor
submits a link to their documentation (a pull request, a docs page, a commit).
For EACH rule, AI validators independently fetch the document and reach
consensus on whether it satisfies that rule, in its own consensus round. When
every rule is satisfied, the contributor's wallet receives a permanent
"Verified Contributor" badge for that repository.

Why this belongs on GenLayer: the judgment ("does this documentation actually
meet the repo's stated guidelines?") requires reading and interpreting content,
and the evidence is independently checkable — every validator fetches the same
document. The badge is a durable, consensus-derived credential that any other
contract or application can query, so the on-chain artifact IS the value.

Consensus uses gl.vm.run_nondet with a leader/validator pair, one round per
rule. The leader judges a rule against the fetched document; each validator
INDEPENDENTLY fetches the same document and re-judges, agreeing only if it
reproduces the leader's verdict. A leader that fabricates a verdict is caught
when a validator's independent judgment disagrees. Each rule gets its own round,
so one ambiguous rule does not deadlock the others.

This deliberately does NOT use gl.eq_principle.strict_eq over an LLM output:
strict_eq does not enforce cross-validator equality for non-deterministic
results on this network (verified on-chain — a value that changes every
execution committed under AGREE).

Storage uses parallel TreeMap keyed by id with scalar values — no
@allow_storage dataclass, which this GenVM build rejects at deploy time
(verified by bisect: adding any such dataclass to an otherwise-working contract
makes the deploy store no code while still returning AGREE).

No funds are held or moved: the credential is the artifact.
"""

import json
import re
from datetime import datetime, timezone

from genlayer import *


def _extract_text(raw_html: str) -> str:
    text = re.sub(r"<script[^>]*>.*?</script>", "", raw_html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL | re.IGNORECASE)
    paragraphs = re.findall(r"<p[^>]*>(.*?)</p>", text, flags=re.DOTALL | re.IGNORECASE)
    text = " ".join(paragraphs) if paragraphs else re.sub(r"<[^>]+>", " ", text)
    for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'"), ("&nbsp;", " ")):
        text = text.replace(a, b)
    return re.sub(r"\s+", " ", text).strip()


def _fetch_doc(url: str) -> str:
    response = gl.nondet.web.request(url, method="GET")
    body = response.body if hasattr(response, "body") else (
        response.get("body", "") if isinstance(response, dict) else str(response))
    raw = body.decode("utf-8", errors="replace") if isinstance(body, bytes) else str(body)
    return _extract_text(raw)[:6000]


def _parse_verdict(raw: str) -> str:
    raw = re.sub(r"```json\s*", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"```\s*", "", raw)
    match = re.search(r"\{.*\}", raw, flags=re.DOTALL)
    if match:
        raw = match.group()
    try:
        data = json.loads(raw)
        v = str(data.get("verdict", "")).upper().strip()
        if v in ("MET", "NOT_MET"):
            return v
    except (json.JSONDecodeError, KeyError):
        pass
    upper = raw.upper()
    if "NOT_MET" in upper or "NOT MET" in upper:
        return "NOT_MET"
    if "MET" in upper:
        return "MET"
    return "UNCLEAR"


def _judge(doc_text: str, rule: str) -> dict:
    """Judge ONE documentation rule against the fetched document."""
    prompt = (
        "You are a meticulous open-source documentation reviewer. Decide whether "
        "the documentation satisfies the single rule below.\n\n"
        f"DOCUMENTATION:\n{doc_text}\n\n"
        f"RULE:\n{rule}\n\n"
        "Decide:\n"
        "- MET: the documentation clearly satisfies the rule\n"
        "- NOT_MET: the documentation clearly does not satisfy it\n\n"
        "Respond with ONLY a valid JSON object in this exact format:\n"
        '{"verdict": "MET"} or {"verdict": "NOT_MET"}\n\n'
        "Do NOT include any text outside the JSON object."
    )
    return {"verdict": _parse_verdict(gl.nondet.exec_prompt(prompt).strip())}


class DocReviewer(gl.Contract):
    """Documentation review oracle: repositories register plain-English rules,
    contributors submit docs, validators independently judge each rule, and a
    verified contributor badge is granted on-chain."""

    # repo registry
    repo_owner: TreeMap[str, str]
    repo_rules: TreeMap[str, str]        # JSON list of rules
    repo_count: u256 = u256(0)

    # submissions
    sub_repo: TreeMap[str, str]
    sub_url: TreeMap[str, str]
    sub_contributor: TreeMap[str, str]
    sub_verdicts: TreeMap[str, str]      # JSON list of MET/NOT_MET
    sub_passed: TreeMap[str, u256]
    sub_total: TreeMap[str, u256]
    sub_approved: TreeMap[str, u256]     # 1 if every rule MET
    sub_created: TreeMap[str, u256]
    sub_count: u256 = u256(0)

    # badges: wallet -> JSON badge record for that repo
    badge_record: TreeMap[str, str]
    badge_count: u256 = u256(0)

    def __init__(self):
        self.repo_count = u256(0)
        self.sub_count = u256(0)
        self.badge_count = u256(0)

    def _now(self) -> int:
        return int(datetime.now(timezone.utc).timestamp())

    def _consensus_one(self, target_url: str, rule: str) -> str:
        """One independent leader/validator round for one rule."""
        url = target_url
        r = rule

        def leader_fn() -> dict:
            return _judge(_fetch_doc(url), r)

        def validator_fn(leader_res) -> bool:
            if not isinstance(leader_res, gl.vm.Return):
                return False
            mine = _judge(_fetch_doc(url), r)
            return mine.get("verdict") == leader_res.calldata.get("verdict")

        result = gl.vm.run_nondet(leader_fn, validator_fn)
        data = result.calldata if hasattr(result, "calldata") else result
        v = str(data.get("verdict", "UNCLEAR")).upper()
        return v if v in ("MET", "NOT_MET") else "NOT_MET"

    @gl.public.write
    def register_repo(self, repo_id: str, rules: DynArray[str]) -> str:
        """Claim a repo_id and set its documentation rules.

        First registration wins: a repo_id can only ever be claimed once, by
        one wallet. This prevents a bad actor from pre-registering someone
        else's repository (e.g. "torvalds/linux") with trivial rules and
        issuing Verified Contributor badges the real maintainer never
        authorised. The claiming wallet is the sole authority for that repo.
        """
        if not repo_id:
            raise gl.vm.UserError("repo_id required")
        if self.repo_rules.get(repo_id, None) is not None:
            raise gl.vm.UserError(
                f"Repository {repo_id} already claimed by {self.repo_owner[repo_id]}")
        if len(rules) == 0:
            raise gl.vm.UserError("at least one rule required")
        self.repo_owner[repo_id] = str(gl.message.sender_address)
        self.repo_rules[repo_id] = json.dumps(list(rules))
        self.repo_count += u256(1)
        return f"REGISTERED {len(rules)} rules"

    @gl.public.write
    def update_rules(self, repo_id: str, rules: DynArray[str]) -> str:
        """Replace a repo's rules. Only the wallet that claimed the repo may
        call this. Existing badges are unaffected — they were earned against
        the rules in force at the time of the verified submission."""
        repo_id = str(repo_id)
        if self.repo_rules.get(repo_id, None) is None:
            raise gl.vm.UserError(f"Repository {repo_id} not registered")
        if str(gl.message.sender_address) != self.repo_owner[repo_id]:
            raise gl.vm.UserError("Only the repo owner can update rules")
        if len(rules) == 0:
            raise gl.vm.UserError("at least one rule required")
        self.repo_rules[repo_id] = json.dumps(list(rules))
        return f"UPDATED {len(rules)} rules"

    @gl.public.view
    def is_repo_owner(self, repo_id: str, wallet: str) -> u256:
        if self.repo_rules.get(str(repo_id), None) is None:
            return u256(0)
        return u256(1) if str(wallet) == self.repo_owner[str(repo_id)] else u256(0)

    @gl.public.write
    def submit_doc(self, submission_id: str, repo_id: str, doc_url: str) -> str:
        if not submission_id:
            raise gl.vm.UserError("submission_id required")
        if self.sub_repo.get(submission_id, None) is not None:
            raise gl.vm.UserError(f"Submission {submission_id} already exists")
        if self.repo_rules.get(repo_id, None) is None:
            raise gl.vm.UserError(f"Repository {repo_id} not registered")
        if not doc_url.startswith(("http://", "https://")):
            raise gl.vm.UserError("doc_url must be http(s)")

        target_url = doc_url
        rules = json.loads(self.repo_rules[repo_id])

        # one independent consensus round per rule
        verdicts = []
        for rule in rules:
            verdicts.append(self._consensus_one(target_url, str(rule)))

        passed = sum(1 for v in verdicts if v == "MET")
        total = len(verdicts)
        approved = u256(1 if passed == total else 0)

        contributor = str(gl.message.sender_address)
        self.sub_repo[submission_id] = repo_id
        self.sub_url[submission_id] = doc_url
        self.sub_contributor[submission_id] = contributor
        self.sub_verdicts[submission_id] = json.dumps(verdicts)
        self.sub_passed[submission_id] = u256(passed)
        self.sub_total[submission_id] = u256(total)
        self.sub_approved[submission_id] = approved
        self.sub_created[submission_id] = u256(self._now())
        self.sub_count += u256(1)

        # grant the badge on full approval — permanent, keyed by wallet+repo
        if approved == u256(1):
            key = repo_id + "|" + contributor
            self.badge_record[key] = json.dumps({
                "repo_id": repo_id,
                "wallet": contributor,
                "submission_id": submission_id,
                "rules_met": total,
                "granted_at": self._now(),
            })
            self.badge_count += u256(1)
            return "VERIFIED"

        return "REJECTED"

    @gl.public.view
    def get_submission(self, submission_id: str) -> dict:
        submission_id = str(submission_id)
        if self.sub_repo.get(submission_id, None) is None:
            return {"exists": False}
        return {
            "exists": True,
            "submission_id": submission_id,
            "repo_id": self.sub_repo[submission_id],
            "doc_url": self.sub_url[submission_id],
            "contributor": self.sub_contributor[submission_id],
            "verdicts": json.loads(self.sub_verdicts[submission_id]),
            "passed": int(self.sub_passed[submission_id]),
            "total": int(self.sub_total[submission_id]),
            "approved": int(self.sub_approved[submission_id]),
            "created_at": int(self.sub_created[submission_id]),
        }

    @gl.public.view
    def get_repo(self, repo_id: str) -> dict:
        repo_id = str(repo_id)
        if self.repo_rules.get(repo_id, None) is None:
            return {"exists": False}
        return {
            "exists": True,
            "repo_id": repo_id,
            "owner": self.repo_owner[repo_id],
            "rules": json.loads(self.repo_rules[repo_id]),
        }

    @gl.public.view
    def has_badge(self, repo_id: str, wallet: str) -> u256:
        key = str(repo_id) + "|" + str(wallet)
        return u256(1) if self.badge_record.get(key, None) is not None else u256(0)

    @gl.public.view
    def get_badge(self, repo_id: str, wallet: str) -> dict:
        key = str(repo_id) + "|" + str(wallet)
        rec = self.badge_record.get(key, None)
        if rec is None:
            return {"exists": False}
        out = json.loads(rec)
        out["exists"] = True
        return out

    @gl.public.view
    def total_repos(self) -> u256:
        return self.repo_count

    @gl.public.view
    def total_submissions(self) -> u256:
        return self.sub_count

    @gl.public.view
    def total_badges(self) -> u256:
        return self.badge_count

    @gl.public.view
    def now(self) -> str:
        return datetime.now(timezone.utc).isoformat()
