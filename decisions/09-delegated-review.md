---
status: Accepted
date: 2026-07-30
---
# Decision 09 — Delegated review

This record describes a practice that is **already running**, not one being
proposed. It is written down because it was established in-session and would
otherwise live only in a transcript.

## Context

Work on this repo is done by agents at a pace that outruns a human reviewing every
diff. The owner is the only human in the loop, and the bottleneck was becoming the
review step rather than the work.

On 2026-07-30 the owner delegated review sign-off in-session, in as many words:
**"You manage reviews."** That did not delete the review step; it moved who
performs it. The failure mode it opens is obvious and is the thing this record
exists to close off: an agent that both writes the change and declares it good has
reviewed nothing.

## Decision

**Review is delegated, and it is separate from implementation.**

- **An implementing agent never signs off its own work.** No exceptions for small
  changes, and none for changes the implementer is confident about — confidence is
  what a review is for.
- **A distinct review precedes every `review → done` move on the board.** The move
  is not a formality applied to finished work; it is what the review authorises.
- The review has three parts, and all three are performed:
  1. **The lead reads the diff.** Actually reads it, against what the card asked
     for.
  2. **Multi-dimension clean-code audit agents** run over the change, each on its
     own principle rather than one agent with a checklist.
  3. **Gates and CI stand as evidence** — the coverage layers, the boundary test,
     lint. Green gates are not the review, but a review cannot conclude without
     them.
- **Sign-off is journalled**, as a `claude-lead` entry that cites its evidence.
  "Reviewed, looks good" is not a sign-off; the entry names what was read, what
  the audits returned and which gates were green.
- **Findings above severity 0.5 block the move.** Findings at the threshold are
  fixed when fixing them is cheap and recorded when it is not — the point of a
  threshold is that it decides, so a finding is never left to be re-argued later.

## Consequences

- Review capacity scales with the work, which is what made the delegation
  necessary; the separation is what keeps that from being self-certification.
- The board's `review` column means something specific — work waiting on a review
  that has not happened yet, not work waiting on a rubber stamp.
- The journal is the audit trail. Anyone asking "who accepted this, and on what
  evidence?" reads the `claude-lead` entry rather than reconstructing it from
  commits.
- The owner retains the authority and can review anything directly. This is
  delegation of the routine, not a transfer of ownership — and it is revocable by
  the same means it was granted.
