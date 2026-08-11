// tests/unit/inject.test.ts
import { test, expect } from "bun:test";
import { injectSync, SYNC_SCRIPT_RE } from "../../inject.ts";

const TAG = /<script src="\/sync\.js" data-room="([^"]*)" data-token="([^"]*)"><\/script>/;

function injected(html: string) {
  const out = injectSync(html, "pages/demo", "tok-1");
  const m = TAG.exec(out);
  return { out, room: m?.[1], token: m?.[2], count: (out.match(/sync\.js/g) || []).length };
}

test("injects exactly one tag, right after <head>", () => {
  const { out, room, token } = injected("<html><head><title>t</title></head><body>x</body></html>");
  expect(room).toBe("pages/demo");
  expect(token).toBe("tok-1");
  expect(out.indexOf("<script")).toBeLessThan(out.indexOf("<title>"));
});

test("falls back to <body>, then to prepending", () => {
  expect(injectSync("<body>x</body>", "r", "t").indexOf("<script")).toBe("<body>".length);
  expect(injectSync("<div>bare</div>", "r", "t").startsWith("<script")).toBe(true);
});

test("a page-authored sync.js tag is stripped in every attribute form", () => {
  const forms = [
    '<script src="/sync.js"></script>',
    "<script src='/sync.js'></script>",
    "<script src=/sync.js></script>",
    '<script src="../sync.js"></script>',
    '<script src="http://host:8787/sync.js"></script>',
    '<script src="/sync.js?v=2"></script>',
    '<script src="/sync.js#x"></script>',
    '<script defer src="/sync.js" data-room="mine"></script>',
    '<script  SRC = "/sync.js" ></script >',
  ];
  for (const form of forms) {
    const { count, room } = injected(`<html><head></head><body>${form}</body></html>`);
    // Exactly one mention left = the server's own tag. Two would make
    // document.currentScript bind to the wrong one and silently join the room
    // derived from location.pathname with an empty token.
    expect({ form, count }).toEqual({ form, count: 1 });
    expect({ form, room }).toEqual({ form, room: "pages/demo" });
  }
});

test("scripts that merely end in sync.js are left alone", () => {
  for (const src of ["/mysync.js", "/async.js", "/sync.json"]) {
    const html = `<html><head></head><body><script src="${src}"></script></body></html>`;
    expect(injectSync(html, "r", "t")).toContain(`src="${src}"`);
  }
});

test("the strip only removes the script tag, not the page around it", () => {
  const { out } = injected(
    '<html><head></head><body><p>before</p><script src="/sync.js"></script><p>after</p></body></html>',
  );
  expect(out).toContain("<p>before</p>");
  expect(out).toContain("<p>after</p>");
});

test("re-serving already-injected output stays idempotent", () => {
  const once = injectSync("<html><head></head><body>x</body></html>", "pages/demo", "tok-1");
  const twice = injectSync(once, "pages/demo", "tok-2");
  expect((twice.match(/sync\.js/g) || []).length).toBe(1);
  expect(TAG.exec(twice)?.[2]).toBe("tok-2"); // the fresh token wins
});

test("room and token are attribute-escaped", () => {
  const out = injectSync("<head></head>", 'a"b', '"><script>alert(1)</script>');
  expect(out).not.toContain('<script>alert(1)</script>');
  expect(out).toContain("&quot;");
});

test("the regex is reused across calls without lastIndex leaking", () => {
  // A /g regex carries lastIndex; String.replace resets it, but a future
  // refactor to .test()/.exec() would not — pin the behavior callers rely on.
  const html = '<html><head></head><body><script src="/sync.js"></script></body></html>';
  for (let i = 0; i < 3; i++) {
    expect((injectSync(html, "r", "t").match(/sync\.js/g) || []).length).toBe(1);
  }
  expect(SYNC_SCRIPT_RE.lastIndex).toBe(0);
});
