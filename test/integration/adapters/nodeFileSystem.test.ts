import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../../src/adapters/node/fs";
import { describeFileSystemPortContract } from "../../support/filesystemContract";
import { linkForSetup } from "../../support/linkCapability";
import { tmpRoot } from "../../support/tmpDir";

// The real adapter against a real temp tree — the fidelity that matters for a
// filesystem port, where the interesting behaviour is what node:fs actually
// does with a missing parent directory or a recursive remove.
//
// Running the shared contract here is what turns the in-memory fakes the core
// services are tested against into checked claims: if the adapter stopped
// creating parent directories on write, this fails even though every core test
// still passes against its fake.

// Every contract case asks for its own root, so `make()` — one temp dir per
// call, all of them removed when the test that asked for them ends.
const tmp = tmpRoot("dcs-fs-");

describeFileSystemPortContract("NodeFileSystem", () => new NodeFileSystem(), {
  makeRoot: () => tmp.make(),
  join: (...parts: string[]) => nodePath.join(...parts),
});

// A clause that is the ADAPTER'S alone, so it lives here rather than in the
// shared contract: `MemFileSystem` has no concept of a link, and holding it to
// an answer about one would be inventing behaviour rather than checking it.
describe("measuring a tree that contains a link", () => {
  it("does not walk through a link that points back at an ancestor", async () => {
    // The failure this prevents is not a wrong number, it is a hang: a junction
    // to a parent directory makes a naive recursion loop until the stack gives
    // out. `readdirSync(…, { withFileTypes: true })` reports the entry's OWN
    // type, so the link is never `isDirectory()` and the walk stops at it — the
    // reason the implementation cannot be "simplified" to `statSync`.
    const project = nodePath.join(tmp.make(), "project");
    nodeFs.mkdirSync(nodePath.join(project, "Scripts"), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(project, "Scripts", "mod.lua"), "12345");
    linkForSetup(project, nodePath.join(project, "Scripts", "loop"), "dir");

    const measured = await new NodeFileSystem().measure(project);

    // Completing at all is most of the assertion. The count is the rest: the
    // link counts as the one entry it is, not as the subtree behind it walked a
    // second time — which would be 3 files here, or no answer ever.
    expect(measured).toMatchObject({ directory: true, files: 2 });
    // Its size is deliberately not asserted: what `lstat` reports for a reparse
    // point is the platform's business (a junction on Windows, a symlink on the
    // Linux runner), and pinning it would be testing node, not this walk.
    expect(measured?.bytes).toBeGreaterThanOrEqual(5);
  });
});
