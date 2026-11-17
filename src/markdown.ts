// Markdown from a model, parsed into a plain tree and rendered as DOM nodes. The input is hostile: no HTML
// string is ever parsed, only https:, http: and mailto: URLs become links, every link shows where it goes,
// and every scan is bounded so the cost grows linearly with the input.

const MAX_DEPTH = 8;
const MAX_INLINE = 16;
const MAX_COLS = 64;
const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /\s/;
const LANG = /^[A-Za-z0-9_+-]+$/;
const ALNUM = /[A-Za-z0-9]/;
const HEX = /[0-9A-Fa-f]/;
const DEC = /[0-9]/;
const MAX_LABEL = 120;
const MAX_SHOWN = 200;
const ELLIPSIS = String.fromCharCode(0x2026);
const FILLERS = String.fromCharCode(0x2800, 0x3164, 0x115f, 0x1160, 0xffa0);
// What reads as blank inside a label: whitespace, default-ignorables, and fillers such as U+2800 and U+3164.
const BLANK = new RegExp("[\\s\\p{Default_Ignorable_Code_Point}" + FILLERS + "]", "u");
// What stays percent-encoded when an address is shown: anything that would read as blank, or not at all.
const HIDDEN = new RegExp("[\\s\\p{Cc}\\p{Default_Ignorable_Code_Point}" + FILLERS + "]", "gu");
// Joiners a label keeps inside a word: ZWNJ and ZWJ between visible characters, variation selectors after one.
const ZWNJ = String.fromCharCode(0x200c), ZWJ = String.fromCharCode(0x200d);
const VS = new RegExp("[" + String.fromCharCode(0xfe00) + "-" + String.fromCharCode(0xfe0f) + String.fromCodePoint(0xe0100) + "-" + String.fromCodePoint(0xe01ef) + "]", "u");
const HOSTNAME = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/;
// Bidi embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069) reorder what a reader sees, so no
// string in the tree keeps them; the marks U+200E and U+200F stay.
const BIDI = new RegExp("[" + String.fromCharCode(0x202a) + "-" + String.fromCharCode(0x202e) + String.fromCharCode(0x2066) + "-" + String.fromCharCode(0x2069) + "]", "g");
const NAMED: { [name: string]: string } = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const MORE = "nbsp a0 mdash 2014 ndash 2013 hellip 2026 copy a9 reg ae trade 2122 laquo ab raquo bb lsquo 2018 rsquo 2019 ldquo 201c rdquo 201d times d7 euro 20ac pound a3 yen a5 deg b0 middot b7 bull 2022".split(" ");
for (let k = 0; k < MORE.length; k += 2) NAMED[MORE[k]] = String.fromCharCode(parseInt(MORE[k + 1], 16));

const TEXT = 0, DELIM = 1, EL = 2, BR = 3, CODE = 4, NOTE = 5;

/** A node of the tree parseMarkdown returns: a string is text, already entity-decoded. */
export type MarkdownNode = string | MarkdownElement;

export interface MarkdownElement {
  tag: "p" | "br" | "strong" | "em" | "del" | "code" | "pre" | "blockquote" | "ul" | "ol" | "li" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "hr" | "a" | "table" | "thead" | "tbody" | "tr" | "th" | "td";
  children?: MarkdownNode[]; // absent on br and hr; pre holds exactly one string, the code
  href?: string; // a: already checked, the parsed URL's href
  dest?: string; // a: the destination its note names, when the string just before it is that note, "[dest] "
  start?: number; // ol, only when it doesn't begin at 1
  language?: string; // pre, only when the info string matches /^[A-Za-z0-9_+-]+$/
  align?: "left" | "center" | "right"; // th, td
}

type Tag = MarkdownElement["tag"];
type Align = "left" | "center" | "right";

interface Blk {
  t: string;
  s: string;
  lang_?: string;
  kids_?: Blk[];
  items_?: Blk[][];
  start_?: number;
  tight_?: boolean;
  rows_?: string[][];
  align_?: (Align | "")[];
}
interface Fence { ch: string; len_: number; ind_: number; info_: string }
interface Item { ordered_: boolean; mark_: string; start_: number; indent_: number; content_: string; empty_: boolean }
interface Inl { k: number; s: string; href_: string; dest_: string; kid_: Inl | null; prev_: Inl | null; next_: Inl | null }
interface Delim { node_: Inl; ch: string; n: number; orig_: number; open_: boolean; close_: boolean; id: number; prev_: Delim | null; next_: Delim | null }
interface Bracket { node_: Inl; img_: boolean; active_: boolean; inner_: boolean; delim_: Delim | null; prev_: Bracket | null }

/**
 * The tree is safe as it stands: every tag is on the list above, every href is checked, and a labeled link
 * is preceded by a string naming its destination, "[host] ", unless the label already says exactly that.
 */
export function parseMarkdown(text: string): MarkdownNode[] {
  const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n").map(detab);
  return blockTree(parseBlocks(lines, 0).out_, false);
}

export function renderMarkdown(text: string, doc: Document = document): DocumentFragment {
  const frag = doc.createDocumentFragment();
  build(parseMarkdown(text), frag, doc);
  return frag;
}

// ---- blocks ----

function parseBlocks(lines: string[], depth: number): { out_: Blk[]; loose_: boolean } {
  const out: Blk[] = [];
  const nest = depth < MAX_DEPTH;
  const n = lines.length;
  let loose = false, gap = false, i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { gap = out.length > 0; i++; continue; }
    if (gap) loose = true;
    gap = false;
    let f: Fence | null, h: { level_: number; text_: string } | null, li: Item | null, align: (Align | "")[] | null;
    if ((f = fenceOpen(line))) {
      const code: string[] = [];
      for (i++; i < n && !fenceClose(lines[i], f); i++) code.push(dedent(lines[i], f.ind_));
      i++;
      const lang = f.info_.split(/\s/)[0];
      out.push({ t: "pre", s: code.join("\n"), lang_: LANG.test(lang) ? lang : "" });
    } else if ((h = heading(line))) {
      out.push({ t: "h" + h.level_, s: h.text_ });
      i++;
    } else if (isHr(line)) {
      out.push({ t: "hr", s: "" });
      i++;
    } else if (nest && quoteStrip(line) !== null) {
      const inner: string[] = [];
      let fs: Fence | null = null;
      while (i < n) {
        const q = quoteStrip(lines[i]);
        // A line without ">" continues the quote only as paragraph text (CommonMark laziness).
        if (q === null && (isBlank(lines[i]) || fs || isBlank(inner[inner.length - 1]) || startsBlock(lines[i], nest))) break;
        const l = q === null ? lines[i] : q;
        inner.push(l);
        fs = fenceStep(fs, l);
        i++;
      }
      out.push({ t: "blockquote", s: "", kids_: parseBlocks(inner, depth + 1).out_ });
    } else if (nest && (li = listItem(line))) {
      const first = li, items: Blk[][] = [];
      let cur: Item = li, lz = false;
      for (;;) {
        const body = [cur.content_];
        let fs = fenceStep(null, cur.content_), blank = -1;
        for (i++; i < n; i++) {
          const l = lines[i];
          if (isBlank(l)) { if (blank < 0) blank = i; continue; }
          if (indentOf(l) >= cur.indent_) {
            for (; blank >= 0 && blank < i; blank++) body.push("");
            blank = -1;
            const d = dedent(l, cur.indent_);
            body.push(d);
            fs = fenceStep(fs, d);
            continue;
          }
          if (blank >= 0 || fs || isBlank(body[body.length - 1]) || listItem(l) || startsBlock(l, nest)) break;
          body.push(l);
        }
        if (blank >= 0) i = blank;
        const r = parseBlocks(body, depth + 1);
        items.push(r.out_);
        if (r.loose_) lz = true;
        let j = i;
        while (j < n && isBlank(lines[j])) j++;
        const next = j < n ? listItem(lines[j]) : null;
        if (!next || next.ordered_ !== first.ordered_ || next.mark_ !== first.mark_) break;
        if (j > i) lz = true;
        i = j;
        cur = next;
      }
      out.push({ t: first.ordered_ ? "ol" : "ul", s: "", start_: first.start_, tight_: !lz, items_: items });
    } else if ((align = tableAt(lines, i))) {
      const rows = [cells(line, MAX_COLS)];
      for (i += 2; i < n && !isBlank(lines[i]) && !startsBlock(lines[i], nest); i++) rows.push(cells(lines[i], MAX_COLS));
      out.push({ t: "table", s: "", rows_: rows, align_: align.slice(0, MAX_COLS) });
    } else {
      const buf = [line.trim()];
      for (i++; i < n && !isBlank(lines[i]) && !startsBlock(lines[i], nest) && !tableAt(lines, i); i++) buf.push(lines[i].trim());
      out.push({ t: "p", s: buf.join("\n") });
    }
  }
  return { out_: out, loose_: loose };
}

function isBlank(l: string | undefined): boolean {
  if (l === undefined) return true;
  for (let k = 0; k < l.length; k++) {
    const c = l.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function indentOf(l: string): number {
  let k = 0;
  while (l.charCodeAt(k) === 32) k++;
  return k;
}

function lead(l: string): number {
  let k = 0;
  while (k < 3 && l.charCodeAt(k) === 32) k++;
  return k;
}

function dedent(l: string, k: number): string {
  let p = 0;
  while (p < k && l.charCodeAt(p) === 32) p++;
  return l.slice(p);
}

function detab(l: string): string {
  let k = 0, col = 0, tab = false;
  for (; k < l.length; k++) {
    const c = l.charCodeAt(k);
    if (c === 9) { col += 4 - (col % 4); tab = true; } else if (c === 32) col++; else break;
  }
  return tab ? " ".repeat(col) + l.slice(k) : l;
}

function fenceOpen(l: string): Fence | null {
  const ind = lead(l), ch = l.charAt(ind);
  if (ch !== "`" && ch !== "~") return null;
  let e = ind;
  while (l.charAt(e) === ch) e++;
  const info = l.slice(e).trim();
  return e - ind >= 3 && !(ch === "`" && info.indexOf("`") >= 0) ? { ch, len_: e - ind, ind_: ind, info_: info } : null;
}

function fenceClose(l: string, f: Fence): boolean {
  const s = lead(l);
  let e = s;
  while (l.charAt(e) === f.ch) e++;
  return e - s >= f.len_ && isBlank(l.slice(e));
}

function fenceStep(f: Fence | null, l: string): Fence | null {
  return f ? (fenceClose(l, f) ? null : f) : fenceOpen(l);
}

function heading(l: string): { level_: number; text_: string } | null {
  const s = lead(l);
  let e = s;
  while (e - s < 7 && l.charAt(e) === "#") e++;
  const level = e - s, c = l.charAt(e);
  if (level < 1 || level > 6 || (c !== "" && c !== " " && c !== "\t")) return null;
  let t = l.slice(e).trim(), k = t.length;
  while (k > 0 && t.charAt(k - 1) === "#") k--;
  if (k === 0 || t.charAt(k - 1) === " " || t.charAt(k - 1) === "\t") t = t.slice(0, k).trim();
  return { level_: level, text_: t };
}

function isHr(l: string): boolean {
  const s = lead(l), ch = l.charAt(s);
  if (ch !== "-" && ch !== "*" && ch !== "_") return false;
  let count = 0;
  for (let k = s; k < l.length; k++) {
    const c = l.charAt(k);
    if (c === ch) count++;
    else if (c !== " " && c !== "\t") return false;
  }
  return count >= 3;
}

function quoteStrip(l: string): string | null {
  let s = lead(l);
  if (l.charAt(s) !== ">") return null;
  s++;
  if (l.charAt(s) === " " || l.charAt(s) === "\t") s++;
  return detab(l.slice(s));
}

function listItem(l: string): Item | null {
  let p = lead(l), start = 1;
  const c = l.charAt(p), ordered = c >= "0" && c <= "9";
  let mark = c;
  if (ordered) {
    let e = p;
    while (e - p < 9 && l.charAt(e) >= "0" && l.charAt(e) <= "9") e++;
    mark = l.charAt(e);
    if (mark !== "." && mark !== ")") return null;
    start = parseInt(l.slice(p, e), 10);
    p = e;
  } else if (c !== "-" && c !== "*" && c !== "+") return null;
  p++;
  let e = p;
  while (l.charAt(e) === " " || l.charAt(e) === "\t") e++;
  if (e === p && e < l.length) return null;
  const empty = e >= l.length, wide = e - p > 4;
  return { ordered_: ordered, mark_: mark, start_: start, indent_: empty || wide ? p + 1 : e, content_: empty ? "" : l.slice(wide ? p + 1 : e), empty_: empty };
}

function startsBlock(l: string, nest: boolean): boolean {
  if (fenceOpen(l) || heading(l) || isHr(l)) return true;
  if (!nest) return false;
  if (quoteStrip(l) !== null) return true;
  const m = listItem(l);
  return m !== null && !m.empty_ && (!m.ordered_ || m.start_ === 1);
}

// A row's cells, at most max: past that, the rest of the row joins the last cell's text.
function cells(l: string, max: number): string[] {
  const s = l.trim(), out: string[] = [];
  let k = s.charAt(0) === "|" ? 1 : 0, end = s.length, cur = "";
  if (end > k && s.charAt(end - 1) === "|") {
    let bs = 0;
    while (s.charAt(end - 2 - bs) === "\\") bs++;
    if (bs % 2 === 0) end--;
  }
  for (; k < end; k++) {
    const c = s.charAt(k);
    if (c === "\\" && k + 1 < end) {
      const d = s.charAt(++k);
      cur += d === "|" ? d : c + d;
    } else if (c === "|" && out.length < max - 1) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function delimRow(l: string): (Align | "")[] | null {
  if (l.indexOf("|") < 0 || l.indexOf("-") < 0) return null;
  const out: (Align | "")[] = [];
  for (const c of cells(l, Infinity)) {
    if (!/^:?-+:?$/.test(c)) return null;
    const left = c.charAt(0) === ":", right = c.charAt(c.length - 1) === ":";
    out.push(left && right ? "center" : right ? "right" : left ? "left" : "");
  }
  return out;
}

function tableAt(lines: string[], i: number): (Align | "")[] | null {
  const align = i + 1 < lines.length ? delimRow(lines[i + 1]) : null;
  return align && lines[i].indexOf("|") >= 0 && cells(lines[i], Infinity).length === align.length ? align : null;
}

// ---- inlines ----

function mk(k: number, s: string): Inl {
  return { k, s, href_: "", dest_: "", kid_: null, prev_: null, next_: null };
}

function anchor(href: string, kid: Inl): Inl {
  const a = mk(EL, "a");
  a.href_ = href;
  a.kid_ = kid;
  return a;
}

function isAsciiPunct(ch: string): boolean {
  return ch !== "" && ASCII_PUNCT.indexOf(ch) >= 0;
}

function special(c: number): boolean {
  switch (c) {
    case 10: case 33: case 38: case 42: case 60: case 72: case 91: case 92: case 93: case 95: case 96: case 104: case 126:
      return true;
  }
  return false;
}

function parseInline(src: string): Inl | null {
  const head = mk(EL, ""), len = src.length;
  let tail = head, dtop: Delim | null = null, btop = null as Bracket | null, ids = 0, i = 0, rp = 0, url = -1;
  const push = (x: Inl) => { tail.next_ = x; x.prev_ = tail; tail = x; };
  const text = (s: string) => { if (tail.k === TEXT) tail.s += s; else push(mk(TEXT, s)); };
  const unlink = (x: Inl) => { x.prev_!.next_ = x.next_; if (x.next_) x.next_.prev_ = x.prev_; else tail = x.prev_!; };
  const drop = (d: Delim) => {
    d.node_.s = d.node_.s.slice(0, d.n);
    if (d.prev_) d.prev_.next_ = d.next_;
    if (d.next_) d.next_.prev_ = d.prev_; else dtop = d.prev_;
  };

  // CommonMark's "process emphasis"; floor[] bounds each opener search so the whole pass stays linear.
  const emphasis = (bottom: Delim | null) => {
    const bid = bottom ? bottom.id : -1, floor: { [key: string]: number } = {};
    let c = dtop;
    if (!c || c.id <= bid) return;
    while (c.prev_ && c.prev_.id > bid) c = c.prev_;
    while (c) {
      if (!c.close_) { c = c.next_; continue; }
      const key = c.ch + (c.open_ ? "1" : "0") + (c.orig_ % 3);
      const lim = Math.max(bid, key in floor ? floor[key] : -1);
      let o: Delim | null = c.prev_;
      while (o && o.id > lim && !(o.ch === c.ch && o.open_ && pairs(o, c))) o = o.prev_;
      if (o && o.id > lim) {
        const use = c.ch === "~" || (c.n > 1 && o.n > 1) ? 2 : 1;
        o.n -= use;
        c.n -= use;
        const el = mk(EL, c.ch === "~" ? "del" : use === 2 ? "strong" : "em");
        if (o.node_.next_ !== c.node_) {
          const first = o.node_.next_!, last = c.node_.prev_!;
          first.prev_ = null;
          last.next_ = null;
          el.kid_ = first;
        }
        o.node_.next_ = el; el.prev_ = o.node_; el.next_ = c.node_; c.node_.prev_ = el;
        for (let d = o.next_; d && d !== c; d = d.next_) d.node_.s = d.node_.s.slice(0, d.n);
        o.next_ = c;
        c.prev_ = o;
        if (!o.n) { unlink(o.node_); drop(o); }
        if (!c.n) { unlink(c.node_); const nx: Delim | null = c.next_; drop(c); c = nx; }
      } else {
        floor[key] = c.prev_ ? c.prev_.id : -1;
        const nx: Delim | null = c.next_;
        if (!c.open_) drop(c);
        c = nx;
      }
    }
    while (dtop && dtop.id > bid) drop(dtop);
  };

  // Backtick runs and, for each, the next run of the same length: code spans close in O(1).
  const runAt: number[] = [], runLen: number[] = [], nextSame: number[] = [];
  if (src.indexOf("`") >= 0) {
    for (let k = 0; k < len; ) {
      if (src.charCodeAt(k) !== 96) { k++; continue; }
      let e = k;
      while (src.charCodeAt(e) === 96) e++;
      runAt.push(k);
      runLen.push(e - k);
      k = e;
    }
    const last: { [n: number]: number } = {};
    for (let r = runAt.length - 1; r >= 0; r--) {
      nextSame[r] = runLen[r] in last ? last[runLen[r]] : -1;
      last[runLen[r]] = r;
    }
  }

  while (i < len) {
    const c = src.charCodeAt(i);
    if (c === 92) {
      const d = src.charAt(i + 1);
      if (d === "\n") { push(mk(BR, "")); i += 2; }
      else if (isAsciiPunct(d)) {
        let e = i + 2;
        if (d === "`") while (src.charCodeAt(e) === 96) e++;
        text(src.slice(i + 1, e));
        i = e;
      } else { text("\\"); i++; }
    } else if (c === 96) {
      while (rp < runAt.length && runAt[rp] < i) rp++;
      if (runAt[rp] !== i) { text("`"); i++; continue; }
      const n = runLen[rp], cl = nextSame[rp];
      if (cl < 0) { text(src.slice(i, i + n)); i += n; continue; }
      let code = src.slice(i + n, runAt[cl]).replace(/\n/g, " ");
      if (code.length > 1 && code.charAt(0) === " " && code.charAt(code.length - 1) === " " && /[^ ]/.test(code)) code = code.slice(1, -1);
      push(mk(CODE, code));
      i = runAt[cl] + n;
    } else if (c === 42 || c === 95 || c === 126) {
      let e = i + 1;
      while (src.charCodeAt(e) === c) e++;
      const b = src.charAt(i - 1), a = src.charAt(e);
      const bw = b === "" || SPACE.test(b), aw = a === "" || SPACE.test(a), bp = PUNCT.test(b), ap = PUNCT.test(a);
      const left = !aw && (!ap || bw || bp), right = !bw && (!bp || aw || ap);
      const open = c === 95 ? left && (!right || bp) : left;
      const close = c === 95 ? right && (!left || ap) : right;
      const x = mk(DELIM, src.slice(i, e));
      push(x);
      if ((open || close) && (c !== 126 || e - i === 2)) {
        const d: Delim = { node_: x, ch: src.charAt(i), n: e - i, orig_: e - i, open_: open, close_: close, id: ids++, prev_: dtop, next_: null };
        if (dtop) dtop.next_ = d;
        dtop = d;
      }
      i = e;
    } else if (c === 91 || (c === 33 && src.charCodeAt(i + 1) === 91)) {
      const img = c === 33, x = mk(DELIM, img ? "![" : "[");
      push(x);
      btop = { node_: x, img_: img, active_: true, inner_: false, delim_: dtop, prev_: btop };
      i += img ? 2 : 1;
    } else if (c === 93) {
      const b: Bracket | null = btop, L = b && b.active_ ? linkTail(src, i + 1) : null;
      if (b) btop = b.prev_;
      if (!b || !L) {
        if (b && b.inner_ && btop) btop.inner_ = true;
        text("]");
        i++;
        continue;
      }
      emphasis(b.delim_);
      const kids = b.node_.next_, href = safeHref(L.dest_);
      if (b.img_ || href) {
        // An image around another link shows its own address: one label can't speak for two destinations.
        let label = !b.img_ && kids ? kids : mk(TEXT, b.img_ && !(href && b.inner_) ? plain(kids) : "");
        if (href) tidy(label);
        if (!plain(label)) label = mk(TEXT, href ? shown(href) : L.dest_);
        label.prev_ = null;
        b.node_.next_ = null;
        tail = b.node_;
        if (href) {
          // The note goes before the label: nothing in a label, however wide, can push it out of view.
          const a = anchor(href, label);
          let p = b.node_.prev_!;
          a.dest_ = note(plain(label), href);
          if (a.dest_) {
            const n = mk(NOTE, "[" + a.dest_ + "] ");
            p.next_ = n;
            n.prev_ = p;
            p = n;
          }
          p.next_ = a;
          a.prev_ = p;
          tail = a;
        } else {
          b.node_.k = TEXT;
          b.node_.s = label.s;
        }
      } else unlink(b.node_);
      if (!b.img_) for (let x = btop; x && x.active_; x = x.prev_) x.active_ = false;
      if (btop && (b.img_ || href || b.inner_)) btop.inner_ = true;
      i = L.end_;
    } else if (c === 60) {
      const al = autolink(src, i);
      if (!al) { text("<"); i++; continue; }
      if (al.href_) {
        push(anchor(al.href_, mk(TEXT, shown(al.href_))));
        if (btop) btop.inner_ = true;
      } else text(al.text_);
      i = al.end_;
    } else if (c === 38) {
      const en = entity(src, i);
      if (en) { text(en[0]); i = en[1]; } else { text("&"); i++; }
    } else if (c === 10) {
      push(mk(BR, ""));
      i++;
      while (src.charCodeAt(i) === 32) i++;
    } else if ((c === 104 || c === 72) && (url = bareUrl(src, i, btop !== null)) > i) {
      const u = src.slice(i, url), href = safeHref(u);
      if (href) {
        push(anchor(href, mk(TEXT, shown(href))));
        if (btop) btop.inner_ = true;
      } else text(u);
      i = url;
    } else {
      let e = i + 1;
      while (e < len && !special(src.charCodeAt(e))) e++;
      text(src.slice(i, e));
      i = e;
    }
  }
  emphasis(null);
  return head.next_;
}

function pairs(o: Delim, c: Delim): boolean {
  return c.ch === "~" || !((o.close_ || c.open_) && (o.orig_ + c.orig_) % 3 === 0 && (o.orig_ % 3 !== 0 || c.orig_ % 3 !== 0));
}

function plain(n: Inl | null): string {
  let s = "";
  const resume: (Inl | null)[] = [];
  for (;;) {
    if (!n) {
      if (!resume.length) return s;
      n = resume.pop()!;
      continue;
    }
    if (n.k === EL) { resume.push(n.next_); n = n.kid_; continue; }
    if (n.k !== NOTE) s += n.k === BR ? " " : n.s;
    n = n.next_;
  }
}

function skipWs(s: string, p: number, lim: number): number {
  while (p < lim && (s.charAt(p) === " " || s.charAt(p) === "\t" || s.charAt(p) === "\n")) p++;
  return p;
}

// The "(dest "title")" after "]"; a title is checked for syntax, then dropped. Scans are capped so a run
// of unclosed links can't go quadratic.
function linkTail(s: string, p: number): { dest_: string; end_: number } | null {
  if (s.charAt(p) !== "(") return null;
  const lim = Math.min(s.length, p + 4096);
  p = skipWs(s, p + 1, lim);
  let dest: string;
  if (s.charAt(p) === "<") {
    const q = ++p;
    for (; p < lim; p++) {
      const c = s.charAt(p);
      if (c === "\\") p++;
      else if (c === ">" || c === "<" || c === "\n") break;
    }
    if (s.charAt(p) !== ">") return null;
    dest = s.slice(q, p++);
  } else {
    const q = p;
    let depth = 0;
    for (; p < lim; p++) {
      const c = s.charCodeAt(p);
      if (c === 92 && isAsciiPunct(s.charAt(p + 1))) p++;
      else if (c <= 32) break;
      else if (c === 40) { if (++depth > 32) return null; }
      else if (c === 41) { if (!depth) break; depth--; }
    }
    if (depth || p >= lim) return null;
    dest = s.slice(q, p);
  }
  const p0 = p;
  p = skipWs(s, p, lim);
  const t = s.charAt(p);
  if (p > p0 && (t === '"' || t === "'" || t === "(")) {
    const close = t === "(" ? ")" : t;
    for (p++; p < lim; p++) {
      const c = s.charAt(p);
      if (c === "\\") p++;
      else if (c === close) break;
      else if (t === "(" && c === "(") return null;
    }
    if (p >= lim) return null;
    p = skipWs(s, p + 1, lim);
  }
  if (s.charAt(p) !== ")") return null;
  return { dest_: decode(dest), end_: p + 1 };
}

function autolink(s: string, p: number): { text_: string; href_: string | null; end_: number } | null {
  const lim = Math.min(s.length, p + 2048);
  let q = p + 1;
  while (q < lim) {
    const c = s.charCodeAt(q);
    if (c <= 32 || c === 60 || c === 62) break;
    q++;
  }
  if (s.charAt(q) !== ">" || q === p + 1) return null;
  const t = s.slice(p + 1, q);
  if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(t)) return { text_: t, href_: safeHref(t), end_: q + 1 };
  if (/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/.test(t)) return { text_: t, href_: safeHref("mailto:" + t), end_: q + 1 };
  return null;
}

// GFM's extended autolink, http(s) only: ends at whitespace or "<", sheds trailing punctuation.
function bareUrl(s: string, p: number, inBracket: boolean): number {
  const b = s.charAt(p - 1);
  if (b !== "" && !SPACE.test(b) && "*_~(".indexOf(b) < 0) return -1;
  if (b === "(" && s.charAt(p - 2) === "]") return -1; // an unfinished [text](url stays text while it streams
  const h = s.slice(p, p + 8).toLowerCase();
  const st = h.indexOf("https://") === 0 ? p + 8 : h.indexOf("http://") === 0 ? p + 7 : -1;
  if (st < 0) return -1;
  let e = st, opens = 0, closes = 0;
  for (; e < s.length; e++) {
    const c = s.charCodeAt(e);
    if (c <= 32 || c === 60 || c === 160 || (inBracket && c === 93)) break;
    if (c === 40) opens++;
    else if (c === 41) closes++;
  }
  for (;;) {
    const c = s.charAt(e - 1);
    if ("?!.,:*_~'\"".indexOf(c) >= 0) e--;
    else if (c === ")" && closes > opens) { e--; closes--; }
    else if (c === ";") {
      let k = e - 2;
      while (k > st && ALNUM.test(s.charAt(k))) k--;
      if (s.charAt(k) !== "&" || k === e - 2) break;
      e = k;
    } else break;
  }
  return e > st ? e : -1;
}

function entity(s: string, p: number): [string, number] | null {
  let q = p + 1;
  if (s.charAt(q) === "#") {
    const hex = s.charAt(q + 1) === "x" || s.charAt(q + 1) === "X", digit = hex ? HEX : DEC, st = (q += hex ? 2 : 1);
    while (q - st < (hex ? 6 : 7) && digit.test(s.charAt(q))) q++;
    if (q === st || s.charAt(q) !== ";") return null;
    let cp = parseInt(s.slice(st, q), hex ? 16 : 10);
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return [String.fromCodePoint(cp), q + 1];
  }
  while (q - p < 10 && ALNUM.test(s.charAt(q))) q++;
  const name = s.slice(p + 1, q);
  return s.charAt(q) === ";" && Object.prototype.hasOwnProperty.call(NAMED, name) ? [NAMED[name], q + 1] : null;
}

function decode(s: string): string {
  if (s.indexOf("\\") < 0 && s.indexOf("&") < 0) return s;
  let out = "";
  for (let k = 0; k < s.length; k++) {
    const c = s.charAt(k);
    if (c === "\\" && isAsciiPunct(s.charAt(k + 1))) { out += s.charAt(++k); continue; }
    const en = c === "&" ? entity(s, k) : null;
    if (en) { out += en[0]; k = en[1] - 1; } else out += c;
  }
  return out;
}

// ---- link checks ----

// Absolute URLs only (no base), judged by the parsed protocol, never carrying credentials, with a host that
// reads as itself: letters, digits, dots and hyphens, or an IP literal. The parsed href is what gets set.
function safeHref(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "mailto:") return mailbox(u) ? u.href : null;
  return (u.protocol === "https:" || u.protocol === "http:") && HOSTNAME.test(u.hostname) ? u.href : null;
}

// A mailto's address from the href's own parts: local part and query as the href encodes them, the domain
// as a URL host (punycode). null when the domain isn't one, or the local part holds @, a quote, a space or
// a parenthesis, encoded or not: display names and quoted parts are refused.
function mailbox(u: URL): string | null {
  const path = u.pathname, at = path.lastIndexOf("@"), domain = path.slice(at + 1);
  if (at < 1 || /[/\\?#:]/.test(domain)) return null;
  let local: string, host: string;
  try {
    local = decodeURIComponent(path.slice(0, at));
    host = new URL("http://" + domain).hostname;
  } catch {
    return null;
  }
  return HOSTNAME.test(host) && !/[@"()\s]/.test(local) ? path.slice(0, at + 1) + host + u.search : null;
}

// How a link's own address reads: the parsed host, then path, query and fragment decoded where that shows
// a visible character; capped at MAX_SHOWN characters.
function shown(href: string): string {
  const u = new URL(href);
  const text = u.protocol === "mailto:" ? "mailto:" + (mailbox(u) || u.pathname) : u.protocol + "//" + u.host + decodeOr(u.pathname + u.search + u.hash);
  return points(text) > MAX_SHOWN ? firstPoints(text, MAX_SHOWN - 1) + ELLIPSIS : text;
}

function decodeOr(s: string): string {
  try {
    return decodeURI(s).replace(HIDDEN, encodeURIComponent);
  } catch {
    return s;
  }
}

function points(s: string): number {
  let n = 0;
  for (let k = 0; k < s.length; k += s.codePointAt(k)! > 0xffff ? 2 : 1) n++;
  return n;
}

function firstPoints(s: string, n: number): string {
  let k = 0;
  for (; n > 0 && k < s.length; n--) k += s.codePointAt(k)! > 0xffff ? 2 : 1;
  return s.slice(0, k);
}

// The destination a labeled link names after itself, its host or a mailto's address; "" when the label
// already reads exactly as that. Compared with case, since "I" passes for "l".
function note(label: string, href: string): string {
  const u = new URL(href);
  if (u.protocol === "mailto:") {
    const to = mailbox(u) || u.pathname;
    return label === to ? "" : to;
  }
  const t = unscheme(label), host = u.hostname;
  return t === unscheme(href) || t === unscheme(shown(href)) || t === host || t === "www." + host ? "" : host;
}

// Inside a label, breaks read as spaces, blank runs collapse to one, the ends are trimmed and the text
// stops at MAX_LABEL characters; joiners stay inside words, so emoji and ZWNJ scripts read as written.
function tidy(first: Inl | null): void {
  const nodes: Inl[] = [], outs: string[] = [];
  let all = "";
  eachText(first, (x) => {
    if (x.k === BR) {
      x.k = TEXT;
      x.s = " ";
    }
    nodes.push(x);
    all += x.s;
    return true;
  });
  let pos = 0, count = 0, space = true, joinTo = -1, join = false;
  for (const x of nodes) {
    let out = "";
    for (const end = pos + x.s.length; pos < end; ) {
      const ch = String.fromCodePoint(all.codePointAt(pos)!);
      pos += ch.length;
      if (!space && (ch === ZWNJ || ch === ZWJ) && pos > joinTo) {
        // One look past each run of joiners: the run stays only when a visible character follows it.
        for (joinTo = pos; joinTo < all.length; ) {
          const c = String.fromCodePoint(all.codePointAt(joinTo)!);
          if (c !== ZWNJ && c !== ZWJ && !VS.test(c)) break;
          joinTo += c.length;
        }
        join = joinTo < all.length && !BLANK.test(String.fromCodePoint(all.codePointAt(joinTo)!));
      }
      const blank: boolean = BLANK.test(ch) && (space || (ch === ZWNJ || ch === ZWJ ? !join : !VS.test(ch)));
      if (blank && space) continue;
      out += blank ? " " : ch;
      count++;
      space = blank;
    }
    outs.push(out);
  }
  for (let k = outs.length - 1; k >= 0; k--) {
    if (!outs[k]) continue;
    if (outs[k].charAt(outs[k].length - 1) === " ") {
      outs[k] = outs[k].slice(0, -1);
      count--;
    }
    break;
  }
  if (count > MAX_LABEL) {
    let left = MAX_LABEL - 1, k = 0;
    while (points(outs[k]) < left) left -= points(outs[k++]);
    let head = firstPoints(outs[k], left);
    if (head.charAt(head.length - 1) === " ") head = head.slice(0, -1);
    outs[k] = head + ELLIPSIS;
    while (++k < outs.length) outs[k] = "";
  }
  nodes.forEach((x, k) => { x.s = outs[k]; });
}

// Calls fn on each node of a label that carries text, in reading order, until fn returns false.
function eachText(n: Inl | null, fn: (x: Inl) => boolean): void {
  const resume: (Inl | null)[] = [];
  for (;;) {
    if (!n) {
      if (!resume.length) return;
      n = resume.pop()!;
      continue;
    }
    if (n.k === EL) {
      resume.push(n.next_);
      n = n.kid_;
      continue;
    }
    if (n.k !== NOTE && !fn(n)) return;
    n = n.next_;
  }
}

function unscheme(s: string): string {
  s = s.trim();
  const head = s.slice(0, 8).toLowerCase();
  s = head.indexOf("https://") === 0 ? s.slice(8) : head.indexOf("http://") === 0 ? s.slice(7) : s;
  return s.charAt(s.length - 1) === "/" ? s.slice(0, -1) : s;
}

// ---- tree ----

function blockTree(bs: Blk[], tight: boolean): MarkdownNode[] {
  const out: MarkdownNode[] = [];
  for (const b of bs) {
    switch (b.t) {
      case "p":
        if (tight) inlineTree(parseInline(b.s), out, 0, false);
        else out.push({ tag: "p", children: inlineTree(parseInline(b.s), [], 0, false) });
        break;
      case "pre":
        out.push(b.lang_ ? { tag: "pre", language: b.lang_, children: [clean(b.s)] } : { tag: "pre", children: [clean(b.s)] });
        break;
      case "blockquote":
        out.push({ tag: "blockquote", children: blockTree(b.kids_ || [], false) });
        break;
      case "ul":
      case "ol": {
        const items = (b.items_ || []).map((item): MarkdownNode => ({ tag: "li", children: blockTree(item, !!b.tight_) }));
        const list: MarkdownElement = { tag: b.t, children: items };
        if (b.t === "ol" && b.start_ !== 1) list.start = b.start_;
        out.push(list);
        break;
      }
      case "table":
        out.push(tableTree(b.rows_ || [], b.align_ || []));
        break;
      case "hr":
        out.push({ tag: "hr" });
        break;
      default:
        out.push({ tag: b.t as Tag, children: inlineTree(parseInline(b.s), [], 0, false) });
    }
  }
  return out;
}

// Short rows are padded to the header's width while the padding stays within twice the cells written;
// past that budget rows stay as written, so a wide header can't multiply the rows under it.
function tableTree(rows: string[][], align: (Align | "")[]): MarkdownElement {
  const sections: MarkdownElement[] = [], width = rows.length ? rows[0].length : 0;
  let body: MarkdownNode[] = [], budget = 0;
  for (const row of rows) budget += 2 * row.length;
  for (let r = 0; r < rows.length; r++) {
    if (r < 2) sections.push({ tag: r ? "tbody" : "thead", children: (body = []) });
    const has = rows[r].length;
    let n = has;
    if (has < width) {
      if (width - has <= budget) {
        budget -= width - has;
        n = width;
      } else budget = 0;
    }
    const row: MarkdownNode[] = [];
    for (let c = 0; c < n; c++) {
      const cell: MarkdownElement = { tag: r ? "td" : "th", children: c < has ? inlineTree(parseInline(rows[r][c]), [], 0, false) : [] };
      const a = align[c];
      if (a) cell.align = a;
      row.push(cell);
    }
    body.push({ tag: "tr", children: row });
  }
  return { tag: "table", children: sections };
}

function inlineTree(n: Inl | null, out: MarkdownNode[], depth: number, inA: boolean): MarkdownNode[] {
  let run = "";
  for (; n; n = n.next_) {
    if (n.k === TEXT || n.k === DELIM) run += n.s;
    else if (n.k === NOTE) {
      // A link's destination stays a string of its own, unless that link was flattened into text.
      if (inA || depth >= MAX_INLINE) continue;
      pushText(out, run);
      pushText(out, n.s);
      run = "";
    } else if (n.k === EL && ((n.s === "a" && inA) || depth >= MAX_INLINE)) run += plain(n.kid_);
    else {
      pushText(out, run);
      run = "";
      if (n.k === BR) out.push({ tag: "br" });
      else if (n.k === CODE) out.push({ tag: "code", children: [clean(n.s)] });
      else {
        const el: MarkdownElement = { tag: n.s as Tag, children: inlineTree(n.kid_, [], depth + 1, inA || n.s === "a") };
        if (n.s === "a") {
          el.href = n.href_;
          if (n.dest_) el.dest = n.dest_;
        }
        out.push(el);
      }
    }
  }
  pushText(out, run);
  return out;
}

function pushText(out: MarkdownNode[], s: string): void {
  s = clean(s);
  if (s) out.push(s);
}

function clean(s: string): string {
  return s.replace(BIDI, "");
}

// ---- DOM ----

function build(nodes: MarkdownNode[], parent: Node, doc: Document): void {
  for (const n of nodes) {
    if (typeof n === "string") {
      parent.appendChild(doc.createTextNode(n));
      continue;
    }
    const el: HTMLElement = doc.createElement(n.tag);
    let inner = el;
    if (n.tag === "pre") {
      inner = doc.createElement("code");
      if (n.language) inner.setAttribute("class", "language-" + n.language);
      el.appendChild(inner);
    } else if (n.tag === "a" && n.href) {
      el.setAttribute("href", n.href);
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    } else if (n.tag === "ol" && n.start !== undefined) el.setAttribute("start", String(n.start));
    else if ((n.tag === "th" || n.tag === "td") && n.align) el.style.textAlign = n.align;
    if (n.children) build(n.children, inner, doc);
    parent.appendChild(el);
  }
}
