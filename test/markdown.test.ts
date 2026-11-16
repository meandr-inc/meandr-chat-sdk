// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseMarkdown, renderMarkdown } from "../src/markdown";
import type { MarkdownElement, MarkdownNode } from "../src/markdown";

const NBSP = String.fromCharCode(160);
const CTRL = String.fromCharCode(1);
const cp = (n: number) => String.fromCodePoint(n);
const wide = (s: string) => s.split("").map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");
const VOID = new Set(["br", "hr"]);
const ALLOWED: Record<string, string[]> = {
  p: [], br: [], strong: [], em: [], del: [], code: ["class"], pre: [], blockquote: [], ul: [], ol: ["start"], li: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], hr: [], a: ["href", "target", "rel"],
  table: [], thead: [], tbody: [], tr: [], th: ["style"], td: ["style"],
};

// A document whose nodes do nothing: times the renderer itself, not the DOM library.
function stubDocument(): Document {
  const node = () => ({ style: {}, appendChild: (c: unknown) => c, setAttribute: () => undefined });
  return { createDocumentFragment: node, createElement: node, createTextNode: node } as unknown as Document;
}

function hrefOk(value: string): boolean {
  const u = new URL(value);
  if (u.username || u.password) return false;
  return u.protocol === "mailto:" || ((u.protocol === "https:" || u.protocol === "http:") && /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/.test(u.hostname));
}

function attrOk(el: Element, name: string, value: string): boolean {
  switch (name) {
    case "href": return hrefOk(value);
    case "target": return value === "_blank";
    case "rel": return value === "noopener noreferrer";
    case "start": return /^\d+$/.test(value);
    case "class": return /^language-[A-Za-z0-9_+-]+$/.test(value) && el.parentElement?.tagName.toLowerCase() === "pre";
    case "style": return /^text-align: (left|center|right);?$/.test(value.trim());
  }
  return false;
}

// Throws on any tag, attribute or value outside the allowlist, and on a link inside a link.
function assertSafe(root: Node, inA = false): void {
  for (const n of Array.from(root.childNodes)) {
    if (n.nodeType === 3) continue;
    if (n.nodeType !== 1) throw new Error(`unexpected node type ${n.nodeType}`);
    const el = n as Element, tag = el.tagName.toLowerCase(), allowed = ALLOWED[tag];
    if (!allowed) throw new Error(`tag not allowed: ${tag}`);
    for (const a of Array.from(el.attributes)) {
      if (allowed.indexOf(a.name) < 0 || !attrOk(el, a.name, a.value)) throw new Error(`attribute not allowed: ${tag}[${a.name}="${a.value}"]`);
    }
    if (tag === "a") {
      if (inA) throw new Error("link inside a link");
      if (!el.hasAttribute("href") || !el.hasAttribute("target") || !el.hasAttribute("rel")) throw new Error("link without href, target or rel");
    }
    assertSafe(el, inA || tag === "a");
  }
}

const KEYS = ["tag", "children", "href", "dest", "start", "language", "align"];

// The same allowlist over parseMarkdown's tree, which a framework renders as it stands; a link's dest
// is always preceded by its note.
function assertTreeSafe(nodes: MarkdownNode[], inA = false): void {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (typeof n === "string") continue;
    const fail = (why: string): never => { throw new Error(`${why}: ${JSON.stringify(n).slice(0, 200)}`); };
    if (!ALLOWED[n.tag]) fail("tag not allowed");
    for (const key of Object.keys(n)) if (KEYS.indexOf(key) < 0) fail(`key not allowed: ${key}`);
    if ((n.tag === "a") !== (n.href !== undefined) || (n.href !== undefined && !hrefOk(n.href))) fail("bad href");
    if (n.tag === "a" && inA) fail("link inside a link");
    if (n.dest !== undefined && (n.tag !== "a" || !n.dest || nodes[i - 1] !== "[" + n.dest + "] ")) fail("dest without its note");
    if (n.start !== undefined && (n.tag !== "ol" || !Number.isInteger(n.start) || n.start < 0 || n.start === 1)) fail("bad start");
    if (n.language !== undefined && (n.tag !== "pre" || !/^[A-Za-z0-9_+-]+$/.test(n.language))) fail("bad language");
    if (n.align !== undefined && ((n.tag !== "th" && n.tag !== "td") || ["left", "center", "right"].indexOf(n.align) < 0)) fail("bad align");
    if ((n.tag === "br" || n.tag === "hr") !== (n.children === undefined)) fail("bad children");
    if (n.tag === "pre" && (n.children!.length !== 1 || typeof n.children![0] !== "string")) fail("pre without one string");
    if (n.children) assertTreeSafe(n.children, inA || n.tag === "a");
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The HTML renderMarkdown should make from a tree, in ser's canonical form.
function treeSer(nodes: MarkdownNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (typeof n === "string") { out += esc(n); continue; }
    const kids = treeSer(n.children || []);
    if (n.tag === "pre") { out += `<pre><code${n.language ? ` class="language-${n.language}"` : ""}>${kids}</code></pre>`; continue; }
    const attrs = (n.href !== undefined ? ` href="${n.href}"` : "") + (n.start !== undefined ? ` start="${n.start}"` : "")
      + (n.align !== undefined ? ` style="text-align: ${n.align};"` : "");
    out += VOID.has(n.tag) ? `<${n.tag}${attrs}>` : `<${n.tag}${attrs}>${kids}</${n.tag}>`;
  }
  return out;
}

// Canonical HTML for assertions; a link's fixed target and rel are left out (assertSafe checks them).
function ser(root: Node): string {
  let out = "";
  for (const n of Array.from(root.childNodes)) {
    if (n.nodeType === 3) {
      out += esc(n.textContent || "");
      continue;
    }
    const el = n as Element, tag = el.tagName.toLowerCase();
    const attrs = Array.from(el.attributes)
      .filter((a) => !(tag === "a" && (a.name === "target" || a.name === "rel")))
      .map((a) => ` ${a.name}="${a.value}"`)
      .sort()
      .join("");
    out += VOID.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${ser(el)}</${tag}>`;
  }
  return out;
}

function render(text: string): DocumentFragment {
  const frag = renderMarkdown(text);
  assertSafe(frag);
  assertTreeSafe(parseMarkdown(text));
  return frag;
}

function md(text: string): string {
  return ser(render(text));
}

function depthOf(root: Node, tags: string[]): number {
  let max = 0;
  for (const n of Array.from(root.childNodes)) {
    if (n.nodeType !== 1) continue;
    const own = tags.indexOf((n as Element).tagName.toLowerCase()) >= 0 ? 1 : 0;
    max = Math.max(max, own + depthOf(n, tags));
  }
  return max;
}

describe("renderMarkdown blocks", () => {
  it("returns an empty fragment for empty input", () => {
    expect(md("")).toBe("");
    expect(renderMarkdown("").childNodes.length).toBe(0);
  });

  it("builds in the document given, using only its node factories", () => {
    const used: string[] = [];
    const doc = {
      createDocumentFragment: () => { used.push("#fragment"); return document.createDocumentFragment(); },
      createElement: (tag: string) => { used.push(tag); return document.createElement(tag); },
      createTextNode: (text: string) => { used.push("#text"); return document.createTextNode(text); },
    } as unknown as Document;
    expect(ser(renderMarkdown("**a**", doc))).toBe("<p><strong>a</strong></p>");
    expect(used).toEqual(["#fragment", "p", "strong", "#text"]);
  });

  it("renders ATX headings", () => {
    expect(md("# One\n## Two\n###### Six")).toBe("<h1>One</h1><h2>Two</h2><h6>Six</h6>");
    expect(md("# Title ##")).toBe("<h1>Title</h1>");
    expect(md("# **bold** title")).toBe("<h1><strong>bold</strong> title</h1>");
    expect(md("#hashtag")).toBe("<p>#hashtag</p>");
    expect(md("####### seven")).toBe("<p>####### seven</p>");
  });

  it("renders paragraphs, a single newline as <br>, and hard breaks", () => {
    expect(md("one\ntwo\n\nthree")).toBe("<p>one<br>two</p><p>three</p>");
    expect(md("hard  \nbreak")).toBe("<p>hard<br>break</p>");
    expect(md("back\\\nslash")).toBe("<p>back<br>slash</p>");
    expect(md("end\\")).toBe("<p>end\\</p>");
  });

  it("renders fenced code with a language class only for a plain info string", () => {
    expect(md("```js\nconst a = 1 < 2;\n**not bold**\n```")).toBe('<pre><code class="language-js">const a = 1 &lt; 2;\n**not bold**</code></pre>');
    expect(md("~~~\nplain\n~~~")).toBe("<pre><code>plain</code></pre>");
    expect(md("```c++\nx\n```")).toBe('<pre><code class="language-c++">x</code></pre>');
    expect(md('```"><script>\nx\n```')).toBe("<pre><code>x</code></pre>");
    expect(md("````\n```\ninside\n````")).toBe("<pre><code>```\ninside</code></pre>");
    expect(md("  ```\n  code\n    more\n  ```")).toBe("<pre><code>code\n  more</code></pre>");
    expect(md("```inline``` text")).toBe("<p><code>inline</code> text</p>");
  });

  it("renders an unclosed fence as code to the end", () => {
    expect(md("intro\n```py\nprint(1)\n\n# not a heading")).toBe('<p>intro</p><pre><code class="language-py">print(1)\n\n# not a heading</code></pre>');
  });

  it("renders blockquotes with blocks inside, nesting and laziness", () => {
    expect(md("> # Title\n> - a\n> - b\n>\n> para")).toBe("<blockquote><h1>Title</h1><ul><li>a</li><li>b</li></ul><p>para</p></blockquote>");
    expect(md("> outer\n>> inner")).toBe("<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>");
    expect(md("> quoted\nlazy")).toBe("<blockquote><p>quoted<br>lazy</p></blockquote>");
    expect(md("> q\n\np")).toBe("<blockquote><p>q</p></blockquote><p>p</p>");
  });

  it("renders unordered and ordered lists, with start", () => {
    expect(md("- a\n- b\n* c\n+ d")).toBe("<ul><li>a</li><li>b</li></ul><ul><li>c</li></ul><ul><li>d</li></ul>");
    expect(md("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
    expect(md("3) three\n4) four")).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
    expect(md("*emph* text")).toBe("<p><em>emph</em> text</p>");
  });

  it("nests lists by indentation", () => {
    expect(md("- a\n  - b\n    - c\n- d")).toBe("<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>");
    expect(md("1. one\n   - sub\n2. two")).toBe("<ol><li>one<ul><li>sub</li></ul></li><li>two</li></ol>");
    expect(md("- item\ncontinued")).toBe("<ul><li>item<br>continued</li></ul>");
  });

  it("keeps tight lists without <p> and gives loose ones paragraphs", () => {
    expect(md("- a\n\n- b")).toBe("<ul><li><p>a</p></li><li><p>b</p></li></ul>");
    expect(md("- a\n\n  more\n- b")).toBe("<ul><li><p>a</p><p>more</p></li><li><p>b</p></li></ul>");
    expect(md("- a\n  - b\n\n  - c\n- d")).toBe("<ul><li>a<ul><li><p>b</p></li><li><p>c</p></li></ul></li><li>d</li></ul>");
  });

  it("lets only a list starting at 1 interrupt a paragraph", () => {
    expect(md("text\n2. not a list")).toBe("<p>text<br>2. not a list</p>");
    expect(md("text\n1. list")).toBe("<p>text</p><ol><li>list</li></ol>");
  });

  it("renders GFM tables with alignment, inline cells and escaped pipes", () => {
    const frag = render("| Left | Center | Right | None |\n|:-----|:------:|------:|------|\n| a | **b** | `c\\|d` | e \\| f |");
    const th = Array.from(frag.querySelectorAll("th")) as HTMLElement[];
    const td = Array.from(frag.querySelectorAll("td")) as HTMLElement[];
    expect(th.map((c) => c.style.textAlign)).toEqual(["left", "center", "right", ""]);
    expect(td.map((c) => c.style.textAlign)).toEqual(["left", "center", "right", ""]);
    expect(th.map((c) => c.textContent)).toEqual(["Left", "Center", "Right", "None"]);
    expect(td.map((c) => c.innerHTML)).toEqual(["a", "<strong>b</strong>", "<code>c|d</code>", "e | f"]);
    expect(frag.querySelectorAll("table > thead > tr").length).toBe(1);
    expect(frag.querySelectorAll("table > tbody > tr").length).toBe(1);
  });

  it("pads short rows, keeps extra cells, aligns every cell, and ends a table at a blank line", () => {
    expect(md("a | b\n:-|-:\n1\n1 | 2 | 3\n\nafter")).toBe(
      '<table><thead><tr><th style="text-align: left;">a</th><th style="text-align: right;">b</th></tr></thead><tbody>'
        + '<tr><td style="text-align: left;">1</td><td style="text-align: right;"></td></tr>'
        + '<tr><td style="text-align: left;">1</td><td style="text-align: right;">2</td><td>3</td></tr></tbody></table><p>after</p>',
    );
    expect(md("intro\n| a |\n| - |")).toBe("<p>intro</p><table><thead><tr><th>a</th></tr></thead></table>");
    expect(md("| a | b |\n|---|\n| c |")).toBe("<p>| a | b |<br>|---|<br>| c |</p>");
  });

  it("caps a table at 64 columns, joining the rest of a row into its last cell", () => {
    const row = (p: string) => "|" + Array.from({ length: 70 }, (_, k) => p + k).join("|") + "|";
    const frag = render(row("h") + "\n|" + "-|".repeat(70) + "\n" + row("c"));
    const th = Array.from(frag.querySelectorAll("th")), td = Array.from(frag.querySelectorAll("td"));
    expect([th.length, td.length]).toEqual([64, 64]);
    expect(th[63].textContent).toBe("h63|h64|h65|h66|h67|h68|h69");
    expect(td[63].textContent).toBe("c63|c64|c65|c66|c67|c68|c69");
  });

  it("stops padding once it would pass twice the cells written", () => {
    const tree = parseMarkdown("|" + "h|".repeat(64) + "\n|" + "-|".repeat(64) + "\n1\n2\n3") as MarkdownElement[];
    const body = (tree[0].children as MarkdownElement[])[1];
    expect(body.children!.map((tr) => ((tr as MarkdownElement).children || []).length)).toEqual([64, 64, 1]);
  });

  it("renders thematic breaks", () => {
    expect(md("---\n***\n___\n- - -")).toBe("<hr><hr><hr><hr>");
    expect(md("a\n---")).toBe("<p>a</p><hr>");
  });

  it("renders skipped constructs literally", () => {
    expect(md("    indented")).toBe("<p>indented</p>");
    expect(md("Title\n=====")).toBe("<p>Title<br>=====</p>");
    expect(md("<div>\n<b>x</b>\n</div>")).toBe("<p>&lt;div&gt;<br>&lt;b&gt;x&lt;/b&gt;<br>&lt;/div&gt;</p>");
    expect(md("Note[^1]\n\n[^1]: The note.")).toBe("<p>Note[^1]</p><p>[^1]: The note.</p>");
    expect(md("[ref][1]\n\n[1]: https://a.com")).toBe('<p>[ref][1]</p><p>[1]: <a href="https://a.com/">https://a.com/</a></p>');
  });

  it("caps nesting at 8 levels and renders deeper markers as text", () => {
    const quotes = render("> ".repeat(12) + "deep");
    expect(depthOf(quotes, ["blockquote"])).toBe(8);
    expect(quotes.textContent).toBe("> > > > deep");
    const lines: string[] = [];
    for (let k = 0; k < 12; k++) lines.push("  ".repeat(k) + "- level" + k);
    const lists = render(lines.join("\n"));
    expect(depthOf(lists, ["ul"])).toBe(8);
    for (let k = 0; k < 12; k++) expect(lists.textContent).toContain("level" + k);
    expect(depthOf(render("> - ".repeat(20) + "x"), ["blockquote", "ul"])).toBe(8);
  });
});

describe("renderMarkdown inlines", () => {
  it("renders code spans", () => {
    expect(md("`code`")).toBe("<p><code>code</code></p>");
    expect(md("`` a ` b ``")).toBe("<p><code>a ` b</code></p>");
    expect(md("`<b>&amp;</b>` `*not em*`")).toBe("<p><code>&lt;b&gt;&amp;amp;&lt;/b&gt;</code> <code>*not em*</code></p>");
    expect(md("unclosed `code")).toBe("<p>unclosed `code</p>");
  });

  it("renders emphasis, strong and strikethrough", () => {
    expect(md("*em* _em_ **strong** __strong__ ~~del~~")).toBe(
      "<p><em>em</em> <em>em</em> <strong>strong</strong> <strong>strong</strong> <del>del</del></p>",
    );
    expect(md("***both***")).toBe("<p><em><strong>both</strong></em></p>");
    expect(md("**bold *nested em* bold**")).toBe("<p><strong>bold <em>nested em</em> bold</strong></p>");
    expect(md("snake_case_name and 2 * 3 * 4")).toBe("<p>snake_case_name and 2 * 3 * 4</p>");
    expect(md("~approx~ ~5")).toBe("<p>~approx~ ~5</p>");
  });

  it("leaves unclosed markers literal", () => {
    expect(md("**unclosed")).toBe("<p>**unclosed</p>");
    expect(md("[unclosed")).toBe("<p>[unclosed</p>");
    expect(md("[text](https://a.com")).toBe("<p>[text](https://a.com</p>");
  });

  it("renders each delimiter character or consumes it in exactly one em, strong or del", () => {
    const count = (s: string, chars: string) => s.split("").filter((c) => chars.indexOf(c) >= 0).length;
    const alphabet = ["*", "*", "**", "***", "_", "__", "~~", "~", "a", "b", " ", ".", ","];
    let seed = 7;
    for (let doc = 0; doc < 2000; doc++) {
      let text = "x ";
      for (let k = 0; k < 14; k++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        text += alphabet[seed % alphabet.length];
      }
      const frag = render(text);
      const em = frag.querySelectorAll("em").length, strong = frag.querySelectorAll("strong").length;
      const out = frag.textContent || "";
      expect(count(text, "*_"), text).toBe(count(out, "*_") + 2 * em + 4 * strong);
      expect(count(text, "~"), text).toBe(count(out, "~") + 4 * frag.querySelectorAll("del").length);
    }
  });

  it("caps inline nesting", () => {
    const frag = render("*".repeat(200) + "a" + "*".repeat(200));
    expect(depthOf(frag, ["strong", "em"])).toBeLessThanOrEqual(16);
    expect(frag.textContent).toBe("a");
  });

  it("renders links, dropping titles, with angle destinations and balanced parentheses", () => {
    expect(md('[Meandr](https://meandr.io "The site")')).toBe('<p>[meandr.io] <a href="https://meandr.io/">Meandr</a></p>');
    expect(md("[x](<https://a.com/a b>)")).toBe('<p>[a.com] <a href="https://a.com/a%20b">x</a></p>');
    expect(md("[wiki](https://en.wikipedia.org/wiki/Foo_(bar))")).toBe('<p>[en.wikipedia.org] <a href="https://en.wikipedia.org/wiki/Foo_(bar)">wiki</a></p>');
    expect(md("[*em* link](https://a.com)")).toBe('<p>[a.com] <a href="https://a.com/"><em>em</em> link</a></p>');
    expect(md("[mail](mailto:a@b.co)")).toBe('<p>[a@b.co] <a href="mailto:a@b.co">mail</a></p>');
    expect(md("[](https://a.com)")).toBe('<p><a href="https://a.com/">https://a.com/</a></p>');
  });

  it("renders a relative or unsafe link as its text alone", () => {
    expect(md("[docs](/docs)")).toBe("<p>docs</p>");
    expect(md("[**bold**](relative.html)")).toBe("<p><strong>bold</strong></p>");
  });

  it("never nests links", () => {
    expect(md("[a [b](https://b.com) c](https://c.com)")).toBe('<p>[a [b.com] <a href="https://b.com/">b</a> c](https://c.com)</p>');
    expect(md("[see https://a.com/x docs](https://a.com/y)")).toBe('<p>[a.com] <a href="https://a.com/y">see https://a.com/x docs</a></p>');
  });

  it("renders autolinks and bare URLs, excluding trailing punctuation", () => {
    expect(md("<https://a.com/x?y=1>")).toBe('<p><a href="https://a.com/x?y=1">https://a.com/x?y=1</a></p>');
    expect(md("<me@example.com>")).toBe('<p><a href="mailto:me@example.com">mailto:me@example.com</a></p>');
    expect(md("Visit https://a.com/path.")).toBe('<p>Visit <a href="https://a.com/path">https://a.com/path</a>.</p>');
    expect(md("(see https://a.com/x_(y))")).toBe('<p>(see <a href="https://a.com/x_(y)">https://a.com/x_(y)</a>)</p>');
    expect(md("https://a.com, and http://b.com!")).toBe('<p><a href="https://a.com/">https://a.com/</a>, and <a href="http://b.com/">http://b.com/</a>!</p>');
    expect(md("**https://a.com**")).toBe('<p><strong><a href="https://a.com/">https://a.com/</a></strong></p>');
    expect(md("xhttps://a.com")).toBe("<p>xhttps://a.com</p>");
  });

  it("renders backslash escapes", () => {
    expect(md("\\*not em\\* \\[not link\\](x) \\\\ \\a")).toBe("<p>*not em* [not link](x) \\ \\a</p>");
    expect(md("\\<script>")).toBe("<p>&lt;script&gt;</p>");
  });

  it("decodes entities into text, never markup", () => {
    expect(md("&amp; &lt; &gt; &quot; &#39; &nbsp; &#65; &#x42; &bogus; &#0;")).toBe(
      "<p>&amp; &lt; &gt; \" ' " + NBSP + " A B &amp;bogus; " + String.fromCharCode(0xfffd) + "</p>",
    );
    expect(md("&lt;b&gt;x&lt;/b&gt;")).toBe("<p>&lt;b&gt;x&lt;/b&gt;</p>");
    expect(md("&#42;not em&#42;")).toBe("<p>*not em*</p>");
  });

  it("decodes the named entities models write", () => {
    const names = "mdash ndash hellip copy reg trade laquo raquo lsquo rsquo ldquo rdquo times euro pound yen deg middot bull".split(" ");
    const codes = [0x2014, 0x2013, 0x2026, 0xa9, 0xae, 0x2122, 0xab, 0xbb, 0x2018, 0x2019, 0x201c, 0x201d, 0xd7, 0x20ac, 0xa3, 0xa5, 0xb0, 0xb7, 0x2022];
    expect(parseMarkdown(names.map((n) => "&" + n + ";").join(" "))).toStrictEqual([{ tag: "p", children: [codes.map(cp).join(" ")] }]);
    expect(md("&hellip;&lt;b&gt;&trade;")).toBe("<p>" + cp(0x2026) + "&lt;b&gt;" + cp(0x2122) + "</p>");
  });

  it("shows images as links to them, never loading them", () => {
    expect(md("![logo](https://a.com/logo.png)")).toBe('<p>[a.com] <a href="https://a.com/logo.png">logo</a></p>');
    expect(md("![](https://a.com/x.png)")).toBe('<p><a href="https://a.com/x.png">https://a.com/x.png</a></p>');
    expect(md('![a *b*](https://a.com/x.png "t")')).toBe('<p>[a.com] <a href="https://a.com/x.png">a b</a></p>');
    expect(md("[![badge](https://img.example/b.svg)](https://a.com)")).toBe('<p>[a.com] <a href="https://a.com/">badge</a></p>');
    expect(md("![![a](https://x.example/i)](https://y.example/j)")).toBe('<p><a href="https://y.example/j">https://y.example/j</a></p>');
    expect(render("![x](https://a.com/x.png)").querySelector("img")).toBeNull();
  });
});

describe("parseMarkdown", () => {
  it("returns plain objects, with text already decoded", () => {
    expect(parseMarkdown("")).toStrictEqual([]);
    expect(parseMarkdown("# Hi *there*\n\nA **b** `c` ~~d~~\nnext")).toStrictEqual([
      { tag: "h1", children: ["Hi ", { tag: "em", children: ["there"] }] },
      { tag: "p", children: ["A ", { tag: "strong", children: ["b"] }, " ", { tag: "code", children: ["c"] }, " ", { tag: "del", children: ["d"] }, { tag: "br" }, "next"] },
    ]);
    expect(parseMarkdown("&lt;b&gt; \\*x\\* ![alt](https://a.com/i.png)")).toStrictEqual([
      { tag: "p", children: ["<b> *x* ", "[a.com] ", { tag: "a", href: "https://a.com/i.png", dest: "a.com", children: ["alt"] }] },
    ]);
  });

  it("returns lists with start, tight items inline and loose ones in paragraphs", () => {
    expect(parseMarkdown("3. a\n4. b\n   - c\n\n- x\n\n- y")).toStrictEqual([
      { tag: "ol", start: 3, children: [
        { tag: "li", children: ["a"] },
        { tag: "li", children: ["b", { tag: "ul", children: [{ tag: "li", children: ["c"] }] }] },
      ] },
      { tag: "ul", children: [
        { tag: "li", children: [{ tag: "p", children: ["x"] }] },
        { tag: "li", children: [{ tag: "p", children: ["y"] }] },
      ] },
    ]);
  });

  it("returns quotes, code with its language, rules and tables", () => {
    expect(parseMarkdown("> quote\n\n```js\nlet a = 1;\n```\n\n---")).toStrictEqual([
      { tag: "blockquote", children: [{ tag: "p", children: ["quote"] }] },
      { tag: "pre", language: "js", children: ["let a = 1;"] },
      { tag: "hr" },
    ]);
    expect(parseMarkdown("```\n```")).toStrictEqual([{ tag: "pre", children: [""] }]);
    expect(parseMarkdown('| a | b | c |\n|:-|-:|---|\n| 1 | [x](https://a.com "t") |')).toStrictEqual([
      { tag: "table", children: [
        { tag: "thead", children: [{ tag: "tr", children: [
          { tag: "th", align: "left", children: ["a"] },
          { tag: "th", align: "right", children: ["b"] },
          { tag: "th", children: ["c"] },
        ] }] },
        { tag: "tbody", children: [{ tag: "tr", children: [
          { tag: "td", align: "left", children: ["1"] },
          { tag: "td", align: "right", children: ["[a.com] ", { tag: "a", href: "https://a.com/", dest: "a.com", children: ["x"] }] },
          { tag: "td", children: [] },
        ] }] },
      ] },
    ]);
  });

  it("parses with no DOM at all", () => {
    vi.stubGlobal("document", undefined);
    try {
      expect(typeof document).toBe("undefined");
      expect(parseMarkdown("**a** [b](https://b.com)\n\n| x |\n|---|\n| `y` |")).toStrictEqual([
        { tag: "p", children: [{ tag: "strong", children: ["a"] }, " ", "[b.com] ", { tag: "a", href: "https://b.com/", dest: "b.com", children: ["b"] }] },
        { tag: "table", children: [
          { tag: "thead", children: [{ tag: "tr", children: [{ tag: "th", children: ["x"] }] }] },
          { tag: "tbody", children: [{ tag: "tr", children: [{ tag: "td", children: [{ tag: "code", children: ["y"] }] }] }] },
        ] },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is exactly what renderMarkdown renders", () => {
    const sample = "# T\n\n> q *e*\n\n1. a\n2. b\n\n3) c\n\n- [l](https://a.com \"t\")\n- `c`\n\n| a | b |\n|:-:|--:|\n| 1 | 2 |\n\n```py\nx < y\n```\n\n---\n\n![i](https://a.com/i.png) https://b.com ~~d~~";
    expect(md(sample)).toBe(treeSer(parseMarkdown(sample)));
    expect(md(sample)).toContain('<ol start="3">');
  });
});

describe("link rules", () => {
  it("never links a URL carrying a username or password", () => {
    expect(md("[x](https://user:pass@bank.com)")).toBe("<p>x</p>");
    expect(md("[x](https://user@bank.com/)")).toBe("<p>x</p>");
    expect(md("[x](https://:pass@bank.com)")).toBe("<p>x</p>");
    expect(md("<https://user:pass@bank.com>")).toBe("<p>https://user:pass@bank.com</p>");
    expect(md("see https://user:pass@bank.com/x")).toBe("<p>see https://user:pass@bank.com/x</p>");
    expect(md("![a](https://u:p@a.com/i.png)")).toBe("<p>a</p>");
    expect(parseMarkdown("[x](https://user:pass@bank.com)")).toStrictEqual([{ tag: "p", children: ["x"] }]);
  });

  const E = "(https://evil.example)";
  const probe3: [string, string][] = [
    ["a Hangul filler", "[" + cp(0x3164) + "https://bank.com]" + E],
    ["a Hangul filler between words", "[Visit" + cp(0x3164) + "https://bank.com]" + E],
    ["a Hangul filler before a host", "[Login" + cp(0x3164) + "bank.com]" + E],
    ["U+115F", "[" + cp(0x115f) + "https://bank.com]" + E],
    ["U+1160", "[" + cp(0x1160) + "https://bank.com]" + E],
    ["U+FFA0", "[" + cp(0xffa0) + "https://bank.com]" + E],
    ["braille blanks", "[Visit" + cp(0x2800) + "https://bank.com" + cp(0x2800) + "now]" + E],
    ["a braille blank before a host", "[Visit" + cp(0x2800) + "bank.com]" + E],
    ["a combining grapheme joiner", "[Visit" + cp(0x34f) + "https://bank.com]" + E],
    ["a variation selector", "[Visit" + cp(0xfe0f) + "https://bank.com]" + E],
    ["U+17B4", "[Visit" + cp(0x17b4) + "https://bank.com]" + E],
    ["a Mongolian variation selector", "[Visit" + cp(0x180b) + "https://bank.com]" + E],
    ["a ratio colon", "[https" + cp(0x2236) + "//bank.com]" + E],
    ["a modifier colon", "[https" + cp(0xa789) + "//bank.com]" + E],
    ["an Armenian full stop", "[https" + cp(0x589) + "//bank.com]" + E],
    ["a missing colon", "[https//bank.com]" + E],
    ["a letter before the scheme", "[xhttps://bank.com]" + E],
    ["a real .md domain", "[maib.md]" + E],
    ["a real .rs domain", "[raiffeisenbank.rs]" + E],
    ["a real .sh domain", "[brew.sh]" + E],
    ["an IP address", "[192.168.1.1]" + E],
    ["an IP URL", "[https://192.168.1.1]" + E],
    ["a digit in the TLD", "[bank.c0m]" + E],
    ["split emphasis", "[ba**nk.co**m]" + E],
    ["split code", "[ba`nk.co`m]" + E],
    ["math bold letters", "[" + [0x1d41b, 0x1d41a, 0x1d427, 0x1d424].map(cp).join("") + ".com]" + E],
    ["a fullwidth scheme", "[" + wide("https") + "://bank.com]" + E],
    ["an at sign", "[@bank.com]" + E],
    ["a lock emoji", "[bank.com" + cp(0x1f512) + "]" + E],
    ["a line break", "[bank.\ncom]" + E],
    ["a trailing hyphen", "[bank.com-]" + E],
    ["a trailing underscore", "[bank.com_]" + E],
    ["www without a TLD", "[www.bank]" + E],
    ["a longer host", "[www.bank.com.au]" + E],
    ["reversed text", "[" + cp(0x202e) + "moc.knab" + cp(0x202c) + "]" + E],
    ["a zero-width space", "[" + cp(0x200b) + "https://bank.com]" + E],
    ["a long label", "[" + "word ".repeat(3000) + "bank.com]" + E],
    ["an image's text", "![" + cp(0x3164) + "https://bank.com](https://evil.example/i.png)"],
  ];

  it.each(probe3)("keeps a label with %s and names the destination before it", (_name, text) => {
    expect(md(text)).toMatch(/^<p>\[evil\.example\] <a href="https:\/\/evil\.example\/(i\.png)?">.*<\/a><\/p>$/s);
  });

  it.each(["FDFD", "12219", "2E3B"])("names the destination before a label of wide U+%s glyphs", (hex) => {
    const text = "[bank.com" + cp(parseInt(hex, 16)).repeat(111) + "](https://evil.example)";
    const tree = parseMarkdown(text)[0] as MarkdownElement;
    expect(tree.children![0]).toBe("[evil.example] ");
    expect((tree.children![1] as MarkdownElement).tag).toBe("a");
    expect(md(text).indexOf("<p>[evil.example] <a ")).toBe(0);
  });

  it("names the destination for labels that aren't exactly it, as a string of its own", () => {
    expect(md("[paypaI.com](https://paypai.com)")).toBe('<p>[paypai.com] <a href="https://paypai.com/">paypaI.com</a></p>');
    expect(md("[login.bank.com](https://bank.com)")).toBe('<p>[bank.com] <a href="https://bank.com/">login.bank.com</a></p>');
    expect(md("[ceo@bank.com](https://bank.com)")).toBe('<p>[bank.com] <a href="https://bank.com/">ceo@bank.com</a></p>');
    expect(md("[bank.com](https://www.bank.com)")).toBe('<p>[www.bank.com] <a href="https://www.bank.com/">bank.com</a></p>');
    expect(md("[https://bank.com](https://evil.example)")).toBe('<p>[evil.example] <a href="https://evil.example/">https://bank.com</a></p>');
    expect(parseMarkdown("[bank.com](https://evil.example) now")).toStrictEqual([
      { tag: "p", children: ["[evil.example] ", { tag: "a", href: "https://evil.example/", dest: "evil.example", children: ["bank.com"] }, " now"] },
    ]);
    expect(parseMarkdown("[bank.com](https://bank.com)")).toStrictEqual([{ tag: "p", children: [{ tag: "a", href: "https://bank.com/", children: ["bank.com"] }] }]);
  });

  it("reads a label's breaks as spaces, collapses its blanks, and cuts it at 120 characters", () => {
    const evil = (label: string) => md("[" + label + "](https://evil.example)");
    const after = (label: string) => `<p>[evil.example] <a href="https://evil.example/">${label}</a></p>`;
    expect(md("[bank.com" + "\\\n".repeat(40) + "](https://evil.example) is our partner")).toBe(
      '<p>[evil.example] <a href="https://evil.example/">bank.com</a> is our partner</p>',
    );
    expect(evil("bank.com\n" + (cp(0x2800) + "\n").repeat(40))).toBe(after("bank.com"));
    expect(evil("Visit" + [0x3000, 0x2003, 0xa0, 0x3164].map(cp).join("").repeat(50) + "bank.com")).toBe(after("Visit bank.com"));
    const prose = render("[" + "word ".repeat(400) + "bank.com](https://evil.example)").querySelector("a")!;
    expect(prose.textContent!.length).toBe(120);
    expect(prose.textContent!.slice(-5)).toBe("word" + cp(0x2026));
    expect(prose.previousSibling!.textContent).toBe("[evil.example] ");
    expect(evil("x".repeat(120))).toBe(after("x".repeat(120)));
    expect(evil("x".repeat(121))).toBe(after("x".repeat(119) + cp(0x2026)));
    expect(evil("  " + "x".repeat(120) + "  ")).toBe(after("x".repeat(120)));
    expect(md("[**bold**   *text*\nhere](https://a.com)")).toBe('<p>[a.com] <a href="https://a.com/"><strong>bold</strong> <em>text</em> here</a></p>');
    expect(md("[" + cp(0x3164) + "](https://evil.example)")).toBe('<p><a href="https://evil.example/">https://evil.example/</a></p>');
  });

  it("keeps joiners and variation selectors inside a label's words", () => {
    const heart = cp(0x2764) + cp(0xfe0f), family = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467].map(cp).join("");
    const persian = [0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645].map(cp).join("");
    for (const label of ["I " + heart + " you", family + " plan", persian, heart]) {
      expect(md("[" + label + "](https://a.com)")).toBe(`<p>[a.com] <a href="https://a.com/">${label}</a></p>`);
    }
    expect(md("[a" + cp(0x200d) + " b" + cp(0x200c) + "](https://a.com)")).toBe('<p>[a.com] <a href="https://a.com/">a b</a></p>');
  });

  it("links only hosts that read as themselves", () => {
    expect(md("[Log in](<https://bank.com)(x.evil.example>)")).toBe("<p>Log in</p>");
    expect(md("<https://bank.com&x.evil.example/> and <https://bank.com'x.evil.example/>")).toBe(
      "<p>https://bank.com&amp;x.evil.example/ and https://bank.com'x.evil.example/</p>",
    );
    expect(md("see https://bank.com,x.evil.example/login")).toBe("<p>see https://bank.com,x.evil.example/login</p>");
    expect(md("[ok](https://192.168.1.1:8080/x) [v6](http://[::1]/)")).toBe(
      '<p>[192.168.1.1] <a href="https://192.168.1.1:8080/x">ok</a> [[::1]] <a href="http://[::1]/">v6</a></p>',
    );
  });

  it("shows a bare URL's path decoded, without bidi controls", () => {
    expect(md("https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC")).toBe(
      `<p><a href="https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC">https://ja.wikipedia.org/wiki/${cp(0x65e5)}${cp(0x672c)}</a></p>`,
    );
    expect(md("https://a.example/x%E2%80%AEy?q=%E2%80%AE")).toBe(
      '<p><a href="https://a.example/x%E2%80%AEy?q=%E2%80%AE">https://a.example/x%E2%80%AEy?q=%E2%80%AE</a></p>',
    );
    const hidden = "https://evil.example/" + "%0A".repeat(30) + "%00%C2%85%E2%80%8B%E2%80%8F%E3%85%A4bank.com/login";
    expect(md(hidden)).toBe(`<p><a href="${hidden}">${hidden}</a></p>`);
    const long = render("https://a.example/" + "x".repeat(300)).querySelector("a")!;
    expect(long.textContent).toBe("https://a.example/" + "x".repeat(181) + cp(0x2026));
    expect(long.getAttribute("href")).toBe("https://a.example/" + "x".repeat(300));
    expect(md("<https://a.example/%E6%97>")).toBe('<p><a href="https://a.example/%E6%97">https://a.example/%E6%97</a></p>');
    expect(md("https://a.example:8443/%2F%3F")).toBe('<p><a href="https://a.example:8443/%2F%3F">https://a.example:8443/%2F%3F</a></p>');
  });

  it("keeps doc-link labels and names the site after them", () => {
    expect(md("[`fs.readFile`](https://nodejs.org/api/fs.html)")).toBe('<p>[nodejs.org] <a href="https://nodejs.org/api/fs.html"><code>fs.readFile</code></a></p>');
    expect(md("[Array.prototype.map()](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/map)")).toBe(
      '<p>[developer.mozilla.org] <a href="https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/map">Array.prototype.map()</a></p>',
    );
    expect(md("[ASP.NET Core](https://learn.microsoft.com/aspnet/core/)")).toBe('<p>[learn.microsoft.com] <a href="https://learn.microsoft.com/aspnet/core/">ASP.NET Core</a></p>');
    expect(md("[Socket.IO](https://socket.io/docs/v4/)")).toBe('<p>[socket.io] <a href="https://socket.io/docs/v4/">Socket.IO</a></p>');
    expect(md("[Node.js](https://nodejs.org) and [Your order](https://shop.example/o/1)")).toBe(
      '<p>[nodejs.org] <a href="https://nodejs.org/">Node.js</a> and [shop.example] <a href="https://shop.example/o/1">Your order</a></p>',
    );
  });

  it("adds nothing when the label already reads as the destination", () => {
    expect(md("[bank.com](https://bank.com/login)")).toBe('<p><a href="https://bank.com/login">bank.com</a></p>');
    expect(md("[bank.com/](https://bank.com)")).toBe('<p><a href="https://bank.com/">bank.com/</a></p>');
    expect(md("[https://bank.com/login/](https://bank.com/login)")).toBe('<p><a href="https://bank.com/login">https://bank.com/login/</a></p>');
    expect(md("[HTTPS://bank.com](https://bank.com)")).toBe('<p><a href="https://bank.com/">HTTPS://bank.com</a></p>');
    expect(md("[www.bank.com](https://bank.com/x)")).toBe('<p><a href="https://bank.com/x">www.bank.com</a></p>');
    expect(md("[https://evil.example/](https://evil.example/)")).toBe('<p><a href="https://evil.example/">https://evil.example/</a></p>');
    expect(md("[https://evil.example/" + cp(0x200f) + "](https://evil.example/)")).toBe('<p><a href="https://evil.example/">https://evil.example/</a></p>');
  });

  it("names a mailto link's address as its href encodes it, domain in punycode, unless the label is that address", () => {
    const puny = new URL("http://b" + cp(0x430) + "nk.com").hostname;
    expect(puny.indexOf("xn--")).toBe(0);
    expect(md("[Contact](mailto:support@b" + cp(0x430) + "nk.com)")).toBe(`<p>[support@${puny}] <a href="mailto:support@b%D0%B0nk.com">Contact</a></p>`);
    expect(md("<mailto:support@b" + cp(0x430) + "nk.com>")).toBe(`<p><a href="mailto:support@b%D0%B0nk.com">mailto:support@${puny}</a></p>`);
    expect(md("[Contact](mailto:support@bank.com%20%3Cattacker@evil.example%3E)")).toBe("<p>Contact</p>");
    expect(md("[Contact](mailto:?to=attacker@evil.example)")).toBe("<p>Contact</p>");
    expect(md("[Contact](mailto:support@bank.com?bcc=attacker@evil.example)")).toBe(
      '<p>[support@bank.com?bcc=attacker@evil.example] <a href="mailto:support@bank.com?bcc=attacker@evil.example">Contact</a></p>',
    );
    expect(md("[support@bank.com](mailto:support@bank.com%3Fbcc=attacker@evil.example)")).toBe("<p>support@bank.com</p>");
    expect(md("[Email support](mailto:support@bank.com,attacker@evil.example)")).toBe("<p>Email support</p>");
    expect(md('[Contact](mailto:"support@bank.com"@evil.example)')).toBe("<p>Contact</p>");
    expect(md("[Contact](mailto:%22support%40bank.com%22@evil.example)")).toBe("<p>Contact</p>");
    expect(md("[Contact](mailto:support(x)@bank.com) [Contact](mailto:sup%20port@bank.com)")).toBe("<p>Contact Contact</p>");
    expect(md("[support@bank.com](mailto:attacker@evil.example)")).toBe('<p>[attacker@evil.example] <a href="mailto:attacker@evil.example">support@bank.com</a></p>');
    expect(md("[Support@Bank.com](mailto:support@bank.com)")).toBe('<p>[support@bank.com] <a href="mailto:support@bank.com">Support@Bank.com</a></p>');
    expect(md("[support@bank.com](mailto:support@bank.com)")).toBe('<p><a href="mailto:support@bank.com">support@bank.com</a></p>');
  });

  it("shows bare URLs and autolinks as their parsed href, and IDN hosts in punycode", () => {
    const a = cp(0x430), punycode = "https://xn--pypal-4ve.com";
    expect(md("https://p" + a + "ypal.com/login")).toBe(`<p><a href="${punycode}/login">${punycode}/login</a></p>`);
    expect(md("<https://p" + a + "ypal.com/login>")).toBe(`<p><a href="${punycode}/login">${punycode}/login</a></p>`);
    expect(md("[p" + a + "ypal.com](https://p" + a + "ypal.com)")).toBe(`<p>[xn--pypal-4ve.com] <a href="${punycode}/">p${a}ypal.com</a></p>`);
    expect(md("![](https://p" + a + "ypal.com/i.png)")).toBe(`<p><a href="${punycode}/i.png">${punycode}/i.png</a></p>`);
    expect(md("[B" + cp(0xfc) + "cher](https://b" + cp(0xfc) + "cher.de)")).toBe(`<p>[xn--bcher-kva.de] <a href="https://xn--bcher-kva.de/">B${cp(0xfc)}cher</a></p>`);
    expect(md("Log in at https://paypaI.com/login or <https://paypaI.com/x>")).toBe(
      '<p>Log in at <a href="https://paypai.com/login">https://paypai.com/login</a> or <a href="https://paypai.com/x">https://paypai.com/x</a></p>',
    );
    expect(md("HTTPS://BANK.COM/x https://b%61nk.com/y https://bank.com%2esecure.evil.example")).toBe(
      '<p><a href="https://bank.com/x">https://bank.com/x</a> <a href="https://bank.com/y">https://bank.com/y</a> '
        + '<a href="https://bank.com.secure.evil.example/">https://bank.com.secure.evil.example/</a></p>',
    );
    const slashed = render("https://bank.com" + cp(0x2215) + "login" + cp(0x2215) + "x.evil.example").querySelector("a")!;
    expect(slashed.textContent).toBe(slashed.getAttribute("href"));
    expect(slashed.getAttribute("href")).toMatch(/^https:\/\/bank\.xn--[a-z0-9-]+\.evil\.example\/$/);
  });
});

describe("bidi controls", () => {
  const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map(cp);

  it("strips an override before a bare URL, so it can't be shown reversed", () => {
    expect(md("go " + cp(0x202e) + " https://evil.example/moc.knab")).toBe(
      '<p>go  <a href="https://evil.example/moc.knab">https://evil.example/moc.knab</a></p>',
    );
  });

  it("strips them from code, headings, cells and the text around links", () => {
    expect(md("```js\nif (ok" + cp(0x202e) + ") { run(); }\n```")).toBe('<pre><code class="language-js">if (ok) { run(); }</code></pre>');
    expect(md("`a" + cp(0x2066) + "b`")).toBe("<p><code>ab</code></p>");
    const all = bidi.join("");
    const text = "# h" + all + "1\n\n| c" + all + "1 |\n|---|\n| d" + all + "2 |\n\n> q" + all + " [x](https://a.com) " + all + "\n\n```\n" + all + "\n```";
    const json = JSON.stringify(parseMarkdown(text)), shown = render(text).textContent || "";
    for (const ch of bidi) {
      expect(json).not.toContain(ch);
      expect(shown).not.toContain(ch);
    }
    expect(shown).toContain("h1");
  });

  it("keeps LRM and RLM, and strips controls from link labels too", () => {
    const marks = "a" + cp(0x200e) + "b" + cp(0x200f) + "c";
    expect(parseMarkdown(marks)).toStrictEqual([{ tag: "p", children: [marks] }]);
    expect(md("[x" + cp(0x202e) + "](https://a.com)")).toBe('<p>[a.com] <a href="https://a.com/">x</a></p>');
  });
});

describe("renderMarkdown safety", () => {
  const unsafe = [
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x]( javascript:alert(1))",
    "[x](<" + CTRL + "javascript:alert(1)>)",
    "[x](<java\tscript:alert(1)>)",
    "[x](<  javascript:alert(1)>)",
    "[x](&#106;avascript:alert(1))",
    "[x](&#x6A;avascript:alert(1))",
    "[x](javascript&#58;alert(1))",
    "[x](&#0;javascript:alert(1))",
    "[x](data:text/html,<script>alert(1)</script>)",
    "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[x](vbscript:msgbox(1))",
    "[x](file:///etc/passwd)",
    "[x](blob:https://a.com/1)",
    "[x](//evil.com/a)",
    "[x](/relative)",
  ];

  it.each(unsafe)("renders %j as text without a link", (vector) => {
    expect(md(vector)).toBe("<p>x</p>");
  });

  it("renders unsafe autolinks and images as text", () => {
    expect(md("<javascript:alert(1)>")).toBe("<p>javascript:alert(1)</p>");
    expect(md("<JaVaScRiPt:alert(1)>")).toBe("<p>JaVaScRiPt:alert(1)</p>");
    expect(md("![a](javascript:alert(1))")).toBe("<p>a</p>");
    expect(md("![](javascript:alert(1))")).toBe("<p>javascript:alert(1)</p>");
    expect(md("![a](data:image/svg+xml,<svg/onload=alert(1)>)")).toBe("<p>a</p>");
  });

  it("renders raw HTML as text", () => {
    expect(md("<script>alert(1)</script>")).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(md("<img src=x onerror=alert(1)>")).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
    expect(md('<a href="javascript:alert(1)">x</a>')).toBe('<p>&lt;a href="javascript:alert(1)"&gt;x&lt;/a&gt;</p>');
    expect(md("```\n<script>alert(1)</script>\n```")).toBe("<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>");
  });

  it("drops link titles, a hover-only channel nobody can check", () => {
    const text = '[x](https://ok.com "a\\" onmouseover=\\"alert(1)") ![i](https://ok.com/i.png "https://user:pw@bank.com")';
    expect(md(text)).toBe('<p>[ok.com] <a href="https://ok.com/">x</a> [ok.com] <a href="https://ok.com/i.png">i</a></p>');
    expect(JSON.stringify(parseMarkdown(text))).not.toContain("title");
  });

  it("produces only allowlisted tags and attributes for hostile and random input", () => {
    const corpus = unsafe.concat([
      "[x](" + CTRL + "javascript:alert(1))",
      "[x](java\tscript:alert(1))",
      "| <img src=x onerror=alert(1)> |\n|---|\n| <script> |",
      "[<img src=x onerror=alert(1)>](https://ok.com)",
      "https://ok.com/<script>alert(1)</script>",
      '```js" onload="alert(1)\nx\n```',
      "<a@b.c> <mailto:x@y.z> <https://a.com/\"onmouseover=alert(1)>",
    ]);
    for (const text of corpus) expect(() => render(text)).not.toThrow();
    expect(() => render(corpus.join("\n\n"))).not.toThrow();

    const tokens = ["*", "_", "~~", "`", "```", "[", "]", "(", ")", "![", "<", ">", "&amp;", "&#106;", "\\", "\n", "\n\n", "> ", "- ", "1. ",
      "| ", "|---|", "# ", "http://", "https://a.com", "javascript:", "data:", " ", "x", '"', "'", ":", "mailto:a@b.c", "<script>", "    ", "~~~"];
    let seed = 42;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let doc = 0; doc < 300; doc++) {
      let text = "";
      for (let k = 0; k < 120; k++) text += tokens[Math.floor(rand() * tokens.length)];
      expect(() => render(text), text).not.toThrow();
    }
  });

  it("builds from DOM calls only, with ES2019 built-ins", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/markdown.ts"), "utf8");
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "DOMParser", "document.write", "createContextualFragment",
      "replaceAll", "findLast", "Object.hasOwn", "(?<=", "(?<!", ".at("]) {
      expect(source).not.toContain(banned);
    }
  });
});

describe("renderMarkdown streaming", () => {
  const answer = [
    "# Order status",
    "",
    "Here is what I found for **order #1042** (see _details_):",
    "",
    "- Shipped on *Monday* via `UPS`",
    "- Tracking: <https://ups.com/track?id=1Z999>",
    "  1. Label created",
    "  2. In transit",
    "",
    "> Note: delivery may take ~2 days.",
    '> See [the FAQ](https://example.com/faq "FAQ").',
    "",
    "| Item | Qty | Price |",
    "|:-----|:---:|------:|",
    "| Mug  | 2   | $8.00 |",
    "| Tee \\| L | 1 | $15 |",
    "",
    "```js",
    'const x = 1 < 2 && "<b>";',
    "```",
    "",
    "---",
    "",
    "Done ~~maybe~~ &amp; thanks! ![chart](https://example.com/c.png) Visit https://meandr.io.",
  ].join("\n");

  it("renders every prefix of an answer", () => {
    for (let k = 0; k <= answer.length; k++) {
      const prefix = answer.slice(0, k);
      expect(() => render(prefix), prefix).not.toThrow();
    }
  });

  it("renders the whole answer", () => {
    const frag = render(answer);
    expect(Array.from(frag.children).map((el) => el.tagName.toLowerCase())).toEqual(["h1", "p", "ul", "blockquote", "table", "pre", "hr", "p"]);
    expect(frag.querySelector("ul ol")?.textContent).toBe("Label createdIn transit");
    expect(frag.querySelector("pre code")?.textContent).toBe('const x = 1 < 2 && "<b>";');
    expect(Array.from(frag.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual([
      "https://ups.com/track?id=1Z999",
      "https://example.com/faq",
      "https://example.com/c.png",
      "https://meandr.io/",
    ]);
  });

  it("needs nothing from the document but its node factories", () => {
    const doc = {
      createDocumentFragment: () => document.createDocumentFragment(),
      createElement: (tag: string) => document.createElement(tag),
      createTextNode: (text: string) => document.createTextNode(text),
    } as unknown as Document;
    expect(ser(renderMarkdown(answer, doc))).toBe(md(answer));
  });

  it("shows an unfinished link, emphasis or fence gracefully", () => {
    expect(md("See [the FAQ](https://exa")).toBe("<p>See [the FAQ](https://exa</p>");
    expect(md("This is **impor")).toBe("<p>This is **impor</p>");
    expect(md("```ts\nconst a")).toBe('<pre><code class="language-ts">const a</code></pre>');
  });
});

describe("renderMarkdown performance", () => {
  const size = 100 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length));
  const nested: string[] = [];
  for (let k = 0; nested.join("\n").length < size; k++) nested.push("> - ".repeat(k % 12) + "x");
  const inputs: [string, string][] = [
    ["*", fill("*")],
    ["_", fill("_")],
    ["[", fill("[")],
    ["`", fill("`")],
    ["<", fill("<")],
    ["|", fill("|")],
    ["> - on one line", fill("> - ")],
    ["> - on many lines", nested.join("\n")],
    ["x then backticks", "x" + fill("`")],
    ["openers *a", fill("*a ")],
    ["closers a*", fill("a* ")],
    ["unclosed links [a](", fill("[a](")],
    ["unclosed titles", fill('[a](b "')],
    ["unclosed autolinks <a", fill("<a")],
    ["unfinished entities &#", fill("&#")],
    ["one long bare URL", fill("(http://a")],
    ["deep emphasis", "*".repeat(size / 2) + "a" + "*".repeat(size / 2)],
  ];

  it.each(inputs)("renders 100 KB of %s quickly", (_name, text) => {
    const start = performance.now();
    renderMarkdown(text);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it.each([50, 200])("pads within budget a wide header over %i KB of one-cell rows, in linear time", (kb) => {
    const cols = (kb * 1024) / 8, rows = (kb * 1024) / 4;
    const text = "|" + "a|".repeat(cols) + "\n|" + "-|".repeat(cols) + "\n" + "x\n".repeat(rows);
    let start = performance.now();
    const tree = parseMarkdown(text);
    const parseMs = performance.now() - start;
    start = performance.now();
    renderMarkdown(text, stubDocument());
    const renderMs = performance.now() - start;
    const [head, body] = (tree[0] as MarkdownElement).children as MarkdownElement[];
    expect(((head.children![0] as MarkdownElement).children || []).length).toBe(64);
    const widths = body.children!.map((tr) => ((tr as MarkdownElement).children || []).length), written = 64 + rows;
    expect(widths.length).toBe(rows);
    expect([widths[0], widths[rows - 1]]).toEqual([64, 1]);
    expect(64 + widths.reduce((sum, w) => sum + w, 0) - written).toBeLessThanOrEqual(2 * written);
    expect(parseMs).toBeLessThan(250);
    expect(renderMs).toBeLessThan(250);
  });

  const alts: [string, (n: number) => string][] = [
    ["letters", (n) => "a".repeat(n)],
    ["a bang and letters", (n) => "!" + "a".repeat(n)],
    ["words", (n) => "ab ".repeat(Math.floor(n / 3))],
  ];

  it.each(alts)("parses 200 KB of images nested around %s in linear time", (_name, alt) => {
    const half = 100 * 1024, depth = Math.floor(half / 21);
    const text = "![".repeat(depth) + alt(half) + "](https://a.co/i)".repeat(depth);
    const start = performance.now();
    const tree = parseMarkdown(text);
    expect(performance.now() - start).toBeLessThan(250);
    expect(tree).toStrictEqual([{ tag: "p", children: [{ tag: "a", href: "https://a.co/i", children: ["https://a.co/i"] }] }]);
  });
});
