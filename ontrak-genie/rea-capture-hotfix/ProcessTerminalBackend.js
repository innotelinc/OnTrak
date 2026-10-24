import {
  spawn as spawnChild
} from "node:child_process";
import { constants as osConstants } from "node:os";
const nativePtyUsable = () => {
  if (process.platform !== "linux") return true;
  const report = process.report?.getReport();
  return report?.header?.glibcVersionRuntime !== void 0;
};
const processTerminalBackend = () => nativePtyUsable() ? "node-pty" : "pipe";
class PipeTerminal {
  pid;
  process;
  cols;
  rows;
  handleFlowControl = false;
  #child;
  #data = /* @__PURE__ */ new Set();
  #exit = /* @__PURE__ */ new Set();
  #exited = false;
  #pendingExit = {
    exitCode: 0
  };
  #drainTimer;
  constructor(executable, args, options) {
    this.process = executable;
    this.cols = options.cols;
    this.rows = options.rows;
    this.#child = spawnChild(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.pid = this.#child.pid ?? -1;
    if (this.pid < 1) {
      this.#child.on("error", () => void 0);
      throw new Error(`could not start ${executable}`);
    }
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#emit(chunk));
    this.#child.stderr.on("data", (chunk) => this.#emit(chunk));
    this.#child.on("error", () => void 0);
    this.#child.on("exit", (code, signal) => {
      const signalNumber = signal === null ? void 0 : osConstants.signals[signal];
      this.#pendingExit = {
        exitCode: code ?? 0,
        ...signalNumber === void 0 ? {} : { signal: signalNumber }
      };
      this.#drainTimer = setTimeout(() => this.#emitExit(), 200);
    });
    this.#child.on("close", () => this.#emitExit());
  }
  #emitExit() {
    if (this.#exited) return;
    this.#exited = true;
    if (this.#drainTimer !== void 0) clearTimeout(this.#drainTimer);
    for (const listener of Array.from(this.#exit)) listener(this.#pendingExit);
  }
  #emit(data) {
    if (this.#exited) return;
    for (const listener of Array.from(this.#data)) listener(data);
  }
  onData(listener) {
    this.#data.add(listener);
    return { dispose: () => this.#data.delete(listener) };
  }
  onExit(listener) {
    if (this.#exited) {
      listener(this.#pendingExit);
      return { dispose: () => void 0 };
    }
    this.#exit.add(listener);
    return { dispose: () => this.#exit.delete(listener) };
  }
  write(data) {
    if (this.#child.stdin.destroyed || this.#child.stdin.writableEnded) return;
    try {
      this.#child.stdin.write(data);
    } catch {
    }
  }
  resize(columns, rows) {
    void columns;
    void rows;
  }
  clear() {
  }
  kill(signal) {
    try {
      this.#child.kill(signal ?? "SIGHUP");
    } catch {
    }
  }
  pause() {
    this.#child.stdout.pause();
    this.#child.stderr.pause();
  }
  resume() {
    this.#child.stdout.resume();
    this.#child.stderr.resume();
  }
}
const spawnProcessTerminal = async (executable, args, options, backend = processTerminalBackend()) => {
  if (backend === "pipe") {
    return {
      terminal: new PipeTerminal(executable, args, options),
      backend
    };
  }
  const { spawn } = await import("@lydell/node-pty");
  return { terminal: spawn(executable, [...args], options), backend };
};
export {
  nativePtyUsable,
  processTerminalBackend,
  spawnProcessTerminal
};
