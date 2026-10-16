/**
 * Installing a skill from a repository: what gets chosen, what gets written, and
 * what is refused.
 *
 * The network is a fake, so these run anywhere and pin the *decisions* — which of
 * a repository's twenty-five identical provider copies is the skill, when a
 * repository holds several skills and nothing says which, that `skills/<name>/`
 * installs as `SKILL.md` at the top of its own directory, and that removing only
 * ever removes what this command installed.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SkillInstallError,
  chooseSkill,
  installSkill,
  parseGitHubRepo,
  removeSkill,
  skillRootsIn,
  type SkillFetcher,
} from "../skill-install.js";

function workDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "genie-install-"));
}

/** A fake GitHub: a tree, and file bodies under `raw`. */
function fakeGitHub(input: {
  branch?: string;
  tree: string[];
  raw?: Record<string, string>;
  seen?: { url: string; authorization?: string }[];
}): SkillFetcher {
  return (async (url: string, init?: RequestInit) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
    input.seen?.push({ url, ...(authorization === undefined ? {} : { authorization }) });

    if (url.includes("/git/trees/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ tree: input.tree.map((entry) => ({ path: entry, type: "blob" })) }),
      } as unknown as Response;
    }
    if (url.includes("/repos/")) {
      return { ok: true, status: 200, json: async () => ({ default_branch: input.branch ?? "main" }) } as unknown as Response;
    }
    const body = input.raw?.[url] ?? "---\nname: fake\ndescription: a fake skill\n---\nbody\n";
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body) } as unknown as Response;
  }) as unknown as SkillFetcher;
}

/* ------------------------------------------------------------------ parsing */

test("a repository is named, and only GitHub is one", () => {
  assert.deepEqual(parseGitHubRepo("pbakaus/impeccable"), { owner: "pbakaus", repo: "impeccable" });
  assert.deepEqual(parseGitHubRepo("https://github.com/awesome-skills/code-review-skill"), {
    owner: "awesome-skills",
    repo: "code-review-skill",
  });
  assert.deepEqual(parseGitHubRepo("git@github.com:pbakaus/impeccable.git"), {
    owner: "pbakaus",
    repo: "impeccable",
  });

  // The installer fetches from GitHub's API and raw host; a URL it cannot serve is
  // refused rather than quietly treated as a GitHub path with the same shape.
  for (const bad of ["gitlab.com/acme/skill", "https://example.com/acme/skill", "impeccable", "a/b/c", "", "  "]) {
    assert.equal(parseGitHubRepo(bad), null, `refused: ${bad}`);
  }
});

/* ----------------------------------------------------------------- choosing */

test("the same skill published for every provider is one skill, and the canonical copy wins", () => {
  /*
   * `impeccable` ships twenty-five `SKILL.md` files: one per provider directory,
   * plus the fixtures in `tests/`. They are one skill, so it installs once — and
   * from `.agents/`, which is the copy this ecosystem reads, rather than whichever
   * the alphabet happened to put first.
   */
  const tree = [
    "README.md",
    "crates/skills/src/lib.rs",
    "tests/oracle/workspaces/x/.claude/skills/impeccable/SKILL.md",
    ".claude/skills/impeccable/SKILL.md",
    ".cursor/skills/impeccable/SKILL.md",
    ".agents/skills/impeccable/SKILL.md",
    ".agents/skills/impeccable/reference/audit.md",
    "plugin/skills/impeccable/SKILL.md",
  ];
  assert.deepEqual(skillRootsIn(tree, "impeccable")[0], { root: ".agents/skills/impeccable", name: "impeccable" });

  const chosen = chooseSkill(tree, { repo: "impeccable" });
  assert.equal(chosen.name, "impeccable");
  assert.equal(chosen.prefix, ".agents/skills/impeccable/");
  assert.deepEqual(chosen.files.sort(), [
    ".agents/skills/impeccable/SKILL.md",
    ".agents/skills/impeccable/reference/audit.md",
  ]);
  assert.equal(
    chosen.files.some((file) => file.includes("tests/")),
    false,
    "the fixtures are not a skill",
  );
});

test("a repository that holds several skills is refused until one is named", () => {
  const tree = ["skills/one/SKILL.md", "skills/two/SKILL.md"];
  assert.throws(() => chooseSkill(tree, { repo: "collection" }), /holds several skills \(one, two\)/);
  assert.throws(() => chooseSkill(tree, { repo: "collection" }), /--path <name>/);

  // Named either way: the directory name, or the path.
  assert.equal(chooseSkill(tree, { repo: "collection", path: "two" }).name, "two");
  assert.equal(chooseSkill(tree, { repo: "collection", path: "skills/two" }).name, "two");
  assert.equal(chooseSkill(tree, { repo: "collection", name: "two" }).root, "skills/two");
  assert.throws(() => chooseSkill(tree, { repo: "collection", path: "three" }), /it holds one, two/);
});

test("a repository that is the skill installs from its root", () => {
  const tree = ["SKILL.md", "references/ios.md", ".gitignore", ".github/workflows/ci.yml"];
  const chosen = chooseSkill(tree, { repo: "mobile-app-design" });
  assert.equal(chosen.root, "");
  assert.equal(chosen.prefix, "");
  assert.equal(chosen.name, "mobile-app-design");
  assert.deepEqual(chosen.files.sort(), ["SKILL.md", "references/ios.md"], "VCS and CI files are not part of it");
});

test("a single markdown playbook is a skill too, and anything else is not", () => {
  const chosen = chooseSkill(["README.md", "no-bullshit-review.md"], { repo: "review-skills" });
  assert.equal(chosen.name, "no-bullshit-review");
  assert.deepEqual(chosen.files, ["no-bullshit-review.md"]);

  assert.throws(() => chooseSkill(["README.md", "src/index.ts"], { repo: "library" }), /does not hold a skill/);
  assert.throws(() => chooseSkill(["README.md", "LICENSE.md", "a.md", "b.md"], { repo: "docs" }), /does not hold a skill/);
});

/* ---------------------------------------------------------------- installing */

test("a skill is written into its own directory, with provenance", async () => {
  const dir = workDir();
  const seen: { url: string; authorization?: string }[] = [];
  const fetchImpl = fakeGitHub({
    tree: ["skills/audit/SKILL.md", "skills/audit/checklist.md"],
    raw: {
      "https://raw.githubusercontent.com/acme/skills/main/skills/audit/SKILL.md":
        "---\nname: audit\ndescription: Review hierarchy\n---\nLook closely.\n",
      "https://raw.githubusercontent.com/acme/skills/main/skills/audit/checklist.md": "- [ ] contrast\n",
    },
    seen,
  });

  const outcome = await installSkill({ owner: "acme", repo: "skills", dir, path: "audit" }, { fetchImpl });
  assert.equal(outcome.skill.name, "audit");
  assert.equal(outcome.skill.files, 2);
  assert.equal(outcome.skill.repo, "acme/skills");
  assert.equal(outcome.replaced, false);

  // Nested under the repository's layout on GitHub, flat in the skills directory.
  assert.ok(fs.existsSync(path.join(dir, "audit", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(dir, "audit", "checklist.md")));
  const provenance = JSON.parse(fs.readFileSync(path.join(dir, "audit", ".source.json"), "utf8")) as Record<string, unknown>;
  assert.equal(provenance.repo, "acme/skills");
  assert.equal(provenance.path, "skills/audit/SKILL.md");
  assert.equal(provenance.files, 2);
});

test("a token is sent when there is one, and not when there is not", async () => {
  const dir = workDir();
  const anonymous: { url: string; authorization?: string }[] = [];
  await installSkill(
    { owner: "acme", repo: "skills", dir, path: "audit" },
    { fetchImpl: fakeGitHub({ tree: ["skills/audit/SKILL.md"], seen: anonymous }) },
  );
  assert.equal(anonymous.every((call) => call.authorization === undefined), true);

  const authenticated: { url: string; authorization?: string }[] = [];
  await installSkill(
    { owner: "acme", repo: "skills", dir, path: "audit", token: "ghp_example" },
    { fetchImpl: fakeGitHub({ tree: ["skills/audit/SKILL.md"], seen: authenticated }) },
  );
  assert.equal(authenticated.every((call) => call.authorization === "Bearer ghp_example"), true, "every call, raw included");
});

test("a refusal from GitHub is a sentence, not a status code", async () => {
  const dir = workDir();
  const refused = (async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response) as SkillFetcher;
  await assert.rejects(
    () => installSkill({ owner: "acme", repo: "skills", dir }, { fetchImpl: refused }),
    /usually its hourly limit for anonymous callers; set GITHUB_TOKEN/,
  );
  await assert.rejects(
    () => installSkill({ owner: "acme", repo: "skills", dir, token: "ghp_x" }, { fetchImpl: refused }),
    /check it has access/,
  );
});

test("reinstalling replaces what was there rather than merging into it", async () => {
  const dir = workDir();
  fs.mkdirSync(path.join(dir, "audit"), { recursive: true });
  fs.writeFileSync(path.join(dir, "audit", "yesterday.md"), "old\n");

  const outcome = await installSkill(
    { owner: "acme", repo: "skills", dir, path: "audit" },
    { fetchImpl: fakeGitHub({ tree: ["skills/audit/SKILL.md"] }) },
  );
  assert.equal(outcome.replaced, true);
  assert.equal(fs.existsSync(path.join(dir, "audit", "yesterday.md")), false, "a skill is one snapshot at one ref");
});

test("a skill whose SKILL.md is empty leaves nothing behind", async () => {
  const dir = workDir();
  await assert.rejects(
    () =>
      installSkill(
        { owner: "acme", repo: "skills", dir, path: "audit" },
        { fetchImpl: fakeGitHub({ tree: ["skills/audit/SKILL.md"], raw: { "https://raw.githubusercontent.com/acme/skills/main/skills/audit/SKILL.md": "  \n" } }) },
      ),
    /no usable content/,
  );
  assert.equal(fs.existsSync(path.join(dir, "audit")), false);
});

/* ------------------------------------------------------------------ removal */

test("only what was installed is removed", async () => {
  const dir = workDir();
  await installSkill(
    { owner: "acme", repo: "skills", dir, path: "audit" },
    { fetchImpl: fakeGitHub({ tree: ["skills/audit/SKILL.md"] }) },
  );
  const removed = await removeSkill(path.join(dir, "audit"));
  assert.equal(removed.files >= 1, true);
  assert.equal(fs.existsSync(path.join(dir, "audit")), false);

  // Somebody's own hand-written directory has no provenance, so it is not ours.
  const own = path.join(dir, "mine");
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, "SKILL.md"), "---\nname: mine\n---\nbody\n");
  await assert.rejects(() => removeSkill(own), SkillInstallError);
  assert.equal(fs.existsSync(own), true, "and it is still there");
});
