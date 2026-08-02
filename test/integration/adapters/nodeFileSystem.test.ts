import * as path from "node:path";
import { NodeFileSystem } from "../../../src/adapters/node/fs";
import { describeFileSystemPortContract } from "../../support/filesystemContract";
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
  join: (...parts: string[]) => path.join(...parts),
});
