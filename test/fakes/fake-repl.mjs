// Fake `osascript -i` child process: each stdin line is evaluated in a node:vm
// context whose console.log writes to stdout (osascript's REPL echoes logs the
// same way). Modes script failures the daemon must survive.
import { EventEmitter } from "node:events";
import vm from "node:vm";

export function fakeSpawner({ mode = "ok", chunk = 0, globals = {} } = {}) {
  const spawned = [];
  const spawnFn = (cmd, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = new EventEmitter();
    proc.killed = false;
    proc.lines = [];
    proc.cmd = cmd; proc.args = args;
    const out = (s) => {
      if (!chunk) return setImmediate(() => proc.stdout.emit("data", Buffer.from(s)));
      for (let i = 0; i < s.length; i += chunk) {
        const piece = s.slice(i, i + chunk);
        setImmediate(() => proc.stdout.emit("data", Buffer.from(piece)));
      }
    };
    const ctx = vm.createContext({ console: { log: (s) => out(String(s) + "\n") }, ...globals });
    proc.stdin.write = (line) => {
      if (mode === "throwOnWrite") throw new Error("EPIPE");
      // "deaf": the REPL takes input but never evaluates it, like `osascript -i`
      // over a pipe on macOS 27, which waits for EOF before running anything.
      if (mode === "deaf") { proc.lines.push(line); return true; }
      proc.lines.push(line);
      const isHandshake = proc.lines.length === 1;
      if (mode === "silent" && !isHandshake) return true;
      if (mode === "exitMidCall" && !isHandshake) { setImmediate(() => proc.emit("exit", 1)); return true; }
      try { vm.runInContext(line, ctx); } catch (e) { out(`!! ${e.message}\n`); }
      return true;
    };
    proc.kill = () => { proc.killed = true; setImmediate(() => proc.emit("exit", null)); };
    spawned.push(proc);
    return proc;
  };
  return { spawnFn, spawned };
}
