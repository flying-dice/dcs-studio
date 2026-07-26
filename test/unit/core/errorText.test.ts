import { describe, expect, it } from "vitest";
import { errorText } from "../../../src/core/domain/errorText";

// Three call sites put this string in front of a user: two presenters rendering
// a failed marketplace or install action, and the install swap's recovery
// message. What matters is that the non-Error case produces something readable
// rather than "[object Object]" in a dialog the user has to act on.

describe("errorText", () => {
  it("takes an Error's message, without the class name", () => {
    expect(errorText(new Error("7-Zip exited 2"))).toBe("7-Zip exited 2");
  });

  it("keeps the message of an Error subclass", () => {
    class HttpError extends Error {}
    expect(errorText(new HttpError("404 Not Found"))).toBe("404 Not Found");
  });

  it("renders a thrown string as itself", () => {
    // A rejected promise carrying a bare string is ordinary in JS libraries.
    expect(errorText("ENOENT")).toBe("ENOENT");
  });

  it("renders a thrown non-Error object rather than showing nothing useful", () => {
    expect(errorText({ code: "EPERM" })).toBe("[object Object]");
  });

  it("survives null and undefined", () => {
    expect(errorText(null)).toBe("null");
    expect(errorText(undefined)).toBe("undefined");
  });
});
