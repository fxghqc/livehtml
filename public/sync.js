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
  let myId = loadClientId();
  let user = loadUser();

  const bindings = new Map(); // key -> Set<HTMLElement>
  let state = {};
  let peers = [];
  let ws = null;
  let connected = false;
  let backoff = 500;
  let suppress = false; // suppress events while applying remote updates
  let pendingOutbox = [];
  let authedIdentity = false;
  let deniedLogin = false;

  function bind(el) {
    const key = el.dataset.live;
    if (!key) return;
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
        setVal(el, state[key]);
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

  function applyKey(key, v) {
    if (v === undefined) delete state[key];
    else state[key] = v;
    const set = bindings.get(key);
    if (!set) return;
    suppress = true;
    try {
      for (const el of set) {
        if (isTextLike(el) && document.activeElement === el) continue;
        if (v === undefined) setVal(el, "");
        else setVal(el, v);
      }
    } finally {
      suppress = false;
    }
  }

  function applyFullState(newState) {
    state = { ...newState };
    suppress = true;
    try {
      for (const [key, set] of bindings) {
        const v = state[key];
        for (const el of set) {
          if (isTextLike(el) && document.activeElement === el) continue;
          if (v === undefined) setVal(el, "");
          else setVal(el, v);
        }
      }
    } finally {
      suppress = false;
    }
  }

  function sendMsg(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    else pendingOutbox.push(msg);
  }

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      connected = true;
      backoff = 500;
      ws.send(
        JSON.stringify({ t: "hi", room, clientId: myId, user }),
      );
      for (const m of pendingOutbox) ws.send(JSON.stringify(m));
      pendingOutbox = [];
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
          peers = msg.peers || [];
          updateChip();
          break;
        case "set":
          applyKey(msg.key, msg.v);
          flashChange(msg.key, msg.by);
          break;
        case "del":
          applyKey(msg.key, undefined);
          flashChange(msg.key, msg.by);
          break;
        case "replace":
          applyFullState(msg.state || {});
          break;
        case "pres":
          peers = msg.peers || [];
          updateChip();
          break;
        case "denied":
          deniedLogin = true;
          try { ws.close(); } catch {}
          showLoginNeeded();
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

  window.LiveHtml = {
    get state() {
      return { ...state };
    },
    get peers() {
      return peers.slice();
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
    setUser(u) {
      user = typeof u === "string" ? { name: u } : u;
      if (user.name) saveUserName(user.name);
      sendMsg({ t: "pres", v: user });
      updateChip();
    },
    set(key, v) {
      state[key] = v;
      sendMsg({ t: "set", key, v });
      applyKey(key, v);
    },
    del(key) {
      delete state[key];
      sendMsg({ t: "del", key });
      applyKey(key, undefined);
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
