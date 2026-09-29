import assert from "node:assert/strict";
import test from "node:test";

/**
 * Tests for the preview pane's highlighter - the one part of the client that is
 * worth testing on its own, because it is the only part doing real work on input
 * it does not control.
 *
 * It lives in `public/` with the rest of the client (no build step, no
 * dependencies), so it is loaded here the way a browser would load it: as a
 * module by path. That also proves the file works as a standalone ES module, not
 * just as something the bundler-less client happens to import.
 */
const moduleUrl = new URL("../../public/highlight.js", import.meta.url).href;
const { highlightCode, languageOf, languages } = (await import(moduleUrl)) as {
  highlightCode: (text: string, language: string) => string | null;
  languageOf: (path: string) => string;
  languages: () => string[];
};

/** The visible text of a highlighted fragment, with the spans taken out. */
function collapse(html: string): string {
  return html
    .replace(/<\/?span[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

test("languageOf", async (t) => {
  await t.test("maps the extensions this project uses", () => {
    assert.equal(languageOf("src/agent.ts"), "javascript");
    assert.equal(languageOf("public/app.js"), "javascript");
    assert.equal(languageOf("workspace/tic_tac_toe.py"), "python");
    assert.equal(languageOf("package.json"), "json");
    assert.equal(languageOf("scripts/run.sh"), "shell");
  });

  await t.test("a dotfile with no extension is still a shell file", () => {
    assert.equal(languageOf(".env"), "shell");
  });

  await t.test("anything unknown is plain, not guessed at", () => {
    assert.equal(languageOf("notes.md"), "plain");
    assert.equal(languageOf("Makefile"), "plain");
    assert.equal(languageOf("archive.tar.gz"), "plain");
    assert.equal(languageOf(""), "plain");
  });
});

test("highlightCode", async (t) => {
  await t.test("colourises a python file", () => {
    const html = highlightCode('# a comment\ndef greet(name):\n    return "hi"', "python");
    assert.ok(html !== null);
    assert.match(String(html), /<span class="tok-comment"># a comment<\/span>/);
    assert.match(String(html), /<span class="tok-keyword">def<\/span>/);
    assert.match(String(html), /<span class="tok-string">&quot;hi&quot;<\/span>/);
  });

  await t.test("survives a file that is still being written", () => {
    // The interesting case: an unclosed string, an unclosed triple quote, a
    // comment with no newline yet, and half a keyword. None of it may throw, and
    // all of it must appear.
    for (const partial of [
      'x = "unterminated',
      'x = """docstring so far',
      "# a comment with no newline at the end",
      "def",
      'data = {"key": [1, 2,',
      "const value = `template ${",
    ]) {
      for (const language of languages()) {
        assert.doesNotThrow(() => highlightCode(partial, language), `${language}: ${partial}`);
      }
    }
  });

  await t.test("keeps every character, which is what the caller relies on", () => {
    const source = [
      "#!/usr/bin/env python3",
      '# comment with "quotes" and a backslash \\',
      "def main(n: int) -> int:",
      '    """Doc."""',
      "    total = n * 1.5  # inline",
      "    return total",
    ].join("\n");

    for (const language of languages()) {
      const html = highlightCode(source, language);
      if (html === null) continue;
      assert.equal(collapse(html), source, `${language} changed the text`);
    }
  });

  await t.test("escapes markup instead of emitting it", () => {
    const html = highlightCode('x = "<script>alert(1)</script>"', "python");
    assert.ok(!String(html).includes("<script>"));
    assert.match(String(html), /&lt;script&gt;/);
  });

  await t.test("json keys are told apart from json values", () => {
    const html = String(highlightCode('{"path": "notes.md", "added": 3, "ok": true}', "json"));
    assert.match(html, /<span class="tok-key">&quot;path&quot;<\/span>/);
    assert.match(html, /<span class="tok-string">&quot;notes.md&quot;<\/span>/);
    assert.match(html, /<span class="tok-number">3<\/span>/);
    assert.match(html, /<span class="tok-keyword">true<\/span>/);
  });

  await t.test("a path in a json string is not read as a key", () => {
    const html = String(highlightCode('{"content": "see: \\"a\\": 1"}', "json"));
    assert.equal((html.match(/tok-key/g) ?? []).length, 1);
  });

  await t.test("a // inside a string is not a comment", () => {
    const html = String(highlightCode('const url = "https://example.test/x";', "javascript"));
    assert.equal((html.match(/tok-comment/g) ?? []).length, 0);
    assert.match(html, /tok-string/);
  });

  await t.test("an unknown language or empty text is left alone", () => {
    assert.equal(highlightCode("plain text", "markdown"), null);
    assert.equal(highlightCode("", "python"), null);
  });

  await t.test("highlighting is linear enough to run on every draft", () => {
    // A file past the preview's own cap, highlighted repeatedly: this is the path
    // that runs on each streamed fragment, so a runaway regex here would be felt
    // as a stalling pane.
    const big = Array.from({ length: 4_000 }, (_line, index) => `value_${index} = ${index}  # line`).join("\n");
    const started = Date.now();
    for (let run = 0; run < 5; run += 1) highlightCode(big, "python");
    assert.ok(Date.now() - started < 5_000, "highlighting a large file took too long");
  });
});
