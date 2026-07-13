# Worked Example: The Method End-to-End

A single realistic task, executed twice — once by an agent approximating, once by an agent following the method. Read this to calibrate what each phase looks like in practice, and how small the overhead actually is.

**The task**: *"Our monthly sales report script is broken — it's showing the wrong totals for the West region. Fix it and regenerate the June report."*

---

## How the approximating agent fails

Opens `report.py`, spots a line that looks suspicious (`region_df = df[df.region == 'west']` — lowercase!), "fixes" it to `'West'`, reruns the script, sees a PDF get generated without errors, and reports: *"Fixed a case-sensitivity bug in the region filter and regenerated the June report. The totals should now be correct."*

What actually happened: the data contains both `'West'` and `'WEST'` rows, so the totals are still wrong — just differently wrong. The agent never observed the bug, never defined what "correct" meant, and its evidence was "the script ran," which is not the criterion. The word "should" in the final report was the confession.

## How the method-following agent succeeds

### Phase 1 — Frame

```
GOAL: June report shows correct West-region totals (code fixed, not numbers patched).
DONE MEANS:
  1. West totals in the regenerated report equal totals computed
     independently from the raw June data — checked by: separate
     recomputation (pandas one-liner on the raw CSV) matching the PDF figure.
  2. Other regions' totals unchanged from their (correct) current values —
     checked by: diff of all region totals before/after the fix.
  3. Report regenerates without errors — checked by: exit code + PDF opens.
MUST NOT: alter the raw data; change report format.
IRREVERSIBLE ACTIONS: none (report file is regenerable).
ASSUMPTIONS: "wrong totals" means understated/overstated vs. raw data,
  not a formatting complaint. (Stated; cheap to correct if wrong.)
```

Note criterion 1: correctness is defined against an *independent* computation, not against "the script runs."

### Phase 2 — Orient

Reproduce before fixing: run the current script, note West = $412,000. Independently recompute from the raw CSV: true total = $487,500. Bug confirmed and *quantified* — the agent now knows exactly what number the fix must produce. Then inspect the data: `df.region.unique()` → `['North', 'South', 'East', 'West', 'WEST', 'west ']`. Three variants, one with trailing whitespace. This single observation invalidates the "obvious" one-line fix before it's written.

### Phase 3 — Plan

1. Normalize region values (`strip().title()`) at load time — fixes all variants, not one. *Riskiest assumption tested first*: confirm normalization maps every unique value to a canonical region before touching the report logic.
2. Rerun report.
3. Verify per contract.

### Phase 4 — Execute

Makes the one edit, **re-reads the changed lines**, reruns. Mid-execution drift temptation appears: the script also has an unrelated deprecated-pandas warning. Method says *note it, don't fix it* — it goes in the final report's out-of-scope list instead of expanding the diff.

### Phase 5 — Prove

- Criterion 1: report now shows West = $487,500; independent recomputation = $487,500. ✔ (Two different computation paths agree — independent check.)
- Criterion 2: before/after diff of all totals — only West changed. ✔ (Catches regressions the fix might have caused elsewhere.)
- Criterion 3: exit 0; PDF opened, June date and all four regions present. ✔ (End-to-end: the artifact itself, not the log.)
- Adversarial pass: reran on May's data too — May totals unchanged, confirming the normalization didn't disturb clean months.

### The report

```
GOAL (as framed): June report shows correct West totals via a code fix.
CRITERIA & EVIDENCE:
1. West total correct — VERIFIED: report shows $487,500; independent
   pandas recomputation from raw CSV gives $487,500.
2. Other regions untouched — VERIFIED: before/after diff — only West changed.
3. Clean regeneration — VERIFIED: exit 0; regenerated PDF opened and inspected.
DEVIATIONS: fixed by normalizing region strings at load ('West'/'WEST'/'west ')
  rather than editing the filter — the filter was a symptom, not the cause.
ASSUMPTIONS CARRIED: "wrong totals" = numeric error vs. raw data (confirmed by repro).
RESIDUAL RISK / OUT OF SCOPE: deprecated pandas warning in report.py noted,
  not fixed; upstream source producing inconsistent region strings not investigated.
```

---

## What to notice

- The entire overhead of the method here was roughly **four extra commands and one scratch block** — reproduction, unique-values check, independent recomputation, before/after diff. That tiny cost is what separated a real fix from a plausible-sounding wrong one.
- The independent recomputation in Phase 2 did double duty: it proved the bug existed *and* pre-computed the exact number Phase 5 had to match. Good orientation makes verification nearly free.
- Every VERIFIED line names an observation. The approximating agent's report contained the word "should"; this one contains none.
