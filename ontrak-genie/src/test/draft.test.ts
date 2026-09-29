import assert from "node:assert/strict";
import test from "node:test";

import { draftPreview, scanStringFields, textDraftPreview } from "../draft.js";

/**
 * Tests for reading a tool call that is still arriving.
 *
 * The cases that matter are the ones a preview is *for*: a body cut off
 * mid-string, an escape split across fragments, and a field name that also
 * appears inside another value. A reader that only worked on complete JSON would
 * be useless here, since complete JSON is the case that no longer needs it.
 */

test("scanStringFields", async (t) => {
  await t.test("reads a complete object", () => {
    const fields = scanStringFields('{"path":"src/a.ts","content":"hi\\nthere"}');
    assert.equal(fields.get("path")?.value, "src/a.ts");
    assert.equal(fields.get("path")?.closed, true);
    assert.equal(fields.get("content")?.value, "hi\nthere");
    assert.equal(fields.get("content")?.closed, true);
  });

  await t.test("reports an unterminated value as still arriving", () => {
    const fields = scanStringFields('{"path":"a.md","content":"# Head');
    assert.equal(fields.get("path")?.value, "a.md");
    assert.equal(fields.get("content")?.value, "# Head");
    assert.equal(fields.get("content")?.closed, false);
  });

  await t.test("a truncated escape does not corrupt the tail", () => {
    // `\` at the very end, and a `\u` with too few hex digits, are both normal
    // fragment boundaries rather than reasons to stop reading.
    assert.equal(scanStringFields('{"content":"hi\\n').get("content")?.value, "hi\n");
    assert.equal(scanStringFields('{"content":"hi\\').get("content")?.value, "hi");
    assert.equal(scanStringFields('{"content":"hi\\u00').get("content")?.value, "hi");
  });

  await t.test("decodes unicode and the simple escapes", () => {
    const fields = scanStringFields('{"content":"\\u0041\\t\\"q\\"\\\\"}');
    assert.equal(fields.get("content")?.value, 'A\t"q"\\');
  });

  await t.test("a field name inside another value is not taken for the key", () => {
    // An edit's old text very often says `content`, which is exactly the field
    // being read - so matching by name alone would return the wrong body.
    const fields = scanStringFields(
      '{"path":"content.md","old_string":"content","new_string":"new"}',
    );
    assert.equal(fields.get("path")?.value, "content.md");
    assert.equal(fields.get("old_string")?.value, "content");
    assert.equal(fields.get("new_string")?.value, "new");
  });

  await t.test("nested values are stepped over rather than misread", () => {
    const fields = scanStringFields('{"options":{"content":"decoy"},"content":"real"}');
    assert.equal(fields.get("content")?.value, "real");
  });

  await t.test("malformed input yields what it can and never throws", () => {
    for (const input of ["", "{", "not json at all", '{"a":}', '{"a":1e', '{"a":[', '{"a":"b"']) {
      assert.doesNotThrow(() => scanStringFields(input), `input: ${input}`);
    }
  });
});

test("draftPreview", async (t) => {
  await t.test("reads a write_file as it arrives", () => {
    const draft = draftPreview("write_file", '{"path":"src/x.ts","content":"export const x');
    assert.equal(draft?.name, "write_file");
    assert.equal(draft?.path, "src/x.ts");
    assert.equal(draft?.content, "export const x");
    assert.equal(draft?.started, true);
    assert.equal(draft?.complete, false);
  });

  await t.test("names the path before the body has started", () => {
    const draft = draftPreview("write_file", '{"path":"notes.md","content":');
    assert.equal(draft?.path, "notes.md");
    assert.equal(draft?.started, false);
    assert.equal(draft?.content, "");
  });

  await t.test("takes the replacement text of an edit as the body", () => {
    const draft = draftPreview(
      "edit_file",
      '{"path":"a.ts","old_string":"old","new_string":"new"}',
    );
    assert.equal(draft?.path, "a.ts");
    assert.equal(draft?.content, "new");
    assert.equal(draft?.complete, true);
  });

  await t.test("a path that has not arrived yet is null, not empty", () => {
    assert.equal(draftPreview("write_file", '{"conten')?.path, null);
  });

  await t.test("tools that write nothing produce no draft", () => {
    assert.equal(draftPreview("run_command", '{"command":"npm test"}'), null);
    assert.equal(draftPreview("read_file", '{"path":"a.ts"}'), null);
    assert.equal(draftPreview("", '{"path":"a.ts"}'), null);
  });
});

test("textDraftPreview", async (t) => {
  const tools = new Set(["read_file", "write_file", "edit_file", "run_command"]);

  await t.test("reads the file out of a call printed as prose", () => {
    const draft = textDraftPreview(
      'I will write it now.\n{"name": "write_file", "arguments": {"path": "a.py", "content": "print(1',
      tools,
    );
    assert.equal(draft?.name, "write_file");
    assert.equal(draft?.path, "a.py");
    assert.equal(draft?.content, "print(1");
    assert.equal(draft?.complete, false);
  });

  await t.test("follows the arguments, not the outer object", () => {
    // The `path` here belongs to the call, not to the message wrapper, so a scan
    // starting at the wrong brace would report a path of "write_file".
    const draft = textDraftPreview(
      '```json\n{"name":"edit_file","arguments":{"path":"b.ts","old_string":"x","new_string":"y"}}\n```',
      tools,
    );
    assert.equal(draft?.path, "b.ts");
    assert.equal(draft?.content, "y");
    assert.equal(draft?.complete, true);
  });

  await t.test("nothing until the tool is named", () => {
    assert.equal(textDraftPreview('{"path":"a.py","content":"hi', tools), null);
  });

  await t.test("a named tool that writes nothing is not drafted", () => {
    assert.equal(
      textDraftPreview('{"name":"run_command","arguments":{"command":"ls"}}', tools),
      null,
    );
  });

  await t.test("a tool the agent does not have is ignored", () => {
    assert.equal(textDraftPreview('{"name":"write_file"', new Set(["read_file"])), null);
  });
});
