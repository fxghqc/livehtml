// tests/unit/lint.test.ts
import { test, expect } from "bun:test";
import { lintHtml } from "../../lint.ts";

const page = (body: string) => `<html><head></head><body>${body}</body></html>`;

test("data-live on a container with element children is an error", async () => {
  const r = await lintHtml(page('<div data-live="poll"><input type="radio"></div>'));
  expect(r.errors.length).toBe(1);
  expect(r.errors[0]).toContain("是容器");
});

test("data-live on the control itself, or on a text leaf, is fine", async () => {
  for (const body of [
    '<input data-live="a">',
    '<select data-live="b"><option>x</option></select>',
    '<textarea data-live="c"></textarea>',
    '<details data-live="d"><summary>s</summary>body</details>',
    '<span data-live="e">just text</span>',
    '<span contenteditable data-live="f"><b>rich</b></span>',
  ]) {
    const r = await lintHtml(page(body));
    expect({ body, errors: r.errors }).toEqual({ body, errors: [] });
  }
});

test("implicitly-closed siblings are not misread as nesting", async () => {
  // <li> without </li> produces no end tag, so these can never be confidently
  // called containers — and a false "your page is broken" would block a publish.
  const r = await lintHtml(page('<ul><li data-live="a">one<li data-live="b">two</ul>'));
  expect(r.errors).toEqual([]);
});

test("a hallucinated LiveHtml member is an error, real ones are not", async () => {
  const bad = await lintHtml(page("<script>LiveHtml.watch('k', function(){})</script>"));
  expect(bad.errors.length).toBe(1);
  expect(bad.errors[0]).toContain("LiveHtml.watch");

  const good = await lintHtml(
    page(
      "<script>LiveHtml.onChange(function(s){});LiveHtml.set('k',1);LiveHtml.del('k');" +
        "LiveHtml.watchRoom('r',function(){});var u=LiveHtml.users;var m=LiveHtml.me;</script>",
    ),
  );
  expect(good.errors).toEqual([]);
});

test("LiveHtml.state called as a function is an error", async () => {
  const r = await lintHtml(page("<script>var s = LiveHtml.state();</script>"));
  expect(r.errors.some((e) => e.includes("是属性不是函数"))).toBe(true);
});

test("inline on* handlers are scanned too", async () => {
  const r = await lintHtml(page(`<button onclick="LiveHtml.emit('x')">go</button>`));
  expect(r.errors.some((e) => e.includes("LiveHtml.emit"))).toBe(true);
});

test("mentions inside comments do not block a publish", async () => {
  const r = await lintHtml(
    page(
      "<script>\n// 以前用的是 LiveHtml.watch，已废弃\n/* LiveHtml.subscribeAll(...) */\nLiveHtml.set('k',1);\n</script>",
    ),
  );
  expect(r.errors).toEqual([]);
});

test("prose in the visible body is never scanned as JS", async () => {
  const r = await lintHtml(page("<p>用法：LiveHtml.somethingMadeUp(x) 之类的说明文字</p>"));
  expect(r.errors).toEqual([]);
});

test("a page-supplied sync.js tag warns but does not block", async () => {
  const r = await lintHtml(page('<script src="/sync.js"></script>'));
  expect(r.errors).toEqual([]);
  expect(r.warnings.length).toBe(1);
  expect(r.warnings[0]).toContain("sync.js");
});

test("an external script's src is not scanned as page JS", async () => {
  const r = await lintHtml(page('<script src="https://cdn.example/x.js"></script>'));
  expect(r.errors).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("several problems are all reported at once", async () => {
  const r = await lintHtml(
    page('<div data-live="c"><input></div><script>LiveHtml.watch("k",function(){})</script>'),
  );
  expect(r.errors.length).toBe(2);
});
