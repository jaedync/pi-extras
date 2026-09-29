import assert from "node:assert/strict";
import test from "node:test";
import { compactSnapshot } from "../lib/windows-use/snapshot.ts";

/** Windows-MCP's snapshot text as it arrives: a half-dedented header, then a box-drawn tree. */
const RAW = [
	"",
	"    Cursor Position: (10, 20)",
	"Screenshot Size: (800,600)",
	"Visible Displays: 0:\\\\.\\DISPLAY1 (0,0,800,600) primary",
	"Screenshot Backend: pillow",
	"",
	"    Active Desktop:",
	"    Name",
	"---------",
	"Desktop 1",
	"",
	"    All Desktops:",
	"    Name",
	"---------",
	"Desktop 1",
	"",
	"    Focused Window:",
	"    Name                 Depth  Status    Width    Height    Handle",
	"-----------------  -------  ------  -------  --------  --------",
	"Untitled - Editor        0  Normal      640       480    123456",
	"",
	"    Opened Windows:",
	"    Name          Depth  Status       Width    Height    Handle",
	"----------  -------  ---------  -------  --------  --------",
	"Mail              1  Minimized      800       600    654321",
	"Calculator        2  Normal         320       500    111111",
	"",
	"",
	"    UI Tree:",
	"    desktop",
	"    ├── window \"Untitled - Editor\"",
	"    │   ├── tool bar \"Menu\"",
	"    │   │   ├── (40,30) button \"File\"  [action: click]",
	"    │   │   └── (80,30) button \"Edit\"  [action: click]  [toggle:off]",
	"    │   └── (400,300) edit \"Text\"  [action: fill]  [focused]  [value:\"\u200e9/\u200e28 notes\"]",
	"    └── window \"Taskbar\"",
	"        └── (20,590) button \"Start\"  [action: click]",
].join("\n");

test("snapshot text keeps what the agent acts on and drops layout and single-desktop noise", () => {
	assert.equal(compactSnapshot(RAW), [
		"Cursor Position: (10, 20)",
		"Screenshot Size: (800,600)",
		"",
		"Focused Window:",
		"- Untitled - Editor (Normal, 640x480)",
		"",
		"Opened Windows:",
		"- Mail (Minimized, 800x600)",
		"- Calculator (Normal, 320x500)",
		"",
		"UI Tree:",
		"window \"Untitled - Editor\"",
		"  tool bar \"Menu\"",
		"    (40,30) button \"File\"",
		"    (80,30) button \"Edit\" [toggle:off]",
		"  (400,300) edit \"Text\" [action: fill] [focused] [value:\"9/28 notes\"]",
		"window \"Taskbar\"",
		"  (20,590) button \"Start\"",
	].join("\n"));
});

test("names and values that span lines stay on their element's line, and empty windows go", () => {
	const raw = [
		"    UI Tree:",
		"    desktop",
		"    ├── window \"\"",
		"    ├── window \"Editor\"",
		"    │   ├── (5,5) word \"pi\"  [action: click]",
		"    │   └── (40,50) document \"Text\"  [action: scroll]  [value:\"one\rtwo\"]",
		"    ├── window \"\"",
		"    └── window \"Taskbar\"",
		"        ├── (833,744) button \"OneDrive",
		"Not signed in\"  [action: click]",
		"        └── (976,744) button \"Clock 6:07 PM",
		"9/28/2026\"  [action: click]",
	].join("\n");
	assert.equal(compactSnapshot(raw), [
		"",
		"",
		"UI Tree:",
		"window \"Editor\"",
		"  (5,5) word \"pi\"",
		"  (40,50) document \"Text\" [action: scroll] [value:\"one\\ntwo\"]",
		"window \"Taskbar\"",
		"  (833,744) button \"OneDrive\\nNot signed in\"",
		"  (976,744) button \"Clock 6:07 PM\\n9/28/2026\"",
	].join("\n").replace(/^\n\n/, ""));
});

test("a screenshot's header is compacted too; its UI Tree note is not a tree", () => {
	const raw = [
		"",
		"    Cursor Position: (512, 81)",
		"Screenshot Size: (1024,768)",
		"Visible Displays: 0:\\\\.\\DISPLAY1 (0,0,1024,768) primary",
		"Screenshot Backend: pillow",
		"UI Tree: Skipped for fast screenshot-only capture. Call Snapshot when you need interactive or scrollable elements.",
		"",
		"    Active Desktop:",
		"    Name",
		"---------",
		"Desktop 1",
		"",
		"    All Desktops:",
		"    Name",
		"---------",
		"Desktop 1",
		"",
		"    Focused Window:",
		"    No active window found",
		"",
		"    Opened Windows:",
		"    No windows found",
		"    ",
	].join("\n");
	assert.equal(compactSnapshot(raw), "Cursor Position: (512, 81)\nScreenshot Size: (1024,768)\n\nFocused Window:\nNo active window found\n\nOpened Windows:\nNo windows found");
});

test("several desktops or displays are kept, and text it doesn't recognize passes through", () => {
	const many = RAW.replace("    All Desktops:\n    Name\n---------\nDesktop 1", "    All Desktops:\n    Name\n---------\nDesktop 1\nDesktop 2")
		.replace("primary\n", "primary; 1:\\\\.\\DISPLAY2 (800,0,1600,600)\n");
	const out = compactSnapshot(many);
	assert.match(out, /Active Desktop:\nName\n---------\nDesktop 1\n\nAll Desktops:\nName\n---------\nDesktop 1\nDesktop 2/);
	assert.match(out, /Visible Displays: .*DISPLAY2/);
	assert.equal(compactSnapshot("something new\n  indented"), "something new\n  indented");
	const noWindows = compactSnapshot(RAW.replace(/ {4}Opened Windows:[\s\S]*?\n\n\n/, "    Opened Windows:\n    No windows found\n\n\n"));
	assert.match(noWindows, /Opened Windows:\nNo windows found\n\nUI Tree:/);
	assert.match(compactSnapshot(`${RAW}\n\nThe tree was cut at 500 elements.`), /"Start"\n\nThe tree was cut at 500 elements\.$/);
});
