(function () {
  "use strict";

  const SCRIPT = document.currentScript;
  const SRC_URL = SCRIPT && SCRIPT.src ? new URL(SCRIPT.src) : new URL(location.href);
  const WS_URL =
    (SRC_URL.protocol === "https:" ? "wss:" : "ws:") + "//" + SRC_URL.host + "/ws";

  function defaultRoom() {
    if (SCRIPT && SCRIPT.dataset && SCRIPT.dataset.room) return SCRIPT.dataset.room;
    const meta = document.querySelector('meta[name="livehtml-room"]');
    if (meta && meta.getAttribute("content")) return meta.getAttribute("content");
    if (window.LiveHtmlRoom) return String(window.LiveHtmlRoom);
    return location.pathname || "default";
  }

  function loadClientId() {
    try {
      let id = localStorage.getItem("livehtml:clientId");
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
        localStorage.setItem("livehtml:clientId", id);
      }
      return id;
    } catch {
      return String(Math.random()).slice(2);
    }
  }

  function loadUser() {
    if (window.LiveHtmlUser) return window.LiveHtmlUser;
    const meta = document.querySelector('meta[name="livehtml-user"]');
    if (meta && meta.getAttribute("content")) {
      const c = meta.getAttribute("content");
      try {
        return JSON.parse(c);
      } catch {
        return { name: c };
      }
    }
    try {
      let name = localStorage.getItem("livehtml:user");
      if (!name) {
        name = "User-" + Math.floor(Math.random() * 9000 + 1000);
        localStorage.setItem("livehtml:user", name);
      }
      return { name };
    } catch {
      return { name: "Anonymous" };
    }
  }

  function saveUserName(name) {
    try {
      localStorage.setItem("livehtml:user", name);
    } catch {}
  }

  function hueFromId(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  // ---- Element value adapters ----

  function isCheckLike(el) {
    return (
      el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")
    );
  }

  function getVal(el) {
    if (isCheckLike(el)) return !!el.checked;
    if (el.tagName === "INPUT" && el.type === "number")
      return el.value === "" ? null : Number(el.value);
    if (el.tagName === "INPUT" && el.type === "range") return Number(el.value);
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el.value;
    if (el.tagName === "SELECT") {
      if (el.multiple) return Array.from(el.selectedOptions).map((o) => o.value);
      return el.value;
    }
    if (el.tagName === "DETAILS") return !!el.open;
    if (el.isContentEditable) return el.innerHTML;
    return el.textContent;
  }

  function setVal(el, v) {
    if (isCheckLike(el)) {
      el.checked = !!v;
      return;
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      el.value = v == null ? "" : String(v);
      return;
    }
    if (el.tagName === "SELECT") {
      if (el.multiple && Array.isArray(v)) {
        Array.from(el.options).forEach((o) => (o.selected = v.includes(o.value)));
      } else {
        el.value = v == null ? "" : String(v);
      }
      return;
    }
    if (el.tagName === "DETAILS") {
      el.open = !!v;
      return;
    }
    if (el.isContentEditable) {
      el.innerHTML = v == null ? "" : String(v);
      return;
    }
    el.textContent = v == null ? "" : String(v);
  }

  function eventName(el) {
    if (el.tagName === "DETAILS") return "toggle";
    if (el.isContentEditable) return "input";
    if (isCheckLike(el) || el.tagName === "SELECT") return "change";
    return "input";
  }

  function isTextLike(el) {
    if (el.isContentEditable) return true;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    const t = el.type;
    return (
      t === "text" ||
      t === "search" ||
      t === "email" ||
      t === "url" ||
      t === "password" ||
      t === "tel" ||
      t === "number"
    );
  }

  // ---- State + WebSocket ----

  const room = defaultRoom();
  // Room capability injected by the page GET: it says which room this page may
  // join (and which it may read), nothing about who the viewer is — identity is
  // still the localStorage clientId plus whatever /auth/me verifies. Empty when
  // the deployment runs no login gate, which is also when the server asks for none.
  const token = (SCRIPT && SCRIPT.dataset && SCRIPT.dataset.token) || "";
  let myId = loadClientId();
  let user = loadUser();

  const bindings = new Map(); // key -> Set<HTMLElement>
  let state = {};
  let peers = [];
  // Server-maintained roster {uid: name}, carried in the reserved `__users`
  // state key. Split out of `state` (so it never binds and never flashes) and
  // exposed read-only via LiveHtml.users, so a page can put a name on a
  // participant who has already left — `peers` only lists live connections.
  let roster = {};
  let ws = null;
  let connected = false;
  let backoff = 500;
  let suppress = false; // suppress events while applying remote updates
  let pendingOutbox = [];
  let retryTimer = null; // armed while the server has throttled us
  let authedIdentity = false;
  let deniedLogin = false;

  const listeners = new Set();
  let notifying = false;

  function safeInvoke(cb, snap) {
    try {
      cb(snap);
    } catch (e) {
      console.warn("[livehtml] onChange 回调抛错（已忽略）:", e);
    }
  }

  // The server injects sync.js into <head>, so a top-level onChange/watchRoom
  // runs before the DOM its callback wants to render into exists. Hold the
  // first callback until the document is parsed. The membership check covers a
  // subscriber that unsubscribed inside that window.
  function firstCall(set, cb, snap) {
    const fire = function () {
      if (set.has(cb)) safeInvoke(cb, snap());
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fire, { once: true });
    } else {
      fire();
    }
  }

  function notifyListeners() {
    if (notifying) return; // a callback calling LiveHtml.set must not recurse
    notifying = true;
    try {
      const snap = { ...state };
      for (const cb of Array.from(listeners)) safeInvoke(cb, snap);
    } finally {
      notifying = false;
    }
  }

  // ---- Rooms this page declared `--read` on at publish time ----
  // The server attaches them at connect and pushes their frames wrapped in
  // {t:"room", room, msg}, so watchRoom is purely local: nothing to request,
  // and a reconnect restores the subscriptions without client bookkeeping.
  // A watched room's state is passed through as-is, `__users` included — a
  // dashboard usually wants those names.

  const roomStates = new Map();
  const roomWatchers = new Map();

  function roomSnapshot(r) {
    return { ...(roomStates.get(r) || {}) };
  }

  function applyRoomFrame(r, m) {
    if (m.t === "init" || m.t === "replace") {
      roomStates.set(r, { ...(m.state || {}) });
    } else if (m.t === "set" && typeof m.key === "string") {
      const cur = roomSnapshot(r);
      cur[m.key] = m.v;
      roomStates.set(r, cur);
    } else if (m.t === "del" && typeof m.key === "string") {
      const cur = roomSnapshot(r);
      delete cur[m.key];
      roomStates.set(r, cur);
    } else {
      return; // pres and friends carry no state for a read-only subscriber
    }
    const set = roomWatchers.get(r);
    if (!set) return;
    const snap = roomSnapshot(r);
    for (const cb of Array.from(set)) safeInvoke(cb, snap);
  }

  function watchRoom(r, cb) {
    if (typeof r !== "string" || typeof cb !== "function") {
      console.warn("[livehtml] LiveHtml.watchRoom(房间, 函数) 参数不对，已忽略");
      return function () {};
    }
    let set = roomWatchers.get(r);
    if (!set) {
      set = new Set();
      roomWatchers.set(r, set);
    }
    set.add(cb);
    firstCall(set, cb, function () {
      return roomSnapshot(r);
    });
    return function () {
      set.delete(cb);
    };
  }

  function bind(el) {
    const key = el.dataset.live;
    if (!key) return;
    const synced =
      el.tagName === "INPUT" ||
      el.tagName === "SELECT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "DETAILS" ||
      el.isContentEditable;
    if (!synced && el.children && el.children.length > 0) {
      // Binding a container would sync its textContent and wipe the children
      // (radios, labels, …) on the first applied value — refuse instead.
      console.warn(
        "[livehtml] data-live 应放在内部的 input/select 上，容器绑定已忽略以防清空内容: " + key,
      );
      return;
    }
    let set = bindings.get(key);
    if (!set) {
      set = new Set();
      bindings.set(key, set);
    }
    if (set.has(el)) return;
    set.add(el);

    if (key in state) {
      suppress = true;
      try {
        applyValueWithDefault(el, key, state[key]);
      } finally {
        suppress = false;
      }
    }

    const ev = eventName(el);
    let timer = null;
    el.addEventListener(ev, () => {
      if (suppress) return;
      const v = getVal(el);
      state[key] = v;
      if (isTextLike(el)) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => sendMsg({ t: "set", key, v }), 150);
      } else {
        sendMsg({ t: "set", key, v });
      }
    });
  }

  function blank(v) {
    return (
      v === undefined ||
      v === null ||
      v === "" ||
      v === "<br>" ||
      v === "<div><br></div>"
    );
  }

  // Apply a value to a data-live element, honoring `data-default`: when the
  // incoming value is blank (missing / "" / empty-contenteditable markup) and the
  // element declares data-default, show the default instead of wiping to empty —
  // and seed that default back into shared state so it persists across reloads.
  // Elements WITHOUT data-default keep the old behavior (blank -> empty).
  //
  // The seed WRITE is skipped for a `~` (live-only) key; showing the default
  // locally is not. The write's whole purpose is "so it persists across
  // reloads", which a `~` key does not do by definition. And since the server
  // reclaims an unwritten `~` key and fans the eviction out as an ordinary
  // `del`, this path is on the receiving end of that frame — a seed here would
  // answer every eviction by re-publishing the default, overwriting whatever a
  // participant had typed and re-stamping the key so the reclaim never
  // completes. A viewer that merely received a key's deletion must not
  // republish it.
  function applyValueWithDefault(el, key, v) {
    const def = el.dataset ? el.dataset.default : undefined;
    if (def !== undefined && blank(v)) {
      setVal(el, def);
      if (blank(state[key]) && key.charAt(0) !== "~") {
        state[key] = def;
        sendMsg({ t: "set", key, v: def });
      }
    } else {
      setVal(el, v === undefined ? "" : v);
    }
  }

  let revealed = false;
  function reveal() {
    // Drop the page's first-paint guard class once initial state is applied.
    // Pages may hide first-screen live fields via `body.live-pending` CSS to
    // avoid the default→real-value flicker; sync.js removes it here.
    if (revealed) return;
    revealed = true;
    try {
      document.body.classList.remove("live-pending");
    } catch {}
  }

  function applyKey(key, v) {
    if (v === undefined) delete state[key];
    else state[key] = v;
    const set = bindings.get(key);
    if (!set) return;
    suppress = true;
    try {
      for (const el of set) {
        if (isTextLike(el) && document.activeElement === el) continue;
        applyValueWithDefault(el, key, v);
      }
    } finally {
      suppress = false;
    }
  }

  function applyFullState(newState) {
    // Split the reserved `__users` roster out before it can bind or flash. A
    // payload without `__users` (an unauthenticated room, or a server predating
    // the roster) keeps the current one rather than flickering names away.
    const next = { ...newState };
    if (next.__users && typeof next.__users === "object" && !Array.isArray(next.__users)) {
      roster = next.__users;
    }
    delete next.__users;
    state = next;
    suppress = true;
    try {
      for (const [key, set] of bindings) {
        const v = state[key];
        for (const el of set) {
          if (isTextLike(el) && document.activeElement === el) continue;
          applyValueWithDefault(el, key, v);
        }
      }
    } finally {
      suppress = false;
    }
  }

  // The outbox is last-wins per key: `set` and `del` are both last-wins on the
  // server, so a queued op is worthless once a newer one for the same key
  // exists. Without this, a page that keeps writing while the socket is down
  // queues one op per write and replays the whole pile on reconnect; with it
  // the backlog stays O(keys) no matter the write rate.
  function outboxId(msg) {
    if (msg.t === "set" || msg.t === "del") {
      return typeof msg.key === "string" ? "k:" + msg.key : null;
    }
    if (msg.t === "pres") return "pres";
    return null;
  }

  function queueMsg(msg) {
    const id = outboxId(msg);
    if (id) {
      for (let i = 0; i < pendingOutbox.length; i++) {
        if (outboxId(pendingOutbox[i]) === id) {
          pendingOutbox.splice(i, 1);
          break;
        }
      }
    }
    pendingOutbox.push(msg);
  }

  // A throttled op sits in the outbox until the window the server named has
  // passed. One shared timer owns that schedule, so a page that keeps writing
  // through a throttle does not turn into a stream of individually-refused
  // messages — which is how a rate-limited page ends up sending MORE than an
  // unlimited one.
  function scheduleRetry(ms) {
    if (retryTimer) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      flushOutbox();
    }, ms > 0 ? ms : 1000);
  }

  function flushOutbox() {
    if (retryTimer || !pendingOutbox.length) return;
    if (!ws || ws.readyState !== 1) return;
    const items = pendingOutbox;
    pendingOutbox = [];
    for (const m of items) ws.send(JSON.stringify(m));
  }

  function sendMsg(msg) {
    if (ws && ws.readyState === 1 && !retryTimer) ws.send(JSON.stringify(msg));
    else queueMsg(msg);
  }

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      connected = true;
      backoff = 500;
      ws.send(
        JSON.stringify({ t: "hi", room, clientId: myId, user, token }),
      );
      flushOutbox();
      updateChip();
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.t) {
        case "init":
          // The server may key us by a trusted id (e.g. authenticated uid);
          // adopt it so our own presence row + self-checks match.
          if (msg.you) myId = msg.you;
          applyFullState(msg.state || {});
          reveal();
          peers = msg.peers || [];
          updateChip();
          notifyListeners();
          break;
        case "set":
          if (msg.key === "__users") {
            // Reserved roster update: refresh LiveHtml.users, never touch
            // state or the data-live bindings.
            if (msg.v && typeof msg.v === "object") roster = msg.v;
            notifyListeners();
            break;
          }
          applyKey(msg.key, msg.v);
          flashChange(msg.key, msg.by);
          notifyListeners();
          break;
        case "del":
          if (msg.key === "__users") break; // the server never deletes the roster
          applyKey(msg.key, undefined);
          flashChange(msg.key, msg.by);
          notifyListeners();
          break;
        case "replace":
          applyFullState(msg.state || {});
          notifyListeners();
          break;
        case "pres":
          peers = msg.peers || [];
          updateChip();
          notifyListeners();
          break;
        case "room":
          // A read-only room this page declared at publish time.
          if (typeof msg.room === "string" && msg.msg) applyRoomFrame(msg.room, msg.msg);
          break;
        case "throttled":
          // That op was dropped. Re-queue the page's CURRENT value for the key
          // rather than the dropped one — by now the page may have written
          // something newer, and resurrecting the old value would undo it.
          if (typeof msg.key === "string") {
            queueMsg(
              msg.key in state
                ? { t: "set", key: msg.key, v: state[msg.key] }
                : { t: "del", key: msg.key },
            );
          }
          scheduleRetry(msg.retryAfterMs);
          break;
        case "too_large":
          console.warn(
            "[livehtml] 单条写入超过服务端上限 " + msg.limit + " 字节，已被拒绝",
          );
          break;
        case "denied":
          deniedLogin = true;
          try { ws.close(); } catch {}
          // `room` = the page's room capability is missing or expired. The page
          // GET is the only thing that mints one, so reloading is the fix —
          // and if the session lapsed too, that reload lands on the login page.
          if (msg.reason === "room") showReloadNeeded();
          else showLoginNeeded();
          break;
      }
    };
    ws.onclose = () => {
      connected = false;
      updateChip();
      if (deniedLogin) return; // login required — stop hammering
      const delay = Math.min(backoff, 8000) + Math.random() * 500;
      backoff = Math.min(backoff * 2, 8000);
      setTimeout(connect, delay);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  // ---- Presence chip UI ----

  let chip, chipDot, chipCount, chipPanel;

  function showReloadNeeded() {
    if (chipCount) chipCount.textContent = "请刷新页面";
    if (chipDot) chipDot.style.background = "#ef4444";
  }

  function showLoginNeeded() {
    if (chipCount) chipCount.textContent = "需要登录";
    if (chipDot) chipDot.style.background = "#ef4444";
    const next = encodeURIComponent(location.pathname + location.search);
    const a = document.createElement("a");
    a.href = "/auth/dingtalk/login?next=" + next;
    a.textContent = "点此登录";
    a.style.cssText = "margin-left:8px;color:#2563eb;text-decoration:underline";
    if (chip) chip.appendChild(a);
  }

  function buildChip() {
    chip = document.createElement("div");
    chip.id = "livehtml-chip";
    chip.style.cssText = [
      "position:fixed",
      "top:12px",
      "right:12px",
      "z-index:2147483647",
      "font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "background:rgba(255,255,255,0.95)",
      "border:1px solid #e5e7eb",
      "border-radius:999px",
      "padding:6px 12px",
      "box-shadow:0 1px 3px rgba(0,0,0,0.08)",
      "display:flex",
      "align-items:center",
      "gap:8px",
      "cursor:pointer",
      "user-select:none",
      "color:#111",
    ].join(";");

    chipDot = document.createElement("span");
    chipDot.style.cssText =
      "width:8px;height:8px;border-radius:50%;background:#9ca3af;display:inline-block";
    chip.appendChild(chipDot);

    chipCount = document.createElement("span");
    chip.appendChild(chipCount);

    chipPanel = document.createElement("div");
    chipPanel.style.cssText = [
      "position:fixed",
      "top:48px",
      "right:12px",
      "z-index:2147483647",
      "background:#fff",
      "border:1px solid #e5e7eb",
      "border-radius:8px",
      "box-shadow:0 4px 12px rgba(0,0,0,0.08)",
      "padding:10px 12px",
      "min-width:200px",
      "display:none",
      "font:13px/1.5 -apple-system,sans-serif",
      "color:#111",
    ].join(";");
    chip.addEventListener("click", () => {
      chipPanel.style.display =
        chipPanel.style.display === "none" ? "block" : "none";
      renderPanel();
    });

    document.body.appendChild(chip);
    document.body.appendChild(chipPanel);
    updateChip();
  }

  function updateChip() {
    if (!chip) return;
    chipDot.style.background = connected ? "#22c55e" : "#9ca3af";
    const n = peers.length || (connected ? 1 : 0);
    chipCount.textContent = `${n} 在线 · ${user.name || "?"}`;
    if (chipPanel.style.display !== "none") renderPanel();
  }

  function renderPanel() {
    if (!chipPanel) return;
    chipPanel.innerHTML = "";
    const title = document.createElement("div");
    title.textContent = "房间：" + room;
    title.style.cssText = "font-size:11px;color:#6b7280;margin-bottom:6px;word-break:break-all";
    chipPanel.appendChild(title);

    const list = peers.length ? peers : [{ id: myId, user }];
    list.forEach((p) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;padding:3px 0";
      const dot = document.createElement("span");
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:hsl(${hueFromId(p.id)} 70% 50%);display:inline-block`;
      const name = document.createElement("span");
      name.textContent = (p.user && p.user.name) || p.id.slice(0, 6);
      if (p.id === myId) {
        name.textContent += " (你)";
        if (!authedIdentity) {
          name.style.cursor = "pointer";
          name.title = "点击改名";
          name.addEventListener("click", (e) => {
            e.stopPropagation();
            const newName = prompt("修改昵称", user.name || "");
            if (newName && newName.trim()) {
              user = { ...user, name: newName.trim() };
              saveUserName(user.name);
              sendMsg({ t: "pres", v: user });
              updateChip();
            }
          });
        }
      }
      row.appendChild(dot);
      row.appendChild(name);
      chipPanel.appendChild(row);
    });

    const tip = document.createElement("div");
    tip.style.cssText = "font-size:11px;color:#9ca3af;margin-top:8px;border-top:1px solid #f3f4f6;padding-top:6px";
    tip.textContent = connected ? "已连接" : "未连接，重试中…";
    chipPanel.appendChild(tip);
  }

  // ---- Change flash (gentle hint) ----

  function flashChange(key, byId) {
    if (byId === myId) return;
    const set = bindings.get(key);
    if (!set) return;
    for (const el of set) {
      const orig = el.style.boxShadow;
      el.style.transition = "box-shadow 0.4s ease";
      el.style.boxShadow = `0 0 0 3px hsl(${hueFromId(byId || "?")} 80% 60% / 0.5)`;
      setTimeout(() => {
        el.style.boxShadow = orig;
      }, 600);
    }
  }

  // ---- DOM observation: auto-bind elements added later ----

  function scanAndBind(root) {
    if (root.matches && root.matches("[data-live]")) bind(root);
    if (root.querySelectorAll) {
      root.querySelectorAll("[data-live]").forEach(bind);
    }
  }

  function observeDom() {
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType === 1) scanAndBind(n);
        });
        if (m.type === "attributes" && m.target.hasAttribute("data-live")) {
          bind(m.target);
        }
      }
    });
    obs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-live"],
    });
  }

  function start() {
    buildChip();
    scanAndBind(document);
    observeDom();
    // Fallback reveal: if the WS is slow/offline, still un-hide first-screen
    // fields (showing HTML defaults) so the page never stays hidden.
    setTimeout(reveal, 1500);
    // If the deployment requires login, /auth/me returns the verified identity.
    fetch("/auth/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => {
        if (me && me.authenticated && me.name) {
          user = { name: me.name, userId: me.userId };
          authedIdentity = true;
        }
      })
      .catch(() => {})
      .finally(() => {
        updateChip();
        connect();
      });
  }

  // ---- Public API ----

  // Subscribe to state changes (the only event API). The callback receives a
  // state snapshot, fires once immediately on subscribe, and again on every
  // remote init/set/del/replace/pres and local LiveHtml.set/del. Returns an
  // unsubscribe function.
  function onChange(cb) {
    if (typeof cb !== "function") {
      console.warn("[livehtml] LiveHtml.onChange 需要函数参数，已忽略");
      return () => {};
    }
    listeners.add(cb);
    firstCall(listeners, cb, function () {
      return { ...state };
    });
    return () => listeners.delete(cb);
  }

  const api = {
    get state() {
      return { ...state };
    },
    get peers() {
      return peers.slice();
    },
    get users() {
      // {uid: name} for everyone the server has seen sign in to this room,
      // including people who have since left — render "who voted" via
      // LiveHtml.users[uid]. Only populated behind the login gate. Snapshot copy.
      return { ...roster };
    },
    get room() {
      return room;
    },
    get me() {
      // Current participant. `userId` is the server-verified DingTalk id, present
      // only when logged in; `id` is the per-connection clientId. Pages choose:
      // per-connection -> me.id ; per-user -> me.userId || me.id.
      return { id: myId, name: (user && user.name) || null, userId: (user && user.userId) || null };
    },
    onChange,
    onStateChange: onChange,
    subscribe: onChange,
    getState: () => ({ ...state }),
    watchRoom,
    setUser(u) {
      user = typeof u === "string" ? { name: u } : u;
      if (user.name) saveUserName(user.name);
      sendMsg({ t: "pres", v: user });
      updateChip();
    },
    set(key, v) {
      if (String(key).startsWith("__")) {
        console.warn("[livehtml] " + key + " 是服务端保留键，页面不可写");
        return;
      }
      state[key] = v;
      sendMsg({ t: "set", key, v });
      applyKey(key, v);
      notifyListeners();
    },
    del(key) {
      if (String(key).startsWith("__")) {
        console.warn("[livehtml] " + key + " 是服务端保留键，页面不可写");
        return;
      }
      delete state[key];
      sendMsg({ t: "del", key });
      applyKey(key, undefined);
      notifyListeners();
    },
  };

  // Warning-net: a hallucinated LiveHtml member (agent-generated pages reach
  // for LiveHtml.watch/on/subscribeState all the time) degrades to a
  // console.warn plus a Promise of the current state snapshot, instead of a
  // TypeError that kills the whole page <script>. Real members above never
  // reach the trap; symbols and then/catch/finally return undefined so
  // LiveHtml is never mistaken for a thenable.
  window.LiveHtml = new Proxy(api, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "symbol" || prop === "then" || prop === "catch" || prop === "finally") {
        return undefined;
      }
      return function () {
        console.warn("LiveHtml." + String(prop) + " 不存在；订阅状态变化用 LiveHtml.onChange(fn)");
        return Promise.resolve({ ...state });
      };
    },
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
