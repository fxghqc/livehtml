// Publish-time lint. Only high-confidence "this page will definitely misbehave"
// patterns are errors (they block the PUT and are handed back so an agent can
// fix and re-publish); everything else is a warning that rides along with a
// successful publish.
//
// Parsing is Bun's HTMLRewriter (lol-html) rather than a hand-rolled tokenizer:
// real generated HTML is messy, and a wrong "your page is broken" that blocks
// publishing is worse than the bug it claims to catch.

export type LintResult = { errors: string[]; warnings: string[] };

// Elements sync.js drives through a value/checked/open property. Anything else
// with data-live is synced through textContent.
const SYNCED_TAGS = new Set(["input", "select", "textarea", "details"]);

// Tags an identical sibling implicitly closes, so `<li>a<li>b` is two siblings
// rather than a nesting. The parser reports an end tag for the first one all
// the same, and it arrives AFTER the sibling's start — which would otherwise
// read as "this element has an element child". Restricted to tags where the
// implicit close is real: a <div> inside a <div> is genuine nesting and stays
// reportable.
const IMPLICITLY_CLOSED_BY_SIBLING = new Set([
  "li",
  "p",
  "option",
  "tr",
  "td",
  "th",
  "dt",
  "dd",
]);

// Everything window.LiveHtml actually exposes. A member outside this list is a
// hallucination, and calling one throws — which kills the whole page <script>.
const LIVEHTML_MEMBERS = new Set([
  "state",
  "peers",
  "users",
  "room",
  "me",
  "onChange",
  "onStateChange",
  "subscribe",
  "onFrame",
  "getState",
  "setUser",
  "set",
  "del",
  "watchRoom",
]);

const API_REFERENCE =
  "LiveHtml 的全部成员：state / peers / users / room / me / " +
  "onChange(fn) / onStateChange / subscribe / onFrame(fn) / getState() / setUser(名字) / " +
  "set(键,值) / del(键) / watchRoom(房间,fn)";

// Comments are stripped before the member scan: prose in a comment mentioning
// LiveHtml.whatever, or a commented-out earlier attempt, must not block a
// publish. `<!--` inside a <script> is a line comment in browsers (Annex B),
// hence the third and fourth patterns.
function stripJsComments(js: string): string {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/<!--[^\n]*/g, "")
    .replace(/^[ \t]*-->[^\n]*/gm, "");
}

export async function lintHtml(html: string): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const js: string[] = [];
  let hasOwnSyncScript = false;

  // A `data-live` container is only reported once we have seen BOTH an element
  // child open inside it AND its own end tag. Requiring the end tag is what
  // keeps implicitly-closed markup (`<li data-live>a<li data-live>b`) from
  // being misread as nesting: those elements never produce an end tag, so they
  // are never flagged. Erring toward silence is the right direction for a check
  // that blocks publishing.
  type Candidate = { key: string; tag: string; sawChild: boolean };
  const open = new Set<Candidate>();

  let inInlineScript = false;

  const rewriter = new HTMLRewriter().on("*", {
    element(el) {
      for (const [name, value] of el.attributes) {
        if (name.startsWith("on") && value) js.push(value);
      }

      const tag = el.tagName.toLowerCase();
      if (tag === "script") {
        const src = el.getAttribute("src");
        if (src && /(^|\/)sync\.js([?#]|$)/.test(src)) hasOwnSyncScript = true;
        if (!src) {
          inInlineScript = true;
          el.onEndTag(() => {
            inInlineScript = false;
          });
        }
        return;
      }

      // Any element opening now is a descendant of everything still open —
      // except an identical sibling that implicitly closed one of them.
      for (const c of open) {
        if (c.tag === tag && IMPLICITLY_CLOSED_BY_SIBLING.has(tag)) open.delete(c);
        else c.sawChild = true;
      }

      const key = el.getAttribute("data-live");
      if (key === null) return;
      // A valueless `contenteditable` reads as "", which is still editable —
      // only an explicit "false" turns it off.
      const editable =
        el.hasAttribute("contenteditable") &&
        (el.getAttribute("contenteditable") || "").toLowerCase() !== "false";
      if (SYNCED_TAGS.has(tag) || editable) return;

      const candidate: Candidate = { key, tag, sawChild: false };
      open.add(candidate);
      el.onEndTag(() => {
        open.delete(candidate);
        if (!candidate.sawChild) return;
        errors.push(
          `<${candidate.tag} data-live="${candidate.key}"> 是容器：data-live 要放在里面的 ` +
            `<input>/<select> 等控件本身，放在容器上会用 textContent 同步、把里面的内容清空`,
        );
      });
    },
    text(t) {
      if (inInlineScript && t.text) js.push(t.text);
    },
  });

  try {
    await rewriter.transform(new Response(html)).text();
  } catch {
    // Unparseable input is not something to block a publish over; the browser
    // will make of it whatever it makes.
    return { errors, warnings };
  }

  const source = stripJsComments(js.join("\n"));

  const bad = [
    ...new Set(
      Array.from(source.matchAll(/LiveHtml\.([A-Za-z_$][\w$]*)/g), (m) => m[1]!).filter(
        (name) => !LIVEHTML_MEMBERS.has(name),
      ),
    ),
  ].sort();
  if (bad.length) {
    errors.push(
      `页面 JS 调用了不存在的成员：${bad.map((n) => "LiveHtml." + n).join("、")}。${API_REFERENCE}`,
    );
  }
  if (/LiveHtml\.state\s*\(/.test(source)) {
    errors.push("LiveHtml.state 是属性不是函数；直接读 LiveHtml.state，或用 LiveHtml.getState()");
  }
  if (hasOwnSyncScript) {
    warnings.push("页面自带了 sync.js 的 <script>，服务端会剥掉并注入自己的，无需自带");
  }

  return { errors, warnings };
}
