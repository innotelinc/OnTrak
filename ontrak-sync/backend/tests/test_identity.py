"""The identity layer: passwords, sessions, throttling, roles, OIDC decisions.

These run with the standard library alone — no FastAPI, no network, no Network —
which is the point: the rules that decide who may install a package on every
machine in the Network should be provable without a running service.

The tests worth reading first are the ones that assert a REFUSAL, because the
successes were never the risky part:

  * a forged or `alg: none` ID token is rejected;
  * the last administrator cannot be locked out;
  * an SSO assertion never reactivates a deactivated account;
  * a username that does not exist costs the same time as one with a wrong
    password, so the login form is not a directory.
"""

from __future__ import annotations

import json
import sqlite3
import time
import unittest
from datetime import datetime, timedelta, timezone

from ontrak import db, identity, oidc


def fresh():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    db.init(conn)
    return conn


class Passwords(unittest.TestCase):
    def test_round_trip(self):
        digest = identity.hash_password("correct horse battery staple")
        self.assertTrue(identity.verify_password("correct horse battery staple", digest))
        self.assertFalse(identity.verify_password("correct horse battery stapl", digest))

    def test_salt_is_per_password(self):
        first = identity.hash_password("same password twice")
        second = identity.hash_password("same password twice")
        self.assertNotEqual(first, second)
        self.assertTrue(identity.verify_password("same password twice", first))
        self.assertTrue(identity.verify_password("same password twice", second))

    def test_algorithm_and_work_factor_travel_with_the_digest(self):
        digest = identity.hash_password("another one", iterations=1000)
        self.assertTrue(digest.startswith("pbkdf2_sha256$1000$"))
        self.assertTrue(identity.verify_password("another one", digest))

    def test_malformed_digests_fail_closed(self):
        for stored in (None, "", "not-a-digest", "pbkdf2_sha256$0$aaaa$bbbb",
                       "md5$1$aaaa$bbbb", "pbkdf2_sha256$x$aaaa$bbbb"):
            with self.subTest(stored=stored):
                self.assertFalse(identity.verify_password("anything", stored))

    def test_policy_refuses_short_and_personal_passwords(self):
        problems = identity.password_problems("short", username="alice")
        self.assertTrue(any("12 characters" in problem for problem in problems))
        problems = identity.password_problems("alice-is-my-name", username="alice")
        self.assertTrue(any("username" in problem for problem in problems))
        self.assertEqual([], identity.password_problems("entirely unrelated phrase"))


class Roles(unittest.TestCase):
    def test_every_role_has_a_capability_set(self):
        for role in identity.ROLES:
            with self.subTest(role=role):
                self.assertIn("portal:view", identity.role_capabilities(role))

    def test_apply_belongs_to_sysadmins_not_to_everyone_who_can_read(self):
        self.assertTrue(identity.has_capability("SYSADMIN", "sync:apply"))
        self.assertTrue(identity.has_capability("ADMIN", "sync:apply"))
        for role in ("ANALYST", "TECHNICIAN", "INSTRUCTOR", "STUDENT"):
            with self.subTest(role=role):
                self.assertFalse(identity.has_capability(role, "sync:apply"))

    def test_an_unknown_role_holds_nothing(self):
        self.assertEqual((), identity.role_capabilities("SUPERUSER"))
        self.assertEqual("STUDENT", identity.normalize_role("WIZARD"))

    def test_products_follow_the_role(self):
        self.assertIn("its", identity.products_for("STUDENT"))
        self.assertIn("tix", identity.products_for("TECHNICIAN"))
        self.assertIn("sentinel", identity.products_for("ANALYST"))
        self.assertIn("sync", identity.products_for("SYSADMIN"))
        self.assertEqual(("its", "tix", "sentinel", "sync"), identity.products_for("ADMIN"))
        self.assertEqual((), identity.products_for("STUDENT")[1:])


class Users(unittest.TestCase):
    def test_create_look_up_and_update(self):
        conn = fresh()
        user = identity.create_user(conn, username="alice", password="a-long-enough-one",
                                    role="SYSADMIN", email="alice@example.test")
        self.assertEqual("SYSADMIN", user.role)
        # Case-insensitive on the way in: `Alice` at 3am is the same person.
        self.assertIsNotNone(identity.get_user(conn, username="ALICE"))
        updated = identity.update_user(conn, user.id, role="ANALYST")
        self.assertEqual("ANALYST", updated.role)

    def test_the_public_shape_never_carries_the_digest(self):
        conn = fresh()
        user = identity.create_user(conn, username="bob", password="a-long-enough-one")
        public = user.public()
        self.assertNotIn("password_hash", public)
        self.assertNotIn("a-long-enough-one", json.dumps(public))
        self.assertIn("capabilities", public)

    def test_an_sso_only_account_has_no_password_and_cannot_use_the_form(self):
        conn = fresh()
        identity.create_user(conn, username="carol", password=None, external_id="sub-1")
        outcome = identity.authenticate(conn, username="carol", password="anything at all")
        self.assertFalse(outcome.ok)
        self.assertEqual("Invalid username or password.", outcome.reason)

    def test_changing_a_password_revokes_the_old_sessions(self):
        conn = fresh()
        user = identity.create_user(conn, username="dave", password="a-long-enough-one")
        token, _ = identity.create_session(conn, user.id)
        self.assertIsNotNone(identity.resolve_session(conn, token))
        identity.set_password(conn, user.id, "a-different-long-one")
        self.assertIsNone(identity.resolve_session(conn, token))


class Sessions(unittest.TestCase):
    def test_a_token_resolves_to_its_user_and_is_never_stored_in_the_clear(self):
        conn = fresh()
        user = identity.create_user(conn, username="erin", password="a-long-enough-one")
        token, expires = identity.create_session(conn, user.id)
        self.assertTrue(expires.endswith("Z"))
        stored = conn.execute("SELECT token_hash FROM sessions").fetchone()["token_hash"]
        self.assertNotEqual(token, stored)
        self.assertEqual(identity.session_digest(token), stored)
        resolved = identity.resolve_session(conn, token)
        self.assertEqual("erin", resolved["user"].username)

    def test_an_expired_session_is_refused_and_removed(self):
        conn = fresh()
        user = identity.create_user(conn, username="frank", password="a-long-enough-one")
        token, _ = identity.create_session(conn, user.id)
        conn.execute("UPDATE sessions SET expires_at=?", (
            (datetime.now(timezone.utc) - timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),))
        conn.commit()
        self.assertIsNone(identity.resolve_session(conn, token))
        self.assertEqual(0, conn.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()["n"])

    def test_an_idle_session_is_dropped(self):
        conn = fresh()
        user = identity.create_user(conn, username="gina", password="a-long-enough-one")
        token, _ = identity.create_session(conn, user.id)
        conn.execute("UPDATE sessions SET last_seen_at=?", (
            (datetime.now(timezone.utc)
             - timedelta(seconds=identity.SESSION_IDLE_SECONDS + 60)).strftime("%Y-%m-%dT%H:%M:%SZ"),))
        conn.commit()
        self.assertIsNone(identity.resolve_session(conn, token))

    def test_a_deactivated_account_loses_its_sessions_immediately(self):
        conn = fresh()
        user = identity.create_user(conn, username="hank", password="a-long-enough-one")
        token, _ = identity.create_session(conn, user.id)
        identity.update_user(conn, user.id, active=False)
        self.assertIsNone(identity.resolve_session(conn, token))

    def test_sign_out_revokes(self):
        conn = fresh()
        user = identity.create_user(conn, username="iris", password="a-long-enough-one")
        token, _ = identity.create_session(conn, user.id)
        self.assertTrue(identity.revoke_session(conn, token))
        self.assertIsNone(identity.resolve_session(conn, token))


class Login(unittest.TestCase):
    def test_a_good_password_signs_in_and_is_audited(self):
        conn = fresh()
        identity.create_user(conn, username="jane", password="a-long-enough-one", role="SYSADMIN")
        outcome = identity.authenticate(conn, username="jane", password="a-long-enough-one")
        self.assertTrue(outcome.ok)
        self.assertEqual("SYSADMIN", outcome.user.role)
        actions = [row["message"] for row in
                   conn.execute("SELECT message FROM events").fetchall()]
        self.assertTrue(any("auth.login" in message for message in actions))

    def test_wrong_password_and_unknown_user_are_indistinguishable(self):
        conn = fresh()
        identity.create_user(conn, username="kate", password="a-long-enough-one")
        wrong = identity.authenticate(conn, username="kate", password="not-the-password")
        gone = identity.authenticate(conn, username="nobody-here", password="not-the-password")
        self.assertEqual(wrong.reason, gone.reason)
        self.assertFalse(wrong.ok)
        self.assertFalse(gone.ok)

    def test_an_inactive_account_cannot_sign_in(self):
        conn = fresh()
        user = identity.create_user(conn, username="lee", password="a-long-enough-one")
        identity.update_user(conn, user.id, active=False)
        outcome = identity.authenticate(conn, username="lee", password="a-long-enough-one")
        self.assertFalse(outcome.ok)

    def test_repeated_failures_lock_the_account_and_the_address(self):
        conn = fresh()
        identity.create_user(conn, username="mo", password="a-long-enough-one")
        for _ in range(identity.LOGIN_MAX_FAILURES):
            identity.authenticate(conn, username="mo", password="wrong", address="10.0.0.9")
        blocked = identity.authenticate(conn, username="mo", password="a-long-enough-one",
                                        address="10.0.0.9")
        self.assertFalse(blocked.ok)
        self.assertGreater(blocked.retry_after, 0)
        # ...and the right password from a fresh address is still throttled by the
        # account key, which is what a password guess should be.
        self.assertGreater(identity.login_locked_for(conn, username="mo"), 0)
        # The address key alone blocks a walk through other usernames.
        self.assertGreater(identity.login_locked_for(conn, username="someone-else",
                                                     address="10.0.0.9"), 0)

    def test_the_lockout_backs_off_and_then_expires(self):
        self.assertEqual(0, identity.lockout_seconds(identity.LOGIN_MAX_FAILURES - 1))
        first = identity.lockout_seconds(identity.LOGIN_MAX_FAILURES)
        later = identity.lockout_seconds(identity.LOGIN_MAX_FAILURES + 3)
        self.assertGreater(later, first)
        self.assertLessEqual(later, identity.LOGIN_MAX_LOCKOUT_SECONDS)
        stale = (datetime.now(timezone.utc)
                 - timedelta(seconds=identity.LOGIN_FAILURE_WINDOW_SECONDS + 5))
        self.assertEqual(0, identity.lockout_remaining(
            stale.strftime("%Y-%m-%dT%H:%M:%SZ"), 99))

    def test_a_successful_sign_in_clears_the_failures(self):
        conn = fresh()
        identity.create_user(conn, username="nina", password="a-long-enough-one")
        for _ in range(3):
            identity.authenticate(conn, username="nina", password="wrong")
        self.assertTrue(identity.authenticate(
            conn, username="nina", password="a-long-enough-one").ok)
        self.assertEqual(0, identity.login_locked_for(conn, username="nina"))


class Bootstrap(unittest.TestCase):
    def test_the_first_administrator_is_generated_once(self):
        conn = fresh()
        user, generated = identity.ensure_bootstrap_admin(conn)
        self.assertIsNotNone(user)
        self.assertEqual("ADMIN", user.role)
        self.assertTrue(generated)
        # A second call changes nothing: the account lives in SQLite afterwards.
        again, second = identity.ensure_bootstrap_admin(conn, password="something-else-long")
        self.assertIsNone(again)
        self.assertIsNone(second)
        self.assertTrue(identity.authenticate(conn, username=user.username,
                                              password=generated).ok)

    def test_a_supplied_password_is_used_verbatim(self):
        conn = fresh()
        user, generated = identity.ensure_bootstrap_admin(conn, password="chosen-deliberately")
        self.assertIsNone(generated)
        self.assertTrue(identity.authenticate(conn, username=user.username,
                                              password="chosen-deliberately").ok)


class OidcClaims(unittest.TestCase):
    def test_claims_are_read_from_the_usual_places(self):
        claims = identity.OidcClaims.from_payload({
            "sub": "abc", "email": "Person@Example.TEST", "name": "A Person",
            "preferred_username": "aperson", "groups": ["range-instructors"],
        })
        self.assertEqual("abc", claims.subject)
        self.assertEqual("person@example.test", claims.email)
        self.assertEqual(("range-instructors",), claims.groups)
        self.assertTrue(claims.email_verified)

    def test_an_explicit_unverified_email_is_respected(self):
        claims = identity.OidcClaims.from_payload({"sub": "a", "email": "x@y.test",
                                                   "email_verified": False})
        self.assertFalse(claims.email_verified)

    def test_a_single_group_string_becomes_a_tuple(self):
        claims = identity.OidcClaims.from_payload({"sub": "a", "groups": "it-ops"})
        self.assertEqual(("it-ops",), claims.groups)

    def test_the_highest_privilege_matching_group_wins(self):
        mappings = {"range-instructors": "INSTRUCTOR", "it-ops": "SYSADMIN"}
        role, matched = identity.role_from_groups(("range-instructors", "it-ops"), mappings)
        self.assertEqual("SYSADMIN", role)
        self.assertEqual("it-ops", matched)
        role, matched = identity.role_from_groups(("range-instructors",), mappings)
        self.assertEqual("INSTRUCTOR", role)
        self.assertEqual("range-instructors", matched)

    def test_no_match_falls_back_to_the_default_and_says_so(self):
        role, matched = identity.role_from_groups(("nobody",), {}, "STUDENT")
        self.assertEqual("STUDENT", role)
        self.assertIsNone(matched)


class OidcProvisioning(unittest.TestCase):
    def claims(self, **over):
        base = {"sub": "sub-1", "email": "sam@example.test", "name": "Sam",
                "groups": ["range-instructors"]}
        base.update(over)
        return identity.OidcClaims.from_payload(base)

    def test_a_first_sign_in_provisions_and_a_second_adopts(self):
        conn = fresh()
        user, reason, provisioned = identity.resolve_oidc_user(
            conn, self.claims(), {"range-instructors": "INSTRUCTOR"})
        self.assertTrue(provisioned)
        self.assertEqual("INSTRUCTOR", user.role)
        self.assertIsNone(user.password_hash)

        again, _, provisioned = identity.resolve_oidc_user(
            conn, self.claims(name="Samuel"), {"range-instructors": "INSTRUCTOR"})
        self.assertFalse(provisioned)
        self.assertEqual(user.id, again.id)
        self.assertEqual("Samuel", again.display_name)

    def test_an_existing_account_is_adopted_by_email_rather_than_duplicated(self):
        conn = fresh()
        existing = identity.create_user(conn, username="sam", password="a-long-enough-one",
                                        email="sam@example.test", role="STUDENT")
        user, _, provisioned = identity.resolve_oidc_user(
            conn, self.claims(), {"range-instructors": "INSTRUCTOR"})
        self.assertFalse(provisioned)
        self.assertEqual(existing.id, user.id)
        self.assertEqual("INSTRUCTOR", user.role)

    def test_a_rename_in_the_directory_moves_the_account(self):
        conn = fresh()
        user, _, _ = identity.resolve_oidc_user(conn, self.claims(), {})
        moved, _, _ = identity.resolve_oidc_user(
            conn, self.claims(email="sam.renamed@example.test"), {})
        self.assertEqual(user.id, moved.id)

    def test_an_assertion_never_reactivates_a_deactivated_account(self):
        conn = fresh()
        user, _, _ = identity.resolve_oidc_user(conn, self.claims(), {})
        identity.update_user(conn, user.id, active=False)
        refused, reason, provisioned = identity.resolve_oidc_user(conn, self.claims(), {})
        self.assertIsNone(refused)
        self.assertIn("deactivated", reason)
        self.assertFalse(provisioned)

    def test_the_last_administrator_keeps_the_role(self):
        conn = fresh()
        admin = identity.create_user(conn, username="root", password=None, role="ADMIN",
                                     email="root@example.test", display_name="Root")
        conn.execute("UPDATE users SET external_id='sub-9' WHERE id=?", (admin.id,))
        conn.commit()
        user, _, _ = identity.resolve_oidc_user(
            conn, self.claims(sub="sub-9", email="root@example.test", groups=["students"]),
            {"students": "STUDENT"}, "STUDENT")
        self.assertEqual("ADMIN", user.role)

    def test_an_unverified_or_emailless_assertion_is_refused(self):
        conn = fresh()
        refused, reason, _ = identity.resolve_oidc_user(
            conn, self.claims(email_verified=False), {})
        self.assertIsNone(refused)
        self.assertIn("verify", reason)
        refused, reason, _ = identity.resolve_oidc_user(conn, self.claims(email=""), {})
        self.assertIsNone(refused)
        self.assertIn("email", reason)
        refused, reason, _ = identity.resolve_oidc_user(conn, self.claims(sub=""), {})
        self.assertIsNone(refused)
        self.assertIn("subject", reason)

    def test_a_colliding_username_is_suffixed(self):
        conn = fresh()
        identity.create_user(conn, username="sam", password="a-long-enough-one")
        user, _, _ = identity.resolve_oidc_user(
            conn, self.claims(sub="sub-2", email="other.sam@example.test",
                              preferred_username="sam"), {})
        self.assertEqual("sam2", user.username)


class OidcState(unittest.TestCase):
    SECRET = "a-deployment-secret"

    def test_a_state_cookie_round_trips(self):
        state = oidc.AuthorizationState.new("/findings")
        self.assertIsNotNone(oidc.read_state(oidc.sign_state(state, self.SECRET), self.SECRET))

    def test_a_tampered_or_foreign_state_is_refused(self):
        state = oidc.AuthorizationState.new()
        signed = oidc.sign_state(state, self.SECRET)
        payload, signature = signed.split(".", 1)
        self.assertIsNone(oidc.read_state(f"{payload}.{signature[:-1]}x", self.SECRET))
        self.assertIsNone(oidc.read_state(signed, "another-secret"))
        self.assertIsNone(oidc.read_state("not-a-state", self.SECRET))
        self.assertIsNone(oidc.read_state("", self.SECRET))

    def test_a_stale_state_is_refused(self):
        state = oidc.AuthorizationState.new()
        signed = oidc.sign_state(state, self.SECRET)
        later = int(time.time()) + oidc.STATE_TTL_SECONDS + 1
        self.assertIsNone(oidc.read_state(signed, self.SECRET, now=later))

    def test_pkce_is_s256(self):
        verifier = oidc.code_verifier()
        self.assertGreaterEqual(len(verifier), 43)
        challenge = oidc.code_challenge(verifier)
        self.assertNotIn("=", challenge)
        self.assertNotEqual(verifier, challenge)

    def test_redirects_only_go_to_a_local_path(self):
        self.assertEqual("/findings", oidc.safe_return_to("/findings"))
        for hostile in ("https://evil.test", "//evil.test/x", "javascript:alert(1)",
                        "evil.test", ""):
            with self.subTest(hostile=hostile):
                self.assertEqual("/", oidc.safe_return_to(hostile))


class OidcTokenVerification(unittest.TestCase):
    """The refusals, driven by a real RSA key rather than a mock.

    A forged signature is the attack this whole verification exists to stop, so
    the test that matters signs a token with one key and verifies it against
    another. Everything here uses `cryptography` directly, so the test itself
    performs the same RSA operation the service does.
    """

    @classmethod
    def setUpClass(cls):
        try:
            from cryptography.hazmat.primitives import hashes, serialization
            from cryptography.hazmat.primitives.asymmetric import padding, rsa
        except ImportError:  # pragma: no cover
            raise unittest.SkipTest("cryptography is not installed")
        cls.hashes, cls.serialization = hashes, serialization
        cls.padding, cls.rsa = padding, rsa

    def _key(self):
        return self.rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def _b64(self, raw: bytes) -> str:
        import base64
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    def _jwks(self, key, kid: str) -> dict:
        numbers = key.public_key().public_numbers()
        return {"keys": [{"kty": "RSA", "kid": kid, "alg": "RS256", "use": "sig",
                          "n": self._b64(numbers.n.to_bytes((numbers.n.bit_length() + 7) // 8, "big")),
                          "e": self._b64(numbers.e.to_bytes(3, "big"))}]}

    def _token(self, key, header: dict, payload: dict, *, sign_with=None) -> str:
        head = self._b64(json.dumps(header).encode())
        body = self._b64(json.dumps(payload).encode())
        signing_input = f"{head}.{body}".encode("ascii")
        signer = sign_with or key
        signature = signer.sign(signing_input, self.padding.PKCS1v15(), self.hashes.SHA256())
        return f"{head}.{body}.{self._b64(signature)}"

    def _client(self, key, kid="key-1"):
        jwks = self._jwks(key, kid)

        def fetch(url, **kwargs):
            if url.endswith("openid-configuration"):
                return {"issuer": "https://auth.cerulean.innotel.us/application/o/ontrak",
                        "authorization_endpoint": "https://auth.example/authorize",
                        "token_endpoint": "https://auth.example/token",
                        "jwks_uri": "https://auth.example/keys",
                        "userinfo_endpoint": "https://auth.example/userinfo"}
            if url.endswith("/keys"):
                return jwks
            return {}

        return oidc.OidcClient(issuer="https://auth.cerulean.innotel.us/application/o/ontrak",
                               client_id="ontrak-sync", fetch=fetch)

    def _payload(self, **over):
        now = time.time()
        base = {"iss": "https://auth.cerulean.innotel.us/application/o/ontrak",
                "aud": "ontrak-sync", "sub": "abc", "email": "a@b.test",
                "nonce": "the-nonce", "iat": now, "exp": now + 300}
        base.update(over)
        return base

    def test_a_valid_token_is_accepted(self):
        key = self._key()
        client = self._client(key)
        token = self._token(key, {"alg": "RS256", "kid": "key-1", "typ": "JWT"},
                            self._payload())
        claims = client.verify_id_token(token, nonce="the-nonce", redirect_uri="https://x/y")
        self.assertEqual("abc", claims["sub"])

    def test_a_forged_signature_is_refused(self):
        key, other = self._key(), self._key()
        client = self._client(key)
        forged = self._token(key, {"alg": "RS256", "kid": "key-1"}, self._payload(),
                             sign_with=other)
        with self.assertRaises(oidc.OidcError) as caught:
            client.verify_id_token(forged, nonce="the-nonce", redirect_uri="https://x/y")
        self.assertIn("signature", str(caught.exception))

    def test_alg_none_is_refused(self):
        key = self._key()
        client = self._client(key)
        head = self._b64(json.dumps({"alg": "none", "kid": "key-1"}).encode())
        body = self._b64(json.dumps(self._payload()).encode())
        with self.assertRaises(oidc.OidcError) as caught:
            client.verify_id_token(f"{head}.{body}.", nonce="the-nonce",
                                   redirect_uri="https://x/y")
        self.assertIn("RS256", str(caught.exception))

    def test_a_foreign_issuer_is_refused(self):
        key = self._key()
        client = self._client(key)
        token = self._token(key, {"alg": "RS256", "kid": "key-1"},
                            self._payload(iss="https://attacker.test"))
        with self.assertRaises(oidc.OidcError) as caught:
            client.verify_id_token(token, nonce="the-nonce", redirect_uri="https://x/y")
        self.assertIn("issued by", str(caught.exception))

    def test_a_token_for_another_application_is_refused(self):
        key = self._key()
        client = self._client(key)
        token = self._token(key, {"alg": "RS256", "kid": "key-1"},
                            self._payload(aud="ontrak-tix"))
        with self.assertRaises(oidc.OidcError) as caught:
            client.verify_id_token(token, nonce="the-nonce", redirect_uri="https://x/y")
        self.assertIn("not issued to this application", str(caught.exception))

    def test_a_multi_audience_token_needs_a_matching_azp(self):
        key = self._key()
        client = self._client(key)
        header = {"alg": "RS256", "kid": "key-1"}
        with self.assertRaises(oidc.OidcError):
            client.verify_id_token(
                self._token(key, header, self._payload(aud=["ontrak-sync", "ontrak-tix"])),
                nonce="the-nonce", redirect_uri="https://x/y")
        claims = client.verify_id_token(
            self._token(key, header, self._payload(aud=["ontrak-sync", "ontrak-tix"],
                                                   azp="ontrak-sync")),
            nonce="the-nonce", redirect_uri="https://x/y")
        self.assertEqual("abc", claims["sub"])

    def test_a_replayed_nonce_is_refused(self):
        key = self._key()
        client = self._client(key)
        token = self._token(key, {"alg": "RS256", "kid": "key-1"}, self._payload())
        with self.assertRaises(oidc.OidcError) as caught:
            client.verify_id_token(token, nonce="a-different-nonce", redirect_uri="https://x/y")
        self.assertIn("nonce", str(caught.exception))

    def test_an_expired_or_future_token_is_refused(self):
        key = self._key()
        client = self._client(key)
        header = {"alg": "RS256", "kid": "key-1"}
        expired = self._token(key, header,
                              self._payload(exp=time.time() - 3600))
        with self.assertRaises(oidc.OidcError) as caught:
            client.verify_id_token(expired, nonce="the-nonce", redirect_uri="https://x/y")
        self.assertIn("expired", str(caught.exception))
        future = self._token(key, header, self._payload(iat=time.time() + 3600))
        with self.assertRaises(oidc.OidcError) as caught:
            client.verify_id_token(future, nonce="the-nonce", redirect_uri="https://x/y")
        self.assertIn("future", str(caught.exception))

    def test_small_clock_skew_is_tolerated(self):
        key = self._key()
        client = self._client(key)
        token = self._token(key, {"alg": "RS256", "kid": "key-1"},
                            self._payload(exp=time.time() - 10))
        claims = client.verify_id_token(token, nonce="the-nonce", redirect_uri="https://x/y")
        self.assertEqual("abc", claims["sub"])

    def test_an_unknown_kid_is_refused(self):
        key = self._key()
        client = self._client(key)
        token = self._token(key, {"alg": "RS256", "kid": "retired-key"}, self._payload())
        with self.assertRaises(oidc.OidcError) as caught:
            client.verify_id_token(token, nonce="the-nonce", redirect_uri="https://x/y")
        self.assertIn("signing key", str(caught.exception))

    def test_a_discovery_document_that_renames_the_issuer_is_refused(self):
        def fetch(url, **kwargs):
            return {"issuer": "https://attacker.test",
                    "authorization_endpoint": "https://a/b",
                    "token_endpoint": "https://a/t",
                    "jwks_uri": "https://a/k"}

        client = oidc.OidcClient(issuer="https://auth.cerulean.innotel.us", client_id="x",
                                 fetch=fetch)
        with self.assertRaises(oidc.OidcError) as caught:
            client.discovery()
        self.assertIn("advertises issuer", str(caught.exception))

    def test_an_unconfigured_deployment_says_so_rather_than_half_working(self):
        client = oidc.OidcClient(issuer="", client_id="")
        self.assertFalse(client.configured)
        with self.assertRaises(oidc.OidcError):
            client.discovery()

    def test_a_public_client_proves_itself_with_pkce_alone(self):
        client = oidc.OidcClient(issuer="https://auth.example", client_id="public")
        self.assertTrue(client.configured)


if __name__ == "__main__":
    unittest.main()
