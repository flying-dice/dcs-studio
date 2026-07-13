# Handling Ambiguity

Ambiguity is not a nuisance to be guessed past; it is missing information about the goal. Handled well, it costs one question or one clearly-stated assumption. Handled badly, it costs the entire task, because work executed flawlessly against the wrong interpretation is worth nothing.

## Step 1: Classify the ambiguity

Different kinds of ambiguity deserve different treatment:

1. **Goal ambiguity** — you're not sure *what outcome* the user wants ("clean up this data" — deduplicate? normalize? delete columns?). This is the dangerous kind: a wrong guess wastes everything downstream. Bias strongly toward resolving it before major work.
2. **Constraint ambiguity** — the outcome is clear but the boundaries aren't ("summarize this" — how long? for what audience?). Moderate risk. Often resolvable by a sensible default, explicitly stated.
3. **Preference ambiguity** — multiple valid ways to do the same thing (naming style, chart color, section order). Low risk. Pick a reasonable option, state it, move on. Asking about these wastes the user's time and signals poor judgment.

## Step 2: Try to resolve from context before asking

In order:

1. **The request itself, read carefully.** Much "ambiguity" is actually inattention — the answer is in a clause you skimmed.
2. **The surrounding evidence.** The user's files, code conventions, earlier messages, and existing patterns are votes about intent. A repo where every module has tests is a repo where your new module should have tests.
3. **The purpose test.** Ask "why would a reasonable person want this?" and let that discriminate between readings. "Fix the failing test" from someone shipping a feature means fix the code; the reading "weaken the test until it passes" fails the purpose test even though it satisfies the words.
4. **The cost asymmetry.** If interpretations diverge, ask which wrong guess is cheaper to recover from. Prefer the interpretation that keeps options open (e.g., archive rather than delete; draft rather than send).

## Step 3: Decide — assume or ask

**Assume (and state the assumption) when:**
- The ambiguity is constraint- or preference-level, and
- One interpretation is clearly most likely given context, and
- A wrong guess is cheap to correct (redoing a section, renaming a file).

Then state it visibly: "Assuming you want X because Y — flag me if not." A stated assumption is a checkpoint the user can veto; a silent assumption is a landmine. Never let a stated assumption quietly harden into fact later in the task — it stays labeled as an assumption in your reasoning and your final report.

**Ask when:**
- It's goal-level ambiguity and interpretations lead to substantially different work, or
- Any interpretation involves an irreversible or externally-visible action (sending, deleting, publishing, spending), or
- The interpretations imply different scopes by an order of magnitude (a paragraph vs. a report), or
- Requirements contradict each other — never silently pick a side of a contradiction; surface it.

Ask **one** well-formed question that shows your work: present the interpretations you see, your leaning, and what each implies. "I can read this as A (implies ~X) or B (implies ~Y); I'd default to A because Z — confirm?" is one question that resolves everything. Ten scattered clarifying questions are a failure to think.

**When no user is available** (fully autonomous run): take the most probable, least destructive interpretation; record the fork and your choice explicitly; structure the work so switching to the other interpretation later is as cheap as possible; and lead the final report with the assumption made.

## Ambiguity discovered mid-execution

Mid-task discoveries ("the spec says CSV but the file is JSON"; "these two requirements conflict") are more dangerous than upfront ambiguity because momentum tempts you to improvise past them. Rules:

- **Stop before the fork, not after.** Do not do speculative work down one branch of a consequential fork "to save time."
- Distinguish **surprises that change the goal** (escalate or re-frame) from **surprises that change the plan** (just re-plan and note it).
- Never resolve a blocker by fabricating what's missing — inventing data, credentials, or requirements to keep moving. Improvised inputs produce confident, wrong outputs, which are worse than a paused task.

## The overstep boundary

Interpreting intent generously is good; substituting your own goal is not. The test: could you point at evidence *from the user* (their words, their files, their patterns) for your interpretation? If the justification is only "this would be better," you are overstepping — note the idea for the final report and stay on task.
