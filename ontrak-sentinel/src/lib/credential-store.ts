/**
 * Where a password verifier lives.
 *
 * A port of its own, deliberately **not** a widening of `IdentityStore`. Twelve test
 * files implement `IdentityStore` as a stub, and a login that added two methods to it
 * would have made every one of them a compile error for a reason unrelated to what
 * they are testing. Credentials are also read on exactly one path — sign-in — while
 * `IdentityStore` is read everywhere, so the split is honest about the difference.
 *
 * What the port can do is only what a login needs: find the verifier for an identity,
 * write one, replace one. It cannot list credentials or read a hash for an identity
 * other than the one being signed in, because nothing should be able to.
 */

import type { CredentialRecord } from "./identity-rules";

export interface CredentialStore {
  /** The verifier for an identity, or `null` when it has no password at all. */
  findForIdentity(organizationId: string, identityId: string): Promise<CredentialRecord | null>;
  /** Write the first verifier for an identity. */
  insert(record: CredentialRecord): Promise<void>;
  /**
   * Replace the verifier for an identity.
   *
   * Replace rather than append: a person has one password, and a table that kept the
   * old hashes would keep every password they had ever set working.
   */
  replace(organizationId: string, identityId: string, hash: string): Promise<void>;
}

/** In-memory, for tests and local development, matching `MemoryIdentityStore`. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly byIdentity = new Map<string, CredentialRecord>();
  private seq = 0;

  private key(organizationId: string, identityId: string): string {
    return `${organizationId}::${identityId}`;
  }

  async findForIdentity(organizationId: string, identityId: string): Promise<CredentialRecord | null> {
    return this.byIdentity.get(this.key(organizationId, identityId)) ?? null;
  }

  async insert(record: CredentialRecord): Promise<void> {
    const key = this.key(record.organizationId, record.identityId);
    // Mirrors the unique index the Prisma store relies on, so a test that inserts
    // twice fails the same way production would rather than quietly overwriting.
    if (this.byIdentity.has(key)) throw new Error("That identity already has a credential.");
    this.byIdentity.set(key, record);
  }

  async replace(organizationId: string, identityId: string, hash: string): Promise<void> {
    const key = this.key(organizationId, identityId);
    const existing = this.byIdentity.get(key);
    if (!existing) {
      this.byIdentity.set(key, {
        id: `cred-${++this.seq}`,
        organizationId,
        identityId,
        hash,
        createdAt: new Date().toISOString(),
      });
      return;
    }
    this.byIdentity.set(key, { ...existing, hash });
  }

  /** Test helper: how many identities hold a verifier. */
  size(): number {
    return this.byIdentity.size;
  }
}
