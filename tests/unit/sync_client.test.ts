// tests/unit/sync_client.test.ts
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "bun:test";

// Runs the REAL public/sync.js inside a node:vm with a compact DOM/WebSocket
// stub (no jsdom). Covers the LiveHtml.onChange subscription API and the
// container-binding refusal in bind().

const SRC = readFileSync(
  fileURLToPath(new URL("../../public/sync.js", import.meta.url)),
  "utf8",
);
const POKER = readFileSync(
  fileURLToPath(new URL("../../examples/poker.html", import.meta.url)),
  "utf8",
);

type LiveEl = Record<string, any>;

function makeEl(tag: string, props: LiveEl = {}): LiveEl {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    tagName: tag,
    dataset: {},
    style: {},
    checked: false,
    value: "",
    open: false,
    innerHTML: "",
    textContent: "",
    isContentEditable: false,
    multiple: false,
    options: [],
    selectedOptions: [],
    addEventListener: (ev: string, cb: () => void) => {
      (handlers[ev] ||= []).push(cb);
    },
    appendChild: () => {},
    _emit: (ev: string) => (handlers[ev] || []).forEach((cb) => cb()),
    ...props,
  };
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  dispatch(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

class FakeMutationObserver {
  constructor(_cb: unknown) {}
  observe() {}
}

function makeLocalStorage(init: Record<string, string>) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => {
      m.set(k, String(v));
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
  };
}

function loadClient(liveEls: LiveEl[] = []) {
  FakeWebSocket.instances = [];
  const warns: string[] = [];

  const scriptEl = makeEl("SCRIPT", {
    src: "http://host/sync.js",
    dataset: { room: "t/room" },
  });
  const body = makeEl("BODY", {
    classList: { remove: () => {}, add: () => {} },
  });

  const doc: LiveEl = {
    currentScript: scriptEl,
    readyState: "complete",
    activeElement: null,
    body,
    querySelector: () => null,
    querySelectorAll: (sel: string) => (sel === "[data-live]" ? liveEls : []),
    createElement: () => makeEl("DIV"),
    addEventListener: () => {},
  };

  const win: LiveEl = { addEventListener: () => {} };

  const ctx = vm.createContext({
    document: doc,
    window: win,
    location: { href: "http://host/page", pathname: "/page", search: "" },
    localStorage: makeLocalStorage({
      "livehtml:clientId": "me-1",
      "livehtml:user": "Tester",
    }),
    crypto: { randomUUID: () => "uuid-1" },
    WebSocket: FakeWebSocket,
    fetch: () => Promise.reject(new Error("no /auth/me in tests")),
    MutationObserver: FakeMutationObserver,
    setTimeout,
    clearTimeout,
    URL,
    console: {
      log: console.log,
      error: console.error,
      warn: (...a: unknown[]) => {
        warns.push(a.map(String).join(" "));
      },
    },
  });
  vm.runInContext(SRC, ctx);

  return { win, warns, ws: () => FakeWebSocket.instances[0]! };
}

// start() connects after the /auth/me fetch settles (a microtask chain).
async function boot(liveEls: LiveEl[] = []) {
  const h = loadClient(liveEls);
  await new Promise((r) => setTimeout(r, 0));
  h.ws().open();
  return h;
}

test("onChange calls back immediately with the current state snapshot", async () => {
  const h = await boot();
  h.ws().dispatch({ t: "init", you: "me-1", state: { a: 1 }, peers: [] });
  const calls: any[] = [];
  h.win.LiveHtml.onChange((s: any) => calls.push(s));
  expect(calls.length).toBe(1);
  expect(calls[0]).toEqual({ a: 1 });
});

test("remote init/set/del/replace/pres each notify subscribers", async () => {
  const h = await boot();
  const calls: any[] = [];
  h.win.LiveHtml.onChange((s: any) => calls.push(s));
  calls.length = 0; // drop the immediate on-subscribe call

  h.ws().dispatch({ t: "init", you: "me-1", state: { a: 1 }, peers: [] });
  expect(calls.length).toBe(1);
  expect(calls[0]).toEqual({ a: 1 });

  h.ws().dispatch({ t: "set", key: "b", v: 2, by: "other" });
  expect(calls.length).toBe(2);
  expect(calls[1]).toEqual({ a: 1, b: 2 });

  h.ws().dispatch({ t: "del", key: "a", by: "other" });
  expect(calls.length).toBe(3);
  expect(calls[2]).toEqual({ b: 2 });

  h.ws().dispatch({ t: "replace", state: { z: 9 } });
  expect(calls.length).toBe(4);
  expect(calls[3]).toEqual({ z: 9 });

  h.ws().dispatch({ t: "pres", peers: [{ id: "p1", user: { name: "P" } }] });
  expect(calls.length).toBe(5);
  expect(h.win.LiveHtml.peers.length).toBe(1);
});

test("local LiveHtml.set / LiveHtml.del notify subscribers", async () => {
  const h = await boot();
  const calls: any[] = [];
  h.win.LiveHtml.onChange((s: any) => calls.push(s));
  calls.length = 0;

  h.win.LiveHtml.set("k", "v");
  expect(calls.length).toBe(1);
  expect(calls[0]).toEqual({ k: "v" });

  h.win.LiveHtml.del("k");
  expect(calls.length).toBe(2);
  expect(calls[1]).toEqual({});
});

test("the returned unsubscribe stops further notifications", async () => {
  const h = await boot();
  const calls: any[] = [];
  const un = h.win.LiveHtml.onChange((s: any) => calls.push(s));
  calls.length = 0;
  un();
  h.win.LiveHtml.set("k", 1);
  h.ws().dispatch({ t: "set", key: "j", v: 2, by: "other" });
  expect(calls.length).toBe(0);
});

test("a throwing subscriber does not break other subscribers or sync", async () => {
  const note = makeEl("INPUT", { type: "text", dataset: { live: "note" } });
  const h = await boot([note]);
  const calls: any[] = [];
  h.win.LiveHtml.onChange(() => {
    throw new Error("boom");
  });
  h.win.LiveHtml.onChange((s: any) => calls.push(s));
  calls.length = 0;

  h.ws().dispatch({ t: "set", key: "note", v: "hello", by: "other" });
  expect(calls.length).toBe(1);
  expect(calls[0]).toEqual({ note: "hello" });
  expect(note.value).toBe("hello");
  expect(h.warns.some((w) => w.includes("onChange 回调抛错"))).toBe(true);
});

test("onStateChange / subscribe alias onChange; getState returns a snapshot", async () => {
  const h = await boot();
  expect(h.win.LiveHtml.onStateChange).toBe(h.win.LiveHtml.onChange);
  expect(h.win.LiveHtml.subscribe).toBe(h.win.LiveHtml.onChange);
  h.win.LiveHtml.set("k", 1);
  const s1 = h.win.LiveHtml.getState();
  expect(s1).toEqual({ k: 1 });
  expect(h.win.LiveHtml.getState()).not.toBe(s1);
});

test("onChange with a non-function warns and returns a no-op unsubscribe", async () => {
  const h = await boot();
  const un = h.win.LiveHtml.onChange("not a fn");
  expect(typeof un).toBe("function");
  un();
  expect(h.warns.some((w) => w.includes("onChange 需要函数参数"))).toBe(true);
});

test("data-live on a container with element children is refused, content preserved", async () => {
  const inner = makeEl("INPUT", { type: "radio" });
  const container = makeEl("DIV", {
    dataset: { live: "poll", default: "D" },
    children: [inner],
    textContent: "keep me",
  });
  const leaf = makeEl("SPAN", { dataset: { live: "t" } });
  const h = await boot([container, leaf]);

  h.ws().dispatch({ t: "init", you: "me-1", state: { poll: "", t: "hello" }, peers: [] });

  expect(container.textContent).toBe("keep me"); // not wiped
  expect(leaf.textContent).toBe("hello"); // text leaf still binds
  expect(h.warns.some((w) => w.includes("容器绑定已忽略"))).toBe(true);

  // the refused container must not seed its data-default into shared state
  const seeds = h
    .ws()
    .sent.map((s) => JSON.parse(s))
    .filter((m) => m.t === "set" && m.key === "poll");
  expect(seeds.length).toBe(0);
  expect(h.win.LiveHtml.state.poll).toBe("");
});

test("a SELECT with option children still binds (synced type)", async () => {
  const opt = makeEl("OPTION", { value: "a" });
  const sel = makeEl("SELECT", { dataset: { live: "choice" }, children: [opt] });
  const h = await boot([sel]);
  h.ws().dispatch({ t: "init", you: "me-1", state: { choice: "a" }, peers: [] });
  expect(sel.value).toBe("a");
  expect(h.warns.some((w) => w.includes("容器绑定已忽略"))).toBe(false);
});

test("poker.html renders via onChange, not a setInterval poll", () => {
  expect(POKER).not.toContain("setInterval(render");
  expect(POKER).toContain("onChange(render)");
});
