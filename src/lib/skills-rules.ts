/**
 * The skills matrix — who is competent in what.
 *
 * A certificate already carries the competencies its attempt demonstrated
 * (`credentials.ts`), and the record is *stored* on the attempt when it is issued
 * (`certificates.ts`), so the facts this needs are already durable. What was
 * missing is the aggregate: this module folds those stored records into one row
 * per person and one column per competency, which is the question an instructor
 * actually asks — "who can do this, and who needs the scenario again" — without
 * opening attempts one at a time.
 *
 * Three of the certificate's own rules decide what counts, read again here rather
 * than re-defined:
 *
 *  - a **revoked** record demonstrates nothing. A re-grade that dropped the
 *    attempt below the pass mark took the certification away, and the skill goes
 *    with it — the matrix must not go on claiming a competence the product has
 *    withdrawn.
 *  - a record with **no competencies** contributes nothing. A scenario its author
 *    tagged nothing for attests nothing, and pretending otherwise would invent a
 *    skill from an empty list.
 *  - the same competency earned twice is **one** competence, and the earliest pass
 *    that earned it is the one recorded: the matrix answers "since when", and the
 *    first demonstration is the true answer to that.
 *
 * A learner whose only records were revoked still gets a row, deliberately, with
 * no skills in it and the revocation counted. Dropping them would make a
 * withdrawal invisible in the one view that exists to show what people can do —
 * which is exactly the outcome revocation is supposed to be visible in.
 */

import { readStoredCertificate, type CertificateColumns } from "./certificate-rules";

/**
 * One attempt's certificate columns, plus who the attempt belonged to.
 *
 * The certificate half is passed through to `readStoredCertificate` unchanged, so
 * a row the product would fail to read anywhere else fails here the same way.
 */
export interface SkillRow extends CertificateColumns {
  userId: string;
  /** The learner's display name, as the account carries it now. */
  learnerName: string;
}

/** One competency a learner holds, and when they first demonstrated it. */
export interface EarnedSkill {
  /** The competency, spelled as the certificate that first earned it. */
  skill: string;
  /** ISO-8601 UTC — the earliest live certificate carrying it. */
  firstEarnedAt: string;
  /** How many live certificates carry it. */
  certificates: number;
}

export interface LearnerSkills {
  userId: string;
  name: string;
  /** Live competencies, by first demonstration. Empty when every record was revoked. */
  skills: EarnedSkill[];
  /** How many of this learner's certificates are revoked. */
  revoked: number;
}

export interface SkillsMatrix {
  /** Every competency anyone holds, alphabetically. */
  skills: string[];
  /** One row per learner with any stored certificate, by name then id. */
  learners: LearnerSkills[];
  /** How many learners hold each competency, keyed by its grouped form. */
  holders: Record<string, number>;
  /** Live certificates counted… */
  counted: number;
  /** …and the two reasons one was left out. Both are reported, not swallowed. */
  revoked: number;
  unreadable: number;
}

/**
 * The key a competency is grouped under: case- and whitespace-insensitive.
 *
 * Two authors tagging `Linux` and `linux` mean one competence, and a matrix that
 * drew two columns would answer "who can do this" with half the people. Exported
 * because the page keys its columns by it too, so the view and the rule cannot
 * disagree about what a column is.
 */
export function skillKey(skill: string): string {
  return skill.trim().toLowerCase();
}

/** Alpha by the grouped key, so the column order never depends on insertion. */
function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the matrix from stored certificates.
 *
 * Rows are read in the order given, which decides two things the caller should
 * therefore keep stable: the last name seen for a learner is the one shown (rows
 * ordered by issue date make that the account's current name), and the spelling a
 * competency's column is drawn with is the first one seen for it.
 */
export function skillsMatrixFrom(rows: readonly SkillRow[]): SkillsMatrix {
  const labels = new Map<string, string>();
  const learners = new Map<
    string,
    { name: string; skills: Map<string, { firstEarnedAt: string; certificates: number }>; revoked: number }
  >();
  let counted = 0;
  let revoked = 0;
  let unreadable = 0;

  for (const row of rows) {
    const entry =
      learners.get(row.userId) ??
      { name: row.learnerName, skills: new Map<string, { firstEarnedAt: string; certificates: number }>(), revoked: 0 };
    learners.set(row.userId, entry);
    entry.name = row.learnerName;

    const stored = readStoredCertificate(row);
    // No readable record: a row from an older deployment or a hand-edited value.
    // Counted rather than treated as competence — the same failing closed the
    // certificate reader does everywhere else.
    if (!stored) {
      unreadable += 1;
      continue;
    }
    if (stored.revokedAt) {
      revoked += 1;
      entry.revoked += 1;
      continue;
    }

    counted += 1;
    for (const raw of stored.record.skills ?? []) {
      const key = skillKey(raw);
      if (!key) continue;
      if (!labels.has(key)) labels.set(key, raw.trim());

      const existing = entry.skills.get(key);
      if (existing) {
        existing.certificates += 1;
        // Earliest wins: "since when" is the first demonstration, not the latest.
        if (stored.issuedAt < existing.firstEarnedAt) existing.firstEarnedAt = stored.issuedAt;
        continue;
      }
      entry.skills.set(key, { firstEarnedAt: stored.issuedAt, certificates: 1 });
    }
  }

  // The columns are the *labels* — the first spelling seen for each competency —
  // ordered by the grouped key. Building them from the keys would draw the column
  // as whatever case the last author typed, which is the one thing the label map
  // exists to prevent (and the learners below already spell it the right way).
  const skills = [...labels.values()].sort((a, b) => byKey(skillKey(a), skillKey(b)));

  const holders: Record<string, number> = {};
  for (const entry of learners.values()) {
    for (const key of entry.skills.keys()) holders[key] = (holders[key] ?? 0) + 1;
  }

  return {
    skills,
    learners: [...learners.entries()]
      .map(([userId, entry]) => ({
        userId,
        name: entry.name,
        skills: [...entry.skills.entries()]
          .map(([key, earned]) => ({
            skill: labels.get(key) ?? key,
            firstEarnedAt: earned.firstEarnedAt,
            certificates: earned.certificates,
          }))
          .sort((a, b) => byKey(skillKey(a.skill), skillKey(b.skill))),
        revoked: entry.revoked,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId)),
    holders,
    counted,
    revoked,
    unreadable,
  };
}

/** Does this learner hold the competency in the given column? */
export function holdsSkill(learner: LearnerSkills, key: string): boolean {
  return learner.skills.some((earned) => skillKey(earned.skill) === key);
}
