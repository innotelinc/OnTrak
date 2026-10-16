import "server-only";

/**
 * A class code a person has to read aloud, type, and get right.
 *
 * The alphabet omits I, O, 0 and 1 because the code is dictated over the phone and
 * copied off a whiteboard, and those four are the characters that come back wrong.
 * It lives here rather than in one of the actions because there is now more than one
 * place a class is created, and two implementations of "the same" code would be two
 * different alphabets before long.
 */
export function joinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}
