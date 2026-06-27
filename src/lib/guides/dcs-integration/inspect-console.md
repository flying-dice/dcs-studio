# Inspect console

The Inspect console is an interactive object explorer for the live sim. Evaluate any Lua expression against the running DCS — no breakpoint and no debug session needed — and drill into the result as an expandable tree. It is the quickest way to find out what a DCS API actually returns.

## Requirements

Inspect evaluates against the live sim over the bridge, so DCS must be running with the bridge connected — see the **Injecting the bridge** and **Managed Launch (DCS)** guides.

## Opening the console

In the tool rail along the bottom-left edge, click the **Inspect** icon. The empty state suggests a couple of starting points:

```
return Export.LoGetSelfData()
return _G
```

## Evaluating an expression

1. Type a Lua expression into the input at the bottom (return a value to explore it).
2. Press `Enter`, or click the return-arrow button, to evaluate it.
3. The expression and its result are added to the log. `Up`/`Down` in the input recall your previous expressions.

For each entry:

- A **table** result renders as an expandable tree — click a node to drill in; children load lazily, so even large tables stay responsive.
- A **scalar** result shows its value and type.
- An **error** is shown in red.

## Searching within results

The **search keys/values…** box at the top filters across the explored trees by key or value (results are sorted on the sim side), auto-expanding matching branches so hits surface without manual expanding. Clear it with the **✕** to see everything again.

## Persistence and clearing

Each result stays explorable until you clear — the sim keeps a persistent inspection registry behind every entry, so you can expand a tree you evaluated several queries ago. The **clear** button (trash icon, shown once there is at least one entry) empties the log and releases every inspection reference the sim was holding for you.

## Tips and gotchas

- **Return the value you want to see.** As in the examples, prefix with `return` so the expression yields a result to explore rather than just executing.
- **Inspect vs. Console.** The **Lua Console** logs the result of running a file or selection as formatted text; the Inspect console is built for *exploring* a value structurally, expanding tables node by node.
- **Inspect vs. the debugger.** Inspect runs against the live sim with no session. To evaluate inside a specific paused stack frame, use the Console in the **In-sim Lua Debugger** instead — it shares the same expandable-tree view.
