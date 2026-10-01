import assert from "node:assert/strict";
import test from "node:test";

/**
 * Which address is published, and which one never is.
 *
 * The bug this exists to prevent is not a crash: it is a URL that looks correct.
 * `172.17.0.1` resolves for the host that produced it and refuses for everyone
 * else, so a deployment that advertises it hands a gateway an address that will
 * fail — and the failure reads as the gateway's. The rule is the platform's own
 * (`stack_lib_lan_ip`): a docker bridge or loopback address is never an upstream.
 */

process.env.AGENT_LAN_IP = "192.168.1.21";
// Never dialled: nothing here runs a turn, and the import must not either.
process.env.OMNIROUTE_URL = "http://127.0.0.1:9/v1";

const { addressFor, detectLanAddress, isPublishable, lanAddress } = await import("../network.js");

test("what may be published", async (t) => {
  await t.test("loopback is never an address to hand out", () => {
    assert.equal(isPublishable("127.0.0.1"), false);
    assert.equal(isPublishable("127.1.2.3"), false);
  });

  await t.test("docker's bridge pools are refused", () => {
    for (const bridge of ["172.17.0.1", "172.18.0.1", "172.23.0.1", "172.31.255.254"]) {
      assert.equal(isPublishable(bridge), false, `${bridge} is a docker bridge address`);
    }
    // Outside the pool, 172/8 is an ordinary private address.
    assert.equal(isPublishable("172.32.0.5"), true);
    assert.equal(isPublishable("172.15.0.5"), true);
  });

  await t.test("link-local is refused", () => {
    assert.equal(isPublishable("169.254.169.254"), false);
  });

  await t.test("LAN addresses are what this is for", () => {
    assert.equal(isPublishable("192.168.1.21"), true);
    assert.equal(isPublishable("10.0.0.5"), true);
  });

  await t.test("an empty or non-IPv4 value is not an address", () => {
    assert.equal(isPublishable(""), false);
    assert.equal(isPublishable("genie.example"), false);
    assert.equal(isPublishable("2001:db8::1"), false);
  });
});

test("which address this deployment uses", async (t) => {
  await t.test("a configured address wins, because it was named for a reason", () => {
    // This process is in a container whose own interfaces are bridges; the
    // deployment's answer is the one that matters.
    assert.equal(lanAddress(), "192.168.1.21");
  });

  await t.test("detection never returns a bridge or loopback address", () => {
    const detected = detectLanAddress();
    if (detected !== null) assert.equal(isPublishable(detected), true, detected);
  });
});

test("the URL that gets handed out", async (t) => {
  await t.test("a port and a host make an address", () => {
    assert.equal(addressFor("192.168.1.21", 5173), "http://192.168.1.21:5173/");
  });

  await t.test("neither half alone is an address", () => {
    assert.equal(addressFor(null, 5173), null);
    assert.equal(addressFor("192.168.1.21", null), null);
    assert.equal(addressFor("", 5173), null);
  });

  await t.test("a bare IPv6 address is bracketed or it is not a URL", () => {
    assert.equal(addressFor("2001:db8::1", 8080), "http://[2001:db8::1]:8080/");
  });
});
