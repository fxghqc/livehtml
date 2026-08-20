# gamenet：多人实时游戏 / 共享画布配方（WebSocket 版）

需要**很多人同时看到彼此每秒几十次动作**的页面——多人游戏、共享画布、实时对局——用这套协议。**不要用 `data-live`**：`data-live` 是给表单类共享状态（勾选/填写/投票）设计的，每次写入都落盘、推进版本号、唤醒 `livehtml watch` 长轮询，扛不住 20 Hz 的位置更新。

本文末尾是一个**可直接发布、可换皮**的完整页面（方向键控制一个点的共享竞技场）。照抄它，保留键名、`by` 校验、心跳/TTL 的比例（见「必须原样保留」），把「一个点的位置」换成你的游戏状态即可。坦克大战：坦克 = 点（自报位置+朝向），难点在命中判定——见 §2。

这套配方**不需要任何服务端改动**，全部搭在平台已有的 `~`（transient）键语义上。

---

## 1. 键的模式

| 键 | 谁写 | 频率 | 用到的前缀语义 |
|---|---|---|---|
| `~g:in:<uid>` | **只有该用户自己的标签页**（§2 由接收方强制） | 50 ms 一拍、合并；即使没动也每 ≤1500 ms 心跳重发一次 | 一人一键，所以 per-key last-write-wins 无需协调。"只有本人写"是接收方校验 `by` 得来的（§5），不是服务端授予的 |

整个协议就这一句：**一人一键，只携带该玩家对自己的描述**（位置）。没有花名册键、没有 host、没有租约。需要"一个没人能自报的量"（谁被击中、谁得分）时见 §2。

键带 `~` 前缀 = **live-only**：广播、进房间内存，但**永不落盘、不推进版本号**（所以不唤醒 `livehtml watch`），且**没人重写就会被服务端回收**。服务端每秒扫一遍，回收"最后一次写入早于 `TRANSIENT_TTL_SEC`（默认 30 s）"的 `~` 键——所以你用 `~` 键装的东西**必须在这个窗口内被反复重写**，动没动都写（上表的心跳就是干这个的）。回收会以一条**普通 `del` 帧**到达页面，带 `by:""` + `src:"server"`（§5 必须放行这条，否则服务端已收回的状态永远留在屏幕上）。

要长期保存的值（房间标题）放**普通键**（`data-live`），别放 `~` 键——`~` 键不是"写一次放着"的存储。模板里 `g-room-title` 就是普通 `data-live`，和 `~` 键各走各的、互不干扰。

## 2. 没有裁判

每个键都是**自报**：`~g:in:<uid>` 是该用户说自己在哪，接收方唯一的检查是"帧的 `by` 等于键里的 uid"（§5）。每个客户端从它收到的全部 `~g:in:*` 帧里自己画出竞技场，并按各自的接收时间剪掉不再听到的人（§5 stale sweep）。**不要引入 host / 选举 / 租约 / "谁先谁说了算"的协调者**——每个客户端自己决定画什么，画出来不可能和别人矛盾。

**需要一个"被决定的量"时**（击中、被吃、发牌、得分——一个玩家对**另一个**玩家的判定），它**不能走自报**，`by` 校验也授权不了它（`~g:hit:<受害者>` 是开枪者写的，`by` 只说明谁写的、不说明内容是否为真）。两条正解，都不用选举：

1. **每个接收方各自重算**。每个客户端都握有全部玩家的 `~g:in:*`，所以一条确定性规则（"这两个点重叠 → 都反弹"）在相同输入上求值，人人得同一答案，无需谁做主。把规则写成"收到状态的纯函数"，它天然一致。坦克大战的子弹-坦克/子弹-墙碰撞走这条。
2. **交给后端 agent**。把结果写进**普通（非 `~`）键**——agent 用 `livehtml set <room> '{...}'`（或 HTTP `PUT /pages/<key>/state`）写入，这是本系统里唯一"不是参与者"的写者，才是真正的权威。慢（不是 50 ms 的路径），适合值得留存的东西（比分、结果、回合）。

**不要**在页面里搞客户端选举——那只是让"一个参与者"做主，不是权威。

## 3. 传输：`LiveHtml.set` + `onFrame`

- **上行**：位置用 `LiveHtml.set("~g:in:"+UID, {x,y,seq})` 写，走 sync.js 的 WebSocket。
- **下行**：用 **`LiveHtml.onFrame(fn)`** 收**每一条**远端 `set`/`del` 帧的原文 `{t,key,v,by,src}`。这是做 `by` 校验和识别服务端回收所必需的——`LiveHtml.onChange` 只给合并后的 state 快照、不带 `by`，**做不了这个配方**。

**关键：不要从 state / onChange 里读 `~g:in:*` 来画远端玩家。** sync.js 会把任何 `~g:in:<x>` 的 set 无条件写进 state（它不知道你的 `by` 规则），所以 state 里可能是被别人冒名写入的位置。**只信 `onFrame` 里 `by` 通过校验的帧。** 代价：新加入者要等别人的下一次心跳（≤1500 ms）才看到对方——可接受，且换来"绝不渲染未经授权的位置"。

**重连回放**：sync.js 断线时会把 `LiveHtml.set` 缓进 `pendingOutbox`，重连后回放。对 20 Hz 位置来说这会把你的点沿最近路径倒着走一下——但因为写者是**心跳驱动**（不是只在变化时写），最多一个心跳后（≤1500 ms）下一拍就把它盖回当前值。容忍这个瞬时抖动即可；要零抖动的分叉可自行在断线时丢弃 `~` 写入。

### 3.1 渲染：自己的点本地预测，别人的点追赶

- **你自己的点永不从网络数据画**。方向键设一个 held 方向表，rAF 循环按 `SPEED` px/s 乘每帧 `dt` 积分、立即落位——不等"按键→set→广播回来"那一圈，否则自己的点会迟钝。（`onFrame`、渲染都对 `pid === UID` 跳过，服务端回收自己的键也跳过——那不代表你走了，下一拍心跳会把它写回。）
- **别人的点从各自的 `~g:in:` 一手拿到**，朝最新已知位置**按固定时间常数追赶**（`1 - exp(-dt/TAU)`），超过 `SNAP_DISTANCE` 就直接跳（respawn/重连不要滑过整个场地）。不要为"一致性"再引入一个中继键——每个客户端本来就直接收到每个人的输入，中继只增加一跳延迟、零收益。

## 4. 限流预算

`OPS_RATE_PER_SEC`（livehtml 默认 **60**）按 **(房间, 写者)** 计，写者是登录 uid（不是标签页），突发容量 2×。50 ms 一拍、按住方向键 = **≤20 写/秒**，远在预算内；同一登录用户开两个标签页共用一个桶，各 20 = 40，仍在内。

**这个预算只在登录房间成立。公开页所有匿名访客折进同一个桶**（公开页每次 GET 发一个新匿名 id，否则按 id 分桶等于免费配额）：整个竞技场共享 60/秒，三个匿名玩家（各 20）就顶到 60、第四个就超。超了 `LiveHtml.set` 的帧被静默丢弃 = 全场卡顿。**把游戏发到登录房间**（不加 `--public`）。玩家多就调高服务端 `OPS_RATE_PER_SEC`（约 `20 × 人数`）。

单帧大小上限 `OPS_MAX_BYTES`（默认 256 KiB），每帧就一个 `{x,y,seq}` 几十字节，远够；但往一帧里塞很多每玩家状态（轨迹/背包/聊天）的分叉要留意。

## 5. 必须原样保留（除非你明确知道为什么改）

- **无 host、无裁判**——加回来不是它看起来的那个"修复"。每个键只带本人对自己的描述，每个客户端从收到的全部 `~g:in:*` 自己画。别写客户端选举/租约/"谁先谁说了算"。
- **`onFrame` 里对 `set` 帧的 `by` 校验**：`~g:in:<uid>` 只接受 `frame.by === uid`。`by` 由服务端从房间 token 盖章、页面伪造不了，是本系统**唯一**的授权；键名本身不授予任何东西——任何参与者都能发一条名为别人的 `~g:in:`，是这个校验（不是服务端）挡住它。丢了它，任何人都能操纵/抹掉别人的点。
- **`del` 只认两种来源**：`frame.by === uid`（本人删自己）**或** `frame.src === "server" && frame.by === ""`（平台回收失活的 `~` 键）。别的 `del`（某 peer 删别人的键）忽略，否则会被用来反复闪删别人。回收自己的键则跳过（不代表你走了，下一拍心跳写回）。
- **每一个"拿线上来的字符串当键去查"的 map 用 `Object.create(null)`，不是 `{}`**：`targets`/`shown`/`players`/`dots` 都以玩家 id 为键，而 id 来自网络、服务端只校验 `__` 前缀不校验别的。id 若是 `constructor`/`__proto__`/`toString`，`{}` 会答应这些名字，导致渲染在每一帧抛错、或某玩家永远无法被清除。`DIRS`（输入白名单）同理——它**就是**那道 guard，普通 `{}` 不是白名单（`DIRS["constructor"]` 是个函数会让非法键通过）。
- **自己的点被所有"从网络来的东西"跳过**（含服务端回收自己的键）**，也被 stale sweep 跳过**（§3.1）。从收到的帧摆自己的点 = 把它拽回一圈之前的位置，看起来像点在和键盘打架。
- **stale sweep 和输入心跳是一对，不能拆**：丢了 sweep，离开的人会一直留在场上（服务端确实会回收键，但按它几十秒的窗口，对渲染太粗）；丢了心跳只留 sweep，静止但在场的人会被误判离开、且服务端也会把他的键回收掉。
- **让这对安全的比例**：`INPUT_HEARTBEAT_MS` 远小于 `PLAYER_STALE_MS`（1500 vs 5000，丢三拍才误剪），`PLAYER_STALE_MS` 远小于 `TRANSIENT_TTL_SEC`（5 s vs 30 s，键的存活久于任何人画它）。收窄任一间隙都会剪掉还在的人。
- **不从 init/state 播种远端玩家**（§3）——state 不带 `by`，播种就绕过了 `by` 校验。只信 `onFrame`。
- 每个 `~` 键都带 `~` 前缀。少了 `~` 会被落盘、每次写推进版本号，把去抖的磁盘写和 `livehtml watch` 冲垮。

**可以自由改**：竞技场视觉、"玩家"是什么（点/牌/格子/坦克）、`INPUT_TICK_MS` 与心跳周期（只要比例不破）、`SPEED`/`SMOOTH_TAU_MS`/`SNAP_DISTANCE`（纯表现，不上线不吃预算）、再加普通 `data-live` 键（和 `~` 层互不干扰）。

## 6. 身份就绪时机（重要）

键 `~g:in:<UID>` 里的 UID **必须等于服务端会盖的 `by`**：登录房间里 `by` = 核验 uid（`LiveHtml.me.userId`），匿名公开页里 `by` = 每连接 id（`LiveHtml.me.id`）。而 `me.userId` 来自异步的 `/auth/me`——sync.js 的 WS 连接**在该请求返回之后**才建立，所以取 UID 要**等 `me.userId` 就绪**再定，别在脚本一加载就取（那时登录用户的 `userId` 可能还没到、错用成 id，会因 `by` 对不上而对所有人隐身）。模板里 `whenIdentityReady` 就是干这个：短暂轮询 `me.userId`，出现就用它，超时（公开页永远不出现）回落到 `me.id`。

## 7. 已知限制

- **init 帧不带 per-key `by`**，所以本配方直接**不播种** state 里的 `~g:in:*`（§3），靠对方心跳补齐（≤1.5 s）。这是有意的安全取舍。
- **同一登录用户开两个标签页**都会写 `~g:in:<uid>`，两个都合法，位置不同 → 那个点在两处间抖。别开第二个本页标签页（含你想"换一个开"时忘了关的旧标签）。
- **公开页每次加载漏一个 `~` 键**，只被 TTL 兜底、不自愈——本配方是给**登录房间**的（也见 §4 的限流）。

---

## 模板（照抄改写）

```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>共享竞技场 · gamenet</title>
<style>
  :root { --bg:#0f1116; --arena:#171a21; --line:#2a2f3a; --ink:#e8ebf0; --muted:#9aa3b2; }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,sans-serif}
  .wrap{max-width:720px;margin:0 auto;padding:20px}
  h1{font-size:18px;margin:0 0 4px} .sub{color:var(--muted);font-size:12px;margin-bottom:12px}
  #title{width:100%;background:var(--arena);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:8px 10px;font-size:14px;margin-bottom:12px}
  #arena{position:relative;width:640px;max-width:100%;height:360px;background:var(--arena);border:1px solid var(--line);border-radius:12px;overflow:hidden;touch-action:none}
  .dot{position:absolute;width:20px;height:20px;border-radius:50%;margin:-10px 0 0 -10px;box-shadow:0 0 0 2px rgba(0,0,0,.35)}
  .nm{position:absolute;left:50%;top:100%;font-size:10px;color:var(--muted);transform:translate(-50%,2px);white-space:nowrap;pointer-events:none}
  .hint{color:var(--muted);font-size:12px;margin-top:10px}
</style>
</head>
<body>
<div class="wrap">
  <h1>🎮 共享竞技场</h1>
  <div class="sub">方向键移动你的点，所有人实时看到彼此。由 livehtml 的 <code>~</code> transient 键驱动。</div>
  <input id="title" data-live="g-room-title" data-default="来玩" placeholder="房间标题（会保存）">
  <div id="arena"></div>
  <div class="hint">别开两个本页标签页（同一个你会互相拉扯）。离开几秒后你的点会自动消失。</div>
</div>
<script>
(function () {
  var UID = null;

  // config —— feel（下面这些）随便改；§5 里的比例别破
  var INPUT_TICK_MS = 50, INPUT_HEARTBEAT_MS = 1500, PLAYER_STALE_MS = 5000;
  var SPEED = 190, SMOOTH_TAU_MS = 90, SNAP_DISTANCE = 120;
  var ARENA_W = 640, ARENA_H = 360, R = 10;

  var arena = document.getElementById("arena");
  // 每个"拿线上 id 当键"的 map 都是 null-proto：id 可能是 "constructor"/"__proto__"
  var targets = Object.create(null);   // pid -> {x,y}  最新已知远端位置
  var shown   = Object.create(null);   // pid -> {x,y}  当前画出来的（追赶中）
  var players = Object.create(null);   // pid -> {at}   本地接收时间，喂给 stale sweep
  var dots    = Object.create(null);   // pid -> 元素
  var DIRS = Object.create(null);      // 输入白名单：它就是那道 guard
  DIRS.ArrowUp=[0,-1]; DIRS.ArrowDown=[0,1]; DIRS.ArrowLeft=[-1,0]; DIRS.ArrowRight=[1,0];
  var held = Object.create(null);      // 已过 DIRS guard 的键

  function now(){ return Date.now(); }
  function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
  function color(id){ var h=0,i; for(i=0;i<id.length;i++) h=(h*31+id.charCodeAt(i))>>>0; return "hsl("+(h%360)+" 70% 60%)"; }
  function place(d,x,y){ d.style.left=x+"px"; d.style.top=y+"px"; }

  function ensureDot(pid){
    var d = dots[pid];
    if (d) return d;
    d = document.createElement("div"); d.className = "dot"; d.style.background = color(pid);
    var nm = document.createElement("div"); nm.className = "nm";
    nm.textContent = (LiveHtml.users && LiveHtml.users[pid]) || pid.slice(0,4);
    d.appendChild(nm); arena.appendChild(d); dots[pid] = d; return d;
  }
  function removePlayer(pid){
    if (dots[pid] && dots[pid].parentNode) dots[pid].parentNode.removeChild(dots[pid]);
    delete dots[pid]; delete targets[pid]; delete shown[pid]; delete players[pid];
  }

  // 我自己的点：本地预测，永不从网络摆位
  var myPos = { x: ARENA_W/2, y: ARENA_H/2 };
  window.addEventListener("keydown", function(ev){ if (DIRS[ev.key]) { held[ev.key]=1; ev.preventDefault(); } });
  window.addEventListener("keyup",   function(ev){ delete held[ev.key]; });
  window.addEventListener("blur",    function(){ for (var k in held) delete held[k]; }); // 失焦收不到 keyup

  // 远端玩家：只信 onFrame 里 by 通过校验的帧，绝不从 state 播种
  function startGame(){
    LiveHtml.onFrame(function (f) {
      if (typeof f.key !== "string" || f.key.slice(0,6) !== "~g:in:") return;
      var pid = f.key.slice(6);
      if (pid === UID) return;                       // 自己的点本地拥有
      if (f.t === "set") {
        if (f.by !== pid) return;                    // by 校验：只有本人能写自己的键
        var v = f.v; if (!v || typeof v.x !== "number" || typeof v.y !== "number") return;
        targets[pid] = { x: v.x, y: v.y };
        if (!shown[pid]) shown[pid] = { x: v.x, y: v.y };
        players[pid] = { at: now() };
      } else if (f.t === "del") {
        if (f.by === pid || (f.src === "server" && f.by === "")) removePlayer(pid);
      }
    });

    // 输入拍：合并 + 心跳，fire-and-forget
    var seq = 0, lastSent = 0;
    setInterval(function () {
      var moved = false, k;
      for (k in held) { moved = true; break; }
      if (moved || (now() - lastSent) >= INPUT_HEARTBEAT_MS) {
        lastSent = now();
        LiveHtml.set("~g:in:" + UID, { x: Math.round(myPos.x), y: Math.round(myPos.y), seq: ++seq });
      }
    }, INPUT_TICK_MS);

    // stale sweep：剪掉不再听到的远端玩家
    setInterval(function () {
      var t = now(), pid;
      for (pid in players) if (t - players[pid].at > PLAYER_STALE_MS) removePlayer(pid);
    }, 1000);

    // 渲染：自己的点积分、别人的点追赶
    var last = null;
    requestAnimationFrame(function frame(ts){
      if (last == null) last = ts;
      var dt = Math.min(100, ts - last); last = ts;
      var dx=0, dy=0, k;
      for (k in held) { var d=DIRS[k]; dx+=d[0]; dy+=d[1]; }
      if (dx || dy) {
        var len = Math.hypot(dx,dy) || 1;
        myPos.x = clamp(myPos.x + (dx/len)*SPEED*dt/1000, R, ARENA_W-R);
        myPos.y = clamp(myPos.y + (dy/len)*SPEED*dt/1000, R, ARENA_H-R);
      }
      place(ensureDot(UID), myPos.x, myPos.y);
      var alpha = 1 - Math.exp(-dt / SMOOTH_TAU_MS), pid;
      for (pid in targets) {
        var tg = targets[pid], s = shown[pid] || (shown[pid] = {x:tg.x,y:tg.y});
        if (Math.abs(tg.x-s.x)+Math.abs(tg.y-s.y) > SNAP_DISTANCE) { s.x=tg.x; s.y=tg.y; }
        else { s.x += (tg.x-s.x)*alpha; s.y += (tg.y-s.y)*alpha; }
        place(ensureDot(pid), s.x, s.y);
      }
      requestAnimationFrame(frame);
    });
  }

  // 身份就绪再定 UID（§6）：登录用户等 me.userId，公开页超时回落到 me.id
  var t0 = now();
  (function whenIdentityReady(){
    var me = (window.LiveHtml && LiveHtml.me) || {};
    if (me.userId) { UID = me.userId; return startGame(); }
    if (now() - t0 > 2000) { UID = me.id || ("anon-" + Math.random().toString(36).slice(2)); return startGame(); }
    setTimeout(whenIdentityReady, 50);
  })();
})();
</script>
</body>
</html>
```
