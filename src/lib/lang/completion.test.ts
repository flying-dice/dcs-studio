// Unit coverage for the completion mapping (completion.ts) — the load-bearing
// half of the autocomplete slice: engine `CompletionItem` → CodeMirror
// `Completion`, and the provider-backed source's trigger/`from`/decline logic.
// No DOM, no editor: a faked `CompletionContext` drives the source directly.

import { describe, it, expect } from "vitest";
import type { CompletionContext } from "@codemirror/autocomplete";

import { toCmCompletion, luaCompletionSource } from "./completion";
import type { CompletionItem, LanguageProvider } from "./provider";

/** A completion item with all six fields, overridable per case. */
function item(over: Partial<CompletionItem>): CompletionItem {
  return {
    label: "x",
    kind: "variable",
    detail: "",
    documentation: "",
    insertText: "x",
    insertTextFormat: "plaintext",
    ...over,
  };
}

/** A provider whose `complete` returns a fixed candidate set. */
function fakeProvider(items: CompletionItem[]): LanguageProvider {
  return { complete: () => Promise.resolve(items) } as unknown as LanguageProvider;
}

type Match = { from: number; to: number; text: string } | null;

/** A minimal `CompletionContext`. `matchBefore` returns `member` for the
 * member-access regex (it contains an escaped dot) and `word` otherwise — the
 * two patterns the source probes. */
function ctx(opts: {
  pos: number;
  explicit?: boolean;
  word?: Match;
  member?: Match;
}): CompletionContext {
  return {
    pos: opts.pos,
    explicit: opts.explicit ?? false,
    matchBefore: (re: RegExp): Match =>
      re.source.includes("\\.") ? (opts.member ?? null) : (opts.word ?? null),
  } as unknown as CompletionContext;
}

describe("toCmCompletion", () => {
  it("maps a field to a property type and the rest to like-named types", () => {
    expect(toCmCompletion(item({ kind: "function" })).type).toBe("function");
    expect(toCmCompletion(item({ kind: "field" })).type).toBe("property");
    expect(toCmCompletion(item({ kind: "variable" })).type).toBe("variable");
    // An unknown kind from another hosted server falls back to variable.
    expect(toCmCompletion(item({ kind: "anything-else" })).type).toBe("variable");
  });

  it("inserts a plain field's insertText and surfaces its doc run as info", () => {
    const c = toCmCompletion(
      item({ label: "speed", kind: "field", detail: "number", insertText: "speed" }),
    );
    expect(c.label).toBe("speed");
    expect(c.type).toBe("property");
    expect(c.detail).toBe("number");
    expect(c.apply).toBe("speed");
  });

  it("leaves info undefined when there is no doc run", () => {
    expect(toCmCompletion(item({ documentation: "" })).info).toBeUndefined();
    expect(toCmCompletion(item({ documentation: "Doc" })).info).toBe("Doc");
  });

  it("applies a function through a snippet (a function applier, not a string)", () => {
    const c = toCmCompletion(
      item({
        label: "spawnUnit",
        kind: "function",
        detail: "function(country, name)",
        insertText: "spawnUnit(${1:country}, ${2:name})",
        insertTextFormat: "snippet",
      }),
    );
    expect(c.label).toBe("spawnUnit");
    expect(c.type).toBe("function");
    expect(c.detail).toBe("function(country, name)");
    expect(typeof c.apply).toBe("function");
  });

  it("falls back to a plain insert when a snippet body is empty", () => {
    const c = toCmCompletion(item({ insertText: "", insertTextFormat: "snippet", label: "x" }));
    expect(c.apply).toBe("x");
  });
});

describe("luaCompletionSource", () => {
  const one = [item({ label: "speed", kind: "field", insertText: "speed" })];

  it("declines when not explicit, with no word and no member access", async () => {
    const source = luaCompletionSource(fakeProvider(one), "main.lua");
    expect(await source(ctx({ pos: 0, word: null, member: null }))).toBeNull();
  });

  it("queries on an explicit invoke even with no word or member (from = pos)", async () => {
    const source = luaCompletionSource(fakeProvider(one), "main.lua");
    const result = await source(ctx({ pos: 3, explicit: true, word: null, member: null }));
    if (!result) throw new Error("expected a completion result");
    expect(result.from).toBe(3);
    expect(result.options).toHaveLength(1);
  });

  it("completes a member access at the cursor (from = pos when no word)", async () => {
    const source = luaCompletionSource(fakeProvider(one), "main.lua");
    const result = await source(
      ctx({ pos: 4, member: { from: 4, to: 4, text: "." }, word: null }),
    );
    if (!result) throw new Error("expected a completion result");
    expect(result.from).toBe(4);
    expect(result.options).toHaveLength(1);
    expect(result.options[0].label).toBe("speed");
  });

  it("anchors `from` at the start of an identifier prefix", async () => {
    const source = luaCompletionSource(fakeProvider(one), "main.lua");
    const result = await source(
      ctx({ pos: 7, word: { from: 4, to: 7, text: "spe" }, member: null }),
    );
    if (!result) throw new Error("expected a completion result");
    expect(result.from).toBe(4);
  });

  it("returns null when the engine offers nothing", async () => {
    const source = luaCompletionSource(fakeProvider([]), "main.lua");
    const result = await source(ctx({ pos: 7, word: { from: 4, to: 7, text: "spe" } }));
    expect(result).toBeNull();
  });
});
