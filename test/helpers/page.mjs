// Runs perch page scripts in happy-dom exactly as the bridge would: wrapped by
// buildEvalWrapper (sync) or the async kickoff, with JSON on the way out.
// Layout is stubbed: every element is 100x20 unless it carries data-zero.
import { Window } from "happy-dom";
import { buildEvalWrapper, pageScript } from "../../server.js";

export function page(html, { url = "https://a.test/p" } = {}) {
  const w = new Window({ url, settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  w.Element.prototype.getBoundingClientRect = function () {
    const z = this.hasAttribute("data-zero");
    return { x: 0, y: 0, left: 0, top: 0, width: z ? 0 : 100, height: z ? 0 : 20, right: z ? 0 : 100, bottom: z ? 0 : 20 };
  };
  w.document.body.innerHTML = html;
  return w;
}

const parse = (s) => (s === "" || s == null ? null : JSON.parse(s));
export const run = (w, name, A = {}) => parse(w.eval(buildEvalWrapper(pageScript(name, A))));
export const runBody = (w, body) => parse(w.eval(buildEvalWrapper(pageScript(null, {}) + body)));
