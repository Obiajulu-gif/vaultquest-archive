import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import SafeExternalLink from "@/components/ui/SafeExternalLink";
import {
  MAX_URL_LENGTH,
  SAFE_LINK_REL,
  escapeHtml,
  renderSafeMarkdown,
  sanitizeText,
  sanitizeUrl,
  toSafeExternalLink,
} from "@/lib/safe-content";

describe("escapeHtml", () => {
  it("escapes all HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&\``)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;",
    );
  });
  it("tolerates null/undefined/numbers", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("sanitizeText", () => {
  it("strips script/style blocks and tags but keeps text", () => {
    expect(sanitizeText("Hi <script>alert(1)</script>there <b>bold</b><style>x{}</style>!")).toBe("Hi there bold!");
  });
  it("defeats nested/reassembled tags", () => {
    expect(sanitizeText("<scr<script>ipt>alert(1)</scr</script>ipt>")).not.toMatch(/<\s*script/i);
    expect(sanitizeText("<<b>img src=x onerror=alert(1)>")).not.toMatch(/<img/i);
  });
  it("strips event-handler tags, comments and unterminated tags", () => {
    expect(sanitizeText('a<img src=x onerror=alert(1)>b')).toBe("ab");
    expect(sanitizeText("a<!-- hidden -->b")).toBe("ab");
  });
  it("keeps text around a bare or unterminated '<' instead of deleting it", () => {
    expect(sanitizeText("I think 1<x holds\nsecond paragraph")).toBe("I think 1<x holds second paragraph");
    expect(sanitizeText("Tom<Jerry fan")).toBe("Tom<Jerry fan");
    expect(sanitizeText("a<img src=x onerror=alert(1)")).toBe("a<img src=x onerror=alert(1)");
  });
  it("removes control, zero-width and bidi override characters", () => {
    expect(sanitizeText("pay‮txt.exe​\u0000ment")).toBe("paytxt.exement");
  });
  it("collapses whitespace by default and keeps newlines when multiline", () => {
    expect(sanitizeText("a \n\t b")).toBe("a b");
    expect(sanitizeText("a\n\nb", { multiline: true })).toBe("a\n\nb");
  });
  it("truncates and handles non-strings", () => {
    expect(sanitizeText("abcdef", { maxLength: 3 })).toBe("abc");
    expect(sanitizeText(undefined)).toBe("");
    expect(sanitizeText({ a: 1 })).toBe("");
  });
});

describe("sanitizeUrl", () => {
  it.each([
    "https://example.com/path?q=1#x",
    "http://example.com",
    "  https://example.com/  ",
  ])("accepts %s", (u) => {
    expect(sanitizeUrl(u)).toMatch(/^https?:\/\/example\.com/);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\nscript:alert(1)",
    "java\tscript:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://example.com/uuid",
    "ftp://example.com/x",
    "//evil.com/x",
    "/\\evil.com",
    "\\\\evil.com",
    "https://trusted.com@evil.com/",
    "https://user:pw@example.com/",
    "https://exa mple.com",
    "https://example.com/‮evil",
    "https://example.com/​",
    "https://",
    "not a url",
    "",
    "   ",
    "/relative/path",
  ])("rejects %j", (u) => {
    expect(sanitizeUrl(u)).toBeNull();
  });

  it("rejects non-strings and oversize URLs", () => {
    expect(sanitizeUrl(undefined)).toBeNull();
    expect(sanitizeUrl({ toString: () => "https://x.com" })).toBeNull();
    expect(sanitizeUrl(`https://example.com/${"a".repeat(MAX_URL_LENGTH)}`)).toBeNull();
  });

  it("enforces https-only and protocol allowlists", () => {
    expect(sanitizeUrl("http://example.com", { requireHttps: true })).toBeNull();
    expect(sanitizeUrl("https://example.com", { requireHttps: true })).not.toBeNull();
    expect(sanitizeUrl("mailto:a@b.co")).toBeNull();
    expect(sanitizeUrl("mailto:a@b.co", { protocols: ["mailto:"] })).toBe("mailto:a@b.co");
  });

  it("enforces host allowlists including subdomains but not look-alikes", () => {
    const opts = { allowedHosts: ["stellar.expert"] };
    expect(sanitizeUrl("https://stellar.expert/x", opts)).not.toBeNull();
    expect(sanitizeUrl("https://sub.stellar.expert/x", opts)).not.toBeNull();
    expect(sanitizeUrl("https://evilstellar.expert/x", opts)).toBeNull();
    expect(sanitizeUrl("https://stellar.expert.evil.com/x", opts)).toBeNull();
  });

  it("allows root-relative paths only when asked, never protocol-relative", () => {
    expect(sanitizeUrl("/app/vaults", { allowRelative: true })).toBe("/app/vaults");
    expect(sanitizeUrl("//evil.com", { allowRelative: true })).toBeNull();
  });
});

describe("toSafeExternalLink", () => {
  it("returns hardened link props including the visible host", () => {
    expect(toSafeExternalLink("https://docs.example.com/a")).toEqual({
      href: "https://docs.example.com/a",
      target: "_blank",
      rel: SAFE_LINK_REL,
      host: "docs.example.com",
    });
    expect(SAFE_LINK_REL).toContain("noopener");
    expect(SAFE_LINK_REL).toContain("noreferrer");
  });
  it("never returns relative or unsafe links", () => {
    expect(toSafeExternalLink("/x", { allowRelative: true })).toBeNull();
    expect(toSafeExternalLink("javascript:alert(1)")).toBeNull();
  });
});

describe("renderSafeMarkdown", () => {
  it("renders the allowlisted subset", () => {
    expect(renderSafeMarkdown("**b** *i* `c`")).toBe("<strong>b</strong> <em>i</em> <code>c</code>");
  });
  it("shows raw HTML as text", () => {
    const html = renderSafeMarkdown("<script>alert(1)</script><img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });
  it("renders safe links with hardened attributes", () => {
    const html = renderSafeMarkdown("[docs](https://example.com/a?b=1&c=2)");
    expect(html).toBe(
      `<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="${SAFE_LINK_REL}">docs</a>`,
    );
  });
  it.each([
    "[x](javascript:alert(1))",
    "[x](JAVASCRIPT:alert(1))",
    "[x](data:text/html;base64,PHNjcmlwdD4=)",
    "[x](vbscript:msgbox)",
    "[x](//evil.com)",
    "[x](https://a.com@evil.com)",
  ])("degrades unsafe link %s to plain text", (md) => {
    const html = renderSafeMarkdown(md);
    expect(html).toBe("x");
    expect(html).not.toContain("href");
  });
  it("degrades images to alt text", () => {
    expect(renderSafeMarkdown("![alt](https://example.com/x.png)")).toBe("alt");
  });
  it("cannot break out of the href attribute", () => {
    const html = renderSafeMarkdown('[x](https://example.com/"onmouseover="alert(1))');
    // the quote is percent-encoded inside href; no extra attribute is created
    expect(html).toMatch(/^<a href="[^"]*" target="_blank" rel="[^"]*">.*<\/a>$/);
    expect(html.match(/"/g)).toHaveLength(6) // exactly href/target/rel, no injected attribute;
  });
  it("does not apply emphasis inside code spans or hrefs", () => {
    expect(renderSafeMarkdown("`**x**`")).toBe("<code>**x**</code>");
    expect(renderSafeMarkdown("[a](https://example.com/**x**)")).not.toContain("<strong>");
  });
  it("keeps line breaks and handles non-strings", () => {
    expect(renderSafeMarkdown("a\nb")).toBe("a<br>b");
    expect(renderSafeMarkdown(undefined)).toBe("");
  });
});

describe("<SafeExternalLink />", () => {
  it("renders a hardened anchor for safe URLs", () => {
    render(<SafeExternalLink href="https://example.com/x">Go</SafeExternalLink>);
    const a = screen.getByRole("link");
    expect(a.getAttribute("href")).toBe("https://example.com/x");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe(SAFE_LINK_REL);
    expect(a.getAttribute("title")).toBe("example.com");
    expect(a.textContent).toContain("opens example.com in a new tab");
  });
  it("renders inert text for unsafe URLs", () => {
    const { container } = render(<SafeExternalLink href="javascript:alert(1)">Go</SafeExternalLink>);
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.textContent).toBe("Go");
    expect(container.querySelector("[data-unsafe-link]")).not.toBeNull();
  });
  it("supports a custom fallback (including none)", () => {
    const { container, rerender } = render(
      <SafeExternalLink href={undefined} fallback={<em>n/a</em>}>Go</SafeExternalLink>,
    );
    expect(container.textContent).toBe("n/a");
    rerender(<SafeExternalLink href="data:x" fallback={null}>Go</SafeExternalLink>);
    expect(container.textContent).toBe("");
  });
  it("lets callers override the title", () => {
    render(<SafeExternalLink href="https://example.com" title="Docs">Go</SafeExternalLink>);
    expect(screen.getByRole("link").getAttribute("title")).toBe("Docs");
  });
});
