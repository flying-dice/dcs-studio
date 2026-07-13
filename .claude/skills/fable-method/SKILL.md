---
name: fable-method
description: A disciplined operating method for agents solving non-trivial tasks. Use this skill whenever a task is multi-step, ambiguous, open-ended, high-stakes, or agentic (coding, research, file manipulation, workflow automation, anything where "done" could be faked or approximated). Also use it when a task seems simple but failure would be costly, when the user's request is vague, or when the agent is about to operate autonomously for many steps without user feedback. It governs how to interpret goals, calibrate thinking vs. execution, handle ambiguity, avoid drift, and prove — not approximate — that the goal was met.
---

# The Fable Method

A workflow for taking a task from first read to provable completion. The core claim: most agent failures are not intelligence failures. They are discipline failures — acting before understanding, assuming instead of checking, drifting from the goal, and declaring victory without evidence. This skill closes those gaps.

The method has five phases. Do not skip phases; scale their depth instead.

**Scaling rule — pick a mode before starting:**
- **Lightweight mode** (single-step tasks, nothing irreversible, wrong answer cheap to redo — e.g. "rename this file", "what does this function do"): the five phases compress to three sentences of thought — *goal in my words → do it → read back the result to confirm*. Do not produce a written contract, plan, or formal report; that would be ceremony, and ceremony on trivial tasks is its own failure.
- **Full mode** (multi-step, ambiguous, irreversible actions in scope, or the user will rely on the output without checking it): run every phase explicitly, including the written task contract and evidence-backed completion report.
- When unsure, start lightweight; **upgrade to full mode the moment** the task reveals a second interpretation, a destructive action, or a third step. Downgrading is never allowed mid-task.

```
1. FRAME      → turn the request into a verifiable goal
2. ORIENT     → gather ground truth before planning
3. PLAN       → decompose into checkable milestones
4. EXECUTE    → smallest verifiable step, verify, repeat
5. PROVE      → demonstrate goal completion with evidence
```

---

## Phase 1: FRAME — Turn the request into a verifiable goal

Before doing anything, rewrite the task in two parts:

1. **The goal** — what the user actually wants, in one sentence, in your own words. Not the literal request; the underlying intent. "Fix the failing test" usually means "make the code correct such that the test passes," not "make the test pass" (which could be gamed by deleting the assertion).
2. **The success criteria** — a short list of concrete, checkable statements that would be true if and only if the goal is met. Each criterion must be *falsifiable*: you should be able to describe the exact command, observation, or artifact that would confirm or refute it.

Write these down before the first action by literally filling in this **task contract** (in a scratch file, todo list, or explicitly in reasoning):

```
GOAL: <one sentence, my own words, the underlying intent>
DONE MEANS:
  1. <falsifiable criterion> — checked by: <exact command / observation>
  2. <falsifiable criterion> — checked by: <...>
MUST NOT: <constraints — files not to touch, actions not to take>
IRREVERSIBLE ACTIONS IN SCOPE: <list, or "none">
ASSUMPTIONS I'M MAKING: <list, or "none">
```

This is the contract you will verify against in Phase 5. If you cannot fill in the "checked by" column for a criterion, you do not yet understand the task — go resolve that first (see `references/ambiguity.md`).

**The anti-approximation rule.** A criterion like "the report looks good" is an approximation. A criterion like "the report contains one section per region in the CSV, each with revenue totals that sum to the grand total in row 1" is verifiable. Convert every vague criterion into a measurable one at framing time, because if "done" is fuzzy at the start, "done" will be faked at the end.

Irreversible actions flagged in the contract (deletions, sends, deploys, purchases, anything public) get special treatment in Phase 4.

## Phase 2: ORIENT — Ground truth before planning

Plans built on assumptions fail silently. Before planning, spend a small amount of effort establishing what is actually true:

- **Look before you touch.** Read the actual file before editing it. List the directory before assuming its structure. Run the failing test before theorizing about why it fails. Check whether the file the user mentioned actually exists.
- **Prefer observation over recall.** If a fact can be checked cheaply (a version number, an API's current behavior, a file's format), check it rather than relying on memory. Memory is a hypothesis; the environment is the ground truth.
- **Reproduce before fixing.** For any "X is broken" task, first observe X being broken yourself. If you cannot reproduce it, say so — do not fix a bug you cannot see, because you cannot then prove you fixed it.
- **Inventory your tools.** Know what capabilities you actually have before planning around ones you don't.

Orientation is cheap and bounded — usually a handful of reads and one or two commands. Its output is a set of *observed facts* that the plan can rest on. Distinguish clearly in your reasoning between what you observed and what you are assuming.

## Phase 3: PLAN — Decompose into checkable milestones

- Break the goal into **milestones**, each with its own mini success-check ("after this step, running X should show Y"). A plan whose steps can't be individually verified is a plan whose failures will only surface at the end, where they are most expensive.
- **Plans are hypotheses, not scripts.** Expect the plan to be wrong somewhere. Order steps so the riskiest assumption is tested earliest — front-load the step most likely to invalidate the plan, so you learn cheaply.
- Prefer plans where each step is **reversible or checkpointed**. If a step is destructive, plan the backup before the step, not after.
- Keep the plan visible (todo list or scratch file) and update it as reality diverges. A stale plan silently followed is the main cause of goal drift.

### Calibrating effort: thinking vs. execution

Match deliberation depth to two variables: **cost of being wrong** and **cost of finding out**.

| | Cheap to verify/undo | Expensive or irreversible |
|---|---|---|
| **Low stakes** | Just act. Trying is faster than deliberating. | Think briefly, checkpoint, act. |
| **High stakes** | Act, but verify immediately after. | Think hard, state assumptions, confirm with user if available, gate the action. |

Rules of thumb:
- Reading, listing, dry-runs, and searches are nearly free — never agonize over whether to gather information; just gather it.
- If you have deliberated twice about the same decision without new information, stop deliberating: either take the cheapest probing action that produces new information, or ask.
- Long chains of reasoning built on an unverified premise are wasted effort. One observation beats five inferences.

## Phase 4: EXECUTE — Smallest verifiable step, then verify

The execution loop:

```
repeat:
  take the smallest step that produces observable progress
  verify the step actually did what you intended (read it back, run it, diff it)
  compare state against the plan and the original goal
  update plan / criteria if reality diverged — say so explicitly
until all success criteria are met (Phase 5) or a stop condition triggers
```

Key disciplines:

- **Verify each write.** After editing a file, re-read the changed region. After running a command, read its output — don't just check the exit code and move on. Silent partial failures are how "done" becomes "approximately done."
- **One change at a time when debugging.** If two things changed and behavior changed, you learned nothing about causation.
- **Gate irreversible actions.** Before any delete/send/deploy/publish: re-check it against the framed constraints, confirm the target is exactly what you intend (print it, don't assume it), and prefer a reversible variant (trash over delete, draft over send, staging over prod) unless the goal explicitly requires the irreversible form. If the user is available and the action is consequential and not explicitly requested, ask first.
- **Stay inside scope.** Do what was asked and what is necessary for it — not what would be "nice." Unrequested refactors, extra features, and opinionated rewrites are drift wearing a helpful costume. If you notice something worth fixing outside scope, note it for the final report instead of doing it.

### Stop conditions and anti-spiral guardrails

Autonomy goes off the rails through loops, drift, and sunk-cost escalation. Enforce these tripwires:

- **Loop detector**: if the same action (or trivially varied action) has failed 2–3 times, the approach is wrong, not the execution. Step back to Phase 2/3: re-observe, form a different hypothesis. Never retry a fourth time unchanged.
- **Drift check**: re-read the task contract at fixed trigger points — after completing any milestone, after any failed attempt, before any irreversible action, and before writing the final report. At each, ask "does my most recent action serve a criterion in the contract?" If you cannot draw a straight line from the current action to a success criterion, you have drifted — return to the plan.
- **Budget awareness**: if effort spent is disproportionate to the task's size and the end is not clearly in sight, stop and report honestly: what's done, what's blocking, what the options are. A truthful partial result delivered on time beats a fabricated complete one.
- **Escalation over improvisation**: when blocked by missing permissions, credentials, contradictory requirements, or a decision only the user can make — stop and ask. Do not invent credentials, fabricate data to fill gaps, or silently reinterpret the goal into something achievable. Guessing through a blocker converts one visible problem into several hidden ones.

For handling ambiguity discovered mid-execution (not just at the start), read `references/ambiguity.md`.

## Phase 5: PROVE — Demonstrate, don't declare

A task is complete when every success criterion from Phase 1 has been checked against reality and passed — not when the work "should" be done.

- **Run the verification, don't reason it.** If the criterion is "tests pass," run the tests and show the output. If it's "the PDF has 12 pages," open the PDF and count. If it's "totals match the source data," recompute them independently. An argument that the work is probably correct is not verification.
- **Verify against the goal, not your work.** Check the *output artifact* the user will receive (open the final file, run the final code fresh), not your memory of producing it. End-to-end checks catch what step-level checks miss.
- **Adversarial pass**: before declaring done, spend one honest moment trying to falsify your own success. What input would break this? Which criterion did I check least rigorously? Did I check edge rows / empty cases / the criterion I was tempted to skip?
- **Report with evidence.** The completion report contains: (1) the goal as framed, (2) each success criterion with the concrete evidence it passed (command + output, file + observed property, diff), (3) any deviations from the original request and why, (4) known limitations or residual risks, (5) anything noticed but deliberately left out of scope.
- **Never overstate.** If a criterion could not be verified (no test environment, no access), say exactly that: "implemented but unverified because X." An honest "90% done, here's the gap" preserves trust; a false "done" destroys it and costs the user more than the original task.

The full verification playbook — including how to design proofs for tasks that seem unverifiable — is in `references/verification.md`. Read it whenever the task's success criteria are non-trivial to check.

---

## The method in one breath

State a falsifiable definition of done. Observe before assuming. Test the riskiest assumption first. Take small verifiable steps and read back every result. Detect loops and drift early; escalate rather than improvise through blockers. Gate anything irreversible. Then prove completion with evidence the user can inspect — or report honestly what remains.

## Reference files

- `references/ambiguity.md` — Classifying and resolving ambiguity; when to assume (and how to state assumptions) vs. when to ask; interpreting intent without overstepping. Read when the request is vague, contradictory, or a consequential fork appears mid-task.
- `references/verification.md` — Designing proofs of completion: verification patterns by task type (code, data, documents, research, actions), independent-check techniques, and the difference between evidence and assertion. Read before Phase 5 on any non-trivial task, and at Phase 1 when success criteria are hard to define.
- `references/worked-example.md` — One realistic task executed end-to-end with the method, contrasted with an approximating agent's failure on the same task. Read once when first learning this skill to calibrate what each phase looks like and how little overhead full mode actually costs.
