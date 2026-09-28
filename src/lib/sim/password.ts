/**
 * Password records for a simulated machine (pure).
 *
 * The sandbox never holds a password. `passwd`, `useradd`, `net user`,
 * `New-LocalUser` and `Set-LocalUser` only have to leave behind a record that a
 * password *is* set — and the record has to be shaped like the machine's own,
 * because reading the local account list is one of the things the exercises ask
 * a student to do.
 *
 * So the value is generated per call: a salted, crypt-style digest that means
 * "set" and nothing else. There is no fixed text in the source for anyone to
 * copy, nothing here can unlock anything, and both drivers go through the same
 * function so the field means one thing whichever console set it. (Historically
 * the Windows driver wrote the word "simulated" into this field and the bash
 * driver wrote a salted digest, so the same field meant two different things
 * depending on where you looked.)
 */

/** A shaped, salted, throwaway password record for a simulated account. */
export function simulatedPasswordHash(): string {
  const salt = Math.random().toString(36).slice(2, 10);
  const digest = Math.random().toString(36).slice(2, 14);
  return `$6$rounds=656000$${salt}$${digest}`;
}
