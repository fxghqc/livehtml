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

test("onFrame delivers each remote set/del frame verbatim with by and src", async () => {
  const h = await boot();
  h.ws().dispatch({ t: "init", you: "me-1", state: {}, peers: [] });
  const frames: any[] = [];
  h.win.LiveHtml.onFrame((f: any) => frames.push(f));

  // a peer's set carries the server-stamped writer — the by-check's input
  h.ws().dispatch({ t: "set", key: "~g:in:u2", v: { x: 1 }, by: "u2" });
  expect(frames.length).toBe(1);
  expect(frames[0]).toEqual({ t: "set", key: "~g:in:u2", v: { x: 1 }, by: "u2", src: undefined });

  // a server reclaim of a transient key: src:"server", empty by
  h.ws().dispatch({ t: "del", key: "~g:in:u2", by: "", src: "server" });
  expect(frames.length).toBe(2);
  expect(frames[1]).toEqual({ t: "del", key: "~g:in:u2", v: undefined, by: "", src: "server" });

  // edge-triggered (no on-subscribe replay), and the reserved roster is not a frame
  h.ws().dispatch({ t: "set", key: "__users", v: { u2: "Bob" }, by: "system" });
  expect(frames.length).toBe(2);
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

test("a subscriber calling LiveHtml.set does not recurse; the nested set still hits the wire", async () => {
  const h = await boot();
  h.ws().dispatch({ t: "init", you: "me-1", state: {}, peers: [] });
  let calls = 0;
  h.win.LiveHtml.onChange(() => {
    calls++;
    h.win.LiveHtml.set("echo", "x"); // would recurse forever without the guard
  });
  h.ws().dispatch({ t: "set", key: "y", v: 1, by: "other" });
  expect(calls).toBeLessThan(10);
  expect(h.win.LiveHtml.state.echo).toBe("x");
  // The guard suppresses only the re-notification, never the write itself.
  const echoSends = h
    .ws()
    .sent.map((s) => JSON.parse(s))
    .filter((m) => m.t === "set" && m.key === "echo");
  expect(echoSends.length).toBeGreaterThan(0);
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

test("an unknown LiveHtml member warns instead of throwing, and is not thenable", async () => {
  const h = await boot();
  h.ws().dispatch({ t: "init", you: "me-1", state: { a: 1 }, peers: [] });

  // A hallucinated member must not be a TypeError — that kills the page script.
  const ret = h.win.LiveHtml.watch("a", () => {});
  expect(h.warns.some((w) => w.includes("LiveHtml.watch 不存在"))).toBe(true);
  expect(await ret).toEqual({ a: 1 });

  // then/catch/finally stay undefined so `await LiveHtml` can't hang.
  expect(h.win.LiveHtml.then).toBeUndefined();
  expect(h.win.LiveHtml.catch).toBeUndefined();
  expect(h.win.LiveHtml.finally).toBeUndefined();

  // Real members are untouched by the trap.
  expect(typeof h.win.LiveHtml.onChange).toBe("function");
  expect(h.win.LiveHtml.state).toEqual({ a: 1 });
});

test("the offline outbox is last-wins per key and replays once on reconnect", async () => {
  const h = loadClient();
  await new Promise((r) => setTimeout(r, 0)); // let start() build the socket

  // Socket is not open yet: every write buffers.
  h.win.LiveHtml.set("k", 1);
  h.win.LiveHtml.set("k", 2);
  h.win.LiveHtml.set("j", "a");
  h.win.LiveHtml.set("k", 3);
  h.win.LiveHtml.del("j"); // supersedes the queued set for j
  expect(h.ws().sent.length).toBe(0);

  h.ws().open();
  const sent = h.ws().sent.map((s) => JSON.parse(s));
  expect(sent[0].t).toBe("hi");
  const ops = sent.slice(1);
  expect(ops.length).toBe(2); // one per key, not one per write
  expect(ops.find((m: any) => m.key === "k")).toEqual({ t: "set", key: "k", v: 3 });
  expect(ops.find((m: any) => m.key === "j")).toEqual({ t: "del", key: "j" });
});

test("a `~` key with data-default is never seeded back, and survives eviction locally", async () => {
  const cur = makeEl("SPAN", { dataset: { live: "~hint", default: "D" } });
  const h = await boot([cur]);

  h.ws().dispatch({ t: "init", you: "me-1", state: {}, peers: [] });
  expect(cur.textContent).toBe("D"); // default still renders locally

  h.ws().dispatch({ t: "set", key: "~hint", v: "typing…", by: "other" });
  expect(cur.textContent).toBe("typing…");

  // Server reclaim: `by` is empty and `src` marks the origin. The element falls
  // back to its default WITHOUT republishing it — republishing would overwrite
  // the next writer and re-stamp the key so the reclaim never completes.
  h.ws().dispatch({ t: "del", key: "~hint", by: "", src: "server" });
  expect(cur.textContent).toBe("D");

  const seeds = h
    .ws()
    .sent.map((s) => JSON.parse(s))
    .filter((m) => m.key === "~hint");
  expect(seeds.length).toBe(0);
});

test("__users is exposed as LiveHtml.users, kept out of state, and unwritable", async () => {
  const h = await boot();

  h.ws().dispatch({
    t: "init",
    you: "me-1",
    state: { a: 1, __users: { u1: "Alice" } },
    peers: [],
  });
  expect(h.win.LiveHtml.state).toEqual({ a: 1 }); // roster never leaks into state
  expect(h.win.LiveHtml.users).toEqual({ u1: "Alice" });

  h.ws().dispatch({ t: "set", key: "__users", v: { u1: "Alice", u2: "Bob" }, by: "system" });
  expect(h.win.LiveHtml.users).toEqual({ u1: "Alice", u2: "Bob" });
  expect(h.win.LiveHtml.state).toEqual({ a: 1 });

  // A replace that omits the roster keeps the names rather than flickering.
  h.ws().dispatch({ t: "replace", state: { b: 2 } });
  expect(h.win.LiveHtml.users).toEqual({ u1: "Alice", u2: "Bob" });

  const before = h.ws().sent.length;
  h.win.LiveHtml.set("__users", { hacker: "x" });
  h.win.LiveHtml.del("__users");
  expect(h.ws().sent.length).toBe(before); // nothing reached the wire
  expect(h.win.LiveHtml.users).toEqual({ u1: "Alice", u2: "Bob" });
  expect(h.warns.filter((w) => w.includes("保留键")).length).toBe(2);
});

test("a throttle stops the flow, then replays one op per key with the latest value", async () => {
  const h = await boot();
  h.ws().dispatch({ t: "init", you: "me-1", state: {}, peers: [] });

  h.win.LiveHtml.set("k", 1); // goes out, and the server refuses it
  h.ws().dispatch({ t: "throttled", key: "k", retryAfterMs: 40 });
  const mark = h.ws().sent.length;

  // While the window is armed nothing may go out — writing anyway is what turns
  // a throttled page into more traffic than an unthrottled one.
  h.win.LiveHtml.set("k", 2);
  h.win.LiveHtml.set("j", "a");
  expect(h.ws().sent.length).toBe(mark);

  await new Promise((r) => setTimeout(r, 90));
  const ops = h.ws().sent.slice(mark).map((s) => JSON.parse(s));
  expect(ops.length).toBe(2); // one per key, not one per write
  // The re-queued op carries v:2 — the page's current value — not the v:1 the
  // server dropped. Replaying the dropped value would undo the newer write.
  expect(ops.find((m: any) => m.key === "k")).toEqual({ t: "set", key: "k", v: 2 });
  expect(ops.find((m: any) => m.key === "j")).toEqual({ t: "set", key: "j", v: "a" });
});

test("a throttled key the page has since deleted replays as a del", async () => {
  const h = await boot();
  h.ws().dispatch({ t: "init", you: "me-1", state: { k: 1 }, peers: [] });
  h.win.LiveHtml.del("k");
  const mark = h.ws().sent.length;
  h.ws().dispatch({ t: "throttled", key: "k", retryAfterMs: 30 });
  await new Promise((r) => setTimeout(r, 80));
  const ops = h.ws().sent.slice(mark).map((s) => JSON.parse(s));
  expect(ops).toEqual([{ t: "del", key: "k" }]);
});

test("watchRoom exposes a declared read-only room and ignores its presence frames", async () => {
  const h = await boot();
  h.ws().dispatch({ t: "init", you: "me-1", state: { own: 1 }, peers: [] });

  const seen: any[] = [];
  h.win.LiveHtml.watchRoom("pages/source", (s: any) => seen.push(s));
  expect(seen).toEqual([{}]); // immediate call, nothing known yet

  h.ws().dispatch({ t: "room", room: "pages/source", msg: { t: "init", state: { n: "one" } } });
  h.ws().dispatch({ t: "room", room: "pages/source", msg: { t: "set", key: "n", v: "two" } });
  h.ws().dispatch({ t: "room", room: "pages/source", msg: { t: "pres", peers: [] } });
  h.ws().dispatch({ t: "room", room: "pages/other", msg: { t: "set", key: "x", v: 1 } });

  expect(seen).toEqual([{}, { n: "one" }, { n: "two" }]); // pres and other rooms do not notify
  expect(h.win.LiveHtml.state).toEqual({ own: 1 }); // a watched room never leaks into own state
});

test("poker.html renders via onChange, not a setInterval poll", () => {
  expect(POKER).not.toContain("setInterval(render");
  expect(POKER).toContain("onChange(render)");
});
