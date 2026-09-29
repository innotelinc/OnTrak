/**
 * SCIM client: the four network calls an outbound sync needs.
 *
 * The decisions live in `scim-rules.ts`; this is the seam that makes them
 * testable without a provider. Two implementations ship:
 *
 *  - `HttpScimClient` speaks RFC 7644 to a real provider (OnTrak Sentinel, or any
 *    directory). It is what the sync action uses.
 *  - `MemoryScimClient` is a provider in a `Map`, so the sync service can be
 *    exercised end to end — including the second run that must change nothing —
 *    with no socket and no token.
 *
 * A failure is a `ScimRequestError` carrying the status and the provider's own
 * sentence, because "the sync failed" is not something an operator can act on and
 * "409: userName already exists (uniqueness)" is.
 */

import {
  SCIM_CONTENT_TYPE,
  deactivatePatch,
  externalIdFilter,
  parseUserList,
  parseUserResource,
  personBody,
  scimErrorDetail,
  userUrl,
  usersUrl,
  userNameFilter,
  type DeskPerson,
  type PersonAtProvider,
  type ScimTarget,
} from "./scim-rules";

export class ScimRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ScimRequestError";
  }
}

export interface ScimClient {
  /** The person the provider holds for this address, if any. */
  findByUserName(userName: string): Promise<PersonAtProvider | null>;
  /** The person the provider holds for Tix's own account id, if any. */
  findByExternalId(externalId: string): Promise<PersonAtProvider | null>;
  create(person: DeskPerson): Promise<PersonAtProvider>;
  replace(remoteId: string, person: DeskPerson): Promise<PersonAtProvider>;
  deactivate(remoteId: string): Promise<PersonAtProvider>;
}

/* -------------------------------------------------------------------------- */
/*  HTTP                                                                      */
/* -------------------------------------------------------------------------- */

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class HttpScimClient implements ScimClient {
  constructor(
    private readonly target: ScimTarget,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.target.token}`,
      accept: SCIM_CONTENT_TYPE,
      "content-type": SCIM_CONTENT_TYPE,
    };
  }

  /** A refusal, as an exception carrying what the provider actually said. */
  private async refuse(response: Response): Promise<never> {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    throw new ScimRequestError(scimErrorDetail(body, response.status), response.status);
  }

  private async json(response: Response): Promise<unknown> {
    if (!response.ok) return this.refuse(response);
    try {
      return await response.json();
    } catch {
      throw new ScimRequestError("The identity provider answered with something that is not JSON.", response.status);
    }
  }

  private async find(filter: string): Promise<PersonAtProvider | null> {
    const response = await this.fetchImpl(usersUrl(this.target, { filter, count: 2 }), {
      headers: this.headers(),
    });
    const people = parseUserList(await this.json(response));
    if (people === null) throw new ScimRequestError("The identity provider returned no user list.", 200);
    return people[0] ?? null;
  }

  async findByUserName(userName: string): Promise<PersonAtProvider | null> {
    return this.find(userNameFilter(userName));
  }

  async findByExternalId(externalId: string): Promise<PersonAtProvider | null> {
    return this.find(externalIdFilter(externalId));
  }

  async create(person: DeskPerson): Promise<PersonAtProvider> {
    const response = await this.fetchImpl(usersUrl(this.target), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(personBody(person)),
    });
    const created = parseUserResource(await this.json(response));
    if (created === null) throw new ScimRequestError("The identity provider did not return the user it created.", 201);
    return created;
  }

  async replace(remoteId: string, person: DeskPerson): Promise<PersonAtProvider> {
    const response = await this.fetchImpl(userUrl(this.target, remoteId), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(personBody(person)),
    });
    const replaced = parseUserResource(await this.json(response));
    if (replaced === null) throw new ScimRequestError("The identity provider did not return the user it replaced.", 200);
    return replaced;
  }

  async deactivate(remoteId: string): Promise<PersonAtProvider> {
    const response = await this.fetchImpl(userUrl(this.target, remoteId), {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify(deactivatePatch()),
    });
    const patched = parseUserResource(await this.json(response));
    if (patched === null) throw new ScimRequestError("The identity provider did not return the user it patched.", 200);
    return patched;
  }
}

/* -------------------------------------------------------------------------- */
/*  A provider in memory (tests and local work)                               */
/* -------------------------------------------------------------------------- */

/**
 * A provider that lives in a `Map`.
 *
 * Deliberately strict where it matters to the sync: a `userName` is unique, and
 * a replaced or patched person is returned as the provider now holds them, so a
 * second run over the same people has to plan `NOOP` on its own merits rather
 * than being told to.
 */
export class MemoryScimClient implements ScimClient {
  private readonly users = new Map<string, PersonAtProvider>();

  /** The people this provider holds, for assertions. */
  all(): PersonAtProvider[] {
    return [...this.users.values()].map((person) => ({ ...person }));
  }

  seed(person: PersonAtProvider): void {
    this.users.set(person.id, { ...person });
  }

  async findByUserName(userName: string): Promise<PersonAtProvider | null> {
    const wanted = userName.trim().toLowerCase();
    for (const person of this.users.values()) {
      if (person.userName.toLowerCase() === wanted) return { ...person };
    }
    return null;
  }

  async findByExternalId(externalId: string): Promise<PersonAtProvider | null> {
    for (const person of this.users.values()) {
      if (person.externalId === externalId) return { ...person };
    }
    return null;
  }

  async create(person: DeskPerson): Promise<PersonAtProvider> {
    if (person.email.trim() === "") throw new ScimRequestError("userName is required.", 400);
    const existing = await this.findByUserName(person.email);
    if (existing) throw new ScimRequestError("userName already exists (uniqueness)", 409);

    const created: PersonAtProvider = {
      id: `mem-${this.users.size + 1}`,
      userName: person.email,
      active: person.active,
      externalId: person.id,
    };
    this.users.set(created.id, created);
    return { ...created };
  }

  async replace(remoteId: string, person: DeskPerson): Promise<PersonAtProvider> {
    const current = this.users.get(remoteId);
    if (!current) throw new ScimRequestError("No such user.", 404);
    const replaced: PersonAtProvider = {
      id: remoteId,
      userName: person.email,
      active: person.active,
      externalId: person.id,
    };
    this.users.set(remoteId, replaced);
    return { ...replaced };
  }

  async deactivate(remoteId: string): Promise<PersonAtProvider> {
    const current = this.users.get(remoteId);
    if (!current) throw new ScimRequestError("No such user.", 404);
    const patched: PersonAtProvider = { ...current, active: false };
    this.users.set(remoteId, patched);
    return { ...patched };
  }
}
