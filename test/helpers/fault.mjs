// A perch page script that throws is reported by its error name alone: the
// message and stack are page internals, not something the agent can act on.
import assert from "node:assert/strict";

export const SECRET = "throw new TypeError('secret-internal detail');";

// Makes the nth (by `when`) page script containing `marker` run `thrown` just before it.
export function throwAt(dom, marker, when = () => true, thrown = SECRET) {
  const ev = dom.eval.bind(dom);
  let n = 0, threw = 0;
  dom.eval = (js) => js.includes(marker) && when(++n, js) ? (threw++, ev(js.replace(marker, thrown + marker))) : ev(js);
  return () => threw;
}

export const noRaw = (x) => {
  const s = JSON.stringify(x);
  for (const k of ["secret-internal", "__perch_error", "stack"]) assert.ok(!s.includes(k), s);
};
