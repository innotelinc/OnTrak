import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ShellResult } from "../shell.js";

/**
 * Deploying the built app.
 *
 * No host is reached: the shell runner and `fetch` are injected, so what is
 * checked is the *pipeline* — that the project is built before anything is
 * uploaded, that the output directory is the built one rather than the source, and
 * that each transport is handed the files in the shape its API documents (`deploy`
 * is called with `deps` directly, which is what makes that possible).
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-test-"));
const workspace = path.join(scratch, "workspace");
process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");
process.env.NETLIFY_TOKEN = "netlify-test-token";
process.env.VERCEL_TOKEN = "vercel-test-token";
process.env.AGENT_GIT_TOKEN = "gh-test-token";

const { deploy, deployTargets, DeployError, zipStore } = await import("../deploy.js");

test.after(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

/** A project with a build script and the output that build writes. */
async function project(name: string): Promise<void> {
  const dir = path.join(workspace, name);
  await fs.mkdir(path.join(dir, "dist", "assets"), { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }), "utf8");
  await fs.writeFile(path.join(dir, "index.html"), "<h1>source</h1>\n", "utf8");
  await fs.writeFile(path.join(dir, "dist", "index.html"), "<h1>built</h1>\n", "utf8");
  await fs.writeFile(path.join(dir, "dist", "assets", "app.js"), "console.log(1);\n", "utf8");
}

const ok = (output = ""): ShellResult => ({ ok: true, exitCode: 0, timedOut: false, backend: "host", output });

/** Read the names out of a stored zip's central directory. */
function zipNames(buffer: Buffer): { names: string[]; methods: number[] } {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, "the buffer is not a zip: no end-of-central-directory record");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names: string[] = [];
  const methods: number[] = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "central directory entry has the wrong signature");
    methods.push(buffer.readUInt16LE(offset + 10));
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { names, methods };
}

test("which targets this deployment can reach", () => {
  const targets = deployTargets();
  assert.deepEqual(
    targets.map((target) => target.id),
    ["netlify", "vercel", "github-pages"],
  );
  for (const target of targets) assert.equal(target.ready, true, `${target.id} should be ready with its token set`);
});

test("an unknown target is refused before anything is built or uploaded", async () => {
  const ran: string[] = [];
  const error = await deploy(
    { target: "dropbox", dir: "site" },
    { run: async (options) => (ran.push(options.command), ok()), fetch: async () => ({ status: 200, text: "{}" }) },
  ).catch((caught: unknown) => caught);
  assert.ok(error instanceof DeployError);
  assert.match(error.message, /target must be one of netlify, vercel, github-pages \(got "dropbox"\)/);
  assert.deepEqual(ran, []);
});

// --- netlify ----------------------------------------------------------------

test("Netlify gets the built output as a zip, and a site when there is none", async () => {
  await project("site");
  const calls: { url: string; body: string | Uint8Array | undefined; headers: Record<string, string> }[] = [];
  const ran: string[] = [];

  const result = await deploy(
    { target: "netlify", dir: "site" },
    {
      run: async (options) => (ran.push(options.command), ok("vite build: 12 modules transformed")),
      fetch: async (url, init) => {
        calls.push({ url, body: init.body, headers: init.headers });
        return url.endsWith("/sites")
          ? { status: 200, text: JSON.stringify({ id: "site-1" }) }
          : { status: 200, text: JSON.stringify({ ssl_url: "https://site.netlify.app" }) };
      },
    },
  );

  assert.deepEqual(ran, ["npm run build"], "a project with a build script is built first");
  assert.equal(result.built, true);
  assert.equal(result.output, "site/dist", "the built directory is what is uploaded, not the source");
  assert.equal(result.files, 2);
  assert.equal(result.url, "https://site.netlify.app");
  assert.match(result.buildLog, /12 modules transformed/);

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://api.netlify.com/api/v1/sites");
  assert.deepEqual(JSON.parse(calls[0]!.body as string), { name: "site" });
  assert.equal(calls[1]!.url, "https://api.netlify.com/api/v1/sites/site-1/deploys");
  assert.equal(calls[1]!.headers["Content-Type"], "application/zip");
  assert.equal(calls[1]!.headers.Authorization, "Bearer netlify-test-token");

  const zip = Buffer.from(calls[1]!.body as Uint8Array);
  assert.equal(zip.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
  const { names, methods } = zipNames(zip);
  assert.deepEqual(names.sort(), ["assets/app.js", "index.html"]);
  assert.deepEqual(methods, [0, 0], "entries are stored, which is what a zip with no compressor looks like");
});

test("a build that fails stops the deploy and carries its output", async () => {
  await project("broken");
  let fetched = 0;
  const error = await deploy(
    { target: "netlify", dir: "broken" },
    {
      run: async () => ({
        ok: false,
        exitCode: 1,
        timedOut: false,
        backend: "host",
        output: "src/main.ts(4,9): error TS2345: Argument of type 'string' is not assignable",
      }),
      fetch: async () => (fetched += 1, { status: 200, text: "{}" }),
    },
  ).catch((caught: unknown) => caught);

  assert.ok(error instanceof DeployError);
  assert.match(error.message, /the build failed, so nothing was deployed/);
  assert.match(error.message, /error TS2345/);
  assert.equal(fetched, 0, "nothing is uploaded after a failed build");
});

test("a directory with no build and no output says so instead of uploading sources", async () => {
  await fs.mkdir(path.join(workspace, "bare"), { recursive: true });
  await fs.writeFile(path.join(workspace, "bare", "notes.md"), "no app here\n", "utf8");
  const error = await deploy(
    { target: "netlify", dir: "bare" },
    { run: async () => ok(), fetch: async () => ({ status: 200, text: "{}" }) },
  ).catch((caught: unknown) => caught);
  assert.ok(error instanceof DeployError);
  assert.match(error.message, /no built output to deploy/);
});

test("an empty output directory is refused", async () => {
  const dir = path.join(workspace, "empty");
  await fs.mkdir(path.join(dir, "dist"), { recursive: true });
  const error = await deploy(
    { target: "netlify", dir: "empty", build: false },
    { run: async () => ok(), fetch: async () => ({ status: 200, text: "{}" }) },
  ).catch((caught: unknown) => caught);
  assert.ok(error instanceof DeployError);
  assert.match(error.message, /no built output to deploy/);
});

test("Netlify's refusal is reported with what it said", async () => {
  const error = await deploy(
    { target: "netlify", dir: "site", build: false },
    {
      run: async () => ok(),
      fetch: async (url) =>
        url.endsWith("/sites")
          ? { status: 422, text: JSON.stringify({ message: "name already taken" }) }
          : { status: 200, text: "{}" },
    },
  ).catch((caught: unknown) => caught);
  assert.match((error as Error).message, /Netlify refused the deploy \(HTTP 422\): name already taken/);
});

// --- vercel -----------------------------------------------------------------

test("Vercel gets an inline file list and answers with a URL", async () => {
  let body: Record<string, unknown> = {};
  const result = await deploy(
    { target: "vercel", dir: "site", name: "My Site" },
    {
      run: async () => ok(),
      fetch: async (url, init) => {
        assert.equal(url, "https://api.vercel.com/v13/deployments");
        body = JSON.parse(init.body as string) as Record<string, unknown>;
        return { status: 200, text: JSON.stringify({ url: "my-site-abc.vercel.app" }) };
      },
    },
  );

  assert.equal(result.url, "https://my-site-abc.vercel.app");
  assert.equal(body.name, "my-site", "the site name is slugged, because a host will not take a space");
  assert.equal(body.target, "production");
  const files = body.files as { file: string; data: string }[];
  assert.deepEqual(
    files.map((file) => file.file).sort(),
    ["assets/app.js", "index.html"],
  );
  assert.equal(Buffer.from(files.find((file) => file.file === "index.html")!.data, "base64").toString(), "<h1>built</h1>\n");
});

// --- github pages -----------------------------------------------------------

test("GitHub Pages pushes the output to the gh-pages branch, with the token in the URL only", async () => {
  const commands: string[] = [];
  const result = await deploy(
    { target: "github-pages", dir: "site", repo: "innotelinc/demo", message: "Deploy demo" },
    {
      run: async (options) => (commands.push(options.command), ok()),
      fetch: async () => ({ status: 200, text: "{}" }),
    },
  );

  assert.equal(result.url, "https://innotelinc.github.io/demo/");
  assert.equal(commands[0], "npm run build");
  assert.ok(commands.some((command) => command.startsWith("git init")), "a fresh repository holds the output");
  assert.ok(commands.some((command) => command.includes("-m 'Deploy demo'")), "the commit message is quoted");
  const push = commands.find((command) => command.startsWith("git push"));
  assert.ok(push !== undefined);
  assert.match(push, /HEAD:refs\/heads\/gh-pages/);
  assert.match(push, /x-access-token:gh-test-token@github\.com\/innotelinc\/demo\.git/);
});

test("GitHub Pages needs a repository, and a failing push is redacted", async () => {
  const missing = await deploy(
    { target: "github-pages", dir: "site", build: false },
    { run: async () => ok(), fetch: async () => ({ status: 200, text: "{}" }) },
  ).catch((caught: unknown) => caught);
  assert.match((missing as Error).message, /needs repo=owner\/name/);

  const failed = await deploy(
    { target: "github-pages", dir: "site", repo: "innotelinc/demo", build: false },
    {
      run: async (options) =>
        options.command.startsWith("git push")
          ? {
              ok: false,
              exitCode: 128,
              timedOut: false,
              backend: "host",
              output: "remote: denied for x-access-token:gh-test-token@github.com",
            }
          : ok(),
      fetch: async () => ({ status: 200, text: "{}" }),
    },
  ).catch((caught: unknown) => caught);
  const message = (failed as Error).message;
  assert.match(message, /could not push gh-pages/);
  assert.ok(!message.includes("gh-test-token"), "the token never reaches a message or a log");
  assert.match(message, /\*\*\*/);
});

// --- the zip ----------------------------------------------------------------

test("the zip writer produces a readable central directory", () => {
  const zip = zipStore([
    { path: "index.html", data: Buffer.from("<h1>hi</h1>") },
    { path: "nested/a.txt", data: Buffer.from("a") },
  ]);
  const { names } = zipNames(zip);
  assert.deepEqual(names, ["index.html", "nested/a.txt"]);
  // The stored data is in the archive, not just its name.
  assert.ok(zip.includes(Buffer.from("<h1>hi</h1>")), "the entry's bytes are in the archive");
});
