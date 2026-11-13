import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

// Pi's own loader parses the frontmatter as YAML. A plain ": " in a description makes it invalid YAML, and Pi then
// drops the skill with only a warning; before this test, only the slow install smoke run saw that.
const SKILLS = join(import.meta.dirname, "..", "skills");
const skillDirs = readdirSync(SKILLS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

test("every skill folder has a SKILL.md that Pi loads with its folder name and a description", () => {
	assert.ok(skillDirs.length > 0);
	for (const name of skillDirs) {
		const { skills, diagnostics } = loadSkillsFromDir({ dir: join(SKILLS, name), source: "test" });
		assert.deepEqual(diagnostics.map((d) => d.message), [], `${name}/SKILL.md`);
		assert.equal(skills.length, 1, `${name}/SKILL.md loads one skill`);
		assert.equal(skills[0].name, name);
		assert.ok(skills[0].description.trim().length > 20, `${name} has a description`);
		assert.ok(skills[0].description.length <= 1024, `${name}: a description of at most 1024 characters`);
	}
});

// Every session's prompt carries each skill's description, so a long one costs tokens on every request of every
// session. The body holds the detail; the description only has to make the model load the skill.
const DESCRIPTION_BUDGET = 560;

test("every skill description stays within its prompt budget and names its /skill: command", () => {
	for (const name of skillDirs) {
		const { skills } = loadSkillsFromDir({ dir: join(SKILLS, name), source: "test" });
		const description = skills[0].description;
		assert.ok(description.length <= DESCRIPTION_BUDGET, `${name}: ${description.length} characters; budget ${DESCRIPTION_BUDGET}`);
		assert.ok(description.includes(`/skill:${name}`), `${name} names /skill:${name}`);
	}
});

test("a description with a plain colon and space is a diagnostic, so the check above can fail", () => {
	const dir = mkdtempSync(join(tmpdir(), "skill-frontmatter-"));
	try {
		mkdirSync(join(dir, "broken"));
		writeFileSync(join(dir, "broken", "SKILL.md"), "---\nname: broken\ndescription: Find `except: pass` blocks in Python code.\n---\n\nBody.\n");
		const { skills, diagnostics } = loadSkillsFromDir({ dir: join(dir, "broken"), source: "test" });
		assert.equal(skills.length, 0);
		assert.ok(diagnostics.length > 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
