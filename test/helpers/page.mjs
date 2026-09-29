// Runs perch page scripts in happy-dom exactly as the bridge would: wrapped by
// buildEvalWrapper (sync) or the async kickoff, with JSON on the way out.
// Layout is stubbed: every element is 100x20 unless it carries data-zero or sits
// in a display:none or [hidden] subtree, which Chrome lays out as an empty 0x0
// box (happy-dom has no user-agent rule for [hidden]).
// data-rect="left,top,width,height" places an element anywhere, offscreen too.
import { Window } from "happy-dom";
import { buildEvalWrapper, pageScript } from "../../server.js";

export function page(html, { url = "https://a.test/p" } = {}) {
  const w = new Window({ url, settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, navigation: { disableChildPageNavigation: true } } });
  w.Element.prototype.getBoundingClientRect = function () {
    const at = this.getAttribute("data-rect");
    if (at) {
      const [left, top, width, height] = at.split(",").map(Number);
      return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
    }
    let z = this.hasAttribute("data-zero");
    for (let el = this; el && !z; el = el.parentElement) z = el.hidden || w.getComputedStyle(el).display === "none";
    return { x: 0, y: 0, left: 0, top: 0, width: z ? 0 : 100, height: z ? 0 : 20, right: z ? 0 : 100, bottom: z ? 0 : 20 };
  };
  // happy-dom follows a link through window.open, which browsers never show page
  // JS, and a detached window navigates nowhere anyway: links only dispatch.
  w.HTMLAnchorElement.prototype.dispatchEvent = Object.getPrototypeOf(w.HTMLAnchorElement.prototype).dispatchEvent;
  w.document.body.innerHTML = html;
  return w;
}

const parse = (s) => (s === "" || s == null ? null : JSON.parse(s));
export const run = (w, name, A = {}) => parse(w.eval(buildEvalWrapper(pageScript(name, A))));
export const runBody = (w, body) => parse(w.eval(buildEvalWrapper(pageScript(null, {}) + body)));

// The OS delivers a posted press: a trusted mousedown on `el` (default: body),
// after whatever the world's onPost already does.
export function deliverPress(world, dom, el) {
  const prior = world.state.onPost;
  world.state.onPost = (e) => {
    if (prior) prior(e);
    if (e.type !== 1 || e.pt.x < 0) return;
    const ev = new dom.MouseEvent("mousedown", { bubbles: true, composed: true });
    Object.defineProperty(ev, "isTrusted", { value: true });
    (el || dom.document.body).dispatchEvent(ev);
  };
}
