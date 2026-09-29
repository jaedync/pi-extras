import assert from "node:assert/strict";
import test from "node:test";
import { pickApp } from "../lib/windows-use/apps.ts";

const START = ["Print Management", "Operations Control Management Console", "Microsoft Edge", "Notepad", "Paint", "Paint 3D", "Services", "System Information", "Windows PowerShell", "Windows PowerShell ISE"];

test("an app's exact Start menu name, in any case, is launched as listed", () => {
	assert.equal(pickApp("notepad", START), "Notepad");
	assert.equal(pickApp("Paint", START), "Paint");
	assert.equal(pickApp("windows powershell", START), "Windows PowerShell");
});

test("words that pick out one app are enough", () => {
	assert.equal(pickApp("Edge", START), "Microsoft Edge");
	assert.equal(pickApp("control management", START), "Operations Control Management Console");
});

test("a name no app has fails with the nearest names, rather than launching a loose match", () => {
	assert.throws(() => pickApp("System Management Console", START), (error: Error) =>
		/No Start menu app is named like "System Management Console"/.test(error.message)
		&& /Operations Control Management Console/.test(error.message)
		&& error.message.indexOf("Operations Control Management Console") < error.message.indexOf("Print Management"));
	assert.throws(() => pickApp("Photoshop", START), /No Start menu app is named like "Photoshop".*Get-StartApps/);
});

test("words several apps share fail listing them, so the agent picks", () => {
	assert.throws(() => pickApp("management", START), /"management" matches several Start menu apps: Operations Control Management Console, Print Management/);
});
