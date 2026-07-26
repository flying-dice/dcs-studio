// What to show a user about a thing that was thrown.
//
// `catch` binds `unknown` because JavaScript lets anything be thrown, and every
// place that puts a failure in front of a user has to decide what to do with
// the non-Error case. Two presenters had already made that decision identically
// and separately; a third copy went in with the install-swap recovery message
// before this became one function.

/** The `message` of a thrown Error, or the best rendering of whatever else it was. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
