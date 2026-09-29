import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildFactorySpec,
  detectStack,
  entryPoint,
  FactorySpecError,
  MAX_APPENDIX_CHARS,
  SPEC_FILENAME_PATTERN,
  specSlug,
  verificationCriteria,
  walkWorkspace,
  writeFactorySpec,
  type WalkedFile,
} from "../builder.js";

/**
 * Tests for the Genie → factory handoff.
 *
 * The cases that matter are the ones that make a spec trustworthy: the headings
 * match the template the factory parses, the same workspace produces the same
 * bytes, an unstated intent is marked rather than guessed, and the write path
 * refuses to clobber a spec someone edited by hand.
 *
 * No test touches the configured workspace. Every fixture is built in a temp
 * directory and passed in explicitly, so a bad test cannot damage real files.
 */

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

/** A small but realistic app: enough for every inference branch to have an answer. */
async function appFixture(root: string): Promise<void> {
  await write(root, "package.json", '{ "name": "todo", "scripts": { "test": "node --test" } }');
  await write(root, "tsconfig.json", "{ }");
  await write(root, "src/App.tsx", "export function App() { return null; }\n");
  await write(root, "server/schema.sql", "create table todos (id integer);\n");
  await write(root, "README.md", "# Todo\n");
}

/* ---- naming -------------------------------------------------------------- */

test("specSlug", async (t) => {
  await t.test("lowercases and collapses runs of punctuation into one dash", () => {
    assert.equal(specSlug("My Todo List"), "my-todo-list");
    assert.equal(specSlug("Billing  &  Invoicing!!"), "billing-invoicing");
  });

  await t.test("cannot produce a separator or a dot, whatever the input", () => {
    // The slug becomes a filename, so the shape that matters is the safe one.
    for (const hostile of ["../../etc/passwd", "a/b", "..", "/root/.ssh/id_rsa", "a.b.c"]) {
      const slug = specSlug(hostile);
      assert.match(slug, /^[a-z0-9-]*$/);
      assert.ok(!slug.includes("/") && !slug.includes("."));
    }
  });

  await t.test("never starts or ends with a dash", () => {
    assert.equal(specSlug("-- leading and trailing --"), "leading-and-trailing");
  });

  await t.test("falls back when nothing survives", () => {
    assert.equal(specSlug("***"), "genie-app");
    assert.equal(specSlug(""), "genie-app");
    assert.equal(specSlug("日本語"), "genie-app");
  });

  await t.test("caps the length so the filename stays writable", () => {
    const slug = specSlug("x".repeat(400));
    assert.equal(slug.length, 60);
    assert.ok(SPEC_FILENAME_PATTERN.test(`${slug}.md`));
  });
});

/* ---- the file set ------------------------------------------------------- */

test("walkWorkspace", async (t) => {
  await t.test("lists files, sorted, with sizes", async () => {
    const root = await tempDir("genie-walk-");
    await write(root, "b.txt", "bb");
    await write(root, "a.txt", "a");
    await write(root, "nested/c.txt", "ccc");

    const files = await walkWorkspace(root);
    assert.deepEqual(
      files.map((file) => file.path),
      ["a.txt", "b.txt", "nested/c.txt"],
    );
    assert.equal(files.find((file) => file.path === "nested/c.txt")?.bytes, 3);
  });

  await t.test("skips the trees the jail already ignores", async () => {
    const root = await tempDir("genie-walk-ignored-");
    await write(root, "keep.ts", "x");
    await write(root, "node_modules/pkg/index.js", "y");
    await write(root, ".git/config", "z");
    await write(root, "dist/out.js", "w");
    await write(root, "__pycache__/m.pyc", "v");

    const files = await walkWorkspace(root);
    assert.deepEqual(
      files.map((file) => file.path),
      ["keep.ts"],
    );
  });

  await t.test("skips dotfiles, which are the workspace's own machinery", async () => {
    const root = await tempDir("genie-walk-dot-");
    await write(root, "keep.ts", "x");
    await write(root, ".env", "SECRET=1");
    await write(root, ".hidden/thing.txt", "y");

    const files = await walkWorkspace(root);
    assert.deepEqual(
      files.map((file) => file.path),
      ["keep.ts"],
    );
  });

  await t.test("does not follow a symlink out of the workspace", async () => {
    const outside = await tempDir("genie-outside-");
    await fs.writeFile(path.join(outside, "secret.txt"), "not yours", "utf8");

    const root = await tempDir("genie-walk-link-");
    await write(root, "keep.ts", "x");
    try {
      await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
      await fs.symlink(outside, path.join(root, "linkdir"));
    } catch {
      t.skip("symlinks unavailable on this platform");
      return;
    }

    // The walk reads file contents into the spec, so following a link would be the
    // same escape the path jail refuses for a tool call.
    const files = await walkWorkspace(root);
    assert.deepEqual(
      files.map((file) => file.path),
      ["keep.ts"],
    );
  });

  await t.test("honours the file and depth caps", async () => {
    const root = await tempDir("genie-walk-caps-");
    for (let i = 0; i < 10; i += 1) await write(root, `f${i}.txt`, "x");
    await write(root, "a/b/c/d/e/deep.txt", "x");

    assert.equal((await walkWorkspace(root, { maxFiles: 4 })).length, 4);
    const shallow = await walkWorkspace(root, { maxDepth: 1 });
    assert.ok(!shallow.some((file) => file.path.includes("deep.txt")));
  });

  await t.test("answers an empty directory with an empty list, not an error", async () => {
    const root = await tempDir("genie-walk-empty-");
    assert.deepEqual(await walkWorkspace(root), []);
  });
});

/* ---- inference ---------------------------------------------------------- */

const FILES: WalkedFile[] = [
  { path: "package.json", bytes: 10 },
  { path: "tsconfig.json", bytes: 10 },
  { path: "src/App.tsx", bytes: 10 },
  { path: "server/schema.sql", bytes: 10 },
  { path: "index.html", bytes: 10 },
];

test("entryPoint", async (t) => {
  await t.test("prefers the client component", () => {
    assert.equal(entryPoint(FILES), "src/App.tsx");
  });

  await t.test("falls back to the data model for an app with no client", () => {
    const files = FILES.filter((file) => !file.path.endsWith("App.tsx"));
    assert.equal(entryPoint(files, "app"), "server/schema.sql");
  });

  await t.test("a website opens its page, not a schema", () => {
    const files = FILES.filter((file) => !file.path.endsWith("App.tsx"));
    assert.equal(entryPoint(files, "website"), "index.html");
  });

  await t.test("says nothing when there is nothing to open", () => {
    assert.equal(entryPoint([]), null);
    assert.equal(entryPoint([{ path: "notes.txt", bytes: 1 }], "website"), null);
  });
});

test("detectStack", async (t) => {
  await t.test("states the kind the operator chose, first and unconditionally", () => {
    assert.equal(detectStack(FILES, "website")[0], "Static site — packaged to `dist/`, no server process");
    // An app gets no packaging line: the factory must not package it.
    assert.ok(!detectStack(FILES, "app").some((line) => line.includes("Static site")));
  });

  await t.test("reads the languages actually present", () => {
    const stack = detectStack(FILES, "app");
    assert.ok(stack.some((line) => line.includes("package.json")));
    assert.ok(stack.some((line) => line.includes("TypeScript")));
    assert.ok(stack.some((line) => line.includes("HTML")));
    assert.ok(stack.some((line) => line.includes("SQL")));
  });

  await t.test("admits the gap rather than claiming a stack from an empty workspace", () => {
    const stack = detectStack([], "app");
    assert.equal(stack.length, 1);
    assert.match(stack[0] ?? "", /Not inferred/);
  });
});

test("verificationCriteria", async (t) => {
  await t.test("names commands the file set can actually run", () => {
    const criteria = verificationCriteria(FILES, "app");
    assert.ok(criteria.includes("`npm install` completes"));
    assert.ok(criteria.includes("`npm run typecheck` completes"));
    assert.ok(criteria.includes("`npm test` completes"));
  });

  await t.test("a Node project with no tsconfig gets no typecheck line", () => {
    const criteria = verificationCriteria([{ path: "package.json", bytes: 1 }], "app");
    assert.ok(!criteria.some((line) => line.includes("typecheck")));
  });

  await t.test("a Python project gets the runner that exists", () => {
    const criteria = verificationCriteria([{ path: "main.py", bytes: 1 }], "app");
    assert.ok(criteria.includes("`python3 -m unittest` completes"));
  });

  await t.test("no runner present: a website is judged by rendering, an app admits it cannot be", () => {
    assert.match(verificationCriteria([], "website")[0] ?? "", /renders at 360px and 1440px/);
    assert.match(verificationCriteria([], "app")[0] ?? "", /Not derived/);
  });
});

/* ---- assembly ----------------------------------------------------------- */

test("buildFactorySpec", async (t) => {
  await t.test("emits exactly the headings the factory template parses", async () => {
    const root = await tempDir("genie-spec-");
    await appFixture(root);

    const spec = await buildFactorySpec(
      { name: "Todo", purpose: "Track chores.", features: ["Add a chore"] },
      { root },
    );

    // These four headings are the contract with `factory/APP_SPEC_TEMPLATE.md`.
    for (const heading of [
      "# Application Specification: Todo",
      "## 🎯 Core Purpose",
      "## 🧰 Tech Stack",
      "## 🛠️ Key Features & Pages",
      "## 🚦 Verification Criteria",
    ]) {
      assert.ok(spec.markdown.includes(heading), `missing heading: ${heading}`);
    }
  });

  await t.test("is deterministic: the same workspace produces the same bytes", async () => {
    const root = await tempDir("genie-spec-stable-");
    await appFixture(root);
    const input = { name: "Todo", purpose: "Track chores.", features: ["Add a chore"] };

    const first = await buildFactorySpec(input, { root });
    const second = await buildFactorySpec(input, { root });
    assert.equal(first.markdown, second.markdown);
    assert.equal(first.filename, second.filename);
  });

  await t.test("marks an unstated purpose instead of inventing one", async () => {
    const root = await tempDir("genie-spec-bare-");
    await write(root, "index.html", "<h1>hi</h1>");

    const spec = await buildFactorySpec({ name: "Landing" }, { root });
    assert.match(spec.markdown, /Not stated/);
    assert.match(spec.markdown, /Not listed/);
  });

  await t.test("numbers the features it was given", async () => {
    const spec = await buildFactorySpec(
      { name: "Todo", features: ["Add a chore", "Tick it off"] },
      { root: await tempDir("genie-spec-feat-"), files: [] },
    );
    assert.match(spec.markdown, /1\. \*\*Feature 1\*\*: Add a chore/);
    assert.match(spec.markdown, /2\. \*\*Feature 2\*\*: Tick it off/);
  });

  await t.test("an empty workspace is described as empty, not as an error", async () => {
    const spec = await buildFactorySpec(
      { name: "Todo", purpose: "Track chores." },
      { root: await tempDir("genie-spec-empty-") },
    );
    assert.match(spec.markdown, /The workspace was empty/);
  });

  await t.test("returns a path-safe filename and usable next steps", async () => {
    const spec = await buildFactorySpec({ name: "My Todo App" }, { root: await tempDir("genie-spec-n-"), files: [] });
    assert.equal(spec.filename, "my-todo-app.md");
    assert.ok(SPEC_FILENAME_PATTERN.test(spec.filename));
    assert.ok(spec.nextSteps.some((step) => step.includes("make app SPEC=build-requests/my-todo-app.md")));
  });

  await t.test("refuses a nameless spec with a 400, not a crash", async () => {
    const root = await tempDir("genie-spec-noname-");
    await assert.rejects(
      () => buildFactorySpec({ name: "   " }, { root }),
      (error: unknown) => error instanceof FactorySpecError && error.status === 400,
    );
  });

  await t.test("quotes file contents, and caps the appendix", async () => {
    const root = await tempDir("genie-spec-appendix-");
    await write(root, "small.txt", "hello");
    await write(root, "big.txt", "x".repeat(MAX_APPENDIX_CHARS + 10));

    const spec = await buildFactorySpec({ name: "Todo" }, { root });
    assert.match(spec.markdown, /hello/);
    // The oversized file is indexed, and skipped rather than quoted.
    assert.match(spec.markdown, /`big\.txt`/);
    assert.ok(spec.markdown.length < MAX_APPENDIX_CHARS + 20_000);
  });

  await t.test("does not quote a binary file", async () => {
    const root = await tempDir("genie-spec-bin-");
    await fs.writeFile(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 5]));

    const spec = await buildFactorySpec({ name: "Todo" }, { root });
    assert.match(spec.markdown, /`blob\.bin`/); // indexed
    assert.ok(!spec.markdown.includes("\u0000"));
  });
});

/* ---- writing ------------------------------------------------------------ */

test("writeFactorySpec", async (t) => {
  await t.test("writes the spec and reports its size", async () => {
    const dir = await tempDir("genie-factory-");
    const spec = await buildFactorySpec({ name: "Todo", purpose: "Track chores." }, { root: await tempDir("genie-w-"), files: [] });

    const result = await writeFactorySpec(dir, spec);
    assert.equal(result.filename, "todo.md");
    assert.equal(result.replaced, false);
    assert.equal(await fs.readFile(result.path, "utf8"), spec.markdown);
    assert.equal(result.bytes, Buffer.byteLength(spec.markdown, "utf8"));
  });

  await t.test("refuses to replace an existing spec unless told to", async () => {
    const dir = await tempDir("genie-factory-exists-");
    const root = await tempDir("genie-w2-");
    await write(root, "a.txt", "1");
    const spec = await buildFactorySpec({ name: "Todo", purpose: "v1" }, { root });

    await writeFactorySpec(dir, spec);
    // A hand-edited request must not be silently replaced by its own export.
    await assert.rejects(
      () => writeFactorySpec(dir, spec),
      (error: unknown) => error instanceof FactorySpecError && error.status === 409,
    );

    const replaced = await writeFactorySpec(dir, spec, { overwrite: true });
    assert.equal(replaced.replaced, true);
  });

  await t.test("creates the directory when it does not exist yet", async () => {
    const base = await tempDir("genie-factory-mk-");
    const dir = path.join(base, "nested", "build-requests");
    const spec = await buildFactorySpec({ name: "Todo" }, { root: await tempDir("genie-w3-"), files: [] });

    const result = await writeFactorySpec(dir, spec);
    assert.equal(result.path, path.join(dir, "todo.md"));
    assert.ok((await fs.stat(result.path)).isFile());
  });

  await t.test("refuses an unsafe filename outright", async () => {
    // The directory is a temp parent holding the factory dir, so the escape target
    // is a path this test owns rather than something in the system temp root.
    const base = await tempDir("genie-factory-unsafe-");
    const dir = path.join(base, "build-requests");
    const spec = {
      filename: "../escape.md",
      markdown: "x",
      nextSteps: [],
    };

    await assert.rejects(
      () => writeFactorySpec(dir, spec),
      (error: unknown) => error instanceof FactorySpecError,
    );
    // Nothing was written next to the directory it was told to use, and the
    // directory itself was never created.
    assert.deepEqual(await fs.readdir(base), []);
  });
});
