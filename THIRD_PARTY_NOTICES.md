# Third-Party Notices

DCS Studio is distributed under the MIT License (see [`LICENSE`](LICENSE)). It
also bundles or links the third-party components listed below. Their licenses
and copyright notices are reproduced here as required for redistribution.

Components pulled as ordinary Cargo/npm dependencies (resolved at build time
from their registries) are not enumerated here; this file covers code that ships
**vendored in this repository** or **statically compiled into the binary**.

---

## Lua 5.1 (5.1.5)

Vendored at `crates/dcs-bridge/lua5.1/` (import library + headers); the in-DCS
bridge (`dcs_studio.dll`) links against the DCS-provided Lua 5.1 runtime through
it. Lua is distributed under the MIT License.

```
Copyright © 1994–2012 Lua.org, PUC-Rio.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

See <https://www.lua.org/license.html>.

---

## SQLite

Statically compiled into the binary via `rusqlite` with its `bundled` feature
(vendored SQLite C amalgamation). SQLite is in the **public domain** and carries
no copyright; no attribution is required. Noted here for provenance only.

See <https://www.sqlite.org/copyright.html>.
