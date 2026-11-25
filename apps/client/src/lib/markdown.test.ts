import { describe, expect, it } from "vitest";

import { markdownToPlainText, renderMarkdown, renderMarkdownCached } from "./markdown";

describe("renderMarkdown", () => {
  it("renders basic markdown to HTML", () => {
    const html = renderMarkdown("**bold** and *italic*");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  it("strips script tags", () => {
    const html = renderMarkdown("hello <script>alert(1)</script> world");
    expect(html).not.toContain("<script");
    expect(html.toLowerCase()).not.toContain("alert(1)</script");
  });

  it("escapes raw HTML so an injected element never becomes live", () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)">');
    // The tag is escaped to inert text, not rendered as an <img> with a live handler.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("drops javascript: links but keeps the link text", () => {
    const html = renderMarkdown("[click me](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click me");
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("strips a join-QR host-key fragment (#k=) from links so a posted link can't re-pin anyone (review 2026-09-25)", () => {
    const sameOrigin = renderMarkdown("[agenda](/#k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA)");
    expect(sameOrigin).toContain("agenda");
    expect(sameOrigin).not.toContain("#k=");
    expect(sameOrigin).toContain('href="/"');

    const absolute = renderMarkdown(`[join](${window.location.origin}/channels#k=BBBB)`);
    expect(absolute).not.toContain("#k=");
    expect(absolute).toContain(`href="${window.location.origin}/channels"`);

    // An ordinary fragment is left alone.
    expect(renderMarkdown("[section](https://example.com/page#notes)")).toContain('href="https://example.com/page#notes"');
  });

  describe("a start-up fragment never survives in a link, judged as the browser parses it", () => {
    const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    /** The href of the one link `markdown` renders to. */
    function renderedHref(markdown: string): string | null {
      const template = document.createElement("template");
      template.innerHTML = renderMarkdown(markdown);
      const links = template.content.querySelectorAll("a");
      expect(links).toHaveLength(1);
      return links[0].getAttribute("href");
    }

    it.each([
      ["a tab after the #", `#\tk=${KEY}`],
      ["a tab inside the name", `#k\t=${KEY}`],
      ["a CR after the #", `#\rk=${KEY}`],
      ["an LF after the #", `#\nk=${KEY}`],
      ["an LF inside the name", `#k\n=${KEY}`],
      ["a CRLF after the #", `#\r\nk=${KEY}`],
      ["a tab and a CR", `#\t\rk\t=${KEY}`],
      ["an upper-case name", `#K=${KEY}`],
      ["a percent-encoded name", `#%6B=${KEY}`],
      ["an upper-case percent-encoded name", `#%4B=${KEY}`],
      ["a later parameter", `#x=1&k=${KEY}`],
      ["a tab before the &", `#x=1\t&k=${KEY}`],
      ["an admin code", "#a=AAAAAAAAAAAAAAAAAAAAAA"],
      ["an invite code", "#i=abc"],
      ["a node-link code", "#l=AAAAAAAAAAAAAAAA"],
      ["a key with an invite", `#k=${KEY}&i=abc`],
    ])("drops a fragment with %s", (_label, fragment) => {
      expect(renderedHref(`[join](/channels${fragment})`)).toBe("/channels");
      expect(renderedHref(`[join](${window.location.origin}/channels${fragment})`)).toBe(`${window.location.origin}/channels`);
    });

    it("drops it when a tab comes before the #", () => {
      expect(renderedHref(`[join](/channels\t#k=${KEY})`)).toBe("/channels\t");
    });

    it("drops it from a mailto: link too", () => {
      expect(renderedHref(`[mail](mailto:a@example.com#\tk=${KEY})`)).toBe("mailto:a@example.com");
      expect(renderedHref("[mail](mailto:a@example.com#i=abc)")).toBe("mailto:a@example.com");
    });

    it.each([
      ["#section", "https://example.com/page#section"],
      ["#task=1", "https://example.com/page#task=1"],
      ["#ok=1", "https://example.com/page#ok=1"],
      ["#x=1&kk=2", "https://example.com/page#x=1&kk=2"],
      ["#a (no =)", "https://example.com/page#a"],
      ["no fragment", "https://example.com/page"],
      ["a relative #section", "/channels#section"],
    ])("leaves %s exactly as it was", (_label, href) => {
      expect(renderedHref(`[link](${href})`)).toBe(href);
    });
  });

  it("hardens safe http(s) links with rel and target", () => {
    const html = renderMarkdown("[loam](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("allows mailto links", () => {
    const html = renderMarkdown("[mail](mailto:a@example.com)");
    expect(html).toContain('href="mailto:a@example.com"');
  });

  it("removes the href from unsupported schemes like data: while keeping the anchor", () => {
    const html = renderMarkdown("[x](data:text/html;base64,PHNjcmlwdD4=)");
    expect(html).not.toContain("data:text/html");
    expect(html).toContain("<a");
    expect(html).not.toMatch(/href="data:/i);
  });

  it("escapes raw HTML entities so angle brackets are not interpreted", () => {
    const html = renderMarkdown("1 < 2 && 3 > 2");
    expect(html).not.toContain("<2");
    expect(html).toContain("&lt;");
    expect(html).toContain("&gt;");
  });

  it("drops the fence language from a code block, so a post can't borrow the app's own CSS classes", () => {
    const html = renderMarkdown("```dialog\nlooks official\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("looks official");
    expect(html).not.toMatch(/class=/i);
    expect(html).not.toContain("dialog");
  });

  it("keeps no id or style attribute either", () => {
    // snarkdown never emits these itself, but the sanitizer is the only line of defence should it ever do so.
    const html = renderMarkdown("```btn\nx\n```");
    expect(html).not.toMatch(/\sid=/i);
    expect(html).not.toMatch(/style=/i);
  });

  describe("image src XSS vectors", () => {
    // A dangerous `src` is one that can execute script when the browser loads
    // it as an image: a `javascript:`/`vbscript:` URL (in any case/whitespace
    // obfuscation) that would run on load in legacy engines, or a live
    // `data:` URI. None of these should ever survive in the rendered `src`.
    function assertNoDangerousSrc(html: string): void {
      expect(html).not.toMatch(/src\s*=\s*"javascript:/i);
      expect(html).not.toMatch(/src\s*=\s*"vbscript:/i);
      expect(html).not.toMatch(/src\s*=\s*"data:/i);
      expect(html.toLowerCase()).not.toContain("alert(1)");
    }

    it("drops javascript: image src while keeping the alt text", () => {
      const html = renderMarkdown("![x](javascript:alert(1))");
      assertNoDangerousSrc(html);
      expect(html).not.toContain("<img");
      expect(html).toContain("x");
    });

    it("drops obfuscated-case JaVaScRiPt: image src", () => {
      const html = renderMarkdown("![x](JaVaScRiPt:alert(1))");
      assertNoDangerousSrc(html);
    });

    it("drops javascript: image src obfuscated with a leading tab", () => {
      const html = renderMarkdown("![x](\tjavascript:alert(1))");
      assertNoDangerousSrc(html);
    });

    it("drops javascript: image src obfuscated with leading whitespace", () => {
      const html = renderMarkdown("![x]( javascript:alert(1))");
      assertNoDangerousSrc(html);
    });

    it("drops javascript: image src obfuscated with an embedded tab in the scheme", () => {
      const html = renderMarkdown("![x](java\tscript:alert(1))");
      assertNoDangerousSrc(html);
    });

    it("drops javascript: image src obfuscated with a leading control char (U+0001)", () => {
      // The WHATWG URL parser strips leading C0 control chars, so a leading  still
      // resolves to the javascript: scheme; isSafeImageSrc must reject it and drop the src.
      const leadingControl = String.fromCharCode(0x01);
      const html = renderMarkdown(`![x](${leadingControl}javascript:alert(1))`);
      assertNoDangerousSrc(html);
      expect(html).not.toContain("src=");
    });

    it("drops vbscript: image src", () => {
      const html = renderMarkdown("![x](vbscript:msgbox(1))");
      assertNoDangerousSrc(html);
    });

    it("drops data: image src (including an SVG payload carrying an onload handler)", () => {
      const html = renderMarkdown(
        "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+)",
      );
      assertNoDangerousSrc(html);
    });

    it("drops data:text/html image src", () => {
      const html = renderMarkdown(
        "![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
      );
      assertNoDangerousSrc(html);
    });

  });

  describe("image syntax renders no image", () => {
    /** The rendered markdown parsed into an inert template, for element and text checks. */
    function rendered(markdown: string): DocumentFragment {
      const template = document.createElement("template");
      template.innerHTML = renderMarkdown(markdown);
      return template.content;
    }

    it("shows an https image as its alt text, with no img element and no URL", () => {
      const content = rendered("![alt text](https://example.com/pic.png)");
      expect(content.querySelector("img")).toBeNull();
      expect(content.textContent).toBe("alt text");
    });

    it("never makes a reader's browser fetch a node URL", () => {
      // A post of hundreds of these would spend every reader's request budget on the node.
      const content = rendered("look ![](/api/search?q=1) ![](/api/search?q=2) here");
      expect(content.querySelector("img")).toBeNull();
      expect(content.textContent).toBe("look   here");
      expect(renderMarkdown("![](/api/search?q=1)")).not.toContain("/api/search");
    });

    it("keeps the alt text as plain text, escaped", () => {
      const content = rendered('![a <b> & "c"](/x.png)');
      expect(content.querySelector("img, b")).toBeNull();
      expect(content.textContent).toBe('a <b> & "c"');
    });

    it("shows nothing for an image with no alt text", () => {
      expect(renderMarkdown("![](/api/attachments/abc123.webp)")).toBe("");
    });
  });

  describe("the sanitiser keeps only what the renderer emits", () => {
    it("strips the attributes a $-pattern in a link target smuggles onto the link", () => {
      const content = document.createElement("template");
      content.innerHTML = renderMarkdown(
        "![q](x tabindex=0 title=hello download=evil.html name=x data-x=1 aria-label=hi onfocus=alert(1)) [a]($`)",
      );
      const links = content.content.querySelectorAll("a");
      expect(links).toHaveLength(1);
      // The garbled href is a harmless relative path, so the protocol check keeps it.
      expect(links[0].getAttributeNames().sort()).toEqual(["href", "rel", "target"]);
      expect(content.content.querySelector("img")).toBeNull();
    });

    it("still renders headings, lists, code, emphasis and links", () => {
      // No quote: the body is HTML-escaped before snarkdown reads it, so a leading ">" is "&gt;" and
      // never starts a quote (that was so before the allowlist too).
      const html = renderMarkdown(
        "# Title\n\n## Sub\n\n- one\n- two\n\n1. first\n\n`inline`\n\n```\nblock\n```\n\n**b** *i* ~~s~~\n\n---\n\n[link](https://example.com)",
      );
      for (const tag of ["<h1>", "<h2>", "<ul>", "<ol>", "<li>", "<code>", "<pre>", "<strong>", "<em>", "<s>", "<hr>", "<br>"]) {
        expect(html).toContain(tag);
      }
      expect(html).toContain('<a href="https://example.com" rel="noreferrer" target="_blank">link</a>');
    });
  });
});

describe("renderMarkdownCached", () => {
  it("returns HTML identical to renderMarkdown", () => {
    const body = "**bold** and [loam](https://example.com)";
    expect(renderMarkdownCached("msg.1", body)).toBe(renderMarkdown(body));
  });

  it("serves a repeat call from cache with the same result", () => {
    const body = "cached *value*";
    const first = renderMarkdownCached("msg.repeat", body);
    const second = renderMarkdownCached("msg.repeat", body);
    expect(second).toBe(first);
    expect(second).toBe(renderMarkdown(body));
  });

  it("invalidates when the body changes (e.g. a streaming delta)", () => {
    const id = "msg.stream";
    expect(renderMarkdownCached(id, "partial")).toBe(renderMarkdown("partial"));
    expect(renderMarkdownCached(id, "partial full")).toBe(renderMarkdown("partial full"));
  });

  it("invalidates when editedAt changes for the same id and body", () => {
    const id = "msg.edit";
    const body = "unchanged text";
    // Distinct editedAt values are distinct cache keys, so the wrapper re-renders rather than
    // returning a stale entry — always matching a direct renderMarkdown(body) call.
    expect(renderMarkdownCached(id, body, 1000)).toBe(renderMarkdown(body));
    expect(renderMarkdownCached(id, body, 2000)).toBe(renderMarkdown(body));
  });

  it("can't serve one message's rendering for another whose id holds a newline", () => {
    // An id may hold any character (a sync peer can supply one), so the parts of the key must not run together.
    expect(renderMarkdownCached("a\n5\nfoo", "bar")).toBe(renderMarkdown("bar"));
    expect(renderMarkdownCached("a", "foo\n\nbar", 5)).toBe(renderMarkdown("foo\n\nbar"));
  });
});

describe("markdownToPlainText", () => {
  it("keeps the text a message reads as, one line, without Markdown syntax", () => {
    expect(markdownToPlainText("Lost property:\n\n- blue rucksack\n- keys on a **red lanyard**\n\nAt the desk.")).toBe(
      "Lost property: • blue rucksack • keys on a red lanyard At the desk.",
    );
    expect(markdownToPlainText("**Welcome** to _the_ site")).toBe("Welcome to the site");
  });

  it("never lets markup through", () => {
    expect(markdownToPlainText("<img src=x onerror=alert(1)> hi")).toBe("<img src=x onerror=alert(1)> hi");
  });
});
