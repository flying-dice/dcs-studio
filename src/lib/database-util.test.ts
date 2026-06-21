import { describe, it, expect } from "vitest";

import { quoteIdent, defaultQuery, resultSummary, messageOf } from "./database-util";

describe("quoteIdent", () => {
  it("double-quotes a plain identifier", () => {
    expect(quoteIdent("events")).toBe('"events"');
  });

  it("escapes embedded double-quotes so the FROM target stays valid", () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });

  it("survives names with spaces and punctuation", () => {
    expect(quoteIdent("unit log 2026")).toBe('"unit log 2026"');
  });
});

describe("defaultQuery", () => {
  it("selects the first 100 rows of a quoted table", () => {
    expect(defaultQuery("events")).toBe('SELECT * FROM "events" LIMIT 100');
  });

  it("quotes a table name that would otherwise be invalid SQL", () => {
    expect(defaultQuery("per frame")).toBe('SELECT * FROM "per frame" LIMIT 100');
  });
});

describe("resultSummary", () => {
  it("pluralises rows", () => {
    expect(resultSummary({ rowCount: 3, capped: false })).toBe("showing 3 rows");
  });

  it("singularises a single row", () => {
    expect(resultSummary({ rowCount: 1, capped: false })).toBe("showing 1 row");
  });

  it("flags a capped result", () => {
    expect(resultSummary({ rowCount: 1000, capped: true })).toBe("showing 1000 rows (capped)");
  });

  it("handles an empty result", () => {
    expect(resultSummary({ rowCount: 0, capped: false })).toBe("showing 0 rows");
  });
});

describe("messageOf", () => {
  it("unwraps a serialised DbError", () => {
    expect(messageOf({ message: "path escapes the DCS write root: /etc/x" })).toBe(
      "path escapes the DCS write root: /etc/x",
    );
  });

  it("reads an Error's message", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
  });

  it("stringifies anything else", () => {
    expect(messageOf("plain string")).toBe("plain string");
  });
});
