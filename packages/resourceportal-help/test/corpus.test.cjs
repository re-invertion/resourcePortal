const test = require("node:test");
const assert = require("node:assert/strict");
const { HELP_CORPUS_REVISION, HELP_SECTIONS } = require("../dist/cjs/index.js");

test("help corpus has stable unique sections and content", () => {
  assert.equal(HELP_SECTIONS.length, 14);
  assert.equal(new Set(HELP_SECTIONS.map((section) => section.id)).size, HELP_SECTIONS.length);
  assert.match(HELP_CORPUS_REVISION, /^[a-f0-9]{64}$/);
  for (const section of HELP_SECTIONS) {
    assert.ok(section.title.length > 3);
    assert.ok(section.description.length > 10);
    assert.ok(section.body.length > 80);
  }
});
