# Verification: Proving the Goal, Not Approximating It

The gap between an approximated result and an achieved one is evidence. An agent that *approximates* produces something in the general direction of the request and asserts success. An agent that *achieves* can point to concrete, inspectable observations demonstrating each success criterion holds. This file is the playbook for the second kind.

## Evidence vs. assertion

- **Assertion**: "I updated the config so the service now uses the new port."
- **Evidence**: "Restarted the service and curled it: `curl localhost:9090/health` → `200 OK`; old port 8080 now refuses connections."

An assertion describes work you did. Evidence describes reality you observed *after* the work. Only the second proves anything. The internal test: for every claim in your completion report, can you name the specific command output, file content, or measurement it rests on? If not, either go produce that observation or downgrade the claim to "unverified."

## Three properties of a real verification

1. **Independent** — the check must not share the failure mode of the work. If you wrote a summation, verify with a different computation path (recompute with a different tool, or check an invariant like "parts sum to the whole"), not by re-reading your own formula and nodding. Checking work with the same reasoning that produced it only confirms you'd make the same mistake twice.
2. **End-to-end** — verify the artifact the user receives, in the state they receive it. Open the final PDF, run the final script fresh in a clean state, re-fetch the page you edited. Step-level checks pass while the assembled whole is broken more often than intuition suggests.
3. **Falsifiable-by-design** — a good check *could have failed*. "I looked it over and it seems fine" cannot fail and therefore proves nothing. "I ran the 6 edge cases from the spec; all matched expected output" could have failed, so its passing means something.

Also: **keep checks dumber than the work.** A verification is only trustworthy if it is simpler than the thing it verifies. Prefer several single-purpose checks over one clever compound expression — compound checks have their own bugs, and a buggy check that prints a reassuring answer is worse than no check. If a check's result contradicts what a raw look at the data suggests, distrust the check first and re-verify with the simplest possible query.

## Verification patterns by task type

**Code**
- Reproduce the bug before the fix; re-run the same reproduction after — the before/after pair is the proof.
- Run the tests; paste the actual result line, not "tests pass." Run the *full* relevant suite, not just the test you were staring at — fixes cause regressions.
- Confirm the fix works for the right reason: you can explain the mechanism, not just the disappearance of the symptom.
- Adversarial minute: feed it the empty input, the huge input, the malformed input.

**Data work (analysis, transforms, spreadsheets)**
- Check invariants: row counts in vs. out, totals preserved, no unexpected nulls, key columns still unique.
- Recompute one or two results by an independent path (different tool, manual arithmetic on a sample).
- Eyeball head, tail, and a random middle sample of actual output — not just the first rows, where everything always looks fine.

**Documents and generated files**
- Open the produced file itself (render the PDF, open the docx, view the image). Generation succeeding is not the file being correct.
- Check the framed criteria mechanically: required sections present, counts right, numbers in the document match the source data (trace 2–3 figures back to origin).
- Check the failure-prone parts: tables, page breaks, images, cross-references — not just body prose.

**Research and factual claims**
- Every load-bearing claim traces to a source you actually opened, not a snippet or memory.
- Corroborate surprising or pivotal claims with a second independent source; report single-source claims as such.
- Where sources conflict, report the conflict rather than silently picking a winner.

**Actions in external systems (emails, tickets, deploys, calendar events)**
- Read back the created object: fetch the event, view the sent ticket, list the deployed version. The API returning 200 is an assertion; the object existing with the right fields is evidence.
- Verify the *absence* of unintended effects where feasible (nothing else deleted, no duplicate created, no extra recipients).

## When success criteria are hard to verify

Some goals resist direct checking ("make this more persuasive", "improve performance"). Do not let that collapse into vibes:

- **Operationalize at framing time**: convert the soft goal into proxy criteria agreed upfront — "persuasive" becomes "leads with the reader's problem, cites two data points, ends with a single clear ask." Verify the proxies mechanically; the report says the proxies were met, not that the abstract quality was achieved.
- **Measure deltas**: for "improve X," measure X before and after with the same instrument (timing runs, readability metrics, file size). No baseline captured before the work = no improvement claim after; say "changed, likely improved, unmeasured."
- **Declare the unverifiable**: when something genuinely can't be checked in your environment (needs prod access, human taste, long-term outcomes), state it explicitly as a residual risk in the report. Marking a boundary of your evidence is a success behavior, not a failure.

## The completion report template

```
GOAL (as framed): <one sentence>

CRITERIA & EVIDENCE:
1. <criterion> — VERIFIED: <exact command/observation and result>
2. <criterion> — VERIFIED: <...>
3. <criterion> — UNVERIFIED: <why, and what would verify it>

DEVIATIONS: <anything done differently than asked, and why>
ASSUMPTIONS CARRIED: <assumptions made and never confirmed>
RESIDUAL RISK / OUT OF SCOPE: <known gaps, ideas noted but not done>
```

Every "VERIFIED" line must contain an observation, not a paraphrase of effort. If any line says UNVERIFIED, the top-line summary must not say "done" — it says "done except X" or "complete pending verification of X."

## Failure modes this playbook exists to prevent

- **Gaming the criterion**: making the check pass instead of making the work correct (weakening a test, hardcoding the expected output, editing the spec to match the result). If you notice the check and the goal diverging, the goal wins and the divergence gets reported.
- **Verification theater**: running checks that cannot fail, checking only the happy path, or checking early steps but not the final artifact.
- **Confident summarization drift**: the final report claiming slightly more than the evidence supports ("all tests pass" when you ran one file's tests). Reports must be written *from* the evidence, sentence by sentence — not from the feeling of having finished.
- **Silent scope shrink**: quietly delivering a narrower thing than framed because the full thing got hard, without flagging the shrink. Renegotiate scope openly or report the gap.
