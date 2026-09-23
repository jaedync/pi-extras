# Computer Use attribution

The `computer_use({ code })` interface, its method list and the worker-based
script runner follow https://github.com/tmustier/codex-computer-use-mcp, MIT,
Copyright (c) 2026 Thomas Mustier. The launchd transport, direct MCP client and
session handling here are new; the code was written for this package.

# Parser research attribution

Selector vocabulary and grouped-result extraction were informed by:
- https://github.com/mjakl/pi-kagi-search (deprecated), MIT, Copyright (c) 2026 Michael Jakl.
- https://github.com/czottmann/kagi-ken, MIT, Copyright (c) 2025 Carlo Zottmann.

The HTTP safety, bounded client, queue/cache and tests here are new. No upstream credential persistence/login UI was reused. `node-html-parser` 7.0.2 is a locked runtime dependency with its own license in node_modules.

## MIT License notice for the referenced implementations

Copyright (c) 2026 Thomas Mustier
Copyright (c) 2026 Michael Jakl
Copyright (c) 2025 Carlo Zottmann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
