/**
 * The lab's configuration, and the one thing a port can get quietly wrong.
 *
 * Three kinds of case are here, and the third is why this file exists.
 *
 * The first two are the Python's own (`OnTrak-dev/tests/test_config.py`): the defaults,
 * the precedence between file, environment and explicit overrides, the `__`-scoped
 * environment variable, the value shapes a `.env` really carries, and the refusals —
 * an unknown section key, and an `ONTRAK_...` variable left behind in a deployment's
 * environment, which must name the variable rather than the field.
 *
 * The third is structural. Eight modules were ported first and each of them took a
 * narrow settings-shaped interface instead of importing `config.ts`, which is the right
 * seam — and the risk that comes with it is that this module produces a tree those
 * modules cannot actually accept, and nobody finds out until a session starts. So the
 * last test hands a default tree to every one of those consumers. The assignments are
 * the assertion: **if any of them needed a cast, the shapes have drifted.**
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-config.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ConfigError,
  IncusConfig,
  SECTION_SCHEMAS,
  defaultTimeLimit,
  ensureDirs,
  guacSecretBytes,
  loadSettings,
  parseEnvValue,
  poolTargetFor,
  requireSecrets,
  scheduleToSchedule,
  settingsToDict,
} from "../src/lib/lab/config";
import { buildDriver, type GuestSettings as DriverGuestSettings } from "../src/lib/lab/guest";
import {
  type ConsoleSettings,
  type GuestSettings as ConsoleGuestSettings,
  type GuacSettings,
} from "../src/lib/lab/guac";
import { IncusClient, type IncusSettings } from "../src/lib/lab/incus";

/** A 128-bit key spelled the way a deployment spells it: 32 hex characters. */
const GUAC_KEY = "0123456789abcdef0123456789abcdef";

/** Run something that must fail, and hand back the error it threw. */
function errorFrom(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected a failure, and nothing was thrown");
}

/** Run something that must fail with a `ConfigError`. */
function configErrorFrom(run: () => unknown): ConfigError {
  const error = errorFrom(run);
  if (!(error instanceof ConfigError)) throw error;
  return error;
}

/* -------------------------------------------------------------------------- */
/*  The defaults, the precedence and the paths                                */
/* -------------------------------------------------------------------------- */

test("config: the defaults, and a relative path resolves against the root", () => {
  const settings = loadSettings({ file: { guest: { user: "alice" } }, env: {}, rootDir: "/srv/ontrak" });

  assert.equal(settings.guest.user, "alice");
  assert.equal(settings.incus.imageAlias, "ontrak-win-base");
  assert.equal(settings.incus.project, "ontrak");
  assert.equal(settings.session.ttlMinutes, 90);
  assert.equal(settings.pool.maxTotal, 60);
  assert.equal(settings.demo.enabled, false);

  // A relative `paths` entry is relative to the deployment root, not to the process.
  assert.equal(settings.scenariosDir, join("/srv/ontrak", "scenarios"));
  assert.equal(settings.lessonsDir, join("/srv/ontrak", "lessons"));
});

test("config: precedence is file, then environment, then explicit overrides", () => {
  const settings = loadSettings({
    file: { session: { ttl_minutes: 30 } },
    env: { ONTRAK_SESSION__TTL_MINUTES: "45" },
    overrides: { session: { ttl_minutes: 60 } },
  });

  assert.equal(settings.session.ttlMinutes, 60, "an explicit override beats the environment");
  assert.deepEqual([...settings.sourceFiles], ["<overrides>"]);

  const fromFile = loadSettings({ file: { session: { ttl_minutes: 30 } }, env: {} });
  assert.equal(fromFile.session.ttlMinutes, 30, "a file's snake_case key lands on its field");

  const fromEnv = loadSettings({ file: { session: { ttl_minutes: 30 } }, env: { ONTRAK_SESSION__TTL_MINUTES: "45" } });
  assert.equal(fromEnv.session.ttlMinutes, 45, "the environment beats the file");
});

test("config: the environment addresses a section with a double underscore", () => {
  const settings = loadSettings({
    env: {
      ONTRAK_GUEST__PASSWORD: "from-env",
      ONTRAK_SESSION__TTL_MINUTES: "15",
      ONTRAK_POOL__TARGETS: "{net-dns-failure: 30}",
      // Not a section-scoped override, and not our prefix: both ignored rather than
      // guessed at.
      IGNORED_KEY: "nope",
      ONTRAK_NOT_SCOPED: "nope",
    },
  });

  assert.equal(settings.guest.password, "from-env");
  assert.equal(settings.session.ttlMinutes, 15);
  assert.equal(poolTargetFor(settings.pool, "net-dns-failure"), 30);
  assert.equal(poolTargetFor(settings.pool, "other"), settings.pool.defaultTarget);
});

test("config: the shipped environment vocabulary is readable and unambiguous", () => {
  // The Python proved this by loading the shipped `.env.example`; the ported equivalent
  // is the schema itself, because the template is a deployment artifact of a later
  // stage and reading the sibling repository from a unit test would make `npm test`
  // depend on OnTrak-dev. What matters is the same thing: every key a deployment can
  // write reaches a field, and no two keys share one.
  for (const [name, schema] of Object.entries(SECTION_SCHEMAS)) {
    const keys = Object.keys(schema.fields);
    const fields = Object.values(schema.fields).map((spec) => spec.field);
    assert.ok(keys.length > 0, `${name} has no settings`);
    assert.equal(new Set(fields).size, fields.length, `${name} maps two keys onto one field`);
  }

  // The values a template really carries, including the ones that used to be a trap:
  // an empty mapping, and `false` as a string.
  const settings = loadSettings({
    env: {
      ONTRAK_GUAC__BASE_URL: "http://127.0.0.1:8080/guacamole/",
      ONTRAK_GUAC__RECORDING: "false",
      ONTRAK_SESSION__TTL_MINUTES: "90",
      ONTRAK_POOL__TARGETS: "{}",
    },
  });
  assert.equal(settings.guac.baseUrl.endsWith("/guacamole/"), true);
  assert.equal(settings.guac.recording, false, "the string \"false\" is false, not truthy");
  assert.equal(settings.session.ttlMinutes, 90);
  assert.deepEqual(settings.pool.targets, {});
});

test("config: a relative state path is created only when asked, and an absolute one is kept", () => {
  const root = mkdtempSync(join(tmpdir(), "ontrak-lab-config-"));
  try {
    const settings = loadSettings({ env: {}, rootDir: root });
    assert.equal(settings.stateDir, join(root, "state"));
    assert.equal(existsSync(settings.stateDir), false, "loading config is not a side effect");

    ensureDirs(settings);
    assert.equal(existsSync(settings.stateDir), true);
    assert.equal(existsSync(settings.mediaDir), true);

    const absolute = join(root, "elsewhere");
    const overridden = loadSettings({ env: {}, rootDir: root, overrides: { paths: { state: absolute } } });
    assert.equal(overridden.stateDir, absolute);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/*  The refusals                                                              */
/* -------------------------------------------------------------------------- */

test("config: a key no field knows is refused, naming the section", () => {
  const error = configErrorFrom(() => loadSettings({ file: { guest: { nope: 1 } }, env: {} }));
  assert.match(error.message, /unknown setting/);
  assert.match(error.message, /GuestConfig/);
});

test("config: an environment variable that names nothing names the variable to delete", () => {
  // The real failure this exists for: a spent `ONTRAK_GUAC__PUBLIC_PORT` in an
  // operator's `.env` made every command that loaded config die on a bare field name.
  const error = configErrorFrom(() => loadSettings({ env: { ONTRAK_GUAC__PUBLIC_PORT: "8081" } }));
  assert.match(error.message, /unknown setting ONTRAK_GUAC__PUBLIC_PORT/);
});

test("config: a section the app does not model stays ignored", () => {
  // Other tooling shares the environment, so `ONTRAK_FOO__BAR` must not become a boot
  // failure — the strict check is for the app's own sections only.
  const settings = loadSettings({ env: { ONTRAK_FOO__BAR: "1" } });
  assert.equal(settings.guac.baseUrl.length > 0, true);
});

test("config: a value that is not the field's kind is refused, naming the variable", () => {
  // The Python handed every parsed value straight to a dataclass, so `ttl_minutes=abc`
  // loaded fine and broke later with a type error far from the typo.
  const error = configErrorFrom(() => loadSettings({ env: { ONTRAK_SESSION__TTL_MINUTES: "abc" } }));
  assert.match(error.message, /ONTRAK_SESSION__TTL_MINUTES/);
  assert.match(error.message, /whole number/);

  const list = configErrorFrom(() => loadSettings({ env: { ONTRAK_INCUS__KNOWN_WORKLOADS: "ubuntu-24.04" } }));
  assert.match(list.message, /must be a list/);
});

/* -------------------------------------------------------------------------- */
/*  Environment values, in the shapes a `.env` uses                           */
/* -------------------------------------------------------------------------- */

test("config: an environment value is parsed the way YAML parsed it", () => {
  assert.deepEqual(parseEnvValue("{net-dns-failure: 30}"), { "net-dns-failure": 30 });
  assert.deepEqual(parseEnvValue("[45, 90]"), [45, 90]);
  assert.equal(parseEnvValue("true"), true);
  assert.equal(parseEnvValue("yes"), true);
  assert.equal(parseEnvValue("off"), false);
  assert.equal(parseEnvValue("15"), 15);
  assert.equal(parseEnvValue("3.5"), 3.5);
  assert.equal(parseEnvValue('"15"'), "15", "a quoted number is a string, as YAML says");
  assert.equal(parseEnvValue(""), null, "an empty value is null, as YAML says");

  // Outside the subset the fallback is the raw string, exactly as the Python fell back
  // on a YAML error — no half-parsed value is ever handed on.
  assert.equal(parseEnvValue("a: b"), "a: b");
  assert.equal(parseEnvValue("{unclosed"), "{unclosed");
  assert.equal(parseEnvValue("  bang  "), "  bang  ");
});

test("config: a flow sequence of mappings reaches the schedule section intact", () => {
  const settings = loadSettings({
    env: { ONTRAK_SCHEDULE__ENABLED: "true", ONTRAK_SCHEDULE__WINDOWS: '[{day: mon, scenarios: [net-dns-failure]}]' },
  });
  assert.equal(settings.schedule.enabled, true);
  assert.equal(settings.schedule.windows.length, 1);
});

/* -------------------------------------------------------------------------- */
/*  Secrets                                                                   */
/* -------------------------------------------------------------------------- */

test("config: the guac key parses from a file and from the environment", () => {
  const fromFile = loadSettings({ env: {}, overrides: { guac: { secret_key: GUAC_KEY } } });
  assert.deepEqual(guacSecretBytes(fromFile.guac), Buffer.from(GUAC_KEY, "hex"));
  assert.equal(guacSecretBytes(fromFile.guac).length, 16, "128-bit AES, not 32 bytes");

  const fromEnv = loadSettings({ env: { ONTRAK_GUAC__SECRET_KEY: GUAC_KEY } });
  assert.deepEqual(guacSecretBytes(fromEnv.guac), guacSecretBytes(fromFile.guac));
});

test("config: a guac key that is not 32 hex characters is refused", () => {
  const settings = loadSettings({ env: {}, overrides: { guac: { secret_key: "short" } } });
  const error = errorFrom(() => guacSecretBytes(settings.guac));
  assert.match(error.message, /32 hex/);
});

test("config: requireSecrets reports each missing secret, and demo mode needs none", () => {
  const problems = requireSecrets(
    loadSettings({
      env: {},
      overrides: { guest: { password: "" }, portal: { secret: "" }, guac: { secret_key: "" } },
    }),
  );
  assert.equal(problems.length, 3);
  assert.equal(problems.some((problem) => problem.includes("guest.password")), true);
  assert.equal(problems.some((problem) => problem.includes("portal.secret")), true);
  assert.equal(problems.some((problem) => /32 hex/.test(problem)), true);

  // A demo never touches a hypervisor or a guest, which is what makes "clone and try
  // it" a two-command experience.
  assert.deepEqual(requireSecrets(loadSettings({ env: {}, overrides: { demo: { enabled: true } } })), []);

  const ready = loadSettings({
    env: {},
    overrides: { guest: { password: "secret" }, portal: { secret: "secret" }, guac: { secret_key: GUAC_KEY } },
  });
  assert.deepEqual(requireSecrets(ready), []);
});

/* -------------------------------------------------------------------------- */
/*  Names, derivation and the schedule                                        */
/* -------------------------------------------------------------------------- */

test("config: the instance name helpers build and parse the same names back", () => {
  const incus = loadSettings({ env: {} }).incus;
  assert.equal(incus.templateName("Net DNS Failure"), "tpl-net-dns-failure");
  assert.equal(incus.poolName("sw-app-crash", 3), "ontrak-pool-sw-app-crash-3");
  assert.equal(incus.sessionName("hw_driver_device", 12).startsWith("ontrak-sess-hw-driver-device-"), true);

  assert.deepEqual(incus.parsePoolName("ontrak-pool-net-dns-failure-2"), {
    scenario: "net-dns-failure",
    workload: "",
    index: 2,
  });
  assert.equal(incus.parsePoolName("not-a-pool-x"), null);

  // A catalog id keeps its dots while a name is slugified, so the workload is matched
  // on its slug and returned as the id it came from — that is what keeps a pooled
  // machine attributable to the catalogue entry it was built from.
  const withWorkloads = new IncusConfig({ knownWorkloads: ["ubuntu-24.04"] });
  assert.deepEqual(withWorkloads.parsePoolName("ontrak-pool-net-dns-failure-ubuntu-24-04-1"), {
    scenario: "net-dns-failure",
    workload: "ubuntu-24.04",
    index: 1,
  });
  assert.deepEqual(withWorkloads.parseTemplateName("tpl-net-dns-failure-ubuntu-24-04"), {
    scenario: "net-dns-failure",
    workload: "ubuntu-24.04",
  });
});

test("config: the time limit default, and the schedule the scheduler reads", () => {
  assert.equal(defaultTimeLimit(loadSettings({ env: {} }).session), 45);
  assert.equal(
    defaultTimeLimit(loadSettings({ env: { ONTRAK_SESSION__TIME_LIMIT_CHOICES: "[]" } }).session),
    90,
    "no choices falls back to the site's TTL",
  );

  assert.equal(scheduleToSchedule(loadSettings({ env: {} }).schedule).enabled, false);
  assert.equal(scheduleToSchedule(loadSettings({ env: { ONTRAK_SCHEDULE__ENABLED: "true" } }).schedule).enabled, true);
});

test("config: the tree as plain data is keyed the way an operator writes it", () => {
  const dict = settingsToDict(loadSettings({ env: { ONTRAK_GUEST__USER: "alice" } }));
  assert.equal((dict.guest as Record<string, unknown>).user, "alice");
  assert.equal((dict.incus as Record<string, unknown>).image_alias, "ontrak-win-base");
  assert.deepEqual(dict.source_files, []);
});

/* -------------------------------------------------------------------------- */
/*  The structural check: the consumers really accept this tree                */
/* -------------------------------------------------------------------------- */

test("config: a default tree is accepted by every ported consumer, with no cast", () => {
  const settings = loadSettings({ env: {} });

  // Compile-time assertions, as much as runtime ones. Each of these modules took a
  // narrow settings-shaped interface rather than importing this file, which is the
  // right seam — and a cast on any of these lines would mean this module produces a
  // shape they cannot actually use.
  const incus: IncusSettings = settings.incus;
  const driverSettings: DriverGuestSettings = settings.guest;
  const consoleGuest: ConsoleGuestSettings = settings.guest;
  const consoleSettings: ConsoleSettings = settings;
  const guac: GuacSettings = settings.guac;
  const idle: { readonly idleRecycleMinutes?: number } = settings.session;

  assert.equal(incus.remote, "local");
  assert.equal(incus.operationTimeoutSeconds, 300);
  assert.equal(driverSettings.linuxDriver, "incus-shell");
  assert.equal(driverSettings.linuxUser, "root");
  assert.equal(driverSettings.rdpPort, 3389);
  assert.equal(consoleGuest.sshPort, 22);
  assert.equal(guac.linkTtlMinutes, 480);
  assert.equal(guac.serverLayout, "en-us-qwerty");
  assert.equal(idle.idleRecycleMinutes, 20);

  // And the constructors really take it. The default driver building is the assertion
  // that matters most: the Python defaulted to `winrm`, which this port cannot build,
  // so a default that had kept that name would throw here — loudly, which is the point.
  assert.equal(settings.guest.driver, "incus-exec", "the ported default, because WinRM is not ported");
  const client = new IncusClient(settings.incus);
  assert.equal(client.settings.project, "ontrak");
  assert.doesNotThrow(() => buildDriver(settings.guest));
  assert.equal(consoleSettings.guac.baseUrl, "http://127.0.0.1:8080/guacamole/");
});
