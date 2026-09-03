// Small request-generation gate used by live route refreshes. Starting a new
// request makes every older ticket stale, so a slow response can never replace
// data fetched for a later bundle revision.
export interface RequestGate {
  begin(): () => boolean;
  cancel(): void;
}

export function createRequestGate(): RequestGate {
  let generation = 0;
  return {
    begin() {
      const ticket = ++generation;
      return () => ticket === generation;
    },
    cancel() {
      generation++;
    },
  };
}
