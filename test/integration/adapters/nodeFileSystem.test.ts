import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vitest";
import { NodeFileSystem } from "../../../src/adapters/node/fs";
import { describeFileSystemPortContract } from "../../support/filesystemContract";

// The real adapter against a real temp tree — the fidelity that matters for a
// filesystem port, where the interesting behaviour is what node:fs actually
// does with a missing parent directory or a recursive remove.
//
// Running the shared contract here is what turns the in-memory fakes the core
// services are tested against into checked claims: if the adapter stopped
// creating parent directories on write, this fails even though every core test
// still passes against its fake.

const roots: string[] = [];

describeFileSystemPortContract("NodeFileSystem", () => new NodeFileSystem(), {
  makeRoot: () => {
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "dcs-fs-"));
    roots.push(dir);
    return dir;
  },
  join: (...parts: string[]) => path.join(...parts),
});

afterAll(() => {
  for (const dir of roots) nodeFs.rmSync(dir, { recursive: true, force: true });
});
