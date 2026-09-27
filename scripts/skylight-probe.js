#!/usr/bin/env osascript -l JavaScript
//
// SkyLight FFI probe: shows that pure JXA can dlopen SkyLight, bind its private
// symbols and marshal the 0xf8-byte event-record buffer, with no event tap and no
// C callback. That is what made background trusted input possible in the
// single-file server (skyInit / skyMouse in server.js).
//
// The two symbols it checks take only pointer arguments:
//
//   * SLEventPostToPid(pid, CGEventRef)     route an event to a pid without
//                                           moving the shared cursor
//   * SLPSPostEventRecordTo(psn*, bytes*)   flip a process AppKit-active without
//                                           raising its window
//
// perch uses the first. It never posts the second in its background route: live,
// it redirected the user's keyboard to the browser (see AGENTS.md, Trusted input).
//
// The probe wires nothing into perch. It resolves the symbols and makes ONE
// harmless SLPSPostEventRecordTo call to the CURRENT process's PSN with window
// id 0, a no-op focus message to this non-GUI osascript process. A bad pointer
// would crash osascript, so run it standalone, never inside the daemon:
//
//   osascript -l JavaScript scripts/skylight-probe.js
//
ObjC.import("Foundation");

const SKYLIGHT =
  "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/SkyLight";
const RTLD_NOW = 2;

const report = { steps: [] };
const note = (name, ok, detail) => report.steps.push({ name, ok, detail });

// $.dlopen is not callable directly: it's undefined on the bridge until dlopen
// itself is bound, as skyInit does. In practice SkyLight is already pulled in transitively
// by the JXA runtime, so the symbols below bind even if this explicit load is skipped
// — but binding dlopen makes force-loading available for environments that don't.
let handle = null;
try {
  ObjC.bindFunction("dlopen", ["void *", ["char *", "int"]]);
  handle = $.dlopen(SKYLIGHT, RTLD_NOW); // raw void* handle, not an ObjC object
  note("dlopen SkyLight (via bound dlopen)", handle != null, "loaded explicitly");
} catch (e) {
  note("dlopen SkyLight (via bound dlopen)", false, String(e));
}

// bindFunction binds a symbol already loaded in the address space to a callable
// on $, given an explicit C signature. Pointers are 'void *'; pid_t and CGError
// are 'int'; size_t is 'unsigned long'.
function bind(name, sig) {
  try {
    ObjC.bindFunction(name, sig);
    note(`bind ${name}`, true, sig[1].join(", ") + " -> " + sig[0]);
    return true;
  } catch (e) {
    note(`bind ${name}`, false, String(e));
    return false;
  }
}

const haveMemset = bind("memset", ["void *", ["void *", "int", "unsigned long"]]);
const havePost = bind("SLPSPostEventRecordTo", ["int", ["void *", "void *"]]);
// Binding-only checks for the event-routing half (not called here — calling it
// needs a CGEventRef and posts a real event; symbol resolution is the question).
bind("SLEventPostToPid", ["int", ["int", "void *"]]);
bind("SLPSSetFrontProcessWithOptions", ["int", ["void *", "unsigned int", "unsigned int"]]);

// Build the 0xf8-byte event record WITHOUT pointer arithmetic: every write goes
// through NSMutableData.replaceBytesInRange:withBytes:length:, where the byte
// OFFSET is carried by the NSRange (.location), and the source bytes come from a
// small scratch buffer filled at offset 0 via memset. This is the crux the probe
// exists to prove — if JXA can do this, the yabai recipe is expressible in pure
// AppleScript+FFI.
function makeData(len) {
  return $.NSMutableData.dataWithLength(len); // zero-filled
}
function fillRegion(data, offset, byteValue, len) {
  const tmp = $.NSMutableData.dataWithLength(len);
  $.memset(tmp.mutableBytes, byteValue, len); // offset-0 fill, no arithmetic
  data.replaceBytesInRangeWithBytesLength($.NSMakeRange(offset, len), tmp.mutableBytes, len);
}

let callResult = "skipped (prereq bind failed)";
if (haveMemset && havePost) {
  try {
    // ProcessSerialNumber { UInt32 high; UInt32 low; }. kCurrentProcess = 2 lives
    // in the low long (offset 4) — targets our own process, harmless.
    const psn = makeData(8);
    fillRegion(psn, 4, 0x02, 1);

    // yabai "make key window" event record. Window id left 0 (probe only needs the
    // call to marshal and return; semantic success isn't the question).
    const bytes = makeData(0xf8);
    fillRegion(bytes, 0x04, 0xf8, 1); // record length
    fillRegion(bytes, 0x08, 0x01, 1); // event kind discriminator
    fillRegion(bytes, 0x3a, 0x10, 1);
    fillRegion(bytes, 0x20, 0xff, 0x10);

    const rc = $.SLPSPostEventRecordTo(psn.mutableBytes, bytes.mutableBytes);
    callResult = `returned CGError ${rc} (call completed — FFI marshaling works; ` +
      `non-zero is fine, it only means window 0 / self-PSN was semantically rejected)`;
  } catch (e) {
    callResult = "threw: " + String(e);
  }
}
note("call SLPSPostEventRecordTo (self-PSN, win 0)", !/threw|skipped/.test(callResult), callResult);

const verdict = (haveMemset && havePost && /returned CGError/.test(callResult))
  ? "REACHABLE — SkyLight symbols bind and the event-record buffer marshals from pure JXA. " +
    "Background input needs no event tap or C callback."
  : "BLOCKED at: " + (report.steps.find((s) => !s.ok)?.name || "unknown step") +
    ". See the step detail.";

const out = ["=== SkyLight FFI probe ==="];
for (const s of report.steps) out.push(`[${s.ok ? "ok " : "FAIL"}] ${s.name} — ${s.detail}`);
out.push("");
out.push("VERDICT: " + verdict);
const text = out.join("\n");
console.log(text); // stderr — visible when run interactively
text;               // stdout — the last expression osascript prints
