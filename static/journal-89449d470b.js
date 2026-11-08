/* In-book feedback notes (DM item 133): the DM leaves notes on text, pictures, pages, the map and the cast.
 *
 *   mountNotes(ctx) → the notes controller, or null when this viewer can't edit the artifact's database
 *
 * Runs only in the published artifact (window.claude) or under the dev mock (?fbmock, see fbmock.js). Notes are flat
 * documents in the db collection "feedback" (fields: README). Outside notes mode nothing of this is on the pages and
 * no listener runs but the N key and the button; the one subscription keeps the button's count.
 */

const QUOTE_MAX = 400, CTX = 40;
const norm = (s) => String(s).replace(/\s+/g, " ");
const clip = (s, n) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")}…` : s);
const clampN = (v, a, b) => Math.min(Math.max(v, a), Math.max(a, b));
const isOpen = (n) => (n.status || "open") === "open";
const STATUS_LABEL = { open: "open", done: "done", wontfix: "won't fix" };
const ERRORS = {
  quota_exceeded: "The notes store is full. Delete a few old notes, then try again.",
  invalid_argument: "That note couldn't be stored (too long?).",
  unavailable: "Notes can't be reached right now. Try again in a moment.",
};
const QUILL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 3.5C14.4 4.3 9.8 8.1 7.7 14.8L6.6 18.4l3.3-2.1c5.6-1.6 9.3-6.2 10.6-12.8zM6.6 18.4 4 21" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.6 13.4c2.2-2.6 4.6-4.6 7.4-6.2" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';

/* the gate: the database, when this viewer may edit the artifact; otherwise null (never throws, never reads claude.db) */
async function notesStore() {
  try {
    if (typeof window.claude?.use !== "function") return null;
    const db = await window.claude.use("db");
    if (!db) return null;
    const user = await window.claude.use("user");
    return (await user?.canEdit?.()) ? db : null;
  } catch {
    return null;
  }
}

/* a store call; `unavailable` is retried once */
async function attempt(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.code !== "unavailable") throw e;
    await new Promise((r) => setTimeout(r, 1200));
    return fn();
  }
}

/* where a quote sits in a page's text: the occurrence whose surroundings match best (-1: not there) */
function findQuote(T, n) {
  const q = n.quote || "", nb = n.before || "", na = n.after || "";
  let best = -1, top = -1;
  for (let i = q ? T.indexOf(q) : -1; i >= 0; i = T.indexOf(q, i + 1)) {
    const b = T.slice(Math.max(0, i - CTX), i), a = T.slice(i + q.length, i + q.length + CTX);
    let s = 0, t = 0;
    while (s < nb.length && s < b.length && nb[nb.length - 1 - s] === b[b.length - 1 - s]) s++;
    while (t < na.length && t < a.length && na[t] === a[t]) t++;
    if (s + t > top) { top = s + t; best = i; }
  }
  return best;
}

/* the client rects of a range, merged into one box per line */
function lineBoxes(range) {
  const out = [];
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const m = (r.top + r.bottom) / 2;
    const ln = out.find((l) => m > l.t && m < l.b);
    if (ln) Object.assign(ln, { l: Math.min(ln.l, r.left), r: Math.max(ln.r, r.right), t: Math.min(ln.t, r.top), b: Math.max(ln.b, r.bottom) });
    else out.push({ l: r.left, r: r.right, t: r.top, b: r.bottom });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function mountNotes(ctx) {
  const db = await notesStore();
  if (!db) return null;
  const { root, stage, book, pages } = ctx;
  const col = db.collection("feedback");
  const mk = (tag, cls, html = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; if (tag === "button") e.type = "button"; return e; };

  // stable page keys: "s15.2" is the second page of session 15
  const keyOf = [], sessOf = [], byKey = new Map(), seen = {};
  pages.forEach((f, i) => {
    const s = f.dataset.session || sessOf[i - 1] || "0";
    seen[s] = (seen[s] || 0) + 1;
    keyOf[i] = `s${s}.${seen[s]}`;
    sessOf[i] = s;
    byKey.set(keyOf[i], i);
  });
  const flat = [];   // each page's text, whitespace collapsed (the originals: identical to their clones)
  const textOf = (i) => (flat[i] ??= norm(pages[i].querySelector(".tj-page")?.textContent || ""));

  /* ---- the notes ---- */
  let notes = [], num = new Map(), loc = new Map(), status = "", loaded = false;
  let on = false, ac = null, cur = null;   // notes mode; its listeners; the open card: { draft } (new) or { note }, + editing, confirm
  const busy = new Set();
  function locate(n) {   // → { page, ok }: pageKey + quote with its context, then the quote anywhere, then the old page number
    const k = byKey.get(n.pageKey), old = Number.isInteger(n.page) && pages[n.page] ? n.page : null;
    const fallback = k ?? old ?? 0;
    if (n.kind !== "text") return { page: fallback, ok: true };
    for (const i of [k, old]) if (i != null && findQuote(textOf(i), n) >= 0) return { page: i, ok: true };
    for (let i = 0; i < pages.length; i++) if (findQuote(textOf(i), n) >= 0) return { page: i, ok: true };
    return { page: fallback, ok: false };
  }

  /* ---- chrome: the button (desktop: top right; phones: the tab bar), banner, chip, card, list ---- */
  const btn = mk("button", "tj-nbtn tj-nui", `${QUILL}<span>Notes</span><b hidden></b>`);
  const pbtn = mk("button", "tj-pnotes", `${QUILL}<span>Notes</span><b hidden></b>`);
  const banner = mk("div", "tj-nbanner tj-nui", '<span class="t"></span><span class="st" aria-live="polite"></span><button class="ls">List</button><button class="x" aria-label="Leave notes mode">×</button>');
  const chip = mk("button", "tj-nchip tj-nui", "+ Note");
  const card = mk("div", "tj-ncard tj-nui");
  const list = mk("div", "tj-nlist tj-nui", '<div class="hd"><b>Notes in this book</b><span class="f" role="group" aria-label="Show"><button data-f="open">Open</button><button data-f="done">Done</button><button data-f="all">All</button></span><button class="x" aria-label="Close the list">×</button></div><div class="bd"></div>');
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Note");
  list.setAttribute("role", "dialog");
  list.setAttribute("aria-label", "Notes in this book");
  for (const b of [btn, pbtn]) { b.setAttribute("aria-pressed", "false"); b.title = "Notes for the DM (N)"; b.addEventListener("click", () => setMode(!on)); }
  banner.hidden = chip.hidden = card.hidden = list.hidden = true;
  stage.append(btn, banner, chip, card, list);
  ctx.pbar.append(pbtn);
  root.classList.add("has-notes");

  function setStatus(s) {
    status = s;
    banner.querySelector(".st").textContent = s;
    for (const b of [btn, pbtn]) b.title = s || "Notes for the DM (N)";
  }
  function counts() {
    const k = notes.filter(isOpen).length;
    for (const b of [btn, pbtn]) { const c = b.querySelector("b"); c.hidden = !k; c.textContent = String(k); }
  }

  /* ---- one subscription, from the start; a 10 s limit on loading ---- */
  const timer = setTimeout(() => { if (!loaded) setStatus(notes.length ? "Notes may be out of date" : "Notes can't be reached right now"); }, 10000);
  const unsubscribe = col.where("book", "==", ctx.volume).onSnapshot((snap) => {
    notes = snap.docs.map((d) => ({ ...d.data(), id: d.id }))
      .sort((a, b) => String(a.created || "").localeCompare(String(b.created || "")) || (a.id < b.id ? -1 : 1));
    num = new Map(notes.map((n, i) => [n.id, i + 1]));
    loc = new Map(notes.map((n) => [n.id, locate(n)]));
    if (!snap.metadata?.fromCache && !loaded) { loaded = true; clearTimeout(timer); setStatus(""); }
    counts();
    if (!on) return;
    renderMarks();
    if (!list.hidden) renderList();
    if (cur?.note) {
      const fresh = notes.find((n) => n.id === cur.note.id);
      if (!fresh) closeCard();
      else if (!cur.editing) { cur.note = fresh; drawCard(); }
    }
  }, (e) => {
    loaded = true;
    clearTimeout(timer);
    setStatus(e?.code === "unavailable" ? "Notes can't be reached right now" : `Notes stopped updating (${e?.code || "error"})`);
  });

  /* ---- notes mode ---- */
  function setMode(v) {
    if (v === on) return;
    on = v;
    root.classList.toggle("is-notes", on);
    for (const b of [btn, pbtn]) b.setAttribute("aria-pressed", String(on));
    banner.hidden = !on;
    if (on) {
      banner.querySelector(".t").textContent = ctx.mode() === "single"
        ? "Notes: long-press text or tap a picture · tap Notes to stop"
        : "Notes: select text or click a picture to leave a note · Esc to exit";
      ac = new AbortController();
      const o = { signal: ac.signal }, oc = { signal: ac.signal, capture: true };
      document.addEventListener("selectionchange", onSelection, o);
      book.addEventListener("click", onBookClick, oc);
      ctx.mapEl?.addEventListener("click", onMapClick, oc);
      ctx.whoRow?.addEventListener("click", onWhoClick, oc);
      ctx.psheet?.addEventListener("click", onWhoClick, oc);
      addEventListener("keydown", onKey, oc);
      addEventListener("resize", () => { shown = []; frame(); }, o);
      shown = [];
      frame();
    } else {
      ac.abort();
      ac = null;
      closeCard();
      closeList();
      chip.hidden = true;
      clearTimeout(markTimer);
      for (const l of book.querySelectorAll(".tj-nl")) l.remove();
      const sel = getSelection();
      if (sel && !sel.isCollapsed && book.contains(sel.anchorNode)) sel.removeAllRanges();
    }
  }
  addEventListener("keydown", (e) => {   // N toggles notes mode
    if ((e.key !== "n" && e.key !== "N") || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]") || ctx.overlayOpen()) return;
    e.preventDefault();
    setMode(!on);
  });
  banner.querySelector(".x").addEventListener("click", () => setMode(false));
  banner.querySelector(".ls").addEventListener("click", () => (list.hidden ? openList() : closeList()));
  function onKey(e) {
    if (e.key !== "Escape" || ctx.overlayOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    if (!card.hidden) closeCard();
    else if (!list.hidden) closeList();
    else setMode(false);
  }

  /* ---- marks on the visible pages: pencil underlines and numbered pins; redrawn once a spread settles ---- */
  let shown = [], dirty = false, markTimer = 0, flash = null;
  function frame() {   // (the engine calls this from every update; a no-op outside notes mode)
    if (!on) return;
    const f = ctx.visibleFaces();
    if (f.length !== shown.length || f.some((x, i) => x !== shown[i])) { shown = f; dirty = true; chip.hidden = true; }
    if (dirty && ctx.atRest()) { dirty = false; clearTimeout(markTimer); markTimer = setTimeout(renderMarks, 60); }
  }
  const idxCache = new WeakMap();
  function textIndex(pg) {   // a page element's collapsed text, and where each of its characters lives in the DOM
    let x = idxCache.get(pg);
    if (x) return x;
    x = { T: "", nodes: [], offs: [] };
    const w = document.createTreeWalker(pg, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      const v = t.nodeValue;
      for (let k = 0; k < v.length; k++) {
        if (/\s/.test(v[k])) { if (x.T.endsWith(" ")) continue; x.T += " "; } else x.T += v[k];
        x.nodes.push(t);
        x.offs.push(k);
      }
    }
    idxCache.set(pg, x);
    return x;
  }
  function rangeIn(pg, n) {
    const { T, nodes, offs } = textIndex(pg);
    const a = findQuote(T, n);
    if (a < 0) return null;
    const b = a + n.quote.length - 1, r = document.createRange();
    r.setStart(nodes[a], offs[a]);
    r.setEnd(nodes[b], offs[b] + 1);
    return r;
  }
  function renderMarks() {
    clearTimeout(markTimer);
    if (!on) return;
    if (!ctx.atRest()) { dirty = true; return; }
    for (const l of book.querySelectorAll(".tj-nl")) l.remove();
    for (const face of ctx.visibleFaces()) {
      const i = +face.dataset.idx, pg = face.querySelector(".tj-page");
      const L = mk("div", "tj-nl");
      face.append(L);
      const fr = face.getBoundingClientRect(), W = face.offsetWidth || 1, k = fr.width / W;
      const X = (x) => (x - fr.left) / k, Y = (y) => (y - fr.top) / k;
      const outerLeft = ctx.mode() === "double" && face.classList.contains("is-left");
      const used = [];
      const free = (y) => {   // pins in the margin don't sit on each other
        for (let moved = true; moved;) { moved = false; for (const u of used) if (Math.abs(u - y) < 23) { y = u + 23; moved = true; } }
        used.push(y);
        return y;
      };
      let tops = 0;
      for (const n of notes) {
        if (loc.get(n.id)?.page !== i || !["text", "image", "page"].includes(n.kind)) continue;
        const st = STATUS_LABEL[n.status] ? n.status : "open";
        let x = null, y = null;
        if (n.kind === "text") {
          const r = loc.get(n.id).ok ? rangeIn(pg, n) : null;
          const lines = r ? lineBoxes(r) : [];
          lines.forEach((ln, j) => {
            const u = mk("i", `tj-nu is-${st}`);
            u.style.cssText = `left:${X(ln.l).toFixed(1)}px;top:${(Y(ln.b) - (ln.b - ln.t) / k * 0.16).toFixed(1)}px;width:${((ln.r - ln.l) / k).toFixed(1)}px;--r:${((j % 3) - 1) * 0.25}deg`;
            L.append(u);
          });
          if (lines.length) { x = outerLeft ? 8 : W - 34; y = free(Y(lines[0].t) - 1); }
        } else if (n.kind === "image") {
          const pic = [...pg.querySelectorAll("img[data-asset], .tj-ph[data-asset]")].find((e) => e.dataset.asset === n.asset);
          if (pic) { const pr = pic.getBoundingClientRect(); x = X(pr.right) - 15; y = Y(pr.top) - 9; }
        }
        if (x === null) { x = W / 2 - 60 + 26 * tops++; y = 9; }   // page notes (and notes whose text has gone): along the top
        const pin = mk("button", `tj-npin is-${st}${flash === n.id ? " is-flash" : ""}`, String(num.get(n.id)));
        pin.dataset.id = n.id;
        pin.style.left = `${x.toFixed(1)}px`;
        pin.style.top = `${y.toFixed(1)}px`;
        pin.setAttribute("aria-label", `Note ${num.get(n.id)} (${STATUS_LABEL[st]}): ${clip(String(n.note || ""), 80)}`);
        L.append(pin);
      }
      const add = mk("button", "tj-npage", "Note on this page");
      add.dataset.idx = String(i);
      L.append(add);
    }
    flash = null;
  }

  /* ---- new notes: a text selection (+ Note chip), a picture, a page, the map, a cast card ---- */
  let selRaf = 0;
  function onSelection() { cancelAnimationFrame(selRaf); selRaf = requestAnimationFrame(updateChip); }
  function selAnchor() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    const pgOf = (nd) => (nd.nodeType === 1 ? nd : nd.parentElement)?.closest?.(".tj-page");
    const pg = pgOf(r.startContainer), face = pg?.closest(".tj-face--page");
    if (!pg || pg !== pgOf(r.endContainer) || !book.contains(pg) || face?.dataset.idx == null) return null;
    const pre = document.createRange();
    pre.selectNodeContents(pg);
    pre.setEnd(r.startContainer, r.startOffset);
    let a = norm(pre.toString()).length;
    pre.setEnd(r.endContainer, r.endOffset);
    let b = norm(pre.toString()).length;
    const T = textIndex(pg).T;
    while (a < b && T[a] === " ") a++;
    while (b > a && T[b - 1] === " ") b--;
    if (b <= a) return null;
    b = Math.min(b, a + QUOTE_MAX);
    return { r, idx: +face.dataset.idx, quote: T.slice(a, b), before: T.slice(Math.max(0, a - CTX), a), after: T.slice(b, b + CTX) };
  }
  let chipFor = null;
  function updateChip() {
    chipFor = card.hidden || !cur?.draft ? selAnchor() : null;
    chip.hidden = !chipFor;
    if (!chipFor) return;
    const rs = chipFor.r.getClientRects(), last = rs[rs.length - 1] || chipFor.r.getBoundingClientRect();
    const st = stage.getBoundingClientRect();
    chip.style.left = `${Math.round(clampN(last.right - st.left + 4, 8, st.width - chip.offsetWidth - 8))}px`;
    chip.style.top = `${Math.round(clampN(last.bottom - st.top + (ctx.mode() === "single" ? 30 : 6), 8, st.height - chip.offsetHeight - 8))}px`;
  }
  chip.addEventListener("pointerdown", (e) => e.preventDefault());   // keep the selection
  chip.addEventListener("click", () => {
    const s = chipFor || selAnchor();
    if (!s) return;
    openCard({ draft: { kind: "text", ...base(s.idx), quote: s.quote, before: s.before, after: s.after } }, chip);
    chip.hidden = true;
  });
  function base(i) {
    const f = pages[i], tab = (f.dataset.tab || `Session ${sessOf[i]}`).trim();
    const side = ctx.mode() === "double" ? (f.classList.contains("is-left") ? ", left" : ", right") : "";
    return { book: ctx.volume, page: i, pageKey: keyOf[i], session: `S${sessOf[i]}`, spreadLabel: `${tab} · page ${keyOf[i].split(".")[1]}${side}`, build: ctx.build };
  }
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  function onBookClick(e) {
    if (!ctx.atRest()) return;   // (a tap on a corner has just started a turn)
    const t = e.target;
    const pin = t.closest?.(".tj-npin");
    if (pin) { stop(e); const n = notes.find((x) => x.id === pin.dataset.id); if (n) openCard({ note: n }, pin); return; }
    const pl = t.closest?.(".tj-npage");
    if (pl) { stop(e); openCard({ draft: { kind: "page", ...base(+pl.dataset.idx) } }, pl); return; }
    const pic = t.closest?.(".tj-page img[data-asset], .tj-page .tj-ph");
    if (!pic || !getSelection().isCollapsed) return;
    stop(e);
    const face = pic.closest(".tj-face--page");
    const alt = pic.tagName === "IMG" ? pic.alt : pic.textContent.trim();
    openCard({ draft: { kind: "image", ...base(+face.dataset.idx), asset: pic.dataset.asset || "", alt: alt || "" } }, pic);
  }
  function onMapClick(e) {
    stop(e);
    const m = ctx.mapSheet();
    openCard({ draft: { kind: "map", ...base(ctx.currentPage()), sheet: m.key, sheetTitle: m.title } }, ctx.mapEl);
  }
  function onWhoClick(e) {
    const c = e.target.closest?.(".tj-who-c, .tj-pcard[data-who]");
    const who = c?._who ? { id: c._who.id, name: c._who.name } : c?.dataset.who ? { id: c.dataset.who, name: c.dataset.name } : null;
    if (!who) return;
    stop(e);
    if (c.closest(".tj-psheet")) ctx.psShut();
    openCard({ draft: { kind: "cast", ...base(ctx.currentPage()), character: who.id, name: who.name || who.id } }, c);
  }

  /* ---- the card: a paper slip ---- */
  const what = (n) => n.kind === "text" ? `“${clip(n.quote || "", 150)}”`
    : n.kind === "image" ? `the picture${n.alt ? `: ${clip(n.alt.replace(/^[^:]{0,40}:\s*/, ""), 90)}` : ""}`
    : n.kind === "map" ? `the map (${n.sheetTitle || n.sheet || "?"})`
    : n.kind === "cast" ? `${n.name || n.character} (who's who)`
    : `this page (${n.spreadLabel || n.pageKey})`;
  function openCard(state, anchor) {
    cur = { editing: !!state.draft, confirm: false, ...state };
    card.hidden = false;
    drawCard();
    if (ctx.mode() === "single") card.style.left = card.style.top = "";
    else {
      const st = stage.getBoundingClientRect(), r = anchor.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight;
      const below = r.bottom - st.top + 10, above = r.top - st.top - h - 10;
      card.style.left = `${Math.round(clampN(r.left - st.left - 10, 8, st.width - w - 8))}px`;
      card.style.top = `${Math.round(clampN(below + h <= st.height - 8 || above < 8 ? below : above, 8, st.height - h - 8))}px`;
    }
    (card.querySelector("textarea") || card.querySelector("button"))?.focus({ preventScroll: true });
  }
  function closeCard() {
    cur = null;
    card.hidden = true;
    card.replaceChildren();
  }
  function drawCard() {
    const n = cur.note || cur.draft;
    card.replaceChildren();
    const h = mk("div", "h");
    h.append(mk("span", "k", cur.note ? `Note ${num.get(n.id) ?? ""} on ` : "A note on "), mk("span", "w"));
    h.lastChild.textContent = what(n);
    card.append(h);
    if (cur.editing) {
      const ta = mk("textarea");
      ta.rows = 4;
      ta.placeholder = "What should change?";
      ta.value = cur.note ? String(cur.note.note || "") : "";
      ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(ta.value); } });
      const a = mk("div", "a");
      const ok = mk("button", "ok", "Save"), no = mk("button", "", "Cancel");
      ok.addEventListener("click", () => save(ta.value));
      no.addEventListener("click", () => (cur.note ? ((cur.editing = false), drawCard()) : closeCard()));
      a.append(ok, no, mk("small", "", "Ctrl+Enter saves · Esc cancels"));
      card.append(ta, a);
    } else {
      const st = STATUS_LABEL[n.status] ? n.status : "open";
      const tx = mk("p", "tx");
      tx.textContent = String(n.note || "");
      const meta = mk("div", "st");
      for (const s of Object.keys(STATUS_LABEL)) {
        const b = mk("button", `is-${s}`, STATUS_LABEL[s]);
        b.setAttribute("aria-pressed", String(s === st));
        b.addEventListener("click", () => { if (s !== st) change(n.id, () => db.doc(`feedback/${n.id}`).update({ status: s, updated: new Date().toISOString() })); });
        meta.append(b);
      }
      card.append(tx, meta);
      if (n.reply) {
        const rp = mk("div", "rp", "<b>Reply</b>");
        rp.append(mk("p"));
        rp.lastChild.textContent = String(n.reply);
        card.append(rp);
      }
      if (n.kind === "text" && loc.get(n.id)?.ok === false) card.append(mk("p", "lost", "The text has changed since this note."));
      const a = mk("div", "a");
      if (cur.confirm) {
        const yes = mk("button", "del", "Delete"), keep = mk("button", "", "Keep");
        yes.addEventListener("click", async () => { if (await change(n.id, () => db.doc(`feedback/${n.id}`).delete())) closeCard(); });
        keep.addEventListener("click", () => { cur.confirm = false; drawCard(); });
        a.append(mk("span", "q", "Delete this note?"), yes, keep);
      } else {
        const ed = mk("button", "", "Edit"), del = mk("button", "", "Delete"), cl = mk("button", "", "Close");
        ed.addEventListener("click", () => { cur.editing = true; drawCard(); card.querySelector("textarea")?.focus(); });
        del.addEventListener("click", () => { cur.confirm = true; drawCard(); });
        cl.addEventListener("click", closeCard);
        a.append(ed, del, cl);
      }
      card.append(a);
    }
    card.append(mk("p", "err"));
    card.lastChild.setAttribute("aria-live", "polite");
    card.classList.toggle("is-busy", busy.size > 0);
  }
  const setErr = (s) => { const e = card.querySelector(".err"); if (e) e.textContent = s; };
  async function change(id, fn) {   // one write at a time per document
    if (busy.has(id)) return false;
    busy.add(id);
    card.classList.add("is-busy");
    for (const b of card.querySelectorAll("button")) b.disabled = true;
    setErr("");
    try {
      await attempt(fn);
      return true;
    } catch (e) {
      setErr(ERRORS[e?.code] || `That didn't work (${e?.message || e?.code || "unknown error"}).`);
      return false;
    } finally {
      busy.delete(id);
      card.classList.toggle("is-busy", busy.size > 0);
      for (const b of card.querySelectorAll("button")) b.disabled = false;
    }
  }
  async function save(text) {
    text = text.trim();
    if (!text) { setErr("Write something first."); return; }
    const now = new Date().toISOString();
    if (cur.note) {
      const id = cur.note.id;
      if (text === cur.note.note) { cur.editing = false; drawCard(); return; }
      if (await change(id, () => db.doc(`feedback/${id}`).update({ note: text, updated: now })) && cur?.note?.id === id) { cur.editing = false; cur.note = { ...cur.note, note: text }; drawCard(); }
    } else {
      const ref = col.doc();   // one id for the create and its retry
      const body = { ...cur.draft, note: text, status: "open", reply: "", created: now, updated: now };
      if (await change(ref.id, () => ref.set(body))) {
        closeCard();
        const sel = getSelection();
        if (sel && book.contains(sel.anchorNode)) sel.removeAllRanges();
      }
    }
  }

  /* ---- the list: every note in this book, by session ---- */
  let filt = "open";
  for (const b of list.querySelectorAll(".f button")) b.addEventListener("click", () => { filt = b.dataset.f; renderList(); });
  list.querySelector(".x").addEventListener("click", closeList);
  function openList() { list.hidden = false; renderList(); list.querySelector(".f button")?.focus({ preventScroll: true }); }
  function closeList() { list.hidden = true; list.querySelector(".bd").replaceChildren(); }
  function renderList() {
    const bd = list.querySelector(".bd");
    bd.replaceChildren();
    for (const b of list.querySelectorAll(".f button")) b.setAttribute("aria-pressed", String(b.dataset.f === filt));
    const pick = notes.filter((n) => filt === "all" || (filt === "open") === isOpen(n))
      .sort((a, b) => loc.get(a.id).page - loc.get(b.id).page || num.get(a.id) - num.get(b.id));
    if (!pick.length) bd.append(mk("p", "empty", filt === "open" ? "No open notes." : "Nothing here."));
    let group = null;
    for (const n of pick) {
      const L = loc.get(n.id), g = (pages[L.page]?.dataset.tab || `Session ${sessOf[L.page]}`).split("·")[0].trim();
      if (g !== group) { group = g; bd.append(mk("h4", "", "")); bd.lastChild.textContent = g; }
      const st = STATUS_LABEL[n.status] ? n.status : "open";
      const it = mk("button", `it is-${st}`);
      it.append(mk("span", "n", String(num.get(n.id))), mk("span", "w"), mk("span", "tx"));
      it.children[1].textContent = what(n);
      it.children[2].textContent = clip(String(n.note || ""), 140);
      if (n.kind === "text" && !L.ok) it.append(mk("span", "lost", "text changed since"));
      if (n.reply) it.append(mk("span", "re", "replied"));
      it.addEventListener("click", () => {
        flash = n.id;
        if (ctx.mode() === "single") closeList();
        ctx.jumpToPage(L.page);
        shown = [];
        frame();
      });
      bd.append(it);
    }
  }

  return {
    frame,
    setMode,
    isOn: () => on,
    status: () => status,
    notes: () => notes.map((n) => ({ ...n, located: loc.get(n.id) })),
    pageKey: (i) => keyOf[i],
    stop: () => { unsubscribe(); setMode(false); },
  };
}
/* Chult Journal — scroll-driven book on a desk.
 *
 *   mountJournal(rootEl, { pagesHtml, route, assets?, assetBase? })
 *
 * The book is modelled as leaves. Each leaf has a front (right-hand face while unturned) and a back
 * (left-hand face once turned). Scrolling walks through one segment per leaf: the current spread holds
 * for most of the segment, then the leaf turns: paper folds from its bottom corner (2D clip-path fold),
 * the covers flip rigidly. Only three slots exist in the DOM at any time: the left page, the page under
 * the turning leaf, and the turning leaf itself (built from clones), so the engine stays cheap no matter
 * how long the book is, and nothing runs while the reader isn't scrolling.
 */

const PAGE_W = 560;
const PAGE_H = 780;
const BOARD = 14;
// screen px kept free for the HUD: session + date (top left), the place (bottom right) above the progress bar;
// design px the bookmark slips stand above the pages (the HUD must clear them)
const HUD_TOP = 54, HUD_BOTTOM = 32, TABS_UP = 78;
// desktop UI scale (DM round 28: "the UI could be larger, I always had Firefox at 120%"): the book may grow 20% further on
// big screens, and the HUD text is drawn 20% larger (--tj-ui in journal.css)
const UI = 1.2;
// Each spread rests LEAD (viewport heights) into its segment; O_F is how far a hovered corner lifts (book px).
const LEAD = 0.24, O_F = [-82, -62];
const SINGLE_BP = 760;
const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Kalam:wght@300;400;700&family=Sue+Ellen+Francisco&family=Annie+Use+Your+Telescope&family=Covered+By+Your+Grace&family=Cedarville+Cursive&family=IM+Fell+English:ital@0;1&family=IM+Fell+English+SC&family=Uncial+Antiqua&family=Reenie+Beanie&family=Cinzel+Decorative:wght@700&display=swap";

/* Oliver's handwriting. Sizes give every hand Kalam's x-height at 19.5px, so pages keep the same fill.
   `bold: false` = the font has no bold; heavier words are written by "pressing harder" (ink spread) instead. */
const HANDS = {
  sue: { family: '"Sue Ellen Francisco"', size: 26, lh: 1.3, bold: false },
  annie: { family: '"Annie Use Your Telescope"', size: 20.7, lh: 1.34, bold: false },
  kalam: { family: "Kalam", size: 19.5, lh: 1.32, bold: true },
};
const OLIVER_HAND = "annie"; // one-line switch: "sue" (runner-up, more characterful; pages 4, 5, 14 overflow) or "kalam" (previous)

/* Where the light comes from in each desk environment (matches the env_<key> images). */
/* x/y: where the light source sits in the env image; c: its colour; glow: strength of the warm pool;
   amb: colour of the darkness gathering away from the light (r,g,b). The light is static (no animation: a moving
   light re-composites the whole screen every frame). `flicker` is kept as a description of the source only. */
const ENV_LIGHT = {
  ship:      { x: "21%", y: "17%", c: "255,186,105", flicker: "lamp" },
  tavern:    { x: "89%", y: "19%", c: "255,196,120", flicker: "lamp" },
  terrace:   { x: "80%", y: "4%",  c: "255,236,200", flicker: "none", glow: 0.1 },
  riverboat: { x: "58%", y: "16%", c: "185,255,222", flicker: "soft", glow: 0.24, amb: "6,12,10" },
  tent:      { x: "74%", y: "15%", c: "255,186,105", flicker: "lamp" },
  fort:      { x: "14%", y: "12%", c: "255,184,100", flicker: "lamp" },
  camp:      { x: "91%", y: "80%", c: "255,140,60", flicker: "fire", glow: 0.26 },
  stilts:    { x: "16%", y: "15%", c: "255,190,112", flicker: "soft" },
  heart:     { x: "79%", y: "82%", c: "255,192,118", flicker: "soft", amb: "6,12,18" },
  mbala:     { x: "12%", y: "13%", c: "255,196,125", flicker: "gutter" },
  inn:       { x: "80%", y: "10%", c: "246,236,214", flicker: "none", glow: 0.12 },
  workshop:  { x: "12%", y: "10%", c: "255,184,104", flicker: "lamp" },
  rooftop:   { x: "88%", y: "80%", c: "255,180,100", flicker: "lamp", amb: "6,10,22" },
  howdah:    { x: "60%", y: "8%",  c: "255,236,196", flicker: "none", glow: 0.12 },
  treehouse: { x: "27%", y: "15%", c: "196,222,255", flicker: "soft", amb: "6,10,18" },
  firefinger:{ x: "23%", y: "12%", c: "255,186,108", flicker: "lamp", amb: "8,12,18" },
  kirsabal:  { x: "14%", y: "71%", c: "255,178,98",  flicker: "lamp", amb: "5,8,20" },
  nangalore: { x: "11%", y: "18%", c: "255,198,132", flicker: "soft", amb: "6,12,12" },
  forge:     { x: "95%", y: "91%", c: "255,138,58", flicker: "fire", glow: 0.24 },
  safehouse: { x: "16%", y: "18%", c: "255,204,138", flicker: "lamp", amb: "6,10,8" },
  ruin:      { x: "12%", y: "48%", c: "255,184,106", flicker: "gutter", amb: "5,8,22" },
  // Book II
  a_fane:    { x: "88%", y: "14%", c: "255,122,72", flicker: "lamp", amb: "4,10,8" },
  a_thayan:  { x: "12%", y: "81%", c: "255,196,122", flicker: "lamp", amb: "8,8,12" },
  b_tomb:    { x: "9%",  y: "83%", c: "255,186,110", flicker: "gutter", amb: "6,10,12" },
  b_vault:   { x: "50%", y: "8%",  c: "255,214,160", flicker: "soft", glow: 0.18, amb: "8,6,6" },
  c_gears:   { x: "14%", y: "81%", c: "255,188,112", flicker: "gutter", amb: "6,8,12" },
  c_home:    { x: "50%", y: "0%",  c: "255,226,184", flicker: "none", glow: 0.12 },
};

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
/* CSS-style cubic-bezier(x1, y1, x2, y2) as a function of x */
function cubicBezier(x1, y1, x2, y2) {
  const bx = (t) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; (bx(mid) < x ? (lo = mid) : (hi = mid)); }
    return by((lo + hi) / 2);
  };
}
/* the weight of a page: the corner lifts slowly, the flap travels a little faster once past vertical,
   then settles softly onto the left page */
const turnEase = cubicBezier(0.6, 0.02, 0.32, 1);
const liftEase = cubicBezier(0.3, 0.32, 0.25, 1);   // wheel / swipe turns: the corner rises at once, then the page sweeps over
const rad = (d) => (d * Math.PI) / 180;

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
/* write-if-changed: Firefox invalidates (and repaints) on every style write, even an identical one */
const _seen = new WeakMap();
function setVar(node, name, value) {
  let m = _seen.get(node);
  if (!m) _seen.set(node, (m = new Map()));
  if (m.get(name) === value) return;
  m.set(name, value);
  if (name.startsWith("--")) node.style.setProperty(name, value);
  else node.style[name] = value;
}
function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
function setHidden(node, h) { if (node.hidden !== h) node.hidden = h; }
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

/* ------------------------------------------------------------------ assets */

function makeResolver(assets, base) {
  const cache = new Map();
  return (key, { pm = false } = {}) => {
    if (assets && pm && assets[`pm/${key}`]) return Promise.resolve(assets[`pm/${key}`]);
    if (assets && assets[key]) return Promise.resolve(assets[key]);
    if (assets) return Promise.resolve(null);   // a built file carries everything it has: never fetch
    if (!cache.has(key + pm)) {
      cache.set(
        key + pm,
        (async () => {
          const exts = ["webp", "jpg", "png"];
          for (const ext of pm ? [...exts.map((e) => `pm/${key}.${e}`), ...exts.map((e) => `${key}.${e}`)] : exts.map((e) => `${key}.${e}`)) {
            const url = `${base}${ext}`;
            try {
              const r = await fetch(url, { method: "HEAD" });
              if (r.ok) return url;
            } catch {
              /* try next */
            }
          }
          return null;
        })(),
      );
    }
    return cache.get(key + pm);
  };
}

/* ------------------------------------------------------------------ textures */
/* Paper grain, fibres and leather as small raster tiles made once on a canvas. SVG feTurbulence backgrounds look
   the same but are re-rasterized by some engines (Firefox) whenever a tile repaints — very slow during a turn. */
function makeTextures(root) {
  const canvases = [];
  const tile = (w, h, paint) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(w, h);
    paint(img.data, w, h);
    ctx.putImageData(img, 0, 0);
    canvases.push(c);
    return `url("${c.toDataURL("image/png")}")`;
  };
  const r = seeded(4242);
  // value noise, smoothed: a few octaves of random lattices, tileable
  const octave = (w, h, cell) => {
    const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell), g = Array.from({ length: gw * gh }, () => r());
    const at = (x, y) => g[((y % gh) + gh) % gh * gw + (((x % gw) + gw) % gw)];
    return (x, y) => {
      const fx = x / cell, fy = y / cell, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx, b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      return a + (b - a) * sy;
    };
  };
  const grain = tile(256, 256, (d, w, h) => {
    const o1 = octave(w, h, 1.4), o2 = octave(w, h, 6);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = 0.75 * o1(x, y) + 0.25 * o2(x, y), i = (y * w + x) * 4;
      d[i] = 90; d[i + 1] = 64; d[i + 2] = 36; d[i + 3] = Math.round(Math.max(0, v - 0.45) * 34);
    }
  });
  const fibre = tile(512, 512, (d, w, h) => {
    const o = octave(w, h, 16), fine = octave(w, h, 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = o(x * 0.35, y * 1.6) * 0.7 + fine(x, y) * 0.3, i = (y * w + x) * 4;
      d[i] = 115; d[i + 1] = 84; d[i + 2] = 46; d[i + 3] = Math.round(Math.max(0, v - 0.6) * 28);
    }
  });
  const leather = tile(300, 300, (d, w, h) => {
    const a = octave(w, h, 3), b = octave(w, h, 11), c = octave(w, h, 37);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = 0.5 * a(x, y) + 0.3 * b(x, y) + 0.2 * c(x, y), i = (y * w + x) * 4;
      const lit = v > 0.5 ? 1 : 0;
      d[i] = lit ? 217 : 20; d[i + 1] = lit ? 168 : 12; d[i + 2] = lit ? 115 : 6; d[i + 3] = Math.round(Math.abs(v - 0.5) * 2 * 70);
    }
  });
  root.style.setProperty("--tj-grain", grain);
  root.style.setProperty("--tj-fibre", fibre);
  root.style.setProperty("--tj-leather-grain", leather);
  // soft shadow under the turning flap: a blurred rectangle, rasterized once
  const sc = document.createElement("canvas");
  sc.width = 164; sc.height = 218;
  const sx = sc.getContext("2d");
  sx.shadowColor = "rgba(26,14,4,.62)"; sx.shadowBlur = 11; sx.shadowOffsetX = 10000;
  sx.fillRect(12 - 10000, 12, 140, 194);
  root.style.setProperty("--tj-softshadow", `url("${sc.toDataURL("image/png")}")`);
  return canvases.slice(0, 2);  // grain + fibre canvases (for the page bitmaps)
}

/* One bitmap per page background (paper colour, light falloff, gutter, grain, fibres, foxing, worn edge):
   a page is then a single image plus text, cheap to move in every engine. A few variants per side. */
function makePapers(texCanvas, theme = "") {
  const W = PAGE_W, H = PAGE_H, out = { left: [], right: [] };
  // Book II is written on Thayan paper taken from the Red Wizards: a greyer, rosier, coarser stock with visible fibres
  // Book III (the DM's notes) is a gridded vellum notebook: cooler, smoother, a faint blue-grey grid
  const T = theme === "thayan" ? { base: "#e8d6bf", light: "rgba(252,240,226,.4)", fox: "120,52,36", gut: "84,40,30", rim: "rgba(105,55,40,.24)", burn: "rgba(112,50,36,.2)" }
    : theme === "dm" ? { base: "#ebe8dc", light: "rgba(255,255,250,.45)", fox: "120,104,78", gut: "70,68,60", rim: "rgba(90,88,78,.2)", burn: "rgba(92,86,70,.13)" }
    : { base: "#efe4cb", light: "rgba(255,250,235,.5)", fox: "140,90,40", gut: "90,60,25", rim: "rgba(110,80,40,.22)", burn: "rgba(120,80,30,.16)" };
  for (const side of ["left", "right"]) {
    for (let v = 0; v < 4; v++) {
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const g = c.getContext("2d");
      g.fillStyle = T.base; g.fillRect(0, 0, W, H);
      const hl = g.createRadialGradient(W * 0.5, H * 0.45, 20, W * 0.5, H * 0.45, W * 0.9);
      hl.addColorStop(0, T.light); hl.addColorStop(1, T.light.replace(/[\d.]+\)$/, "0)"));
      g.fillStyle = hl; g.fillRect(0, 0, W, H);
      for (const t of texCanvas) { g.fillStyle = g.createPattern(t, "repeat"); g.fillRect(0, 0, W, H); }
      if (theme === "thayan") thayanFibres(g, W, H, seeded(5000 + v * 31 + (side === "left" ? 1 : 2)), texCanvas[0]);
      if (theme === "dm") { g.save(); g.strokeStyle = "rgba(70,105,140,.11)"; g.lineWidth = 1;
        for (let x = 13.5; x < W; x += 18) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
        for (let y = 15.5; y < H; y += 18) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
        g.restore(); }
      const r = seeded(1000 + v * 77 + (side === "left" ? 3 : 9));
      for (let i = 0, n = 3 + Math.floor(r() * 4); i < n; i++) {     // foxing
        const x = r() * W, y = r() * H, rad = 4 + r() * 18, a = 0.04 + r() * 0.07;
        const f = g.createRadialGradient(x, y, 0, x, y, rad);
        f.addColorStop(0, `rgba(${T.fox},${a})`); f.addColorStop(1, `rgba(${T.fox},0)`);
        g.fillStyle = f; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      }
      const gx = side === "right" ? 0 : W;                              // gutter
      const gut = g.createLinearGradient(gx, 0, side === "right" ? W * 0.13 : W * 0.87, 0);
      gut.addColorStop(0, `rgba(${T.gut},.32)`); gut.addColorStop(0.38, `rgba(${T.gut},.10)`); gut.addColorStop(1, `rgba(${T.gut},0)`);
      g.fillStyle = gut; g.fillRect(0, 0, W, H);
      g.strokeStyle = T.rim; g.lineWidth = 2; g.strokeRect(1, 1, W - 2, H - 2);
      const edge = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.42, W / 2, H / 2, Math.max(W, H) * 0.62);
      edge.addColorStop(0, T.burn.replace(/[\d.]+\)$/, "0)")); edge.addColorStop(1, T.burn);
      g.fillStyle = edge; g.fillRect(0, 0, W, H);
      out[side].push(`url("${c.toDataURL("image/jpeg", 0.9)}")`);
    }
  }
  return out;
}

// coarser stock: the grain once more, offset, and short fibres pressed into the sheet (a few pale, most rust-grey)
function thayanFibres(g, W, H, r, grain) {
  g.save();
  g.translate(97, 53); g.globalAlpha = 0.55; g.fillStyle = g.createPattern(grain, "repeat"); g.fillRect(-97, -53, W, H);
  g.restore();
  g.save(); g.lineCap = "round";
  for (let i = 0; i < 460; i++) {
    const x = r() * W, y = r() * H, len = 6 + r() * r() * 30, a = r() * Math.PI * 2, bend = (r() - 0.5) * len * 0.6;
    const pale = r() < 0.22;
    g.strokeStyle = pale ? `rgba(255,246,232,${(0.4 + r() * 0.3).toFixed(2)})` : `rgba(${r() < 0.5 ? "120,58,44" : "92,78,70"},${(0.1 + r() * 0.12).toFixed(3)})`;
    g.lineWidth = 0.6 + r() * 0.8;
    const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo((x + ex) / 2 - Math.sin(a) * bend, (y + ey) / 2 + Math.cos(a) * bend, ex, ey); g.stroke();
  }
  g.restore();
}

/* ------------------------------------------------------------------ doodles */

function wobblyLine(r, pts, amp = 1.2) {
  let d = `M${pts[0][0] + (r() - 0.5) * amp},${pts[0][1] + (r() - 0.5) * amp}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const mx = (x0 + x1) / 2 + (r() - 0.5) * amp * 2;
    const my = (y0 + y1) / 2 + (r() - 0.5) * amp * 2;
    d += ` Q${mx.toFixed(1)},${my.toFixed(1)} ${(x1 + (r() - 0.5) * amp).toFixed(1)},${(y1 + (r() - 0.5) * amp).toFixed(1)}`;
  }
  return d;
}

const DOODLES = {
  /* Oliver's step-by-step log of the trapped spiral staircase (S5, Camp Righteous statue). */
  stairs(r) {
    const W = 460, H = 250, n = 25;
    const notes = { 3: "ZAP!", 10: "?", 17: "?", 21: "?", 23: "ouch", 24: "ouch" };
    const stepW = (W - 70) / n, stepH = (H - 70) / n;
    const x0 = 30, y0 = H - 30;
    const pts = [[x0, y0]];
    for (let i = 0; i < n; i++) {
      const x = x0 + i * stepW, y = y0 - i * stepH;
      pts.push([x, y - stepH], [x + stepW, y - stepH]);
    }
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sketch of a 25-step staircase: step 3 zapped, steps 10, 17 and 21 unknown, steps 23 and 24 hurt">`;
    const ink = "#3a2413";
    svg += `<path d="${wobblyLine(r, pts, 1.3)}" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    // hand-hatched underside
    for (let i = 0; i < n; i += 2) {
      const x = x0 + i * stepW + 4, y = y0 - i * stepH;
      svg += `<path d="${wobblyLine(r, [[x, y + 2], [x + 10, y + 12]], 0.6)}" stroke="${ink}" stroke-width="1" opacity=".45" fill="none"/>`;
    }
    const font = `font-family="Kalam, cursive" fill="${ink}"`;
    for (let i = 1; i <= n; i++) {
      const cx = x0 + (i - 1) * stepW + stepW / 2, cy = y0 - i * stepH;
      if (i === 1 || i % 5 === 0) svg += `<text x="${cx}" y="${cy + 22}" font-size="13" ${font} text-anchor="middle" opacity=".7">${i}</text>`;
      const note = notes[i];
      if (!note) continue;
      if (i === 24) continue;
      if (note === "ZAP!") {
        svg += `<path d="M${cx - 4},${cy - 40} l9,10 l-7,3 l10,13" fill="none" stroke="#7a1d12" stroke-width="2.2" stroke-linejoin="round"/>`;
        svg += `<text x="${cx + 10}" y="${cy - 44}" font-size="20" ${font} font-weight="700" transform="rotate(-8 ${cx + 10} ${cy - 44})">ZAP!</text>`;
      } else if (note === "?") {
        svg += `<text x="${cx}" y="${cy - 12}" font-size="22" ${font} text-anchor="middle" font-weight="700">?</text>`;
      } else if (i === 23) {
        const cx2 = cx + stepW;
        svg += `<path d="${wobblyLine(r, [[cx - 6, cy - 14], [cx - 6, cy - 22], [cx2 + 6, cy - 22 - stepH], [cx2 + 6, cy - 14 - stepH]], 0.5)}" fill="none" stroke="${ink}" stroke-width="1.4"/>`;
        svg += `<text x="${cx + stepW / 2 - 18}" y="${cy - 34 - stepH}" font-size="21" ${font} font-weight="700" transform="rotate(-6 ${cx} ${cy})">ouch</text>`;
      }
    }
    svg += `<text x="${x0}" y="22" font-size="17" ${font} opacity=".85">the stairs: 25 steps, I counted</text>`;
    svg += `<text x="${x0 + 6}" y="${y0 + 22}" font-size="13" ${font} opacity=".6">(everything else: nothing)</text>`;
    return svg + "</svg>";
  },
};

/* ------------------------------------------------------------------ page building */

function handwrite(scope, seed) {
  const r = seeded(seed);
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (!p || p.closest("svg, figure img, .tj-nowobble")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const inNote = !!node.parentElement.closest("aside.note");
    const amp = inNote ? 0.6 : 1;
    const frag = document.createDocumentFragment();
    for (const part of node.nodeValue.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        frag.append(part);
        continue;
      }
      const s = document.createElement("span");
      s.className = "tj-w";
      s.textContent = part;
      s.style.setProperty("--dy", `${((r() - 0.5) * 2 * amp).toFixed(2)}px`);            // baseline ±1px
      s.style.setProperty("--ls", `${((r() - 0.5) * 0.04 * amp).toFixed(3)}em`);        // spacing ±2%
      s.style.setProperty("--fs", (1 + (r() - 0.5) * 0.04 * amp).toFixed(3));            // size ±2%
      s.style.setProperty("--o", (0.78 + r() * 0.22).toFixed(2));                        // ink density
      frag.append(s);
    }
    node.replaceWith(frag);
  }
}

function foxing(seed) {
  const r = seeded(seed ^ 0x9e3779b9);
  const spots = [];
  const n = 3 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const x = (r() * 100).toFixed(1), y = (r() * 100).toFixed(1);
    const s = (4 + r() * 18).toFixed(1), a = (0.04 + r() * 0.07).toFixed(3);
    spots.push(`radial-gradient(circle at ${x}% ${y}%, rgba(140,90,40,${a}), transparent ${s}px)`);
  }
  // one faint tide-mark ring now and then
  if (r() < 0.3) {
    const x = (10 + r() * 80).toFixed(1), y = (10 + r() * 80).toFixed(1), s = (50 + r() * 60).toFixed(0);
    spots.push(`radial-gradient(circle at ${x}% ${y}%, transparent ${s - 3}px, rgba(130,90,40,.045) ${s}px, transparent ${+s + 4}px)`);
  }
  return spots.join(",");
}

function buildPageFace(section, idx) {
  const face = el("div", "tj-face tj-face--page");
  face.dataset.idx = idx;
  for (const k of ["session", "env", "map", "tab", "vanish", "critter"]) if (section.dataset[k]) face.dataset[k] = section.dataset[k];
  for (const c of section.classList) if (c !== "page") face.classList.add(`is-${c}`);
  if (section.hasAttribute("data-sparse")) face.dataset.sparse = "";
  const start = section.querySelector("[data-session-start]");
  if (start) face.dataset.sessionStart = start.dataset.sessionStart;
  face.id = section.id ? `tj-${section.id}` : "";
  const seed = hash(section.id || `page-${idx}`) + idx;
  for (const im of section.querySelectorAll("img")) im.draggable = false;   // no ghost image when a page is dragged
  face.style.setProperty("--foxing", foxing(seed));
  const page = el("div", "tj-page");
  page.append(...section.childNodes);
  face.append(page);
  for (const d of page.querySelectorAll(".doodle")) {
    const kind = [...d.classList].find((c) => c !== "doodle" && DOODLES[c]);
    if (kind) d.innerHTML = DOODLES[kind](seeded(seed + kind.length * 31));
  }
  // round-17 markup (Structured/journal/markup_contract_r17.md)
  for (const ins of page.querySelectorAll("ins.by-ofar")) {   // Ofar's correction goes above the words he struck out
    const st = ins.previousElementSibling;
    if (st?.matches("s.by-ofar")) { st.style.position = "relative"; st.append(ins); }
  }
  for (const d of page.querySelectorAll("aside.dmnote")) {   // a hidden DM's note: only its sigil is on the page
    d.dataset.text = d.textContent.replace(/\s+/g, " ").trim();
    d.textContent = "";
    d.classList.add("tj-dm");
    d.tabIndex = 0;
    d.setAttribute("role", "button");
    d.setAttribute("aria-label", "DM's note");
  }
  handwrite(page, seed);
  if (face.classList.contains("is-divine")) windLetters(page, seed);
  const r17 = seeded(seed * 13 + 5);
  for (const sm of page.querySelectorAll("span.smear")) {    // the last letters were wiped while wet (DM 130: subtle, directional)
    const txt = sm.textContent.replace(/\s+$/, "");
    sm.dataset.t = txt.slice(-Math.min(txt.length, 3 + Math.floor(r17() * 2)));
    sm.style.setProperty("--smx", `${(0.08 + r17() * 0.1).toFixed(2)}em`);
    sm.style.setProperty("--smk", `${(-8 - r17() * 10).toFixed(0)}deg`);
    sm.style.setProperty("--sml", `${(0.5 + r17() * 0.6).toFixed(2)}em`);
    sm.style.setProperty("--smr", `${((r17() - 0.6) * 4).toFixed(1)}deg`);
    sm.style.setProperty("--smo", (0.09 + r17() * 0.05).toFixed(2));
  }
  const nSmudge = Math.min(3, Math.max(0, +section.dataset.smudge || 0));
  for (let i = 0; i < nSmudge; i++) {                         // thumbprints where a thumb holds the book: at the outer edge
    const m = el("i", "tj-smudge");
    const [y, se] = i === 0 ? [62 + r17() * 26, 3 + r17() * 7] : i === 1 ? [93 + r17() * 3, 30 + r17() * 60] : [34 + r17() * 18, 2 + r17() * 6];
    m.style.cssText = `--sy:${y.toFixed(1)}%;--se:${se.toFixed(0)}px;--r:${Math.round(-40 + r17() * 80)}deg;--s:${(0.85 + r17() * 0.3).toFixed(2)};` +
      `background-image:url("${fingerprint(r17)}")`;
    face.append(m);
  }
  if (section.dataset.stain) face.append(el("i", `tj-stain is-${section.dataset.stain}`));   // dried blood, water damage (images, see mountJournal)
  if (page.querySelector("figure.loose") || face.classList.contains("is-divine")) face.classList.add("has-overhang");   // a sheet sticks out / letters fly off
  for (const f of page.querySelectorAll("figure.loose")) {
    f.classList.add("tj-loose");
    f.tabIndex = 0;
    f.setAttribute("role", "button");
    f.setAttribute("aria-label", `Open the loose sheet: ${f.querySelector("img")?.alt || "a letter"}`);
    let nudge = null;
    try { nudge = JSON.parse(sessionStorage.getItem(`tj-loose:${f.dataset.loose}`) || "null"); } catch { /* no storage */ }
    if (nudge) { f.style.setProperty("--ldx", `${nudge[0]}px`); f.style.setProperty("--ldy", `${nudge[1]}px`); }
  }
  return face;
}

/* a faint ink thumb-smudge: an oval of broken ridge lines (seeded), as an SVG data URI */
function fingerprint(r) {
  const out = [];
  for (let k = 0; k < 9; k++) {
    const rx = 4 + k * 2.1 + r() * 0.8, ry = 6 + k * 2.6 + r() * 0.8, gap = 3 + r() * 6;
    out.push(`<ellipse cx="25" cy="30" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" stroke-dasharray="${(8 + r() * 14).toFixed(0)} ${gap.toFixed(0)}" stroke-dashoffset="${(r() * 30).toFixed(0)}"/>`);
  }
  // fine, pale ridges fading out at the rim; no fill (never a blob)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 60"><defs><radialGradient id="g"><stop offset=".45" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient><mask id="m"><rect width="50" height="60" fill="url(#g)"/></mask></defs><g mask="url(#m)" fill="none" stroke="#6e5a44" stroke-width=".8" stroke-opacity=".7">${out.join("")}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/* A page written by a power outside the realm (Luth's epilogue, DM feedback 45): a steady hand (no per-word wobble), and
   every letter carries its own flight on the one wind — up and away to the right — for when its word is blown off. */
function windLetters(page, seed) {
  const r = seeded(seed * 7 + 1);
  page.querySelectorAll(".tj-w").forEach((w, i) => {
    w.removeAttribute("style");
    w.classList.add("vw");
    w.dataset.w = i;
    const letters = Array.from(w.textContent);
    w.dataset.t = w.textContent;   // the ink stain it leaves behind
    w.textContent = "";
    letters.forEach((ch, k) => {
      const l = document.createElement("span");
      l.className = "vl";
      l.textContent = ch;
      // drift x, rise y (px), turn (deg), flight and delay (ms): mostly up, a little with the wind to the right
      l.dataset.f = [Math.round(40 + r() * 110), Math.round(-80 - r() * 140), Math.round((r() - 0.35) * 90),
        Math.round(2800 + r() * 1400), Math.round(k * 70 + r() * 60)].join(",");
      w.append(l);
    });
  });
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function buildCover(coverUrl, mark = "", { title = ["CHULT"], by = "O. Lyonbrooke", year = "MCDXCII" } = {}) {
  const f = el("div", "tj-face tj-face--board tj-cover");
  f.innerHTML = `<div class="tj-cover-title" aria-label="${esc(title.join(" "))} — ${esc(by)}${mark ? `, ${esc(mark)}` : ""}">
      <span class="t1">${title.map(esc).join("<br>")}</span>${mark ? `<span class="t4">${esc(mark)}</span>` : ""}<span class="rule"></span><span class="t2">${esc(by)}</span><span class="t3">${esc(year)}</span></div>
    <div class="tj-strap"></div>`;
  if (coverUrl) {
    f.classList.add("has-image");
    f.style.backgroundImage = `url("${coverUrl}")`;
  }
  return f;
}
function buildBackCover(coverUrl) {
  const f = el("div", "tj-face tj-face--board tj-backcover");
  if (coverUrl) {
    const img = el("div", "img");
    img.style.backgroundImage = `url("${coverUrl}")`;
    f.append(img);
  }
  return f;
}
function insideBoard(pageFace, which) {
  const f = el("div", `tj-face tj-face--board is-inside-${which}`);
  f.append(pageFace);
  return f;
}
function blankPaper(cls = "") {
  const f = el("div", `tj-face tj-face--page ${cls}`);
  f.style.setProperty("--foxing", foxing(hash(cls || "blank")));
  return f;
}

/* ------------------------------------------------------------------ map */

function catmull(pts) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/* four frames of a red ant walking (each 22×18 px, facing +x), side by side, as an SVG string: the legs swing in two tripods */
function antStrip() {
  const f = (v) => v.toFixed(2), W = 22, H = 18, C = 9;
  const legs = [[13.9, -1, -50, 20, 0], [12.9, -1, -95, -12, 1], [11.9, -1, -136, -18, 0],
                [13.9, 1, 50, -20, 1], [12.9, 1, 95, 12, 0], [11.9, 1, 136, 18, 1]];   // attach x, side, angle, knee bend, tripod
  const P = (x, y, a, r) => [x + r * Math.cos((a * Math.PI) / 180), y + r * Math.sin((a * Math.PI) / 180)];
  let out = "";
  for (let k = 0; k < 4; k++) {
    let lg = "";
    for (const [x, side, a0, bend, grp] of legs) {
      const a = a0 - side * 16 * Math.sin(2 * Math.PI * (k / 4 + grp / 2));
      const A = [x, C + side * 0.75], K = P(...A, a, 2.8), T = P(...K, a + bend, 3.3);
      lg += `M${f(A[0])} ${f(A[1])}L${f(K[0])} ${f(K[1])}L${f(T[0])} ${f(T[1])}`;
    }
    const sw = 7 * Math.sin((2 * Math.PI * k) / 4);   // the antennae feel the way
    const feeler = (side) => { const B = [17.7, C + side * 0.6], E = P(...B, side * (-58 + sw), 2.1), T = P(...E, side * (-14 - sw), 2.4); return `M${f(B[0])} ${f(B[1])}L${f(E[0])} ${f(E[1])}L${f(T[0])} ${f(T[1])}`; };
    out += `<g transform="translate(${k * W} 0)">` +
      `<ellipse cx="10.6" cy="${C + 1}" rx="8.6" ry="2.6" fill="#2a0d05" opacity=".13"/>` +                       // shadow on the paper
      `<path d="${lg}" fill="none" stroke="#561709" stroke-width=".5" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="${feeler(-1)}${feeler(1)}" fill="none" stroke="#5e1a0b" stroke-width=".42" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<ellipse cx="6.5" cy="${C}" rx="4" ry="2.7" fill="url(#tj-ant-g)"/>` +                                    // gaster
      `<ellipse cx="10.55" cy="${C}" rx=".7" ry=".62" fill="#7a1d0e"/>` +                                         // petiole node
      `<ellipse cx="13" cy="${C}" rx="2.2" ry="1.15" fill="url(#tj-ant-t)"/>` +                                   // thorax
      `<ellipse cx="16.4" cy="${C}" rx="1.65" ry="1.5" fill="url(#tj-ant-t)"/>` +                                // head
      `<path d="M17.8 ${C - 0.7} q.9 .2 .7 .7 M17.8 ${C + 0.7} q.9 -.2 .7 -.7" fill="none" stroke="#3a0f06" stroke-width=".38" stroke-linecap="round"/>` +   // mandibles
      `<ellipse cx="5.8" cy="${C - 0.95}" rx="1.7" ry=".6" fill="#ffd9c4" opacity=".16"/></g>`;                 // a dull shine
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${4 * W}" height="${H}" viewBox="0 0 ${4 * W} ${H}"><defs>` +
    `<radialGradient id="tj-ant-g" cx=".42" cy=".38" r=".7"><stop offset="0" stop-color="#a8301a"/><stop offset=".75" stop-color="#7a1d0e"/><stop offset="1" stop-color="#521308"/></radialGradient>` +
    `<radialGradient id="tj-ant-t" cx=".42" cy=".38" r=".75"><stop offset="0" stop-color="#c0432a"/><stop offset="1" stop-color="#7c2010"/></radialGradient></defs>${out}</svg>`;
}
const ANT_SVG = antStrip();

/* Route legs: { style: "sea" | "river" | "walk" | "portal", pts: [[x, y], …] } in Chult.webp pixels.
   sea/river legs are smooth curves (they follow coasts and rivers), walk legs are straight segments, a portal is a
   dotted jump. A seeded wobble is baked into the geometry so the line looks inked by hand (no SVG filters). */
function legPath(leg, P, seed) {
  const pts = leg.pts.map(P);
  if (leg.style === "portal") {   // a gentle arc for the jump
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1];
    return `M${a[0]},${a[1]} Q${(mx - dy * 0.25).toFixed(1)},${(my + dx * 0.25).toFixed(1)} ${b[0]},${b[1]}`;
  }
  // resample, then wobble (endpoints stay exact so legs join)
  const r = seeded(seed), dense = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]], n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 26));
    for (let k = 0; k < n; k++) dense.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, k === 0]);
  }
  dense.push([...pts[pts.length - 1], true]);
  const amp = leg.style === "walk" ? 1.6 : 2.2;
  const w = dense.map(([x, y, keep], i) => (keep || i === dense.length - 1 ? [x, y] : [x + (r() - 0.5) * 2 * amp, y + (r() - 0.5) * 2 * amp]));
  if (leg.style === "walk") return "M" + w.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L");
  return catmull(w);
}

/* the region of a route mask: the bounds of the leg's path (its control points hold the curve) plus the mask's stroke.
   A mask as large as the sheet made every reveal step re-rasterize the whole map at every leg (Chromium, 4K: seconds
   of raster per page turn); bounded, a step redraws only the legs that changed. */
function maskBox(d, pad) {
  const n = d.match(/-?\d*\.?\d+/g).map(Number);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < n.length; i += 2) { x0 = Math.min(x0, n[i]); x1 = Math.max(x1, n[i]); y0 = Math.min(y0, n[i + 1]); y1 = Math.max(y1, n[i + 1]); }
  return `x="${Math.floor(x0 - pad)}" y="${Math.floor(y0 - pad)}" width="${Math.ceil(x1 - x0 + 2 * pad)}" height="${Math.ceil(y1 - y0 + 2 * pad)}"`;
}

/* Map sheets. The route lives on one or more sheets ("chult" = the base sheet described by route.image/crop/
   scale/size; others under route.sheets, e.g. the city of Port Nyanzaru). Legs and waypoints carry `sheet`
   (default "chult"). Waypoints stay one list in travel order; each sheet reveals its own ink up to where the party
   has been on that sheet. */
const sheetKeyOf = (o) => o.sheet || "chult";
function sheetConfigs(route) {   // Chult plus the sheets a waypoint actually uses
  const used = new Set((route.waypoints || []).map(sheetKeyOf));
  return { chult: { image: route.image, crop: route.crop, scale: route.scale, size: route.size, title: "Chult" },
    ...Object.fromEntries(Object.entries(route.sheets || {}).filter(([k]) => used.has(k))) };
}

function buildMap(root, route, urls, uid) {
  const cfgs = sheetConfigs(route);
  const map = el("div", "tj-map");
  map.setAttribute("aria-label", "Map showing the party's route so far");
  map.innerHTML = `<div class="tj-map-head"><span class="tj-map-title">Chult — where we've been</span><small>(O.L.)</small></div>
    <div class="tj-map-view"></div><div class="tj-map-tip" aria-live="polite"></div>`;
  root.append(map);
  const view = map.querySelector(".tj-map-view");
  const wps = route.waypoints.map((w, gi) => ({ ...w, gi, sheet: sheetKeyOf(w) }));
  const sheets = {};
  const legsAll = route.legs || [{ style: "sea", pts: route.path }];
  for (const [key, cfg] of Object.entries(cfgs)) {
    const [cx, cy] = cfg.crop || [0, 0], sc = cfg.scale || 1, [W, H] = cfg.size;
    const P = ([x, y]) => [(x - cx) * sc, (y - cy) * sc];
    const legs = legsAll.map((l, i) => ({ ...l, i })).filter((l) => sheetKeyOf(l) === key).map((l) => ({ ...l, d: legPath(l, P, 101 + l.i * 13) }));
    const swps = wps.filter((w) => w.sheet === key).map((w) => { w.p = P([w.x, w.y]); return w; });
    const layer = el("div", "tj-sheet");
    layer.dataset.sheet = key;
    const off = key === "chult" && route.offmap ? P([route.offmap.x, route.offmap.y]) : null;
    layer.innerHTML = `
      <div class="tj-map-pan" style="width:${W}px;height:${H}px">
        <img alt="" width="${W}" height="${H}" src="${urls[key] || ""}" decoding="async">
        <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
          <defs>${legs.map((l, i) => `<mask id="tj-mask-${uid}-${key}-${i}" maskUnits="userSpaceOnUse" ${maskBox(l.d, 30)}>
              <path class="tj-route-mask" d="${l.d}" fill="none" stroke="#fff" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/></mask>`).join("")}
          </defs>
          ${off ? `<g class="tj-offmap"><path d="M${off[0] + 120},${off[1] + 46} L${off[0] + 30},${off[1] + 46}" stroke="#3a2413" stroke-width="4" fill="none"/><path d="M${off[0] + 46},${off[1] + 34} L${off[0] + 30},${off[1] + 46} L${off[0] + 46},${off[1] + 58}" stroke="#3a2413" stroke-width="4" fill="none"/><text x="${off[0] + 130}" y="${off[1] + 56}">${route.offmap.label}</text></g>` : ""}
          <g class="tj-routes">${legs.map((l, i) => `<path class="tj-route is-${l.style}" d="${l.d}" mask="url(#tj-mask-${uid}-${key}-${i})"/>`).join("")}</g>
          <g class="tj-wps">${swps.map((w) => `<g class="tj-wp is-hidden" data-i="${w.gi}" tabindex="-1" transform="translate(${w.p[0].toFixed(1)},${w.p[1].toFixed(1)})" role="button" aria-label="${w.label} (session ${w.session})"><circle class="ring" r="21"/><text y="1">${w.session}</text></g>`).join("")}</g>
        </svg>
        <div class="tj-head" style="offset-path: path('${legs.map((l) => l.d).join(" ") || "M0,0"}')"><svg width="40" height="40" viewBox="-20 -20 40 40" aria-hidden="true"><circle class="pulse" r="16"/><circle class="dot" r="9"/></svg></div>
      </div>`;
    view.append(layer);
    const pathEls = [...layer.querySelectorAll(".tj-route")], maskEls = [...layer.querySelectorAll(".tj-route-mask")];
    let acc = 0;
    legs.forEach((l, i) => {
      l.el = pathEls[i]; l.mask = maskEls[i];
      l.len = l.el.getTotalLength(); l.start = acc; acc += l.len;
      l.mask.style.strokeDasharray = `${l.len + 1} ${l.len + 1}`;
      l.mask.style.strokeDashoffset = `${l.len + 1}`;
    });
    const total = acc;
    const pointAt = (len) => {
      if (!legs.length) return [W / 2, H / 2];
      len = clamp(len, 0, total);
      const l = legs.find((g) => len <= g.start + g.len) || legs[legs.length - 1];
      const q = l.el.getPointAtLength(len - l.start);
      return [q.x, q.y];
    };
    // each waypoint's distance along its sheet's route: nearest sample, searching forward (places can be revisited)
    const samples = [];
    for (const l of legs) {
      const n = Math.max(8, Math.round(l.len / 6));
      for (let k = 0; k <= n; k++) { const q = l.el.getPointAtLength((k / n) * l.len); samples.push([l.start + (k / n) * l.len, q.x, q.y]); }
    }
    let from = 0;
    for (const w of swps) {
      let best = from, bd = Infinity;
      for (let i = from; i < samples.length; i++) {
        const dd = (samples[i][1] - w.p[0]) ** 2 + (samples[i][2] - w.p[1]) ** 2;
        if (dd < bd) { bd = dd; best = i; }
        else if (bd < 144 && dd > 144) break;   // past the first close pass (within 12 px): a later pass is a later visit
      }
      w.len = samples.length ? samples[best][0] : 0;
      from = best;
    }
    const pts = legs.flatMap((l) => l.pts.map(P));
    const xs = pts.length ? pts.map((p) => p[0]) : [0, W], ys = pts.length ? pts.map((p) => p[1]) : [0, H];
    const pad = 70;
    const fitZoom = Math.min(380 / (Math.max(...xs) - Math.min(...xs) + 2 * pad), 520 / (Math.max(...ys) - Math.min(...ys) + 2 * pad));
    const mid = [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2];
    sheets[key] = { key, cfg, layer, pan: layer.querySelector(".tj-map-pan"), head: layer.querySelector(".tj-head"), legs, total, pointAt, size: [W, H], fitZoom, mid,
      wpEls: [...layer.querySelectorAll(".tj-wp")], wps: swps, title: cfg.title || key };
  }
  // per waypoint: how far each sheet's ink has got by then
  const state = [];
  const reach = Object.fromEntries(Object.keys(sheets).map((k) => [k, 0]));
  for (const w of wps) { reach[w.sheet] = Math.max(reach[w.sheet], w.len); state.push({ ...reach }); }
  const wpEls = wps.map((w) => sheets[w.sheet].wpEls.find((g) => +g.dataset.i === w.gi));
  return { map, view, sheets, wps, state, wpEls, tip: map.querySelector(".tj-map-tip"), title: map.querySelector(".tj-map-title") };
}

/* ------------------------------------------------------------------ map viewer */
/* The map sheet opens large on the desk: the whole of Chult, the route so far, the places we've been.
   Pan by dragging, zoom with wheel / pinch / buttons; Esc, × or a click outside closes it. */
function buildMapViewer(stage, route, urls, M, onGo) {
  const cfgs = sheetConfigs(route);
  // the large view of the Chult sheet uses the whole-island bake (route.viewer), other sheets their own bake
  // (`size` is the design size: the baked image may be smaller to save bytes and is stretched to it)
  const vcfg = (key) => key === "chult" && route.viewer ? { scale: route.viewer.scale ?? 1, crop: [0, 0], size: route.viewer.size } : { scale: cfgs[key].scale || 1, crop: cfgs[key].crop || [0, 0], size: cfgs[key].size };
  const keys = Object.keys(cfgs);
  const box = el("div", keys.length > 4 ? "tj-mv is-many" : "tj-mv");   // many sheets: the tabs get a row of their own
  box.hidden = true;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "The map");
  const legsAll = route.legs || [];
  const VS = {};
  const sheetHtml = keys.map((key) => {
    const { scale, crop } = vcfg(key);
    const P = ([x, y]) => [(x - crop[0]) * scale, (y - crop[1]) * scale];
    const legs = legsAll.map((l, i) => ({ ...l, i })).filter((l) => sheetKeyOf(l) === key).map((l) => ({ ...l, d: legPath(l, P, 101 + l.i * 13) }));
    const wps = M.wps.filter((w) => w.sheet === key).map((w) => ({ ...w, vp: P([w.x, w.y]) }));
    VS[key] = { key, legs, wps, P, size: vcfg(key).size, W: 0, H: 0, loaded: false };
    return `<div class="tj-mv-pan" data-sheet="${key}" hidden>
        <img alt="Map of ${cfgs[key].title || key}" draggable="false">
        <svg aria-hidden="true">
          <defs>${legs.map((l, i) => `<mask id="tj-mvm-${key}-${i}" maskUnits="userSpaceOnUse" ${maskBox(l.d, 18)}><path class="tj-route-mask" d="${l.d}" fill="none" stroke="#fff" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/></mask>`).join("")}</defs>
          <g class="tj-routes">${legs.map((l, i) => `<path class="tj-route is-${l.style}" d="${l.d}" mask="url(#tj-mvm-${key}-${i})"/>`).join("")}</g>
          <g class="tj-wps">${wps.map((w) => `<g class="tj-wp is-hidden" data-i="${w.gi}" transform="translate(${w.vp[0].toFixed(1)},${w.vp[1].toFixed(1)})" role="button" tabindex="0" aria-label="${w.label} (session ${w.session})"><circle class="ring" r="13"/><text y="1">${w.session}</text></g>`).join("")}</g>
          <g class="tj-head"><circle class="dot" r="6"/></g>
        </svg>
      </div>`;
  }).join("");
  box.innerHTML = `
    <div class="tj-mv-sheet">
      <div class="tj-mv-head"><span class="tj-mv-title">Chult — where we've been</span>
        <span class="tj-mv-tabs" role="tablist">${keys.length > 1 ? keys.map((k) => `<button type="button" role="tab" data-sheet="${k}" title="${cfgs[k].title || k}">${cfgs[k].tab || cfgs[k].title || k}</button>`).join("") : ""}</span>
        <small>drag to look around · wheel or pinch to zoom</small></div>
      <div class="tj-mv-view">${sheetHtml}<div class="tj-mv-loading">unfolding the map…</div></div>
      <div class="tj-mv-panel" hidden><b></b><span></span><button type="button" class="tj-mv-go">Go to the page</button></div>
      <div class="tj-mv-ctrl"><button type="button" data-z="1.4" aria-label="Zoom in">+</button><button type="button" data-z="0.714" aria-label="Zoom out">–</button><button type="button" data-fit aria-label="Show the whole route">⤢</button></div>
      <button type="button" class="tj-mv-close" aria-label="Close the map">×</button>
    </div>`;
  stage.append(box);
  const $ = (q) => box.querySelector(q);
  const view = $(".tj-mv-view"), panel = $(".tj-mv-panel"), loading = $(".tj-mv-loading");
  for (const key of keys) {
    const S = VS[key], pan = box.querySelector(`.tj-mv-pan[data-sheet="${key}"]`);
    Object.assign(S, { pan, img: pan.querySelector("img"), svg: pan.querySelector("svg"), pathEls: [...pan.querySelectorAll(".tj-route")], maskEls: [...pan.querySelectorAll(".tj-route-mask")],
      wpEls: [...pan.querySelectorAll(".tj-wp")], headEl: pan.querySelector(".tj-head") });
  }
  let cur = null, z = 1, tx = 0, ty = 0, zMin = 0.2, sel = -1, stateGi = -1, stateEnd = false;
  const apply = () => { cur.pan.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${z.toFixed(4)})`; };
  const clampPan = () => {
    const vw = view.clientWidth, vh = view.clientHeight, { W, H } = cur;
    tx = W * z < vw ? (vw - W * z) / 2 : clamp(tx, vw - W * z, 0);
    ty = H * z < vh ? (vh - H * z) / 2 : clamp(ty, vh - H * z, 0);
  };
  function zoomAt(k, cx, cy) {
    const nz = clamp(z * k, zMin, 2.2);
    tx = cx - ((cx - tx) * nz) / z; ty = cy - ((cy - ty) * nz) / z; z = nz;
    clampPan(); apply();
  }
  function frame(x0, y0, x1, y1) {
    const vw = view.clientWidth, vh = view.clientHeight, pad = 60;
    z = clamp(Math.min(vw / (x1 - x0 + 2 * pad), vh / (y1 - y0 + 2 * pad)), zMin, 2.2);
    tx = vw / 2 - ((x0 + x1) / 2) * z; ty = vh / 2 - ((y0 + y1) / 2) * z;
    clampPan(); apply();
  }
  function fitRoute() {
    const pts = cur.legs.flatMap((l) => l.pts.map(cur.P));
    if (!pts.length) return frame(0, 0, cur.W, cur.H);
    frame(Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])));
  }
  // reveal each sheet's route as far as the desk sheet shows it (same fraction of each leg)
  function syncRoute(S) {
    const D = M.sheets[S.key];
    const len = stateEnd ? D.total : stateGi < 0 ? 0 : M.state[stateGi][S.key] ?? 0;
    let head = null;
    S.legs.forEach((l, i) => {
      const dl = D.legs[i]; if (!dl) return;
      const f = clamp((len - dl.start) / dl.len), L = S.pathEls[i].getTotalLength();
      S.maskEls[i].style.strokeDasharray = `${L + 1} ${L + 1}`;
      S.maskEls[i].style.strokeDashoffset = `${(L + 1) * (1 - f)}`;
      if (f > 0 && (len <= dl.start + dl.len || i === S.legs.length - 1) && !head) head = S.pathEls[i].getPointAtLength(f * L);
    });
    if (!head && S.legs.length && (stateEnd || S.wps.some((w) => w.gi <= stateGi))) head = S.pathEls[0].getPointAtLength(0);   // at the sheet's first stop
    S.wpEls.forEach((g) => { const gi = +g.dataset.i; g.classList.toggle("is-hidden", !(stateEnd || gi <= stateGi) || M.wps[gi].len > len + 2); });
    S.headEl.style.display = head ? "" : "none";
    if (head) S.headEl.setAttribute("transform", `translate(${head.x.toFixed(1)},${head.y.toFixed(1)})`);
    return head;
  }
  async function show(key, centreOn) {
    cur = VS[key];
    for (const S of Object.values(VS)) S.pan.hidden = S !== cur;
    box.querySelectorAll(".tj-mv-tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.sheet === key)));
    const tabs = box.querySelector(".tj-mv-tabs"), on = tabs?.querySelector('[aria-selected="true"]');
    if (on && tabs.scrollWidth > tabs.clientWidth) {   // phones: the tab row scrolls; keep the open sheet's tab in view
      const tr = tabs.getBoundingClientRect(), br = on.getBoundingClientRect();
      tabs.scrollLeft += br.left - tr.left - (tr.width - br.width) / 2;
    }
    $(".tj-mv-title").textContent = `${cfgs[key].title || key} — where we've been`;
    select(-1);
    if (!cur.loaded) {
      // (S, not cur: a tab tapped or the viewer closed while this sheet loads changes cur, and the sheet that loaded
      // must be the one marked loaded; and the wait ends at the load event or after 6 s, whichever is first, as
      // decode() may never settle in some browsers: the map then stayed "unfolding" until the page was reloaded)
      const S = cur;
      loading.hidden = false;
      S.img.decoding = "async";
      S.img.src = urls[key] || "";
      if (!S.img.complete) await Promise.race([
        S.img.decode().catch(() => {}),
        new Promise((r) => { S.img.addEventListener("load", r, { once: true }); S.img.addEventListener("error", r, { once: true }); }),
        new Promise((r) => setTimeout(r, 6000)),
      ]);
      [S.W, S.H] = S.size || [S.img.naturalWidth, S.img.naturalHeight]; S.loaded = true;
      Object.assign(S.img.style, { width: `${S.W}px`, height: `${S.H}px` });
      S.svg.setAttribute("width", S.W); S.svg.setAttribute("height", S.H); S.svg.setAttribute("viewBox", `0 0 ${S.W} ${S.H}`);
      if (S !== cur) return;   // (another sheet was asked for meanwhile: its own show() lays it out)
    }
    loading.hidden = true;
    zMin = Math.min(view.clientWidth / cur.W, view.clientHeight / cur.H) * 0.98;
    const head = syncRoute(cur);
    if (centreOn && head) frame(head.x - 380, head.y - 300, head.x + 380, head.y + 300); else fitRoute();
  }
  function select(gi) {
    sel = gi;
    for (const S of Object.values(VS)) S.wpEls.forEach((g) => g.classList.toggle("is-sel", +g.dataset.i === gi));
    if (gi < 0) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.querySelector("b").textContent = `Session ${M.wps[gi].session}`;
    panel.querySelector("span").textContent = M.wps[gi].label;
  }
  // pointer: drag to pan, two fingers to pinch
  const pts = new Map();
  let last = null, pinch = null, moved = 0, downOn = null;
  view.addEventListener("pointerdown", (e) => {
    downOn = e.target.closest?.(".tj-wp") || null;   // (pointer capture retargets the pointerup)
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    view.setPointerCapture(e.pointerId);
    moved = 0;
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) }; }
    last = [e.clientX, e.clientY];
  });
  view.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId) || !cur) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    const r = view.getBoundingClientRect();
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt(d / pinch.d, (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top); pinch.d = d; moved += 10; return;
    }
    const dx = e.clientX - last[0], dy = e.clientY - last[1];
    last = [e.clientX, e.clientY]; moved += Math.abs(dx) + Math.abs(dy);
    tx += dx; ty += dy; clampPan(); apply();
  });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (pts.size === 1) last = [...pts.values()][0]; };
  view.addEventListener("pointerup", (e) => {
    up(e);
    if (moved < 6) { const g = downOn; if (g && !g.classList.contains("is-hidden")) select(+g.dataset.i); else select(-1); }
  });
  view.addEventListener("pointercancel", up);
  view.addEventListener("wheel", (e) => { if (!cur) return; e.preventDefault(); const r = view.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  box.querySelectorAll("[data-z]").forEach((b) => b.addEventListener("click", () => zoomAt(+b.dataset.z, view.clientWidth / 2, view.clientHeight / 2)));
  $("[data-fit]").addEventListener("click", fitRoute);
  box.querySelectorAll(".tj-mv-tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.sheet, true)));
  for (const S of Object.values(VS)) S.wpEls.forEach((g) => g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(+g.dataset.i); } }));
  $(".tj-mv-go").addEventListener("click", () => { if (sel >= 0) { const id = M.wps[sel].id; close(); onGo(id, sel); } });
  $(".tj-mv-close").addEventListener("click", () => close());
  box.addEventListener("pointerdown", (e) => { if (e.target === box) close(); });
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  let opener = null;
  async function open(gi, end) {
    opener = document.activeElement;
    stateGi = gi; stateEnd = !!end;
    box.hidden = false;
    requestAnimationFrame(() => box.classList.add("is-open"));
    addEventListener("keydown", onKey, true);
    for (const S of Object.values(VS)) if (S.loaded) syncRoute(S);
    await show(end || gi < 0 ? "chult" : M.wps[gi].sheet, !end);
    $(".tj-mv-close").focus({ preventScroll: true });
  }
  function close() {
    box.classList.remove("is-open");
    removeEventListener("keydown", onKey, true);
    setTimeout(() => { if (!box.classList.contains("is-open")) box.hidden = true; }, 260);
    opener?.focus?.({ preventScroll: true });
  }
  return { open, close, get isOpen() { return !box.hidden; } };
}

/* ------------------------------------------------------------------ engine */

async function mountJournal(root, data) {
  root.classList.add("tj-root");
  // which volume this is: the cover mark, the last endpaper and the card after the book closes
  const vol = { mark: "", endA: "continued in the second book", endB: "(this one is full)",
    card: ["Continued in Book II", "Sessions 31 to 48: Omu, the Fane of the Night Serpent and the Tomb of the Nine Gods.", "— Ofar says: MORE!"], ...data.book };
  root.dataset.volume = String(vol.volume || 1);
  const hand = HANDS[data.hand || OLIVER_HAND];
  root.style.setProperty("--tj-oliver", `${hand.family}, "Kalam", "Segoe Print", cursive`);
  root.style.setProperty("--tj-oliver-size", `${hand.size}px`);
  root.style.setProperty("--tj-oliver-lh", String(hand.lh));
  root.dataset.handBold = hand.bold ? "yes" : "no";
  const papers = makePapers(makeTextures(root), vol.theme);
  const uid = Math.random().toString(36).slice(2, 7);
  let fontLink = document.querySelector("link[data-tj-fonts]");
  if (!fontLink) {
    fontLink = document.createElement("link");
    fontLink.rel = "stylesheet"; fontLink.href = FONT_HREF; fontLink.dataset.tjFonts = "";
    document.head.append(fontLink);
  }
  // resolves once the @font-face rules exist (only then can document.fonts.load() fetch the hands)
  const fontCss = fontLink.sheet ? Promise.resolve() : new Promise((r) => { fontLink.addEventListener("load", r, { once: true }); fontLink.addEventListener("error", r, { once: true }); setTimeout(r, 5000); });
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // a frozen journal (the other book, waiting on the desk of the web edition: see shelf.js) shows what it last showed and
  // ignores scrolling and input until it is thawed
  let frozen = !!data.frozen;
  root.classList.toggle("is-frozen", frozen);
  /* ?debug: count who asks for frames and what keeps running (overlay, top-right; also window.__tjDebug) */
  const DBG = data.debug ? { req: {}, sec: {}, calls: {}, fps: 0, anims: {} } : null;
  const reqFrame = (tag, fn) => { if (DBG) DBG.req[tag] = (DBG.req[tag] || 0) + 1; return requestAnimationFrame(fn); };
  const dbgCall = (tag) => { if (DBG) DBG.calls[tag] = (DBG.calls[tag] || 0) + 1; };
  if (DBG) {
    window.__tjDebug = DBG;
    const box = document.createElement("pre");
    box.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:99999;margin:0;padding:6px 8px;background:rgba(0,0,0,.72);color:#bfe;font:11px/1.35 monospace;pointer-events:none;white-space:pre";
    document.body.append(box);
    let frames = 0, lastReq = {};
    const probe = () => { frames++; requestAnimationFrame(probe); };
    requestAnimationFrame(probe);
    setInterval(() => {
      DBG.fps = frames; frames = 0;
      DBG.sec = Object.fromEntries(Object.entries(DBG.req).map(([k, v]) => [k, v - (lastReq[k] || 0)]).filter(([, v]) => v));
      lastReq = { ...DBG.req };
      const run = {};
      for (const a of document.getAnimations()) if (a.playState === "running") { const n = a.animationName || a.transitionProperty || "anim"; run[n] = (run[n] || 0) + 1; }
      DBG.anims = run;
      box.textContent = `frames/s ${DBG.fps} (incl. this probe)\nrequested/s ${JSON.stringify(DBG.sec)}\nrunning CSS ${JSON.stringify(run)}\ncalls ${JSON.stringify(DBG.calls)}\nstate ${root.className.replace(/tj-root ?/, "")}`;
    }, 1000);
  }
  const resolve = makeResolver(data.assets, data.assetBase || "assets/");

  root.innerHTML = `
    <div class="tj-stage">
      <div class="tj-world">
        <div class="tj-desk"><div class="tj-env"></div><div class="tj-env"></div></div>
        <div class="tj-swing">
          <div class="tj-light"></div>
          <div class="tj-motes" aria-hidden="true">${Array.from({ length: 9 }, (_, i) => `<i style="--i:${i}"></i>`).join("")}</div>
        </div>
        <div class="tj-vignette"></div>
        <div class="tj-scene">
          <div class="tj-book-wrap">
            <div class="tj-book-shadow"></div>
            <div class="tj-book">
              <div class="tj-board tj-board-left" hidden></div>
              <div class="tj-board tj-board-right"></div>
              <div class="tj-slot tj-slot-left"><div class="tj-cast"></div></div>
              <div class="tj-slot tj-slot-right"><div class="tj-cast"></div></div>
              <div class="tj-leaf"></div>
            </div>
          </div>
        </div>
        <div class="tj-lamp-over"></div>
      </div>
      <div class="tj-hud">
        <div class="tj-hud-session"><span class="n"></span><span class="d"></span></div>
        <div class="tj-hud-place"></div>
        <div class="tj-hud-keys">scroll or ← → to turn the page</div>
        <div class="tj-hud-progress"><i></i></div>
      </div>
      <div class="tj-who is-empty" role="list" aria-label="Who's who: the party and companions right now"><span class="tj-who-h" aria-hidden="true">with us</span><div class="tj-who-row"></div></div>
      <div class="tj-who-card" hidden role="tooltip"><div class="pic"><img alt=""></div><small class="cr"></small><div class="tx"><b></b><i></i><p></p></div></div>
      <div class="tj-dm-card" hidden role="tooltip"><b><i class="sig" aria-hidden="true"></i>DM's note</b><p></p></div>
      <div class="tj-lb" hidden role="dialog" aria-modal="true" aria-label="A loose sheet"><div class="tj-lb-view"><img alt=""></div><button type="button" class="tj-lb-close" aria-label="Close">×</button></div>
      <button class="tj-map-toggle" type="button" aria-expanded="false">Map</button>
      <nav class="tj-pbar" aria-label="The journal">
        <button type="button" data-p="map"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5 8.5 4l7 2.5L21 4v13.5L15.5 20l-7-2.5L3 20z M8.5 4v13.5 M15.5 6.5V20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg><span>Map</span></button>
        <button type="button" data-p="who"><svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="12" rx="7.5" ry="9.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="10" r="2.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7.4 17.2c1.2-2.4 2.8-3.4 4.6-3.4s3.4 1 4.6 3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><span>Who's who</span></button>
        <button type="button" data-p="marks"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11v17l-5.5-4-5.5 4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9.5 8.5h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><span>Bookmarks</span></button>
      </nav>
      <div class="tj-psheet" hidden role="dialog" aria-modal="true"><div class="tj-psheet-card"><div class="tj-psheet-head"><b></b><button type="button" class="tj-psheet-close" aria-label="Close">×</button></div><div class="tj-psheet-body"></div></div></div>
      <div class="tj-hint">Scroll to open the journal</div>
      <div class="tj-end" role="dialog" aria-label="End of the book">
        <h2>${esc(vol.card[0])}</h2>${vol.card[1] ? `<p>${esc(vol.card[1])}</p>` : ""}${vol.card[2] ? `<p class="sig">${esc(vol.card[2])}</p>` : ""}
      </div>
      <div class="tj-loading">opening the journal…</div>
    </div>
    <div class="tj-spacer"></div>`;

  const $ = (s) => root.querySelector(s);
  const stage = $(".tj-stage"), world = $(".tj-world"), scene = $(".tj-scene"), bookWrap = $(".tj-book-wrap");
  const book = $(".tj-book"), leafEl = $(".tj-leaf"), slotL = $(".tj-slot-left"), slotR = $(".tj-slot-right");
  const boardL = $(".tj-board-left"), boardR = $(".tj-board-right"), shadow = $(".tj-book-shadow");
  // the lamp's place and colour go on the two layers that draw it: set on an ancestor of the book (as they were), a change
  // of desk restyled every element of the open pages (~40 ms mid-turn)
  const envEls = [...root.querySelectorAll(".tj-env")], lamps = [$(".tj-light"), $(".tj-lamp-over")];
  const hudN = $(".tj-hud-session .n"), hudD = $(".tj-hud-session .d"), hudP = $(".tj-hud-place"), prog = $(".tj-hud-progress i");
  const hint = $(".tj-hint"), endCard = $(".tj-end"), spacer = $(".tj-spacer"), loading = $(".tj-loading"), mapToggle = $(".tj-map-toggle");
  const castL = slotL.querySelector(".tj-cast"), castR = slotR.querySelector(".tj-cast");
  const hudSession = $(".tj-hud-session");
  const whoBox = $(".tj-who"), whoRow = $(".tj-who-row"), whoCard = $(".tj-who-card");
  const pbar = $(".tj-pbar"), psheet = $(".tj-psheet"), psBody = psheet.querySelector(".tj-psheet-body");

  /* ---- content ---- */
  const html = String(data.pagesHtml || "").replace(/src="ASSET:([^"]+)"/g, 'data-asset="$1"');
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const sections = [...tpl.content.querySelectorAll("section.page")];
  const pages = sections.map((s, i) => buildPageFace(s, i));

  // resolve all assets up-front (data URIs in the built artifact, files in dev)
  const imgs = pages.flatMap((p) => [...p.querySelectorAll("img[data-asset]")]);
  const envKeys = [...new Set(pages.map((p) => p.dataset.env).filter(Boolean))];
  const sheetKeys = Object.keys(sheetConfigs(data.route));
  const [coverUrl, fullMapUrl, sheetUrlList, ...rest] = await Promise.all([
    resolve(vol.cover || "cover"),
    data.route.viewer ? resolve(data.route.viewer.image, { pm: true }) : null,
    Promise.all(sheetKeys.map((k) => resolve(sheetConfigs(data.route)[k].image, { pm: true }))),
    ...envKeys.map((k) => resolve(`env_${k}`)),
    ...imgs.map((i) => resolve(i.dataset.asset, { pm: !i.closest("figure.hand-ofar") })),
  ]);
  const envUrls = Object.fromEntries(envKeys.map((k, i) => [k, rest[i]]));
  const shaped = [];   // [figure, img]: floated sketches whose text follows the drawing (trimFigure, shapeFloats)
  imgs.forEach((img, i) => {
    const url = rest[envKeys.length + i];
    img.decoding = "async";
    if (url) { img.src = url; trimFigure(img); return; }
    // not painted yet: a faint pencil frame where the picture will go (keeps the page layout honest)
    let note = img.alt ? img.alt.replace(/^[^:]*:\s*/, "") : "a sketch to come";
    if (note.length > 120) note = note.slice(0, 120).replace(/\s+\S*$/, "") + "…";
    const ph = el("div", "tj-ph", `<span>${note}</span>`);
    ph.style.aspectRatio = img.closest("figure")?.dataset.ratio || (img.closest("figure.small") ? "1" : "3 / 2");
    ph.title = `missing: ${img.dataset.asset}`;
    ph.dataset.asset = img.dataset.asset;
    img.replaceWith(ph);
  });

  // a baked picture whose empty margins were cut (DM 134/137): its figure narrows by as much, so the drawing keeps its size
  // and the text comes closer. A floated sketch without a caption also lets the text follow its outline (see shapeFloats)
  function trimFigure(img) {
    const fig = img.closest("figure.ill");
    if (!fig || fig.querySelectorAll("img").length !== 1) return;
    const T = data.trim?.[img.dataset.asset];
    if (T && T[2] - T[0] < 0.999) {
      const w = parseFloat(fig.style.getPropertyValue("--w")) || (fig.classList.contains("item") ? 33 : 90);
      fig.style.setProperty("--w", `${(w * (T[2] - T[0])).toFixed(2)}%`);
    }
    const floated = fig.classList.contains("item") || /float\s*:\s*(left|right)/.test(fig.getAttribute("style") || "");
    if (floated && img.parentElement === fig && !fig.querySelector("figcaption") && !fig.matches(".hand-ofar, .handout, .loose, .hand-dm")) shaped.push([fig, img]);
  }
  // shape-outside from the picture's alpha. The shape image maps onto the figure's box only when it has no size of its own
  // (Chromium places a raster image at its natural size), so the picture goes inside a size-less SVG. A figure with a
  // caption would stretch it, so it keeps its box; so does the dev page (its pictures are files, which an SVG image can't load)
  async function shapeFloats() {
    await Promise.all(shaped.map(async ([fig, img]) => {
      const W = +img.getAttribute("width"), H = +img.getAttribute("height");
      if (!W || !H || !img.src.startsWith("data:")) return;
      const url = `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><image width="${W}" height="${H}" href="${img.src}"/></svg>`)}`;
      const pre = new Image();
      pre.src = url;
      await pre.decode().catch(() => {});   // (decoded before the fitting measures the pages)
      fig.style.shapeOutside = `url("${url}")`;
      fig.classList.add("is-shaped");
    }));
  }

  const cover = buildCover(coverUrl, vol.mark, vol.coverText || {});
  const backCover = buildBackCover(coverUrl);
  const endpaper = blankPaper("is-endpaper is-right");
  // Book I is full (DM 147): it ends on its last written page, with "continued in the second book" squeezed in at its foot,
  // and no blank page after it (a last page on the right is pasted inside the back board). Books II and III end on "The End".
  const lastPage = pages[pages.length - 1];
  const endOnPage = (vol.volume || 1) === 1 && !!lastPage;
  const tbc = `<span class="a">${esc(vol.endA)}</span>${vol.endB ? ` <span class="b">${esc(vol.endB)}</span>` : ""}`;
  if (endOnPage) lastPage.append(el("div", "tj-tbc-foot", tbc));
  else endpaper.append(el("div", "tj-tbc", tbc));

  /* ---- map ---- */
  const sheetUrls = Object.fromEntries(sheetKeys.map((k, i) => [k, sheetUrlList[i]]));
  const M = buildMap(scene, data.route, sheetUrls, uid);
  // page → waypoint. A place visited again appears in the route once per visit under the same id; a page names the
  // first visit at or after the previous page's waypoint. Pages without data-map carry the previous one forward.
  const visits = {};
  M.wps.forEach((w, i) => (visits[w.id] ||= []).push(i));
  const pageWp = [];
  for (let i = 0, last = 0; i < pages.length; i++) {
    const v = visits[pages[i].dataset.map];
    if (v) last = v.find((g) => g >= last) ?? v[v.length - 1];
    pageWp.push(last);
  }
  const firstPageAt = (gi) => pages.find((p) => pageWp[+p.dataset.idx] >= gi);

  /* ---- leaves (rebuilt per mode) ---- */
  let mode = "double", leaves = [], segs = [], totalVh = 0, curS = -1, envCur = null;
  let pRender = 0, pVel = 0, glide = false;
  let gesture = null;   // { leaf, top, P?, dragging?, anim? } — a click, drag or hover-peek on a page
  let NT = null;        // the DM's feedback notes (notes.js), once the artifact runtime allows them

  function buildLeaves() {
    leaves = [];
    if (mode === "double") {
      const p0 = pages[0];
      p0.classList.add("is-left");
      leaves.push({ front: cover, back: insideBoard(p0, "front"), board: true });
      const pastedLast = endOnPage && pages.length % 2 === 0;   // (the last page would face a blank one)
      for (let i = 1; i < pages.length - (pastedLast ? 1 : 0); i += 2) {
        const f = pages[i], b = pages[i + 1] || blankPaper("is-left");
        f.classList.add("is-right"); f.classList.remove("is-left");
        b.classList.add("is-left"); b.classList.remove("is-right");
        leaves.push({ front: f, back: b, board: false });
      }
      if (pastedLast) { lastPage.classList.add("is-right"); lastPage.classList.remove("is-left"); }
      leaves.push({ front: insideBoard(pastedLast ? lastPage : endpaper, "back"), back: backCover, board: true, closing: true });
    } else {
      leaves.push({ front: cover, back: blankPaper("is-left"), board: true });
      for (const p of pages) {
        p.classList.add("is-right"); p.classList.remove("is-left");
        leaves.push({ front: p, back: blankPaper("is-left"), board: false });
      }
    }
    // a paper bitmap per page, matching its side (gutter)
    for (const lf of leaves) for (const face of [lf.front, lf.back]) {
      const pf = face.classList.contains("tj-face--page") ? face : face.querySelector(".tj-face--page");
      if (!pf) continue;
      const side = pf.classList.contains("is-left") ? "left" : "right";
      pf.style.setProperty("--paper", papers[side][(+(pf.dataset.idx ?? 0) * 7 + 3) % papers[side].length]);
    }
    // page index -> spread where it is first fully visible
    leaves.forEach((lf, li) => {
      for (const [face, side] of [[lf.front, "front"], [lf.back, "back"]]) {
        const pf = face.classList.contains("tj-face--page") ? face : face.querySelector(".tj-face--page");
        if (pf && pf.dataset.idx != null) { pf._leaf = li; pf._side = side; pf._spread = side === "front" ? li : li + 1; }
      }
    });
    // segments: closed cover, content spreads, closing, end card
    segs = leaves.map((lf, i) => ({ len: i === 0 ? 0.9 : lf.closing ? 1.0 : 1.5, turn: i === 0 ? 0.55 : lf.closing ? 0.6 : 0.32 }));
    segs.push({ len: 1.1, turn: 0 });
    totalVh = segs.reduce((a, s) => a + s.len, 0);
    curS = -1;
    for (const d of leafCache.values()) d.box.remove();
    leafCache.clear();
    buildTabs();
  }

  /* ---- bookmarks: torn slips of old paper tucked between the pages, one per session ----
     They sit behind the pages (only the top shows above the edge) and travel with their page. */
  let tabs = [];
  function slipSVG(seed, label, wMax = 48, tall = 0) {
    const r = seeded(seed);
    const w = Math.max(22, wMax - 18 + r() * 18), h = 64 + r() * 14 + tall;   // full slip; ~35–70 px show above the page edge
    const pts = [[0, h]];
    const n = 7 + Math.floor(r() * 4);
    for (let i = 0; i <= n; i++) {                      // torn top edge
      const x = (w * i) / n, y = 2 + r() * 9 + (i === 0 || i === n ? 4 : 0) + (i / n) * (r() - 0.5) * 8;
      pts.push([x, y]);
      if (i < n) pts.push([x + w / n / 2 + (r() - 0.5) * 2, y + (r() - 0.25) * 5]);
    }
    pts.push([w, h]);
    const d = "M" + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L") + " Z";
    const id = `tjslip${seed}`;
    const th = vol.theme === "thayan";
    const dm = vol.theme === "dm";
    const tone = (th ? ["#d6bea6", "#ccb097", "#dbc5ae", "#c7a68e", "#d0b6a0"] : dm ? ["#e2dfd2", "#d8d4c4", "#e6e3d7", "#d2cdbb", "#dedacb"]
      : ["#d9c49a", "#cfb88a", "#ddcba4", "#c9b080", "#d4bf93"])[seed % 5];
    const [s0, s7, s1] = th ? ["#9e7865", "#d9c4ae", "#c09a84"] : dm ? ["#a59f88", "#e1ddcf", "#c8c2ad"] : ["#a98a5a", "#d8c49c", "#c4a877"];
    // Book II: each slip is tied with a short length of red cord just above the page edge
    const cy = th ? 47 + r() * 4 : 0, knot = th ? w * (0.62 + r() * 0.2) : 0;   // (Book I draws no extra random numbers)
    const cord = th ? `<path d="M-1.5,${(cy + 1).toFixed(1)} Q${(w / 2).toFixed(1)},${(cy - 2.5).toFixed(1)} ${(w + 1.5).toFixed(1)},${(cy + 0.5).toFixed(1)}" stroke="#7c1a14" stroke-width="2.1" fill="none"/>
      <path d="M-1.5,${(cy + 1).toFixed(1)} Q${(w / 2).toFixed(1)},${(cy - 2.5).toFixed(1)} ${(w + 1.5).toFixed(1)},${(cy + 0.5).toFixed(1)}" stroke="rgba(255,200,180,.28)" stroke-width=".6" stroke-dasharray="1.6 1.4" fill="none"/>
      <circle cx="${knot.toFixed(1)}" cy="${(cy - 0.6).toFixed(1)}" r="2.3" fill="#6a1510"/>
      <path d="M${knot.toFixed(1)},${cy.toFixed(1)} q${(2 + r() * 2).toFixed(1)},6 ${(1 + r() * 3).toFixed(1)},${(9 + r() * 4).toFixed(1)} M${knot.toFixed(1)},${cy.toFixed(1)} q-1,5 ${(-2 - r() * 2).toFixed(1)},${(8 + r() * 3).toFixed(1)}" stroke="#7c1a14" stroke-width="1.3" fill="none" stroke-linecap="round"/>` : "";
    return `<svg width="${w.toFixed(1)}" height="${h.toFixed(1)}" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0.25" y2="1">
          <stop offset="0" stop-color="${s0}"/><stop offset=".12" stop-color="${tone}"/><stop offset=".7" stop-color="${s7}"/><stop offset="1" stop-color="${s1}"/></linearGradient>
        <radialGradient id="${id}f" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="rgba(140,95,45,.28)"/><stop offset="1" stop-color="rgba(140,95,45,0)"/></radialGradient></defs>
      <path d="${d}" fill="url(#${id})"/>
      <path d="${d}" fill="none" stroke="rgba(110,78,40,.55)" stroke-width=".8"/>
      <ellipse cx="${(w * (0.25 + r() * 0.5)).toFixed(1)}" cy="${(16 + r() * 14).toFixed(1)}" rx="${(3 + r() * 5).toFixed(1)}" ry="${(2 + r() * 4).toFixed(1)}" fill="url(#${id}f)"/>
      <path d="M${(w * 0.15).toFixed(1)},${(h * 0.62).toFixed(1)} l${(w * 0.7).toFixed(1)},${((r() - 0.5) * 3).toFixed(1)}" stroke="rgba(120,90,50,.18)" stroke-width=".7"/>
      <text x="${(w / 2 + (r() - 0.5) * 4).toFixed(1)}" y="${(27 + r() * 6).toFixed(1)}" text-anchor="middle" class="tj-slip-num" transform="rotate(${((r() - 0.5) * 14).toFixed(1)} ${(w / 2).toFixed(1)} 26)">${label}</text>${cord}
    </svg>`;
  }
  function buildTabs() {
    tabs.forEach((t) => t.el.remove());
    tabs = [];
    root.querySelector(".tj-ribbon")?.remove();
    if (mode !== "double") return;
    const seen = new Set();
    const starts = [];
    pages.forEach((p) => {
      if (vol.theme === "dm") {   // the DM's book: one slip per chapter ("Chapter IV · …" → IV)
        const c = (p.dataset.tab || "").match(/Chapter\s+([IVXLC]+)/)?.[1];
        if (c && !seen.has(c)) { seen.add(c); starts.push([c, p]); }
        return;
      }
      for (const s of [p.dataset.session, p.dataset.sessionStart]) if (s && !seen.has(s)) { seen.add(s); starts.push([s, p]); }
    });
    // every session gets its own slot along the top edge (mirrored once its page is turned), so slips never pile up;
    // with many sessions they get narrower and alternate in height so every number stays readable
    const n = starts.length;
    const step = n > 1 ? Math.min(58, (PAGE_W - 96) / (n - 1)) : 58;
    const wMax = Math.max(26, Math.min(48, step + 10));
    starts.forEach(([s, p], i) => {
      const tall = n > 8 && i % 2 ? 18 : 0;
      const b = el("button", "tj-tab is-right", slipSVG(7919 * (i + 3), s, wMax, tall));
      b.type = "button";
      const tabOf = vol.theme === "dm" ? p.dataset.tab : pages.find((q) => q.dataset.session === s)?.dataset.tab;
      b.title = (tabOf || `Session ${s}`).replace(/·/g, "—");
      b.setAttribute("aria-label", `Jump to ${b.title}`);
      const r = seeded(31 * (i + 7));
      b.style.setProperty("--tx", `${Math.round(PAGE_W - 60 - wMax / 2 - i * step - r() * Math.min(10, step / 8))}px`);
      b.style.setProperty("--trot", `${((r() - 0.5) * (n > 8 ? 6 : 11)).toFixed(1)}deg`);
      b.style.setProperty("--tdy", `${Math.round(r() * 8) - tall}px`);
      b.style.setProperty("--tw", `${b.querySelector("svg").getAttribute("width")}px`);
      b.addEventListener("click", () => jumpTurn(p._spread));
      book.insertBefore(b, slotL);           // behind the pages: only the torn top shows
      tabs.push({ el: b, page: p });
    });
    // a faded silk ribbon hanging out at the foot of the spine
    const rib = el("div", "tj-ribbon", `<svg width="150" height="70" viewBox="0 0 150 70" aria-hidden="true">
      <defs><linearGradient id="tjrib" x1="0" y1="0" x2="0" y2="1">${(vol.theme === "thayan" ? ["#2a0807", "#5e1310", "#741a15", "#240606"] : vol.theme === "dm" ? ["#5c4519", "#9c7a34", "#b8933f", "#4f3b15"] : ["#4a2a26", "#6a3d36", "#76473f", "#42231f"]).map((c, i) => `<stop offset="${[0, 0.4, 0.55, 1][i]}" stop-color="${c}"/>`).join("")}</linearGradient>
        <pattern id="tjweave" width="3" height="3" patternUnits="userSpaceOnUse"><path d="M0 1.5 H3" stroke="rgba(0,0,0,.12)" stroke-width=".6"/></pattern></defs>
      <path d="M3 0 L 15 0 C 19 24, 42 35, 90 37 L 124 38 L 113 45 L 127 53 L 90 51 C 40 50, 7 38, 3 0 Z" fill="url(#tjrib)" opacity=".82"/>
      <path d="M3 0 L 15 0 C 19 24, 42 35, 90 37 L 124 38 L 113 45 L 127 53 L 90 51 C 40 50, 7 38, 3 0 Z" fill="url(#tjweave)"/>
      <path d="M9 2 C 14 26, 42 41, 90 44 L 118 45" stroke="rgba(255,222,200,.09)" stroke-width="1.6" fill="none"/>
      <path d="M124 38 L 113 45 L 127 53" fill="none" stroke="rgba(60,30,24,.5)" stroke-width=".7"/>
      <path d="M126 39 l3 -1 M127 52 l3 1" stroke="rgba(110,70,60,.5)" stroke-width=".5"/></svg>`);
    book.insertBefore(rib, slotL);
  }

  /* ---- the turning leaf ----
     Paper turns as a 2D fold: the bottom-right corner travels along an arc, the fold line is the perpendicular
     bisector of (start corner → current corner). The front face is clipped to the spine side of the fold, the
     folded flap shows the back face, placed by reflection-across-the-fold ∘ horizontal mirror (a proper rotation,
     so text is never mirrored), and the next page is revealed underneath. Boards (covers) are stiff: they flip
     rigidly (scaleX about the spine). Only 2D transforms, clip-path and gradients — cheap, and no 3D state. */
  let F = null;
  const leafCache = new Map();   // leaf index → prepared DOM (built ahead of time, so a turn never starts with cloning)
  function cloneFace(face) {
    fitPage(face);
    const c = face.cloneNode(true);
    c.removeAttribute("id");
    // a prepared copy must never paint a frame without its pictures: decode now, paint synchronously
    for (const im of c.querySelectorAll("img")) { im.decoding = "sync"; im.decode?.().catch(() => {}); }
    return c;
  }
  // half-plane wrapper: one page diagonal deep and two wide around the fold point — every point of the page is
  // within one diagonal of the fold, so this covers the page exactly while keeping the rotated clip small
  const BIG = Math.ceil(Math.hypot(PAGE_W, PAGE_H)) + 4;
  function buildLeafDom(lf) {
    const box = el("div", "tj-leafbox");
    if (lf.board) {
      const front = el("div", "tj-board-flip is-front"), back = el("div", "tj-board-flip is-back");
      front.append(cloneFace(lf.front), el("div", "tj-bshade"));
      back.append(cloneFace(lf.back), el("div", "tj-bshade"));
      box.append(back, front);
      return { kind: "board", box, front, back, fs: front.lastChild, bs: back.lastChild, last: -1 };
    }
    // under: shadow thrown on the next page, clipped to the page by a static box
    const under = el("div", "tj-under");
    const uStrip = el("div", "tj-strip is-under");
    under.append(uStrip);
    // half-plane wrapper (keeps the spine side of the fold); its inner layer undoes the rotation
    const hp = el("div", "tj-hp"), inner = el("div", "tj-hp-inner");
    hp.style.setProperty("--hp", `${BIG}px`);
    const front = el("div", "tj-fold-front");
    const frontFace = cloneFace(lf.front);
    const fStrip = el("div", "tj-strip is-front");
    front.append(frontFace, fStrip);
    const shadow = el("div", "tj-flap-shadow");
    const back = el("div", "tj-fold-back");
    const cStrip = el("div", "tj-strip is-crease");
    back.append(cloneFace(lf.back), cStrip);
    // a loose sheet sticking out of its page: the page-sized wrapper must not cut it (the half-plane still clips the fold)
    front.classList.toggle("has-overhang", lf.front.classList.contains("has-overhang"));
    back.classList.toggle("has-overhang", lf.back.classList.contains("has-overhang"));
    inner.append(front, shadow, back);
    hp.append(inner);
    box.append(under, hp);
    for (const f of box.querySelectorAll(".tj-face--page")) f.classList.add("is-moving");
    return { kind: "paper", box, under, uStrip, hp, inner, front, fStrip, shadow, back, cStrip, last: -1 };
  }
  function leafDom(i) {
    if (!leaves[i]) return null;
    if (!leafCache.has(i)) {
      const d = buildLeafDom(leaves[i]);
      d.box.classList.add("is-parked");
      leafEl.append(d.box);
      leafCache.set(i, d);
    }
    return leafCache.get(i);
  }
  let prepTimer = 0;
  function fillLeaf(i) {
    // show leaf i, keep its neighbours prepared (hidden but laid out), drop the rest
    for (const [k, d] of leafCache) if (Math.abs(k - i) > 2) { d.box.remove(); leafCache.delete(k); }
    F = leafDom(i);
    for (const [k, d] of leafCache) d.box.classList.toggle("is-parked", k !== i);
    leafEl.hidden = !F;
    if (F) F.last = -1;
    clearTimeout(prepTimer);
    prepTimer = setTimeout(() => { leafDom(i + 1); leafDom(i - 1); }, 60);
  }

  /* where the turning corner is at turn progress t (bottom corner by default, top corner if `top`) */
  function cornerAt(t, top = false) {
    const W = PAGE_W, H = PAGE_H, lift = 0.13 * H;
    const x = W - 2 * W * t, y = H - lift * Math.pow(Math.sin(Math.PI * t), 0.8);
    return constrainCorner([x, top ? H - y : y], top);
  }
  /* The paper is held at the spine: the corner can't get further than W from the spine end on its own edge,
     nor further than the page diagonal from the other end (otherwise the fold would cross the spine). */
  function constrainCorner([x, y], top) {
    const W = PAGE_W, H = PAGE_H, D = Math.hypot(W, H);
    const near = top ? 0 : H, far = top ? H : 0;
    let d = Math.hypot(x, y - near);
    if (d > W) { x = (x * W) / d; y = near + ((y - near) * W) / d; }
    d = Math.hypot(x, y - far);
    if (d > D) { x = (x * D) / d; y = far + ((y - far) * D) / d; }
    return [x, y];
  }
  /* the rectangle (x0, y0)–(x1, y1) cut to the half-plane nx·x + ny·y ≥ c, as a clip-path polygon */
  const CLIP_PAD = 80;   // (loose sheets may stick out of their page)
  const OLD_FOLD = /oldfold/.test(location.hash);
  if (OLD_FOLD) root.classList.add("tj-oldfold");
  function clipHalf(x0, y0, x1, y1, nx, ny, c) {
    const R = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], out = [];
    for (let i = 0; i < 4; i++) {
      const A = R[i], B = R[(i + 1) % 4], da = nx * A[0] + ny * A[1] - c, db = nx * B[0] + ny * B[1] - c;
      if (da >= 0) out.push(A);
      if ((da >= 0) !== (db >= 0)) { const k = da / (da - db); out.push([A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k]); }
    }
    return out.length >= 3 ? `polygon(${out.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(",")})` : "polygon(0 0,0 0,0 0)";
  }
  const mtx = (a, b, c, d, e, f) => `matrix(${a.toFixed(6)},${b.toFixed(6)},${c.toFixed(6)},${d.toFixed(6)},${e.toFixed(2)},${f.toFixed(2)})`;
  /* strip helper: a static gradient strip (width w, tall) whose left edge (x=0) lies on the line through
     `o` with normal `dir` (pointing into the strip), in the coordinates of the strip's parent */
  const stripAt = (o, dir, h = 1800) => mtx(dir[0], dir[1], -dir[1], dir[0], o[0] + (h / 2) * dir[1], o[1] - (h / 2) * dir[0]);
  function renderFold(t, corner) {
    const W = PAGE_W, H = PAGE_H;
    const q = corner ? `${corner.P[0].toFixed(1)},${corner.P[1].toFixed(1)},${corner.top}` : Math.round(t * 4000);
    if (q === F.last) return;
    F.last = q;
    // a corner (peek, drag, release) that sits on its rest position: the fold has no direction there (n = 0 would collapse
    // the half-plane and hide the page, so the next page flashed through, DM 48/102) — it is simply the page at rest
    const Cr = corner?.top ? [W, 0] : [W, H], Cb = corner?.top ? [-W, 0] : [-W, H];
    let lifted = 0;
    if (corner) {
      const dr = Math.hypot(corner.P[0] - Cr[0], corner.P[1] - Cr[1]), db = Math.hypot(corner.P[0] - Cb[0], corner.P[1] - Cb[1]);
      if (dr < 0.75) t = 0; else if (db < 0.75) t = 1; else t = clamp(t, 0.002, 0.998);
      lifted = Math.min(1, Math.min(dr, db) / 240);   // a lifted corner throws a shadow even when the turn hasn't started
    }
    if (t <= 0.0003 || t >= 0.9997) {   // at rest: the plain page; turned: the back lies flat as the left page
      F.box.classList.toggle("is-rest", t <= 0.0003);
      F.box.classList.toggle("is-turned", t >= 0.9997);
      if (F.clipped) { F.front.style.clipPath = F.back.style.clipPath = F.shadow.style.clipPath = ""; F.clipped = false; }
      return;
    }
    F.box.classList.remove("is-rest", "is-turned");
    const P = corner ? corner.P : cornerAt(t), C = corner?.top ? [W, 0] : [W, H];
    F.P = P;
    const vx = P[0] - C[0], vy = P[1] - C[1], len = Math.hypot(vx, vy) || 1e-6;
    const n = [vx / len, vy / len], m = [(P[0] + C[0]) / 2, (P[1] + C[1]) / 2];
    const np = [-n[1], n[0]];
    // The front stays exactly where it lies at rest (no transform, no layer of its own: its text renders as crisply as on
    // a resting page, DM round 26) and is cut along the fold by a clip-path: the spine side of the fold, (p − m)·n ≥ 0.
    // The flap (the back face and its shadow) is clipped by the same half-plane, written in its own coordinates.
    if (OLD_FOLD) {   // (#oldfold, for comparing: a rotated overflow:hidden half-plane clips a transformed front, as before)
      const e = m[0] - BIG * np[0], f = m[1] - BIG * np[1];
      F.hp.style.transform = mtx(n[0], n[1], np[0], np[1], e, f);
      F.inner.style.transform = mtx(n[0], np[0], n[1], np[1], -(n[0] * e + n[1] * f), -(np[0] * e + np[1] * f));
    } else F.front.style.clipPath = clipHalf(-CLIP_PAD, -CLIP_PAD, W + CLIP_PAD, H + CLIP_PAD, n[0], n[1], m[0] * n[0] + m[1] * n[1]);
    // back face: T = reflect(fold) ∘ mirror(x → W − x)
    const a = -(1 - 2 * n[0] * n[0]), b = 2 * n[0] * n[1], c = -2 * n[0] * n[1], d = 1 - 2 * n[1] * n[1];
    const mn = m[0] * n[0] + m[1] * n[1];
    const te = W * (1 - 2 * n[0] * n[0]) + 2 * mn * n[0], tf = -2 * W * n[0] * n[1] + 2 * mn * n[1];
    const T = mtx(a, b, c, d, te, tf);
    F.back.style.transform = T;
    F.shadow.style.transform = T;
    const gx = a * n[0] + b * n[1], gy = c * n[0] + d * n[1], gc = n[0] * (m[0] - te) + n[1] * (m[1] - tf);
    if (!OLD_FOLD) {
      F.back.style.clipPath = clipHalf(-CLIP_PAD, -CLIP_PAD, W + CLIP_PAD, H + CLIP_PAD, gx, gy, gc);
      F.shadow.style.clipPath = clipHalf(-60, -60, W + 60, H + 60, gx, gy, gc);
      F.clipped = true;
    }
    // shading strips: only their transform and opacity change (pre-rendered gradients, no repaint)
    const k = Math.pow(Math.max(Math.sin(Math.PI * t), lifted), 0.55);
    F.uStrip.style.transform = stripAt(m, [-n[0], -n[1]]);
    F.fStrip.style.transform = stripAt(m, n);
    const g = [a * n[0] + b * n[1], c * n[0] + d * n[1]];                         // fold normal in back-face coords
    const ml = [a * (m[0] - te) + b * (m[1] - tf), c * (m[0] - te) + d * (m[1] - tf)]; // fold point in back-face coords
    F.cStrip.style.transform = stripAt(ml, g);
    const ok = k.toFixed(3);
    F.uStrip.style.opacity = ok; F.fStrip.style.opacity = ok; F.cStrip.style.opacity = ok;
    F.shadow.style.opacity = (0.9 * k).toFixed(3);
  }
  function renderBoard(t) {
    const q = Math.round(t * 4000);
    if (q === F.last) return;
    F.last = q;
    const th = Math.PI * t, cs = Math.cos(th), sn = Math.sin(th);
    const lift = 1 + 0.035 * sn;    // the free edge comes closer to the eye
    F.front.hidden = cs <= 0;
    F.back.hidden = cs > 0;
    F.front.style.transform = t <= 0.0003 ? "" : `scale(${Math.max(cs, 0.001).toFixed(4)}, ${lift.toFixed(4)})`;
    F.back.style.transform = t >= 0.9997 ? "" : `scale(${Math.max(-cs, 0.001).toFixed(4)}, ${lift.toFixed(4)})`;
    F.fs.style.opacity = (0.5 * sn).toFixed(3);
    F.bs.style.opacity = (0.4 * sn).toFixed(3);
    return (PAGE_W + BOARD) * cs;   // x of the free edge, for the cast shadow
  }

  function place(slot, face) {
    for (const c of [...slot.children]) if (!c.classList.contains("tj-cast")) c.remove();
    fitPage(face);
    if (face) slot.prepend(face);
  }

  /* ---- layout / scaling ---- */
  let vw = 0, vh = 0, scale = 1, curShift = 0;
  function layout() {
    dbgCall("layout");
    measureRoot();
    vw = stage.clientWidth || innerWidth;
    vh = stage.clientHeight || innerHeight;
    const newMode = vw <= SINGLE_BP || (vw < vh * 0.82 && vw <= 1100) ? "single" : "double";   // phones, and portrait screens
    root.classList.toggle("is-single", newMode === "single");
    hint.textContent = newMode === "single" ? "Swipe, tap or scroll to open the journal" : "Scroll to open the journal";
    if (newMode !== mode || !leaves.length) { mode = newMode; buildLeaves(); }
    if (mode === "double") {
      const MAP_SZ = 0.86, mapW = 420 * MAP_SZ, tabs = 30;
      const MAP_X = PAGE_W + 20;   // map lies just beside the book, its corner barely touching the board
      const left = -(PAGE_W + BOARD) - tabs, right = MAP_X + mapW + 10;
      const hudTop = HUD_TOP * UI, sceneW = right - left, sceneH = TABS_UP + PAGE_H + BOARD, room = vh - hudTop - HUD_BOTTOM * UI;
      scale = Math.min((vw - 24) / sceneW, room / sceneH, 1.15 * UI);
      const sx = Math.round(vw / 2 - ((left + right) / 2) * scale), sy = Math.round(hudTop + Math.max(0, room - sceneH * scale) / 2 + (TABS_UP + PAGE_H / 2) * scale);
      scene.style.setProperty("--sx", `${sx}px`);
      scene.style.setProperty("--sy", `${sy}px`);
      M.map.style.setProperty("--msz", String(MAP_SZ));
      whoBox.style.setProperty("--wx", `${Math.round(sx + (MAP_X + 6) * scale)}px`);       // under the map card, beside the book
      whoBox.style.setProperty("--wy", `${Math.round(sy + (PAGE_H / 2 - 222) * scale)}px`);
      whoBox.style.setProperty("--wsc", scale.toFixed(4));
      M.map.style.setProperty("--mx", `${MAP_X}px`);
      M.map.style.setProperty("--my", `${-PAGE_H / 2 + 30}px`);
    } else {
      const bottom = (pbar.offsetHeight || 0) + 30;              // the tab bar, and the place line above it
      const room = vh - HUD_TOP - bottom, sceneH = PAGE_H + 2 * BOARD;
      scale = Math.min((vw - 8) / (PAGE_W + BOARD), room / sceneH);
      scene.style.setProperty("--sx", `${Math.round(vw / 2 - ((PAGE_W - BOARD) / 2) * scale)}px`);   // the page and its board, centred
      scene.style.setProperty("--sy", `${Math.round(HUD_TOP + Math.max(0, room - sceneH * scale) / 2 + (sceneH / 2) * scale)}px`);
      root.style.setProperty("--pbar-h", `${pbar.offsetHeight || 0}px`);
      M.map.style.setProperty("--mscale", Math.min((vw - 20) / 420, (vh - 90) / 590).toFixed(3));
    }
    scene.style.setProperty("--scale", scale.toFixed(4));
    spacer.style.height = `${totalVh * vh}px`;
    curS = -1;
    pRender = scrollPos(); pVel = 0;
    update(true);
  }

  /* ---- scroll timeline ---- */
  let rootTop = 0;   // document y of the journal's top edge (cached: no layout reads while scrolling)
  const measureRoot = () => { rootTop = root.getBoundingClientRect().top + scrollY; };
  function scrollPos() {
    const top = rootTop - scrollY;
    return clamp(-top / vh, 0, totalVh);
  }
  function locate(p) {
    let acc = 0;
    for (let s = 0; s < segs.length; s++) {
      const L = segs[s].len;
      if (p < acc + L || s === segs.length - 1) {
        const u = clamp((p - acc) / L);
        const turn = segs[s].turn;
        const t = turn > 0 ? turnEase(clamp((u - (1 - turn)) / turn)) : 0;
        return { s, u, t, acc };
      }
      acc += L;
    }
  }
  function segStart(s) { let a = 0; for (let i = 0; i < s; i++) a += segs[i].len; return a; }
  function jumpToSpread(s, instant) {
    const rootTop = root.getBoundingClientRect().top + scrollY;
    const y = rootTop + (segStart(clamp(s, 0, segs.length - 1)) + LEAD) * vh;
    snapLock = performance.now() + 400;
    glide = true;
    scrollTo({ top: y, behavior: "instant" });
    if (instant) { pRender = scrollPos(); pVel = 0; }
    kick();
  }
  /* A jump to another spread (a tab, the map, the page list) is ONE page turn that ends on the target (DM round 26: it
     used to land on the spread before and then turn): for that turn the leaf carries the page you are on on one side and
     the target's page on the other, over the target's other page, so nothing in between shows and nothing jumps. Covers,
     the closed book and phones keep the plain jump. */
  let jumpLeaf = null;   // { s, from, to, back: slotL face, fwd } while such a turn runs
  function jumpTurn(b) {
    const a = restingSpread(), L = leaves.length;
    b = clamp(b, 0, L);
    if (b === a) return;
    if (Math.abs(b - a) === 1) return b > a ? turnForward() : turnBack();
    const fwd = b > a, s = fwd ? a : a - 1;
    const front = fwd ? leaves[a]?.front : leaves[b]?.front, back = fwd ? leaves[b - 1]?.back : leaves[a - 1]?.back;
    if (reduced || mode !== "double" || gesture?.anim || gesture?.dragging || locate(pRender).t > 0.0003 || !front || !back
        || leaves[s].board || (fwd ? leaves[b - 1].board : leaves[b].board) || b < 1 || b >= L) return jumpToSpread(b);
    clearPeek(true);
    if (jumpLeaf) jumpLeaf.F.box.remove();
    jumpLeaf = { s, from: a, to: b, fwd, F: buildLeafDom({ front, back }) };
    leafEl.append(jumpLeaf.F.box);
    curS = -1;   // re-place the slots for the jump leaf
    animateTurn(s, fwd ? 0 : 1, fwd ? 1 : 0, { dur: 880, final: restP(b) });
  }
  function endJump() {
    if (!jumpLeaf) return;
    jumpLeaf.F.box.remove();
    jumpLeaf = null;
    curS = -1;
  }

  function facePage(face) {
    if (!face) return null;
    return face.classList.contains("tj-face--page") ? face : face.querySelector(".tj-face--page");
  }
  function currentPageAt(s) {
    // the page the reader is looking at in spread s: right page if it is content, else the left page
    const right = s < leaves.length ? facePage(leaves[s].front) : null;
    const left = s > 0 ? facePage(leaves[s - 1].back) : null;
    const ok = (p) => p && p.dataset.idx != null;
    return ok(right) ? right : ok(left) ? left : null;
  }

  function shownFaces() {   // the content pages on screen: the left page, and the unturned leaf's front (a clone) on the right
    const out = [], ok = (f) => f?.dataset.idx != null;
    const l = mode === "double" ? facePage(slotL.firstElementChild) : null, r = facePage(F ? F.front.firstElementChild : slotR.firstElementChild);
    if (ok(l)) out.push(l);
    if (ok(r)) out.push(r);
    return out;
  }

  function contentPageAt(s) {
    for (let k = s; k >= 0; k--) { const p = currentPageAt(k); if (p) return p; }
    return null;
  }

  function stackShadow(n, dir) {
    const out = [];
    for (let i = 1; i <= n; i++) out.push(`${dir * i}px ${i * 0.6}px 0 ${i % 2 ? "#d8c7a2" : "#efe3c8"}`);
    out.push(`${dir * (n + 1)}px ${n * 0.6 + 1}px 2px rgba(0,0,0,.35)`);
    return out.join(",");
  }

  /* ---- who's who: small portraits of the party and companions with them right now (cast.json), under the map card;
     hover / focus / tap shows a card. A variant applies from session `from` (and, in that session, from the page whose
     data-map is `fromMap`); `name` overrides the shown name. Changes fade in and out when the session changes. ---- */
  const cast = data.cast && data.cast.sessions ? data.cast : null;
  const mapIdx = {};
  pages.forEach((q) => { if (q.dataset.map && !(q.dataset.map in mapIdx)) mapIdx[q.dataset.map] = +q.dataset.idx; });
  const castImg = {};
  if (cast) {
    const keys = new Set();
    for (const sn of new Set(pages.map((q) => q.dataset.session).filter(Boolean)))
      for (const e of cast.sessions[sn] || []) for (const v of cast.characters[e.split("@")[0]]?.variants || []) keys.add(v.img);
    // a portrait not painted yet: an empty ink oval on paper (the character still shows, with its card)
    const blank = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 525 720"><rect width="525" height="720" fill="#f1ebde"/><ellipse cx="262" cy="330" rx="185" ry="250" fill="none" stroke="#8a6a44" stroke-width="5" stroke-dasharray="14 10" opacity=".6"/></svg>')}`;
    await Promise.all([...keys].map(async (k) => { castImg[k] = (await resolve(k)) || blank; }));
  }
  function castVariant(ch, S, idx) {
    let pick = null;
    for (const v of ch.variants || []) {
      const ok = S > v.from || (S === v.from && (!v.fromMap || !(v.fromMap in mapIdx) || idx >= mapIdx[v.fromMap]));
      if (ok) pick = v;
    }
    return pick;
  }
  let whoKey = null, whoOpen = null, whoNow = [];
  const whoEls = new Map();
  function castUpdate(page) {
    if (!cast) return;
    const S = +(page?.dataset.session || 0), idx = +(page?.dataset.idx ?? -1);
    const items = (cast.sessions[String(S)] || []).map((entry) => {
      const [id, joins] = entry.split("@");                       // "artus@artus-cellar": with the party from that page on
      const ch = cast.characters[id];
      if (joins && joins in mapIdx && idx < mapIdx[joins]) return null;
      if (ch?.untilMap && ch.untilMap in mapIdx && idx >= mapIdx[ch.untilMap]) return null;   // left the party at that page
      const v = ch && castVariant(ch, S, idx);
      return v && castImg[v.img] ? { id, v, name: v.name || ch.name } : null;
    }).filter(Boolean);
    whoNow = items;
    const key = items.map((x) => `${x.id}:${x.v.img}:${x.name}:${x.v.title}`).join("|");
    if (key === whoKey) return;
    whoKey = key;
    whoBox.classList.toggle("is-empty", !items.length);
    const keep = new Set(items.map((x) => x.id));
    for (const [id, e] of whoEls) if (!keep.has(id)) {          // leaving: fade and fold away
      whoEls.delete(id); e.classList.remove("is-in"); e.classList.add("is-out");
      setTimeout(() => e.remove(), 700);
    }
    items.forEach((x, i) => {
      let e = whoEls.get(x.id);
      if (!e) {
        e = el("button", "tj-who-c");
        e.type = "button";
        e.setAttribute("role", "listitem");
        e.append(el("img"));
        const r = seeded(hash(x.id));
        e.style.setProperty("--wr", `${((r() - 0.5) * 7).toFixed(1)}deg`);
        e.style.setProperty("--wy0", `${Math.round((r() - 0.5) * 6)}px`);
        e.addEventListener("pointerenter", (ev) => { if (ev.pointerType === "mouse") whoShow(e); });
        e.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse") whoHide(e); });
        e.addEventListener("focus", () => { if (e.matches(":focus-visible")) whoShow(e); });   // keyboard only (a tap focuses too)
        e.addEventListener("blur", () => whoHide(e));
        e.addEventListener("pointerdown", (ev) => { e._pt = ev.pointerType; });
        e.addEventListener("click", () => (whoOpen === e && e._pt !== "mouse" ? whoHide(e) : whoShow(e)));   // a tap toggles; a mouse already opened it on hover
        whoEls.set(x.id, e);
        requestAnimationFrame(() => requestAnimationFrame(() => e.classList.add("is-in")));
      }
      e.style.order = String(i);
      const img = e.querySelector("img"), url = castImg[x.v.img];
      if (img.dataset.k !== x.v.img) {
        if (img.dataset.k) {                                       // a new look (glaive, wings…): cross-fade
          e.classList.add("is-swap");
          setTimeout(() => { img.src = url; img.dataset.k = x.v.img; e.classList.remove("is-swap"); }, 350);
        } else { img.src = url; img.dataset.k = x.v.img; }
      }
      e._who = x;
      e.setAttribute("aria-label", `${x.name}: ${x.v.title}`);
      if (!e.isConnected) whoRow.append(e);
      if (whoOpen === e) whoFill(e);
    });
  }
  function whoFill(e) {
    const x = e._who;
    whoCard.querySelector("img").src = castImg[x.v.img];
    setText(whoCard.querySelector("b"), x.name);
    setText(whoCard.querySelector("i"), x.v.title);
    setText(whoCard.querySelector("p"), x.v.text || "");
    // who made the portrait, and in whose hand the card is written (Ofar paints his own; Luth draws his)
    setText(whoCard.querySelector(".cr"), x.v.credit || cast.defaults?.credit || "");
    whoCard.classList.toggle("is-hand-ofar", x.v.hand === "ofar");
    whoCard.classList.toggle("is-hand-luth", x.v.hand === "luth");
  }
  function whoShow(e) {
    if (!e._who) return;
    whoOpen = e;
    whoFill(e);
    whoCard.hidden = false;
    const st = stage.getBoundingClientRect(), r = e.getBoundingClientRect(), cw = whoCard.offsetWidth, ch = whoCard.offsetHeight;
    if (mode === "single") {      // phones: centred, like the map
      whoCard.style.left = `${Math.round((st.width - cw) / 2)}px`;
      whoCard.style.top = `${Math.round(Math.max(56, (st.height - ch) / 2))}px`;
    } else {                      // beside the strip, over the desk/book edge, inside the screen
      whoCard.style.left = `${Math.round(clamp(r.left - st.left - cw - 18, 8, st.width - cw - 8))}px`;
      whoCard.style.top = `${Math.round(clamp(r.top - st.top + r.height / 2 - ch / 2, 8, st.height - ch - 8))}px`;
    }
    requestAnimationFrame(() => whoCard.classList.add("is-on"));
  }
  function whoHide(e) {
    if (e && whoOpen !== e) return;
    whoOpen = null;
    whoCard.classList.remove("is-on");
    whoCard.hidden = true;
  }
  stage.addEventListener("pointerdown", (ev) => { if (whoOpen && !ev.target.closest(".tj-who-c, .tj-who-card")) whoHide(); });
  addEventListener("keydown", (ev) => { if (ev.key === "Escape" && whoOpen) whoHide(); });

  /* ---- loose sheets (figure.loose, DM feedback 61): a real handout lying in the book. It is part of its page, so it
     turns with it. Click / tap / Enter opens it large; a drag nudges it a little (kept for the session). ---- */
  const lb = $(".tj-lb"), lbImg = lb.querySelector("img"), lbClose = lb.querySelector(".tj-lb-close");
  let lbOpener = null;
  function lbOpen(f) {
    const img = f.querySelector("img");
    lbImg.src = img.currentSrc || img.src; lbImg.alt = img.alt;
    lb.classList.remove("is-zoom");
    lbOpener = f;
    lb.hidden = false;
    requestAnimationFrame(() => lb.classList.add("is-on"));
    lbClose.focus({ preventScroll: true });
  }
  function lbShut() {
    if (lb.hidden) return;
    lb.classList.remove("is-on"); lb.hidden = true;
    lbOpener?.focus?.({ preventScroll: true }); lbOpener = null;
  }
  lbClose.addEventListener("click", lbShut);
  lb.addEventListener("click", (e) => {
    if (e.target === lbImg) lb.classList.toggle("is-zoom");      // the letter at full size (phones: scroll to read)
    else if (!e.target.closest(".tj-lb-close")) lbShut();        // a click outside the sheet closes
  });
  addEventListener("keydown", (e) => { if (!lb.hidden && e.key === "Escape") { e.stopPropagation(); lbShut(); } }, true);
  const looseCopies = (id) => new Set([...pages.flatMap((q) => [...q.querySelectorAll(`figure.loose[data-loose="${id}"]`)]),
    ...root.querySelectorAll(`figure.loose[data-loose="${id}"]`)]);
  let lpress = null;
  book.addEventListener("pointerdown", (e) => {
    const f = e.target.closest?.(".tj-loose");
    if (!f || e.button !== 0 || gesture?.anim) return;
    const r = f.getBoundingClientRect();
    lpress = { f, id: e.pointerId, x0: e.clientX, y0: e.clientY, k: slotR.getBoundingClientRect().width / PAGE_W || 1, moved: false,
      dx0: parseFloat(f.style.getPropertyValue("--ldx")) || 0, dy0: parseFloat(f.style.getPropertyValue("--ldy")) || 0, r };
    f.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  book.addEventListener("pointermove", (e) => {
    if (!lpress || e.pointerId !== lpress.id) return;
    const dx = e.clientX - lpress.x0, dy = e.clientY - lpress.y0;
    if (!lpress.moved && Math.hypot(dx, dy) < 6) return;
    lpress.moved = true;
    const nx = clamp(lpress.dx0 + dx / lpress.k, -46, 46), ny = clamp(lpress.dy0 + dy / lpress.k, -46, 24);
    lpress.nx = Math.round(nx); lpress.ny = Math.round(ny);
    lpress.f.style.setProperty("--ldx", `${lpress.nx}px`); lpress.f.style.setProperty("--ldy", `${lpress.ny}px`);
  });
  const lend = (e) => {
    if (!lpress || e.pointerId !== lpress.id) return;
    const P = lpress; lpress = null;
    if (!P.moved) return;   // a plain press opens it on "click" (on touch, the click would otherwise land on the opened lightbox)
    lnoClick = true; setTimeout(() => { lnoClick = false; }, 0);
    for (const c of looseCopies(P.f.dataset.loose)) { c.style.setProperty("--ldx", `${P.nx}px`); c.style.setProperty("--ldy", `${P.ny}px`); }
    try { sessionStorage.setItem(`tj-loose:${P.f.dataset.loose}`, JSON.stringify([P.nx, P.ny])); } catch { /* private mode */ }
  };
  let lnoClick = false;
  book.addEventListener("pointerup", lend);
  book.addEventListener("pointercancel", lend);
  book.addEventListener("click", (e) => {
    const f = e.target.closest?.(".tj-loose");
    if (f && !lnoClick && !gesture?.anim) lbOpen(f);
  });
  book.addEventListener("keydown", (e) => {
    const f = e.target.closest?.(".tj-loose");
    if (f && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); lbOpen(f); }
  });

  /* ---- DM's notes (aside.dmnote): a gold sigil on the page; hover / keyboard focus / tap shows the note in the DM's card ---- */
  const dmCard = $(".tj-dm-card");
  let dmOpen = null, dmHideT = 0;
  function dmShow(d) {
    clearTimeout(dmHideT);
    dmOpen = d;
    dmCard.querySelector("p").textContent = d.dataset.text || "";
    dmCard.hidden = false;
    const st = stage.getBoundingClientRect(), r = d.getBoundingClientRect(), cw = dmCard.offsetWidth, ch = dmCard.offsetHeight;
    if (mode === "single") {
      dmCard.style.left = `${Math.round((st.width - cw) / 2)}px`;
      dmCard.style.top = `${Math.round(Math.max(56, (st.height - ch) / 2))}px`;
    } else {   // beside the sigil (to its right if there's room), inside the screen
      const right = r.right - st.left + 14, left = r.left - st.left - cw - 14;
      dmCard.style.left = `${Math.round(right + cw < st.width - 8 ? right : Math.max(8, left))}px`;
      dmCard.style.top = `${Math.round(clamp(r.top - st.top + r.height / 2 - ch / 2, 8, st.height - ch - 8))}px`;
    }
    requestAnimationFrame(() => dmCard.classList.add("is-on"));
  }
  function dmHide(now) {
    clearTimeout(dmHideT);
    const go = () => { dmOpen = null; dmCard.classList.remove("is-on"); dmCard.hidden = true; };
    if (now) go(); else dmHideT = setTimeout(go, 140);
  }
  book.addEventListener("pointerover", (e) => { const d = e.target.closest?.(".tj-dm"); if (d && e.pointerType === "mouse") dmShow(d); });
  book.addEventListener("pointerout", (e) => { const d = e.target.closest?.(".tj-dm"); if (d && e.pointerType === "mouse" && !d.contains(e.relatedTarget)) dmHide(); });
  book.addEventListener("focusin", (e) => { const d = e.target.closest?.(".tj-dm"); if (d && d.matches(":focus-visible")) dmShow(d); });
  book.addEventListener("focusout", (e) => { if (e.target.closest?.(".tj-dm")) dmHide(); });
  book.addEventListener("click", (e) => {
    const d = e.target.closest?.(".tj-dm");
    if (!d) return;
    e.stopPropagation();
    if (dmOpen === d && dmCard.classList.contains("is-on") && e.pointerType !== "mouse") dmHide(true); else dmShow(d);   // a tap toggles
  });
  book.addEventListener("keydown", (e) => { const d = e.target.closest?.(".tj-dm"); if (d && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); dmShow(d); } });
  stage.addEventListener("pointerdown", (e) => { if (dmOpen && !e.target.closest(".tj-dm, .tj-dm-card")) dmHide(true); });
  addEventListener("keydown", (e) => { if (dmOpen && e.key === "Escape") { e.stopPropagation(); dmHide(true); } }, true);
  addEventListener("scroll", () => { if (dmOpen) dmHide(true); }, { passive: true });
  for (const kind of ["blood", "water"]) {
    if (!pages.some((q) => q.querySelector(`.tj-stain.is-${kind}`))) continue;
    const url = await resolve(`stain_${kind}`);
    if (url) root.style.setProperty(`--tj-stain-${kind}`, `url("${url}")`);
  }

  /* ---- vanishing pages: once a .divine page lies open and settled for VANISH_DELAY, its words are blown off one by one in
     reading order (left page, then right), slower than anyone reads. Count per data-vanish id in sessionStorage. ---- */
  // words per second the wind takes; how fast we assume a reader reads (≈180 wpm, for when a later page on the spread starts);
  // ms the spread must lie still before the wind starts; the longest letter flight
  const VANISH_RATE = 2.3, READ_RATE = 3, VANISH_DELAY = 2500;
  const vPages = pages.filter((q) => q.dataset.vanish);
  const vTotal = new Map(vPages.map((q) => [q.dataset.vanish, q.querySelectorAll(".vw").length]));
  const vCount = new Map();
  const vStore = (id, n) => { if (n != null) { vCount.set(id, n); try { sessionStorage.setItem(`tj-vanish:${id}`, String(n)); } catch { /* private mode */ } }
    if (!vCount.has(id)) { let v = 0; try { v = +sessionStorage.getItem(`tj-vanish:${id}`) || 0; } catch { /* no storage */ } vCount.set(id, v); }
    return vCount.get(id); };
  const vanish = { timers: [], key: "" };
  const vanishStop = () => { vanish.timers.forEach(clearTimeout); vanish.timers = []; };
  // the page itself (not always in the DOM; later clones are made from it) and its clones on screen / in the leaf cache
  const copiesOf = (q) => new Set([q, ...root.querySelectorAll(`.tj-face--page[data-idx="${q.dataset.idx}"]`)]);
  const shown = (c) => !c.checkVisibility || c.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
  // one continuous compositor animation per letter (Web Animations: no per-frame script, and unlike a CSS animation it
  // doesn't restart when its page is moved to another slot); the word leaves a faint ink stain that soaks into the paper
  const STAIN_MS = 7000;
  function flyWord(w) {
    w.classList.add("fly");
    let end = 0;
    for (const l of w.querySelectorAll(".vl")) {
      const [fx, fy, fr, d, del] = l.dataset.f.split(",").map(Number);
      const o = { duration: reduced ? 1400 : d, delay: del, fill: "both" };
      if (!reduced) l.animate([{ transform: "translate(0px, 0px) rotate(0deg) scale(1)" }, { transform: `translate(${fx}px, ${fy}px) rotate(${fr}deg) scale(.72)` }],
        { ...o, easing: "cubic-bezier(.25, .55, .4, 1)" });
      l.animate([{ opacity: 1 }, { opacity: 1, offset: reduced ? 0 : 0.3 }, { opacity: 0 }], { ...o, easing: "linear" });
      end = Math.max(end, o.duration + del);
    }
    w.animate([{ opacity: 0.3 }, { opacity: 0.25, offset: 0.2 }, { opacity: 0 }], { pseudoElement: "::before", duration: STAIN_MS, easing: "ease-in-out", fill: "both" });
    setTimeout(() => {   // settled: nothing remains (and a later clone of the page must not replay it)
      w.classList.replace("fly", "gone");
      w.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    }, Math.max(end, STAIN_MS) + 100);
  }
  function blowWord(q, i, fly) {
    for (const c of copiesOf(q)) {
      const w = c.querySelector(`.vw[data-w="${i}"]`);
      if (!w || w.classList.contains("gone") || w.classList.contains("fly")) continue;
      if (fly && shown(c)) flyWord(w);
      else w.classList.add("gone");
    }
  }
  /* ---- a creature crossing a page once it's open: data-critter="ant" on a section, or the book's `critters` by page key
     ("s23.3" = the third page of session 23). DM: a red ant over Ofar's ant nightmare (Book I, S23 p3). Once per visit
     of the spread, after it has settled; nothing runs otherwise, and nothing at all with reduced motion. ---- */
  const critterKeys = vol.critters ?? ((vol.volume || 1) === 1 ? { "s23.3": "ant" } : {});
  { const seen = {}; for (const q of pages) { const s = q.dataset.session || "0"; seen[s] = (seen[s] || 0) + 1; const k = critterKeys[`s${s}.${seen[s]}`]; if (k && !q.dataset.critter) q.dataset.critter = k; } }
  const hasCritters = pages.some((q) => q.dataset.critter === "ant");
  const crit = { spread: -1, done: false, timer: 0, el: null, anims: [] };
  function critterStop() {
    clearTimeout(crit.timer);
    for (const a of crit.anims) a.cancel();
    crit.anims = [];
    crit.el?.remove();
    crit.el = null;
  }
  function critterCheck() {
    if (!hasCritters || reduced) return;
    if (frozen) { critterStop(); return; }
    if (curS !== crit.spread) { crit.spread = curS; crit.done = false; critterStop(); }
    if (crit.done || gesture || document.hidden || Math.abs(pRender - scrollPos()) > 0.002 || locate(pRender).t > 0.0003) return;
    const face = shownFaces().find((f) => f.dataset.critter === "ant");
    if (!face) return;
    crit.done = true;
    crit.timer = setTimeout(() => crawl(face), 900);   // (once the reader has had a moment with the page)
  }
  function crawl(face) {
    if (!face.isConnected) return;
    const layer = el("div", "tj-critters"), ant = el("i", "tj-ant"), win = el("i", "tj-ant-win", ANT_SVG);
    ant.append(win);
    layer.append(ant);
    face.append(layer);
    crit.el = layer;
    // a wandering line over the paper from one side to the other, around the pictures (an ant on a painting is invisible)
    const W = PAGE_W, H = PAGE_H, fr = face.getBoundingClientRect(), k = fr.width / (face.offsetWidth || W);
    const boxes = [...face.querySelectorAll(".tj-page figure, .tj-page aside.note")].map((f) => {
      const r = f.getBoundingClientRect();
      return [(r.left - fr.left) / k - 14, (r.top - fr.top) / k - 14, (r.right - fr.left) / k + 14, (r.bottom - fr.top) / k + 14];
    });
    let pts = null, best = Infinity;
    for (let tries = 0; tries < 40 && best > 0; tries++) {
      const ltr = Math.random() < 0.5;
      const A = [ltr ? -16 : W + 16, H * (0.08 + Math.random() * 0.84)], B = [ltr ? W + 16 : -16, H * (0.08 + Math.random() * 0.84)];
      const ctl = [A, ...[0.2, 0.42, 0.64, 0.84].map((q) => [lerp(A[0], B[0], q), clamp(lerp(A[1], B[1], q) + (Math.random() - 0.5) * 120, 30, H - 30)]), B];
      const cand = [];
      for (let i = 0; i < ctl.length - 1; i++) {   // Catmull-Rom through the control points
        const p0 = ctl[i - 1] || ctl[i], p1 = ctl[i], p2 = ctl[i + 1], p3 = ctl[i + 2] || p2;
        for (let u = 0; u < 1; u += 1 / 14) {
          const u2 = u * u, u3 = u2 * u, c = (a, b, cc, d) => 0.5 * (2 * b + (-a + cc) * u + (2 * a - 5 * b + 4 * cc - d) * u2 + (-a + 3 * b - 3 * cc + d) * u3);
          cand.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
        }
      }
      cand.push(B);
      const hits = cand.filter(([x, y]) => boxes.some(([x0, y0, x1, y1]) => x > x0 && x < x1 && y > y0 && y < y1)).length;
      if (hits < best) { best = hits; pts = cand; }
    }
    const SPEED = 120, PAUSE = 520;   // design px per second (a real ant's pace at this page's scale); one stop to feel the air
    let len = 0, prevA = null;
    const key = pts.map((p, i) => {
      if (i) len += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
      const q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(i - 1, 0)];
      let a = (Math.atan2(q[1] - o[1], q[0] - o[0]) * 180) / Math.PI;
      if (prevA !== null) a += 360 * Math.round((prevA - a) / 360);   // no spins through ±180°
      prevA = a;
      return { x: p[0], y: p[1], a, t: (1000 * len) / SPEED };
    });
    const iStop = Math.floor(key.length * (0.38 + Math.random() * 0.2)), tStop = key[iStop].t;
    const frames = [];
    for (const [i, k] of key.entries()) {
      frames.push({ ...k, t: k.t + (i > iStop ? PAUSE : 0) });
      if (i === iStop) frames.push({ ...k, a: k.a + 14, t: k.t + PAUSE * 0.45 }, { ...k, a: k.a - 4, t: k.t + PAUSE });
    }
    const total = frames[frames.length - 1].t;
    const walk = ant.animate(frames.map((k) => ({ transform: `translate(${k.x.toFixed(1)}px, ${k.y.toFixed(1)}px) rotate(${k.a.toFixed(1)}deg)`, offset: k.t / total })),
      { duration: total, easing: "linear", fill: "both" });
    const gait = win.firstElementChild.animate([{ transform: "translateX(0)" }, { transform: "translateX(-108px)" }], { duration: 240, easing: "steps(4)", iterations: Infinity });
    crit.anims = [walk, gait];
    crit.timer = setTimeout(() => { gait.pause(); crit.timer = setTimeout(() => gait.play(), PAUSE); }, tStop);
    walk.onfinish = critterStop;
  }
  document.addEventListener("visibilitychange", () => critterCheck());

  /* ---- spheres of annihilation (DM round 24): around a sphere the picture slowly bends. A live WebGL lens on top of the
     warp already baked into the image (tools/sphere_warp.py): <img data-sphere="cx cy r">, fractions of the untrimmed
     picture. Only while the spread rests and the tab is visible: one small canvas per sphere, ~30 fps; stopped (and its
     context released) for any turn, drag or lift; nothing at all with reduced motion or without WebGL. ---- */
  const hasSpheres = pages.some((q) => q.querySelector("img[data-sphere], img[data-ants]"));
  const sph = { spread: -1, runs: [], retry: 0 };
  const SPH_FS = `precision mediump float;
varying vec2 v; uniform sampler2D img; uniform vec4 box; uniform vec2 c; uniform float r, asp, t, amp;
void main() {
  vec2 uv = vec2(box.x + v.x * box.z, box.y + (1.0 - v.y) * box.w);
  vec2 d = vec2(uv.x - c.x, (uv.y - c.y) * asp) / r;
  float dist = length(d);
  float f = clamp((3.0 - dist) / 2.0, 0.0, 1.0); f = f * f * (3.0 - 2.0 * f);
  if (dist < 1.0 || f <= 0.0) { gl_FragColor = vec4(0.0); return; }
  float a = atan(d.y, d.x) + amp * 0.26 * f * f * sin(t * 0.9 + dist * 2.5);
  float ds = dist * (1.0 + amp * 0.08 * f * sin(t * 1.3 + a * 2.0));
  vec4 s = texture2D(img, c + vec2(cos(a), sin(a) / asp) * ds * r);
  float k = smoothstep(0.0, 0.35, f) * smoothstep(1.0, 1.06, dist);
  gl_FragColor = vec4(s.rgb * s.a * k, s.a * k);
}`;
  function sphereStop() {
    for (const run of sph.runs) run();
    sph.runs = [];
    sph.spread = -1;
    for (const c of root.querySelectorAll("canvas.tj-sphere")) c.remove();   // (copies left in faces the engine cloned)
  }
  function sphereCheck() {
    if (!hasSpheres || reduced) return;
    if (frozen) { if (sph.spread !== -1) sphereStop(); return; }
    const rest = !gesture && !document.hidden && Math.abs(pRender - scrollPos()) <= 0.002 && locate(pRender).t <= 0.0003
      && (!F || F.kind !== "paper" || F.box.classList.contains("is-rest"));
    if (!rest) { if (sph.spread !== -1) sphereStop(); return; }
    if (sph.spread === curS) return;
    sphereStop();
    sph.spread = curS;
    for (const f of shownFaces()) for (const img of f.querySelectorAll("img[data-sphere], img[data-ants]")) {
      if (!img.complete || !img.naturalWidth) { sph.spread = -1; clearTimeout(sph.retry); sph.retry = setTimeout(sphereCheck, 250); continue; }   // (not decoded yet: look again shortly)
      const stop = img.dataset.ants ? antsWalk(img) : sphereLens(img);
      if (stop) sph.runs.push(stop);
    }
  }
  function sphereLens(img) {
    const [cx0, cy0, r0] = img.dataset.sphere.split(/\s+/).map(Number);
    const T = data.trim?.[img.dataset.asset] || [0, 0, 1, 1], tw = T[2] - T[0], th = T[3] - T[1];
    const cx = (cx0 - T[0]) / tw, cy = (cy0 - T[1]) / th, r = r0 / tw, asp = img.naturalHeight / img.naturalWidth;
    const W = img.offsetWidth, H = img.offsetHeight, R = 3.05 * r * W;
    if (!W || !H) return null;
    const x0 = Math.max(0, cx * W - R), y0 = Math.max(0, cy * H - R), x1 = Math.min(W, cx * W + R), y1 = Math.min(H, cy * H + R);
    const dpr = Math.min(2, devicePixelRatio || 1), cv = document.createElement("canvas");
    cv.className = "tj-sphere";
    cv.width = Math.max(1, Math.round((x1 - x0) * dpr));
    cv.height = Math.max(1, Math.round((y1 - y0) * dpr));
    Object.assign(cv.style, { left: `${img.offsetLeft + x0}px`, top: `${img.offsetTop + y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
    const gl = cv.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) return null;
    const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return o; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, "attribute vec2 p; varying vec2 v; void main() { v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }"));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, SPH_FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pa = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(pa);
    gl.vertexAttribPointer(pa, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); } catch { return null; }
    const U = (n) => gl.getUniformLocation(prog, n);
    gl.uniform4f(U("box"), x0 / W, y0 / H, (x1 - x0) / W, (y1 - y0) / H);
    gl.uniform2f(U("c"), cx, cy);
    gl.uniform1f(U("r"), r);
    gl.uniform1f(U("asp"), asp);
    const uT = U("t"), uA = U("amp"), t0 = performance.now();
    let raf = 0, last = 0;
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 33) return;   // ~30 fps is plenty for something this slow
      last = now;
      // the swirl wakes slowly after a turn (DM round 26: it "plopped in"): from the still, baked lens to full in ~3 s
      const w = Math.min(1, (now - t0) / 3000);
      gl.uniform1f(uA, w * w * (3 - 2 * w));
      gl.uniform1f(uT, (now - t0) / 1000);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    img.parentElement.appendChild(cv);
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); gl.getExtension("WEBGL_lose_context")?.loseContext(); cv.remove(); };
  }
  /* ---- live ants on a picture (DM round 25, s21_note: "make the small ants on this tree crawl along the tree as an
     animation; they should stay in this image only"). <img data-ants="x y x y …; x y …">: paths in fractions of the
     untrimmed picture, along the painted streams; ants walk each from its first point to its last, fading in and out at
     the ends, a little stop-and-go. A 2D canvas over the picture, ~30 fps, run by sphereCheck: only while the spread
     rests, never with reduced motion (the painted ants stay in the picture either way). ---- */
  let antSprite = null;
  function antsWalk(img) {
    const T = data.trim?.[img.dataset.asset] || [0, 0, 1, 1], tw = T[2] - T[0], th = T[3] - T[1];
    const W = img.offsetWidth, H = img.offsetHeight;
    if (!W || !H) return null;
    const paths = img.dataset.ants.split(";").map((s) => {
      const v = s.trim().split(/\s+/).map(Number), pts = [], seg = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push([((v[i] - T[0]) / tw) * W, ((v[i + 1] - T[1]) / th) * H]);
      for (let i = 1; i < pts.length; i++) seg.push(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      return { pts, seg, len: seg.reduce((x, y) => x + y, 0) };
    }).filter((q) => q.len > 0);
    const at = (q, d) => {   // → [x, y, heading] at distance d along path q
      let i = 0;
      while (i < q.seg.length - 1 && d > q.seg[i]) d -= q.seg[i++];
      const a = q.pts[i], b = q.pts[i + 1], k = Math.min(1, d / q.seg[i]);
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, Math.atan2(b[1] - a[1], b[0] - a[0])];
    };
    const dpr = Math.min(2, devicePixelRatio || 1), cv = document.createElement("canvas");
    cv.className = "tj-sphere";   // (the same live-overlay class: removed with the lenses)
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    Object.assign(cv.style, { left: `${img.offsetLeft}px`, top: `${img.offsetTop}px`, width: `${W}px`, height: `${H}px` });
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    const size = Math.max(5, W * 0.013), r = seeded(hash(img.dataset.asset || "ants")), ants = [];   // as long as the painted ants
    for (const q of paths) for (let d = r() * size; d < q.len; d += size * (2.2 + r() * 2.4)) ants.push({ q, d, v: size * (0.8 + r() * 0.6), j: r() * 6.28 });
    if (!antSprite) { antSprite = new Image(); antSprite.src = `data:image/svg+xml,${encodeURIComponent(ANT_SVG)}`; }
    let raf = 0, last = 0, prev = performance.now();
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 33) return;
      last = now;
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      if (!antSprite.complete) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      for (const a of ants) {
        a.d = (a.d + a.v * dt * Math.max(0, 0.55 + 0.6 * Math.sin(now / 520 + a.j))) % a.q.len;   // walk, pause, walk
        const [x, y, h] = at(a.q, a.d);
        ctx.globalAlpha = Math.max(0, Math.min(1, a.d / (size * 2), (a.q.len - a.d) / (size * 2)));
        ctx.setTransform(dpr, 0, 0, dpr, x * dpr, y * dpr);
        ctx.rotate(h + 0.18 * Math.sin(now / 170 + a.j));
        ctx.drawImage(antSprite, (Math.floor(a.d / (size * 0.3)) % 4) * 22, 0, 22, 18, -size * 0.55, -size * 0.45, size * 1.1, size * 0.9);
      }
    };
    img.parentElement.appendChild(cv);
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); cv.remove(); };
  }
  document.addEventListener("visibilitychange", () => sphereCheck());

  function vanishReset() {   // debug: bring every word back and forget the session's progress
    vanishStop(); vanish.key = "";
    for (const q of vPages) {
      vStore(q.dataset.vanish, 0);
      try { sessionStorage.removeItem(`tj-vanish:${q.dataset.vanish}`); } catch { /* no storage */ }
      for (const c of copiesOf(q)) c.querySelectorAll(".vw.fly, .vw.gone").forEach((w) => { w.getAnimations({ subtree: true }).forEach((a) => a.cancel()); w.classList.remove("fly", "gone"); });
    }
  }
  function vanishRestore() {
    if (new URLSearchParams(location.search).has("vanish-reset")) vanishReset();
    for (const q of vPages) for (let i = 0, n = Math.min(vStore(q.dataset.vanish), vTotal.get(q.dataset.vanish)); i < n; i++) blowWord(q, i, false);
  }
  function vanishVisible() {   // divine pages on the spread that is open and settled right now, in reading order
    if (frozen || !vPages.length || gesture || document.hidden || Math.abs(pRender - scrollPos()) > 0.002) return [];
    const { s, t } = locate(pRender);
    if (t > 0.0003 && t < 0.9997) return [];
    const sp = t > 0.5 ? s + 1 : s, L = leaves.length;
    const left = mode === "double" && sp > 0 && sp - 1 < L ? facePage(leaves[sp - 1].back) : null;
    const right = sp < L ? facePage(leaves[sp].front) : null;
    return [left, right].filter((q) => q?.dataset.vanish);
  }
  function vanishCheck() {
    const vis = vanishVisible(), key = vis.map((q) => q.dataset.vanish).join(",");
    if (key === vanish.key) return;
    vanishStop();
    vanish.key = key;
    // each page has its own wind; a later page on the spread starts when a reader would get to it
    let wait = VANISH_DELAY;
    for (const q of vis) {
      const id = q.dataset.vanish;
      vanish.timers.push(setTimeout(() => vanishStep(q), wait));
      wait += (1000 * (vTotal.get(id) - vStore(id))) / READ_RATE;
    }
  }
  function vanishStep(q) {
    const id = q.dataset.vanish, n = vStore(id);
    if (n >= vTotal.get(id)) return;   // the page is empty
    blowWord(q, n, true);
    vStore(id, n + 1);
    vanish.timers.push(setTimeout(() => vanishStep(q), 1000 / VANISH_RATE));
  }
  document.addEventListener("visibilitychange", () => vanishCheck());

  let lastP = -1;
  function update(force, pIn) {
    const p = pIn ?? pRender;
    if (!force && Math.abs(p - lastP) < 1e-6) return;
    lastP = p;
    const { s, u, t } = locate(p);
    const L = leaves.length;
    const isEnd = s >= L;
    const ls = s;
    const JL = jumpLeaf && jumpLeaf.s === s ? jumpLeaf : null;   // a jump turn running on this leaf

    if (ls !== curS) {
      curS = ls;
      place(slotL, ls > 0 ? leaves[ls - 1].back : null);
      place(slotR, ls + 1 < L ? leaves[ls + 1].front : null);
      fillLeaf(ls);
      if (jumpLeaf && jumpLeaf.s === ls) {   // a jump turn: the target's pages instead of the neighbours
        const J = jumpLeaf;
        if (J.fwd) place(slotR, J.to < L ? leaves[J.to].front : null);
        else place(slotL, J.to > 0 ? leaves[J.to - 1].back : null);
        for (const d of leafCache.values()) d.box.classList.add("is-parked");
        J.F.box.classList.remove("is-parked");
        F = J.F; F.last = -1; leafEl.hidden = false;
      }
      setHidden(boardL, !(mode === "double" && ls >= 1));
      setHidden(boardR, !(ls < L - 1));
      const left = Math.max(0, ls - 1), right = Math.max(0, L - 2 - ls);
      setVar(slotL, "--stackw", `${Math.min(7, Math.ceil(left / 2))}px`);
      setVar(slotR, "--stackw", `${Math.min(7, Math.ceil(right / 2))}px`);
      preloadEnvs(ls);
    }

    // the turning leaf
    if (F) {
      const tt = reduced ? (t < 0.5 ? 0 : 1) : t;
      if (F.kind === "paper") {
        renderFold(tt, gesture && gesture.leaf === s && gesture.P ? { P: gesture.P, top: gesture.top } : null);
        setVar(castL, "--co", "0"); setVar(castR, "--co", "0");
      } else {
        const xEnd = renderBoard(tt);
        if (xEnd !== undefined) {
          const lift = Math.sin(Math.PI * tt);
          const [on, off] = xEnd >= 0 ? [castR, castL] : [castL, castR];
          setVar(on, "--cx", `${Math.abs(xEnd).toFixed(1)}px`); setVar(on, "--co", (0.85 * lift).toFixed(3));
          setVar(off, "--co", "0");
        }
      }
    } else {
      setVar(castL, "--co", "0"); setVar(castR, "--co", "0");
    }

    // book position: closed front centred → open → closed back centred
    let shift = 0, shL = -(PAGE_W + BOARD), shW = 2 * (PAGE_W + BOARD);
    if (mode === "double") {
      if (s === 0) { const k = easeInOut(t); shift = lerp(-PAGE_W / 2, 0, k); shL = lerp(0, -(PAGE_W + BOARD), k); shW = lerp(PAGE_W + BOARD, 2 * (PAGE_W + BOARD), k); }
      else if (s === L - 1) { const k = easeInOut(t); shift = lerp(0, PAGE_W / 2, k); shL = -(PAGE_W + BOARD); shW = lerp(2 * (PAGE_W + BOARD), PAGE_W + BOARD, k); }
      else if (isEnd) { shift = PAGE_W / 2; shL = -(PAGE_W + BOARD); shW = PAGE_W + BOARD; }
    } else {
      shL = 0; shW = PAGE_W + BOARD;
    }
    curShift = shift;
    setVar(book, "--shift", `${shift.toFixed(2)}px`);
    setVar(shadow, "--shift", `${shift.toFixed(2)}px`);
    setVar(shadow, "--shl", `${shL.toFixed(2)}px`);
    setVar(shadow, "--shw", `${shW.toFixed(2)}px`);

    // tabs follow their page
    for (const tb of tabs) {
      const pl = tb.page._leaf;
      const onLeft = JL ? pl < (t > 0.5 ? JL.to : JL.from) : pl < s || (pl === s && t > 0.5) || isEnd;
      tb.el.classList.toggle("is-left", onLeft);
      tb.el.classList.toggle("is-right", !onLeft);
      setHidden(tb.el, (s === 0 && t < 0.6) || isEnd || (s === L - 1 && t > 0.3));
    }

    // which page are we on? (switch to the next spread's page halfway through the turn)
    const vs = clamp(JL ? (t > 0.5 ? JL.to : JL.from) : t > 0.5 ? s + 1 : s, 0, L);
    const page = contentPageAt(vs) || pages[0];
    if (page) {
      setEnv(page.dataset.env || "ship");
      const tab = (page.dataset.tab || "").split("·").map((x) => x.trim());
      const st = page.dataset.sessionStart;
      setText(hudN, st ? `${tab[0]} → ${st}` : tab[0] || "");
      setText(hudD, tab[1] || "");
    }
    castUpdate(page);
    // desk map: jumps to the waypoint of the spread being read (the CSS glides there), never per frame
    const pv = contentPageAt(vs) || pages[0];
    const wv = pv ? pageWp[+pv.dataset.idx] : 0;
    if (data.route.showAll) drawMap(-1, true);   // (Book III: no page names a stop; the desk shows the whole way)
    else drawMap(vs === 0 && !currentPageAt(0) ? -1 : wv, isEnd && u > 0.15);
    setText(hudP, data.route.showAll ? "" : M.wps[wv]?.label || "");

    setVar(prog.parentElement, "--prog", (p / totalVh).toFixed(2));
    hint.classList.toggle("is-gone", p > 0.08);
    endCard.classList.toggle("is-on", isEnd && u > 0.15);
    const hudA = String(s === 0 && t < 0.3 ? 0 : isEnd ? 0.4 : 1);
    setVar(hudSession, "opacity", hudA);
    setVar(hudP, "opacity", hudA);
    vanishCheck();
    critterCheck();
    sphereCheck();
    NT?.frame();
    if (DBG && window.__tjOnRender) window.__tjOnRender();
  }

  /* decode the desk backgrounds of nearby spreads ahead of time, so a cross-fade never waits for a decode */
  const envDecoded = new Map();
  function preloadEnvs(s) {
    for (let k = s - 2; k <= s + 3; k++) {
      const pg = contentPageAt(clamp(k, 0, leaves.length));
      const url = pg && envUrls[pg.dataset.env];
      if (!url || envDecoded.has(url)) continue;
      const im = new Image();
      im.src = url;
      envDecoded.set(url, im);
      im.decode?.().catch(() => {});
    }
  }

  /* ---- environments ---- */
  let envFront = 0;
  function setEnv(key) {
    if (key === envCur) return;
    envCur = key;
    root.dataset.env = key;
    const next = envEls[1 - envFront];
    next.dataset.env = key;
    next.style.backgroundImage = envUrls[key] ? `url("${envUrls[key]}")` : "";
    next.classList.add("is-on");
    envEls[envFront].classList.remove("is-on");
    envFront = 1 - envFront;
    const lamp = ENV_LIGHT[key] || ENV_LIGHT.ship;
    for (const l of lamps) {
      l.style.setProperty("--lx", lamp.x);
      l.style.setProperty("--ly", lamp.y);
      l.style.setProperty("--lc", lamp.c);
      l.style.setProperty("--lglow", String(lamp.glow ?? 0.18));
      l.style.setProperty("--lamb", lamp.amb || "14,8,3");
    }
    root.dataset.flicker = lamp.flicker || "none";
  }

  /* ---- map drawing: one sheet on the desk at a time, chosen by the waypoint of the spread being read ---- */
  let mapGi = -2, mapEnd = false, mapSheet = null, mapStale = false;
  const revealTimers = {};
  /* The ink reveals in a few steps (~8 fps) while the head glides: each step repaints the sheet's SVG once,
     instead of on every frame. */
  function revealRoute(S, from, to, animate) {
    clearTimeout(revealTimers[S.key]);
    const STEPS = !animate || reduced || Math.abs(to - from) < 1 ? 1 : 8, t0 = performance.now(), DUR = 950;
    const ease = cubicBezier(0.45, 0.05, 0.3, 1);
    const step = () => {
      const k = STEPS === 1 ? 1 : clamp((performance.now() - t0) / DUR);
      const len = from + (to - from) * ease(k);
      for (const l of S.legs) setVar(l.mask, "strokeDashoffset", `${(l.len + 1 - clamp(len - l.start, 0, l.len + 1)).toFixed(1)}`);
      showBubbles(S, len);
      revealTimers[S.key] = k < 1 ? setTimeout(step, DUR / STEPS) : 0;
    };
    step();
  }
  const showBubbles = (S, len) => S.wpEls.forEach((g) => g.classList.toggle("is-hidden", M.wps[+g.dataset.i].len > len + 2 || +g.dataset.i > Math.max(mapGi, mapEnd ? 1e9 : -1)));
  function drawMap(gi, end) {
    gi = Math.min(gi, M.wps.length - 1);   // (an empty route draws nothing)
    // phones: the desk card isn't shown (the map opens in the viewer, which only needs mapGi): skip its DOM work mid-turn
    if (mode === "single" && !root.classList.contains("map-open")) { mapGi = gi; mapEnd = end; mapStale = true; return; }
    if (gi === mapGi && end === mapEnd && !mapStale) return;
    mapStale = false;
    const prevGi = mapGi;
    mapGi = gi; mapEnd = end;
    const key = end ? "chult" : gi < 0 ? M.wps[0]?.sheet || "chult" : M.wps[gi].sheet;   // closed cover: where the book begins
    const lens = end ? Object.fromEntries(Object.values(M.sheets).map((S) => [S.key, S.total])) : gi < 0 ? {} : M.state[gi];
    if (key !== mapSheet) {
      mapSheet = key;
      for (const S of Object.values(M.sheets)) S.layer.classList.toggle("is-active", S.key === key);
      setText(M.title, `${M.sheets[key].title} — where we've been`);
    }
    for (const S of Object.values(M.sheets)) {
      const to = lens[S.key] ?? 0, from = S.cur ?? to;
      if (Math.abs(to - from) > 0.05 || S.cur === undefined) revealRoute(S, from, to, S.key === key);
      else if (!revealTimers[S.key]) showBubbles(S, to);   // another stop at the same distance (e.g. a sheet's first stop)
      S.cur = to;
      setVar(S.head, "offsetDistance", `${clamp(to, 0, S.total).toFixed(1)}px`);
      S.head.classList.toggle("is-off", !end && !(gi >= 0 && S.wps.some((w) => w.gi <= gi)));   // until a stop on this sheet is reached
    }
    const S = M.sheets[key];
    if (prevGi !== gi && gi >= 0 && !reduced && mode === "double") {   // the head pulses at a new stop (restarted without forcing a layout)
      S.head.querySelector("circle.pulse")?.animate([{ transform: "scale(.6)", opacity: 0.9 }, { transform: "scale(2.4)", opacity: 0 }],
        { duration: 1800, easing: "ease-out", iterations: 3 });
    }
    const VW = 380, VH = 520, [W, H] = S.size;
    const w = gi >= 0 ? M.wps[gi] : null;
    const zoom = end ? S.fitZoom : w?.zoom || 0.45;
    const [fx, fy] = end ? S.mid : w ? w.p : S.pointAt(0);
    const fit = (c, v, len) => (len * zoom <= v ? (v - len * zoom) / 2 : clamp(v / 2 - c * zoom, v - len * zoom, 0));   // centred if the sheet is smaller than the card
    setVar(S.pan, "--px", `${fit(fx, VW, W).toFixed(1)}px`);
    setVar(S.pan, "--py", `${fit(fy, VH, H).toFixed(1)}px`);
    setVar(S.pan, "--pz", zoom.toFixed(4));
  }
  M.wpEls.forEach((g, i) => {
    if (!g) return;
    const w = M.wps[i];
    const show = () => { M.tip.innerHTML = `<b>Session ${w.session}</b>${w.label}`; M.tip.classList.add("is-on"); };
    const hide = () => M.tip.classList.remove("is-on");
    g.addEventListener("mouseenter", show);
    g.addEventListener("mouseleave", hide);
    g.addEventListener("focus", show);
    g.addEventListener("blur", hide);
    g.addEventListener("click", () => {
      const pg = firstPageAt(i);
      if (pg) jumpTurn(pg._spread);
      root.classList.remove("map-open");
    });
  });
  const viewerUrls = { ...sheetUrls, chult: fullMapUrl || sheetUrls.chult };
  const viewerRoute = fullMapUrl ? data.route : { ...data.route, viewer: undefined }; // no island bake: show the desk sheet
  const MV = viewerUrls.chult ? buildMapViewer(stage, viewerRoute, viewerUrls, M, (id, gi) => {
    const pg = firstPageAt(gi);
    if (pg) jumpTurn(pg._spread);
  }) : null;
  M.map.addEventListener("click", (e) => {
    if (!MV || e.target.closest(".tj-wp")) return;
    MV.open(mapGi, mapEnd);
  });
  M.map.classList.toggle("is-openable", !!MV);
  /* ---- phones: a tab bar for the map, who's who and the bookmarks; the latter two open as a sheet from the bottom ---- */
  let psOpener = null;
  function psOpen(kind, btn) {
    const head = psheet.querySelector("b");
    psBody.replaceChildren();
    if (kind === "who") {
      head.textContent = "Who's who";
      for (const x of whoNow) {
        const c = el("div", `tj-pcard${x.v.hand ? ` is-hand-${x.v.hand}` : ""}`);
        c.dataset.who = x.id; c.dataset.name = x.name;
        const im = el("img"); im.src = castImg[x.v.img]; im.alt = ""; im.loading = "lazy";
        const tx = el("div", "tx");
        tx.append(el("b", "", esc(x.name)), el("i", "", esc(x.v.title)), el("p", "", esc(x.v.text || "")));
        const cr = x.v.credit || cast?.defaults?.credit;
        if (cr) tx.append(el("small", "", esc(cr)));
        c.append(im, tx);
        psBody.append(c);
      }
      if (!whoNow.length) psBody.append(el("p", "tj-pempty", "Nobody yet."));
    } else {
      head.textContent = vol.theme === "dm" ? "Chapters" : "Bookmarks";
      const cur = contentPageAt(restingSpread());
      const seen = new Set();
      for (const q of pages) {
        const key = vol.theme === "dm" ? (q.dataset.tab || "").match(/Chapter\s+[IVXLC]+/)?.[0] : q.dataset.session;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const [a2, b2] = (q.dataset.tab || key).split("·").map((t) => t.trim());
        const it = el("button", "tj-pmark", `<span class="n">${esc(a2)}</span><span class="d">${esc(b2 || "")}</span>`);
        it.type = "button";
        if (cur && (vol.theme === "dm" ? (cur.dataset.tab || "").startsWith(key) : cur.dataset.session === key)) it.classList.add("is-here");
        it.addEventListener("click", () => { psShut(); jumpTurn(q._spread); });
        psBody.append(it);
      }
    }
    psOpener = btn;
    psheet.hidden = false;
    requestAnimationFrame(() => { psheet.classList.add("is-on"); psBody.querySelector(".is-here")?.scrollIntoView({ block: "center" }); });
    psheet.querySelector(".tj-psheet-close").focus({ preventScroll: true });
  }
  function psShut() {
    if (psheet.hidden) return;
    psheet.classList.remove("is-on"); psheet.hidden = true;
    psOpener?.focus?.({ preventScroll: true });
  }
  pbar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-p]");
    if (!btn) return;
    if (btn.dataset.p === "map") { if (MV) MV.open(mapGi, mapEnd); else mapToggle.click(); return; }
    psOpen(btn.dataset.p, btn);
  });
  psheet.querySelector(".tj-psheet-close").addEventListener("click", psShut);
  psheet.addEventListener("click", (e) => { if (e.target === psheet) psShut(); });
  addEventListener("keydown", (e) => { if (!psheet.hidden && e.key === "Escape") { e.stopPropagation(); psShut(); } }, true);
  mapToggle.addEventListener("click", () => {
    if (MV) { MV.open(mapGi, mapEnd); return; }
    const open = root.classList.toggle("map-open");
    if (open) update(true);   // (the desk card catches up)
    mapToggle.setAttribute("aria-expanded", String(open));
    mapToggle.textContent = open ? "Close map" : "Map";
  });

  /* ---- margin notes: nudge a note into the nearest free gap if it lands on the text ----
     Positions come from the content (--x/--y); this only corrects collisions caused by real font metrics.
     Add data-fixed to a note to opt out. Also flags overflowing pages in dev mode. */
  const FIT_MARGIN = 28;            // content must end this far above the page bottom
  const fitted = [];
  /* Fit and fill each page once fonts are loaded (measured on clones, so pages never leave their place; see fitPage):
     - auto-fit: content too long for the page → smaller type (and figures), down to 90 %;
     - auto-fill: content ending above ~80 % of the page → larger type, a little more line-height and spacing,
       then wider figures, until it ends at ~85–92 % (never past the bottom margin). Exempt: endpaper, title,
       `.closing` and `data-sparse` pages. */
  const fillLog = [];
  const nBox = (n, base) => { const r = n.getBoundingClientRect(); return { top: r.top - base.top, bottom: r.bottom - base.top, left: r.left - base.left, right: r.right - base.left }; };
  const nHit = (a, b) => a.top < b.bottom - 2 && a.bottom > b.top + 2 && a.left < b.right && a.right > b.left;
  /* Can every margin note on this (clone of a) page sit without covering text — where it is, or in a free gap
     within reach (the same rule fitNotesOne() applies), at 82 % size at worst? */
  function notesPlaceable(face) {
    const base = face.getBoundingClientRect();
    const pg = face.querySelector(".tj-page");
    const blocks = [...pg.children].filter((ch) => !ch.matches("aside.note, aside.dmnote, .blot")).map((ch) => nBox(ch, base)).filter((b) => b.bottom - b.top > 1);
    for (const n of pg.querySelectorAll(":scope > aside.note")) {
      if (n.dataset.fixed != null) continue;
      const nb = nBox(n, base);
      if (!blocks.some((b) => nHit(nb, b)) && nb.bottom <= PAGE_H - 6) continue;
      const rel = blocks.filter((b) => b.right > nb.left && b.left < nb.right).sort((a, b) => a.top - b.top);
      let y = 6, ok = false;
      const h = (nb.bottom - nb.top) * 0.82 + 3, cy = (nb.top + nb.bottom) / 2;
      const gaps = [];
      for (const b of rel) { if (b.top - y > 0) gaps.push([y, b.top]); y = Math.max(y, b.bottom); }
      gaps.push([y, PAGE_H - 6]);
      for (const [g0, g1] of gaps) if (g1 - g0 >= h && Math.abs(clamp(cy - h / 2, g0, g1 - h) + h / 2 - cy) < 140) { ok = true; break; }
      if (!ok) return false;
    }
    return true;
  }
  const LIMIT = PAGE_H - FIT_MARGIN, LO = 0.85 * PAGE_H, HI = 0.92 * PAGE_H;
  const fitVars = ["--fit", "--lhk", "--pk", "--fw"];
  const applyFit = (f, v) => {
    f.style.setProperty("--fit", String(v.fit));
    f.style.setProperty("--lhk", String(v.lhk ?? 1));
    f.style.setProperty("--pk", String(v.pk ?? 1));
    f.style.setProperty("--fw", String(v.fw ?? 1));
  };
  const bottomOf = (face) => {
    const base = face.getBoundingClientRect().top;
    const pg = face.querySelector(".tj-page");
    return Math.max(0, ...[...pg.children].filter((ch) => !ch.matches("aside.note, aside.dmnote, .blot, figure.loose")).map((ch) => ch.getBoundingClientRect().bottom - base));
  };
  function autoFitOne(face, probe) {
    const c = face.cloneNode(true);
    c.removeAttribute("id");
    for (const k of fitVars) c.style.removeProperty(k);
    probe.append(c);
    let v = { fit: 1 }, bottom = bottomOf(c);
    const start = bottom;
    const exempt = face.matches(".is-endpaper, .is-title, .is-closing") || face.dataset.sparse != null || !!face.querySelector("figure.loose");   // (a loose sheet lies in the free space)
    if (bottom > LIMIT) {                                   // too long: shrink
      while (bottom > LIMIT && v.fit > 0.905) {
        v = { fit: Math.round((v.fit - 0.02) * 100) / 100 };
        applyFit(c, v); bottom = bottomOf(c);
      }
      fitted.push({ page: +face.dataset.idx, fit: v.fit });
    } else if (!exempt && bottom < 0.8 * PAGE_H && bottom > 0) {   // too empty: grow
      let best = { ...v }, bestB = bottom;
      const needNotes = notesPlaceable(c);      // don't let the text grow into the room its notes need
      const tryV = (nv) => {
        applyFit(c, nv);
        const nb = bottomOf(c);
        if ((nb <= Math.min(LIMIT, HI) || (nb <= LIMIT && bestB < LO)) && (!needNotes || notesPlaceable(c))) { best = nv; bestB = nb; return nb; }
        applyFit(c, best);
        return null;
      };
      // 1. type: size, a touch of line-height, more paragraph spacing
      for (let f = 1.02; f <= 1.121 && bestB < LO; f += 0.02) {
        const k = f - 1;
        if (tryV({ fit: +f.toFixed(2), lhk: +(1 + k * 0.45).toFixed(3), pk: +(1 + k * 4).toFixed(2), fw: best.fw ?? 1 }) === null) break;
      }
      // 2. figures, up to full width
      for (let w = 1.06; w <= 1.42 && bestB < LO; w += 0.06) {
        if (tryV({ ...best, fw: +w.toFixed(2) }) === null) break;
      }
      v = best; bottom = bestB;
      applyFit(c, v);
    }
    if (v.fit !== 1 || (v.fw ?? 1) !== 1) applyFit(face, v);
    else for (const k of fitVars) face.style.removeProperty(k);
    if (v.fit > 1 || (v.fw ?? 1) > 1) fillLog.push({ page: +face.dataset.idx, from: Math.round((100 * start) / PAGE_H), to: Math.round((100 * bottom) / PAGE_H), fit: v.fit, fw: v.fw ?? 1 });
    face._fill = bottom / PAGE_H;
    face._exempt = exempt;
    c.remove();
  }
  function fitReport() {
    root.dataset.autofit = JSON.stringify(fitted);
    if (!data.dev) return;
    if (fitted.length) console.warn("[journal] auto-fit:", fitted.map((f) => `page ${f.page} → ${Math.round(f.fit * 100)}%`).join(", "));
    const low = pages.filter((f) => !f._exempt && f._fill < 0.65).map((f) => `${f.dataset.idx} (${f.dataset.tab?.split("·")[0].trim()}, ${Math.round(f._fill * 100)}%)`);
    if (low.length) console.warn("[journal] under-filled (< 65 % after auto-fill):", low.join("; "));
  }

  function fitNotesOne(face, probe) {
    const c = face.cloneNode(true);
    c.removeAttribute("id");
    probe.append(c);
    const base = c.getBoundingClientRect();
    const pg = c.querySelector(".tj-page");
    const blocks = [...pg.children].filter((ch) => !ch.matches("aside.note, aside.dmnote, .blot")).map((ch) => ({ ...nBox(ch, base), loose: ch.matches("figure.loose") })).filter((b) => b.bottom - b.top > 1);
    const lastBottom = Math.max(0, ...blocks.filter((b) => !b.loose).map((b) => b.bottom));   // (a loose sheet may stick out)
    if (lastBottom > PAGE_H - FIT_MARGIN) {
      if (data.dev) { face.classList.add("is-overflowing"); console.warn("[journal] page overflows by", Math.round(lastBottom - PAGE_H + FIT_MARGIN), "px:", face.dataset.idx, face.dataset.tab); }
    }
    const notes = [...pg.querySelectorAll(":scope > aside.note")];
    const origs = [...face.querySelectorAll(".tj-page > aside.note")];
    notes.forEach((n, i) => {
      if (n.dataset.fixed != null) return;
      let nb = nBox(n, base);
      if (!blocks.some((b) => nHit(nb, b)) && nb.bottom <= PAGE_H - 6) return;   // on text, or running off the page
      const rel = blocks.filter((b) => b.right > nb.left && b.left < nb.right).sort((a, b) => a.top - b.top);
      const gaps = [];
      let y = 6;
      for (const b of rel) { if (b.top - y > 0) gaps.push([y, b.top]); y = Math.max(y, b.bottom); }
      gaps.push([y, PAGE_H - 6]);
      // try the note at full size, then a little smaller (people do write smaller to squeeze a note in)
      for (const k of [1, 0.9, 0.82, 0.74]) {
        if (k < 1) { n.style.setProperty("--nfs", String(k)); nb = nBox(n, base); }
        const h = nb.bottom - nb.top + 3, cy = (nb.top + nb.bottom) / 2;
        let best = null, bd = Infinity;
        for (const [g0, g1] of gaps) {
          if (g1 - g0 < h) continue;
          const top = clamp(cy - h / 2, g0, g1 - h);
          const d = Math.abs(top + h / 2 - cy);
          if (d < bd) { bd = d; best = top; }
        }
        if (best != null && bd < 140) {
          const newTop = n.offsetTop + (best + 1.5 - nb.top);
          origs[i].style.setProperty("--y", `${((newTop / PAGE_H) * 100).toFixed(2)}%`);
          if (k < 1) origs[i].style.setProperty("--nfs", String(k));
          return;
        }
      }
      if (data.dev) console.warn("[journal] note overlaps text, no free gap nearby:", face.dataset.idx, n.textContent.trim().slice(0, 40));
    });
    c.remove();
  }

  /* The fitting measures a clone of each page, ~25 ms a page: for a whole book that was seconds of a blocked page before
     it opened, and again when the other book was fetched (the click on it waited). So no page is fitted before it is
     needed: a page is fitted the moment it is about to be shown or prepared for a turn (place, cloneFace), and the rest
     in idle time, nearest the reader first. */
  const pageSet = new Set(pages);
  let fitProbeEl = null, fitReady = false;   // (no fitting before the fonts are in: see the mount)
  function fitPage(face) {
    if (!fitReady || !face || face._fitted || !pageSet.has(face)) return;
    face._fitted = true;
    if (!fitProbeEl?.isConnected) {
      fitProbeEl = el("div", "tj-slot tj-slot-right");
      fitProbeEl.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden";
      stage.append(fitProbeEl);
    }
    autoFitOne(face, fitProbeEl);
    fitNotesOne(face, fitProbeEl);
  }
  let fitTimer = 0;
  const idle = window.requestIdleCallback ? (f) => requestIdleCallback(f) : (f) => setTimeout(() => f(null), 150);   // (Safari: no idle callbacks)
  function fitIdle(deadline) {
    fitTimer = 0;
    const todo = pages.filter((f) => !f._fitted);
    if (!todo.length) { fitProbeEl?.remove(); fitReport(); return; }
    if (!gesture) {   // (never during a turn: one page is one long task)
      const at = restingSpread();
      todo.sort((a, b) => Math.abs(a._spread - at) - Math.abs(b._spread - at));
      const t0 = performance.now();
      for (const f of todo) {
        fitPage(f);
        if (deadline ? deadline.timeRemaining() < 12 : performance.now() - t0 > 12) break;
      }
    }
    fitTimer = idle(fitIdle);
  }
  const fitAll = () => { for (const f of pages) fitPage(f); fitReport(); };

  /* ---- ambience ----
     Lamp flicker, dust motes, ship sway/bob are CSS animations of opacity/transform only (compositor), and
     pause while the tab is hidden. JavaScript only runs while the reader scrolls (see the frame loop). */
  const onVis = () => root.classList.toggle("is-paused", document.hidden);
  document.addEventListener("visibilitychange", onVis);
  onVis();
  // (The desk light is static now: nothing animates on its own, so there's nothing to wake or calm.)

  /* ---- snapping: finish a half-turned page when the reader pauses ---- */
  let snapTimer = 0, snapLock = 0;
  function maybeSnap() {   // (scroll position scrubs only come from the scrollbar now) a page left mid-turn finishes from where it is
    if (reduced || data.noSnap || performance.now() < snapLock || gesture) return;
    const { s, t } = locate(scrollPos());
    if (s >= leaves.length || t <= 0 || t >= 1) return;
    if (locate(pRender).s !== s) { clearTimeout(snapTimer); snapTimer = setTimeout(maybeSnap, 120); return; }
    const T0 = locate(pRender).t;
    animateTurn(s, T0, T0 > 0.5 ? 1 : 0, { dur: 280 + 560 * (T0 > 0.5 ? 1 - T0 : T0) });
  }
  addEventListener("scroll", () => { if (frozen) return; kick(); clearTimeout(snapTimer); snapTimer = setTimeout(maybeSnap, 220); }, { passive: true });
  /* ---- wheel, trackpad and vertical touch swipes are intents, not scrubbing (DM 132) ----
     One gesture = one page turn, committed at once (a notch, or ~30 px of trackpad / finger travel) and run by the same
     animation as a click — the only owner of the visible progress; the document never scrolls under it. A gesture ends after
     a quiet gap, or when the motion picks up again after dying down (a new swipe during an inertia tail). Within a gesture
     the direction is locked: bounce / reverse ticks at its end are ignored. A new gesture during a turn queues one more. When
     no page is left that way (the first or the last), the gesture passes through, so the page around the book scrolls. */
  const INTENT_PX = 30, GAP_MS = 180;
  // A busy main thread (a slow machine, a huge screen) holds the wheel events back, and the browser merges what waited
  // into one event: its delta is the sum, its time that of the last notch. Gaps to such an event aren't pauses: one quick
  // spin then looked like two gestures and turned two pages (DM, at 4K). An event that waited over LATE_MS and is
  // clearly larger than the one before it is taken for such a merge, and continues the gesture.
  const LATE_MS = 60;
  // (DM round 28/29: turning more pages for more scrolling, by distance or by keeping the wheel going, was tried and
  // rolled back: one gesture is one page.) But a gesture that closes the book and keeps going for LEAVE_PX more once
  // the cover lies shut does leave it (web edition: the other book comes); otherwise a continuous spin never could.
  const LEAVE_PX = 90;
  const WG = { on: false, dir: 0, last: 0, mags: [], peak: 0, acc: 0, after: 0, committed: false, capture: false };
  let queued = 0, rootH = 0;
  const engaged = () => { const top = rootTop - scrollY; rootH ||= root.offsetHeight; return top <= 1 && top + rootH >= vh - 1; };
  const afterTurns = () => { const a = gesture?.anim; let sp = a ? Math.round(locate(a.final).s) : restingSpread(); return sp + queued; };
  const canTurn = (dir) => { const sp = afterTurns(); return dir > 0 ? sp < leaves.length : sp > 0; };
  // past the closed back cover (dir > 0) or the closed front cover (dir < 0): may the reader leave this book that way?
  const canLeave = (dir) => !canTurn(dir) && !gesture?.anim && !!data.canLeave?.(dir);
  // …or will be, once the turn that is shutting the cover now has ended (a scroll in its last moments waits for it)
  const willLeave = (dir) => !canTurn(dir) && !!gesture?.anim && !!data.canLeave?.(dir);
  let queuedLeave = 0;
  function startTurn(dir) {
    // a corner already lifted by the hover: the turn continues from it (it never drops back first)
    const pk = gesture?.peek ? gesture : null, sp = restingSpread(), { s: cs, t: ct } = locate(pRender);
    if (ct > 0.0003 && ct < 0.9997 && !pk) return animateTurn(cs, ct, dir > 0 ? 1 : 0, { dur: 260 + 520 * (dir > 0 ? 1 - ct : ct), ease: liftEase });
    if (dir > 0 && sp < leaves.length) {
      const P0 = pk && pk.leaf === sp && pk.P?.[0] > 0 ? pk.P : null;
      return animateTurn(sp, P0 ? clamp((PAGE_W - P0[0]) / (2 * PAGE_W), 0, 0.2) : 0, 1, { P0, top: P0 ? pk.top : false, dur: 760, ease: liftEase });
    }
    if (dir < 0 && sp > 0) {
      const P0 = pk && pk.leaf === sp - 1 && pk.P?.[0] < 0 ? pk.P : null;
      return animateTurn(sp - 1, P0 ? clamp((PAGE_W - P0[0]) / (2 * PAGE_W), 0.8, 1) : 1, 0, { P0, top: P0 ? pk.top : false, dur: 760, ease: liftEase });
    }
  }
  function requestTurn(dir) {
    if (gesture?.anim) { queued = dir; return; }   // one more, right after the running turn
    queued = 0;
    startTurn(dir);
  }
  function intent(sgn, mag, now, hard, waited = 0) {   // → whether this input belongs to a captured gesture (the caller then cancels its default)
    const recent = WG.mags.slice(-3), avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
    const merged = WG.on && sgn === WG.dir && waited > LATE_MS && mag > 1.5 * (WG.mags[WG.mags.length - 1] || Infinity);
    const fresh = !WG.on || (now - WG.last > GAP_MS && !merged)
      || (!merged && sgn === WG.dir && WG.peak > 0 && avg < WG.peak * 0.45 && mag > Math.max(2 * avg, 6) && mag > WG.mags[WG.mags.length - 1] * 1.6)   // picked up again
      || (sgn !== WG.dir && mag >= Math.max(60, 2.5 * avg));                                                                         // a deliberate reverse
    if (fresh) Object.assign(WG, { on: true, dir: sgn, mags: [], peak: 0, acc: 0, after: 0, committed: false, capture: canTurn(sgn) || canLeave(sgn) || willLeave(sgn) });
    WG.last = now;
    if (!WG.capture) return false;
    if (sgn !== WG.dir) return true;          // a bounce / reverse tick inside the gesture: swallowed
    WG.mags.push(mag); if (WG.mags.length > 8) WG.mags.shift();
    WG.peak = Math.max(WG.peak, mag);
    if (!WG.committed && ((WG.acc += mag) >= INTENT_PX || hard)) {
      WG.committed = true;
      if (canLeave(WG.dir)) data.leave(WG.dir);
      else if (willLeave(WG.dir)) { queuedLeave = WG.dir; WG.after = -Infinity; }
      else requestTurn(WG.dir);
    }
    else if (WG.committed && canLeave(WG.dir) && (WG.after += mag) >= LEAVE_PX) { WG.after = -Infinity; data.leave(WG.dir); }   // (only counts once the cover is shut: canLeave waits for the turn)
    return true;
  }
  const blocked = (t) => MV?.isOpen || !lb.hidden || !psheet.hidden || t?.closest?.(".tj-mv, .tj-psheet, .tj-lb, .tj-who-card, .tj-dm-card, .tj-nui");
  addEventListener("wheel", (e) => {
    if (frozen || e.ctrlKey || blocked(e.target) || !engaged()) return;
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : 0;
    if (!d) return;
    const px = d * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? vh : 1);
    // gaps are measured on the inputs' own time (a busy frame delays the handler, not the input); tests may pass e.tjTime
    const at = e.tjTime ?? (e.timeStamp || performance.now()), waited = e.tjTime === undefined ? performance.now() - at : 0;
    if (intent(Math.sign(px), Math.abs(px), at, e.deltaMode !== 0, waited)) e.preventDefault();
  }, { passive: false });
  let touch = null;   // vertical finger swipes (horizontal ones drag the page itself)
  addEventListener("touchstart", (e) => { touch = !frozen && e.touches.length === 1 && !blocked(e.target) ? { x: e.touches[0].clientX, y: e.touches[0].clientY, y1: e.touches[0].clientY, v: null } : null; }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (!touch || !engaged()) return;
    const tt = e.touches[0], dx = tt.clientX - touch.x, dy = tt.clientY - touch.y;
    if (touch.v === null) { if (Math.hypot(dx, dy) < 8) return; touch.v = Math.abs(dy) > Math.abs(dx); WG.on = false; }
    if (!touch.v || (root.classList.contains("is-notes") && !getSelection().isCollapsed)) return;   // (notes: adjusting a selection)
    const step = touch.y1 - tt.clientY; touch.y1 = tt.clientY;   // finger up = forward
    if (step && intent(Math.sign(step), Math.abs(step), e.timeStamp || performance.now(), false)) e.preventDefault();
    else if (WG.capture && WG.on) e.preventDefault();
  }, { passive: false });
  addEventListener("touchend", () => { touch = null; WG.on = false; }, { passive: true });
  addEventListener("touchmove", () => {
    if (frozen) return;
    glide = false;
    if (gesture && !gesture.dragging && !gesture.anim && !press) { gesture = null; if (F) F.last = -1; }
  }, { passive: true });

  /* ---- keyboard ---- */
  addEventListener("keydown", (e) => {
    if (frozen) return;
    const r = root.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    if (e.target.closest?.("input, textarea, [contenteditable], .tj-nui")) return;
    if (MV?.isOpen || !lb.hidden || !psheet.hidden) return;
    const { s, t } = locate(scrollPos());
    const cur = t > 0.5 ? s + 1 : s;
    const fwdKey = ["ArrowRight", "PageDown"].includes(e.key) || (e.key === " " && !e.shiftKey);
    const backKey = ["ArrowLeft", "PageUp"].includes(e.key) || (e.key === " " && e.shiftKey);
    if ((fwdKey || backKey) && canLeave(fwdKey ? 1 : -1)) { e.preventDefault(); data.leave(fwdKey ? 1 : -1); return; }
    glide = true;
    if (["ArrowRight", "PageDown"].includes(e.key) || (e.key === " " && !e.shiftKey)) { e.preventDefault(); if (gesture?.anim) jumpToSpread(cur + 1); else turnForward(); }
    else if (["ArrowLeft", "PageUp"].includes(e.key) || (e.key === " " && e.shiftKey)) { e.preventDefault(); if (gesture?.anim) jumpToSpread(cur - 1); else turnBack(); }
    else if (e.key === "Home") { e.preventDefault(); jumpToSpread(0); }
    else if (e.key === "Escape") root.classList.remove("map-open");
  });

  /* ---- turning by hand: click, drag, hover ---- */
  const invTurnEase = (T) => { let lo = 0, hi = 1; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; (turnEase(m) < T ? (lo = m) : (hi = m)); } return lo; };
  function pForTurn(leaf, T) {
    const turn = segs[leaf].turn;
    return segStart(leaf) + (1 - turn + turn * invTurnEase(clamp(T))) * segs[leaf].len;
  }
  const restP = (spread) => segStart(clamp(spread, 0, segs.length - 1)) + LEAD;
  function syncScroll(p) {   // keep the scroll position in step with the page we're turning to
    const rootTop = root.getBoundingClientRect().top + scrollY;
    snapLock = performance.now() + 500;
    scrollTo({ top: rootTop + p * vh, behavior: "instant" });
  }
  const restingSpread = () => { const { s, t } = locate(pRender); return t > 0.5 ? s + 1 : s; };
  /* animate leaf `leaf` from turn progress T0 to T1 (1 = turned onto the left side) */
  function animateTurn(leaf, T0, T1, { top = false, P0 = null, dur = 900, ease = turnEase, final = null } = {}) {
    if (leaf < 0 || leaf >= leaves.length) return;
    final ??= T1 >= 1 ? restP(leaf + 1) : restP(leaf);
    gesture = { leaf, top, P: P0, anim: { start: performance.now(), dur: reduced ? 1 : dur, T0, T1, ease, P0, final } };
    syncScroll(final);
    kick();
  }
  // a click while a page is still moving continues from where that page is (no jump back to 0)
  function turnForward() {
    const { s, t } = locate(pRender);
    if (t > 0.0003 && t < 0.9997) return animateTurn(s, t, 1, { dur: 300 + 600 * (1 - t) });
    const sp = restingSpread(); if (sp < leaves.length) animateTurn(sp, 0, 1);
  }
  function turnBack() {
    const { s, t } = locate(pRender);
    if (t > 0.0003 && t < 0.9997) return animateTurn(s, t, 0, { dur: 300 + 600 * t });
    const sp = restingSpread(); if (sp > 0) animateTurn(sp - 1, 1, 0);
  }

  // pointer → page coordinates (origin: spine, top of the page block; x < 0 is the left page)
  function toBook(e) {
    const r = slotR.getBoundingClientRect(), k = r.width / PAGE_W;
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
  }
  let press = null;
  const DRAG_START = 7;
  book.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || gesture?.anim) return;
    if (e.target.closest("button, a, input, select, textarea, .tj-tab, .tj-map, .tj-loose, .tj-dm")) return;
    const [x, y] = toBook(e);
    if (y < -BOARD || y > PAGE_H + BOARD) return;
    const sp = restingSpread();
    const single = mode === "single";
    if (root.classList.contains("is-notes") && !cornerZone(x, y, 0, true)) return;   // notes mode: the page is for selecting; corners still turn
    const back = single ? x < PAGE_W * 0.35 : x < 0;
    if (!back && sp >= leaves.length) return;
    if (back && sp <= 0) return;
    const leaf = back ? sp - 1 : sp;
    const outer = true;   // drags turn from anywhere on the page (the pages aren't selectable, DM 124)
    press = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), leaf, back, outer, bx: x, by: y,
              top: y < PAGE_H / 2, board: !!leaves[leaf]?.board, moved: false, samples: [[performance.now(), x]] };
    if (outer && !press.board) { e.preventDefault(); book.setPointerCapture?.(e.pointerId); }
  });
  book.addEventListener("pointermove", (e) => {
    if (!press || e.pointerId !== press.id) { hoverPeek(e); return; }
    const dx = e.clientX - press.x0, dy = e.clientY - press.y0;
    if (!press.moved && Math.hypot(dx, dy) < DRAG_START) return;
    if (!press.moved && mode === "single") {        // phones: a swipe to the left turns forward, to the right back
      if (Math.abs(dx) < Math.abs(dy)) return;      // (vertical: the page scrolls, which turns pages too)
      const sp = restingSpread(), back = dx > 0, leaf = back ? sp - 1 : sp;
      if (leaf < 0 || leaf >= leaves.length) { press = null; return; }
      if (leaves[leaf].board) { press = null; (back ? turnBack : turnForward)(); return; }   // the covers flip whole
      Object.assign(press, { back, leaf, outer: true, board: false });
    }
    if (!press.outer || press.board) return;             // inner-half drags select text instead
    if (!press.moved) {
      press.moved = true;
      clearPeek(true);
      gesture = { leaf: press.leaf, top: press.top, dragging: true };
      root.classList.add("is-dragging");
      // the corner starts where the page currently is
      press.C = press.back ? [-PAGE_W, press.top ? 0 : PAGE_H] : [PAGE_W, press.top ? 0 : PAGE_H];
      pRender = pForTurn(press.leaf, press.back ? 0.999 : 0.001); pVel = 0;
    }
    const [x, y] = toBook(e);
    const k = slotR.getBoundingClientRect().width / PAGE_W;
    const P = constrainCorner([press.C[0] + dx / k, press.C[1] + dy / k], press.top);
    gesture.P = P;
    press.samples.push([performance.now(), x]);
    if (press.samples.length > 12) press.samples.shift();
    pRender = pForTurn(press.leaf, clamp((PAGE_W - P[0]) / (2 * PAGE_W), 0.001, 0.999)); pVel = 0;
    kick();
  });
  function endPress(e, cancelled) {
    if (!press || e.pointerId !== press.id) return;
    const p = press; press = null;
    root.classList.remove("is-dragging");
    if (!p.moved) {
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > DRAG_START) return;   // a swipe (vertical ones are turns of their own), not a tap
      const quick = performance.now() - p.t0 < 500;
      const selecting = (getSelection?.().toString() || "").length > 0;
      if (!cancelled && quick && !selecting) (p.back ? turnBack : turnForward)();
      return;
    }
    if (!gesture) return;
    const P = gesture.P || p.C;
    // flick speed over the last ~120 ms before release (a pause before letting go means no flick)
    const now = performance.now(), recent = p.samples.filter(([t]) => t > now - 120);
    const v = recent.length >= 2 ? (recent[recent.length - 1][1] - recent[0][1]) / Math.max(16, now - recent[0][0]) : 0;
    const T = clamp((PAGE_W - P[0]) / (2 * PAGE_W));
    // desktop: past the spine (or a flick); phones: the whole page is the gesture, so past its middle will do
    const mid = mode === "single" ? PAGE_W / 2 : 0;
    const along = p.back ? v : -v;   // px/ms in the turn's direction at release
    const complete = !cancelled && (along > 0.06 ? true : along < -0.06 ? false : p.back ? P[0] > -mid : P[0] < mid);
    const toT = p.back ? (complete ? 0 : 1) : (complete ? 1 : 0);
    gesture.dragging = false;
    animateTurn(p.leaf, T, toT, { top: p.top, P0: P, dur: 260 + 520 * Math.abs(toT - T), ease: easeOut });
  }
  book.addEventListener("pointerup", (e) => endPress(e, false));
  book.addEventListener("pointercancel", (e) => endPress(e, true));

  /* hover near the outer corner of a page: it lifts a little, inviting a click or drag.
     Once lifted, the zone grows (hysteresis) and leaving lowers the corner softly: with hard edges and an instant drop, a
     hand resting on an edge made the corner flick up and down and the page below flash (DM feedback 48). */
  let peekTimer = 0;
  const PEEK_HOLD = 28;   // extra book px the pointer may stray while a corner is lifted
  function animatePeek(to, dur, done) {
    cancelAnimationFrame(peekTimer);
    const from = gesture.P.slice(), start = performance.now(), G = gesture;
    const step = (now) => {
      if (gesture !== G) return;
      const k = easeOut(clamp((now - start) / dur));
      G.P = constrainCorner([lerp(from[0], to[0], k), lerp(from[1], to[1], k)], G.top);
      update(true);
      if (k < 1) peekTimer = reqFrame("peek", step); else done?.();
    };
    peekTimer = reqFrame("peek", step);
  }
  /* the outer corners (book px; m widens them): they lift on hover, and they still turn in notes mode
     (phones: the left one too, for a press — the only way back there besides a swipe) */
  function cornerZone(x, y, m = 0, press = false) {
    const band = y > PAGE_H - 120 - m || y < 110 + m;
    if (!band) return null;
    if (x > PAGE_W - 95 - m && x < PAGE_W + 10 + m) return "right";
    if (mode === "double" && x < -PAGE_W + 95 + m && x > -PAGE_W - 10 - m) return "left";
    if (mode === "single" && press && x > -10 && x < 95) return "left";
    return null;
  }
  function hoverPeek(e) {
    if (e.pointerType !== "mouse" || gesture?.anim || gesture?.dragging || press) return;
    if (e.target.closest?.(".tj-loose, .tj-dm, .tj-npin, .tj-npage")) { book.classList.remove("is-corner"); clearPeek(); return; }   // a sheet, a DM's sigil or a note's pin, not the corner
    const [x, y] = toBook(e);
    const sp = restingSpread();
    const z = cornerZone(x, y, gesture?.peek && !gesture.releasing ? PEEK_HOLD : 0);
    const nearRight = z === "right", nearLeft = z === "left";
    const want = nearRight && sp < leaves.length && !leaves[sp].board ? { leaf: sp, back: false }
               : nearLeft && sp > 0 && !leaves[sp - 1].board ? { leaf: sp - 1, back: true } : null;
    book.classList.toggle("is-corner", !!want);
    if (!want) { clearPeek(); return; }
    const top = gesture?.peek && gesture.leaf === want.leaf ? gesture.top : y < PAGE_H / 2;   // (top/bottom only chosen on entry)
    if (gesture?.peek && gesture.leaf === want.leaf && gesture.top === top && !gesture.releasing) return;
    const C = want.back ? [-PAGE_W, top ? 0 : PAGE_H] : [PAGE_W, top ? 0 : PAGE_H];
    const lift = [want.back ? -O_F[0] : O_F[0], top ? -O_F[1] : O_F[1]];   // as far as the first scroll step's lift
    if (!(gesture?.peek && gesture.leaf === want.leaf && gesture.top === top)) {   // a fresh lift (a releasing one continues from where it is)
      gesture = { leaf: want.leaf, top, peek: true, P: C };
      pRender = pForTurn(want.leaf, want.back ? 0.999 : 0.001); pVel = 0;
    }
    gesture.releasing = false;
    animatePeek([C[0] + lift[0], C[1] + lift[1]], 220);
  }
  function clearPeek(now = false) {
    if (!gesture?.peek) return;
    const done = () => {
      cancelAnimationFrame(peekTimer);
      gesture = null;
      pRender = scrollPos(); pVel = 0;
      if (F) F.last = -1;
      update(true);
    };
    if (now) return done();
    if (gesture.releasing) return;
    gesture.releasing = true;
    const back = gesture.P[0] < 0, top = gesture.top;
    animatePeek(back ? [-PAGE_W, top ? 0 : PAGE_H] : [PAGE_W, top ? 0 : PAGE_H], 160, done);
  }
  book.addEventListener("pointerleave", () => { if (!press) { book.classList.remove("is-corner"); clearPeek(); } });

  /* ---- go ---- */
  layout();
  addEventListener("resize", () => layout());
  new ResizeObserver(() => measureRoot()).observe(document.body);
  /* Rendering follows the scroll position through a critically damped spring: one wheel tick becomes a
     gentle, continuous motion, never a jump. A completed-on-release turn (snap) glides on a softer spring. */
  let raf = 0, lastNow = 0;
  const OMEGA = 10, OMEGA_GLIDE = 5; // a wheel tick settles in ≈0.25 s (weight without input lag); a released half-turn glides home in ≈0.7 s
  function frame(now) {
    raf = 0;
    if (frozen) return;
    if (gesture && gesture.anim) {               // a click / release animation owns the page until it ends
      const A = gesture.anim;
      // real time, like any animation; only a frame that comes late (a busy machine) may not jump the fold more than
      // 0.25 of a turn (a big jump shows the page underneath for a frame) — the clock then continues from there
      const Tat = (q) => A.T0 + (A.T1 - A.T0) * A.ease(q);
      let k = clamp((now - A.start) / A.dur);
      A.last ??= A.start; A.k ??= 0;   // (the first frame of a turn may be the late one: leaves were just swapped)
      if (now - A.last > 28) {
        const Tprev = Tat(A.k), cap = 0.25;
        if (Math.abs(Tat(k) - Tprev) > cap) {
          let lo = A.k, hi = k; for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; (Math.abs(Tat(m) - Tprev) > cap ? (hi = m) : (lo = m)); }
          k = lo; A.start = now - k * A.dur;
        }
      }
      A.k = k; A.last = now;
      const T = Tat(k);
      let P = cornerAt(T, gesture.top);
      if (A.P0) { const b = easeOut(clamp(k * 2.4)); P = [lerp(A.P0[0], P[0], b), lerp(A.P0[1], P[1], b)]; }
      gesture.P = leaves[gesture.leaf]?.board ? null : P;
      pRender = pForTurn(gesture.leaf, T); pVel = 0;
      update(true);
      if (k < 1) { raf = reqFrame("turn-anim", frame); return; }
      gesture = null; pRender = A.final; pVel = 0; lastNow = 0;
      endJump();
      update(true);
      if (queued) { const d = queued; queued = 0; startTurn(d); }   // a gesture that came during the turn
      if (queuedLeave) { const d = queuedLeave; queuedLeave = 0; if (canLeave(d)) data.leave(d); }
      return;
    }
    if (gesture && gesture.dragging) { update(true); return; }
    const dt = lastNow ? Math.min(0.05, (now - lastNow) / 1000) : 1 / 60;
    lastNow = now;
    const target = scrollPos();
    let x0 = pRender - target;
    // far behind (a jump across several spreads): skip ahead to the spread before the target, lying flat
    if (Math.abs(x0) > 3.2) { const k = locate(target - Math.sign(x0) * 1.6); pRender = segStart(k.s) + LEAD; x0 = pRender - target; pVel = 0; }
    const w = glide ? OMEGA_GLIDE : OMEGA, ew = Math.exp(-w * dt);
    const c = pVel + w * x0;
    const prevP = pRender;
    pRender = target + (x0 + c * dt) * ew;
    pVel = (pVel - w * c * dt) * ew;
    // Never let a visible fold jump: a turn advances at most MAX_T per frame, whatever the spring wants.
    // (Skipping whole spreads while the pages lie flat is fine; drawing a fold mid-air one frame and almost
    // finished the next is what made the page underneath flash through.)
    const a = locate(prevP), z = locate(pRender), MAX_T = 0.12 * clamp(dt * 60, 1, 2.5), fwd = pRender > prevP;
    const mid = (t) => t > 0.0003 && t < 0.9997;
    let limited = null;
    if (z.s === a.s) { if (Math.abs(z.t - a.t) > MAX_T && (mid(a.t) || mid(z.t))) limited = pForTurn(a.s, a.t + (fwd ? MAX_T : -MAX_T)); }
    else if (mid(a.t)) limited = pForTurn(a.s, clamp(a.t + (fwd ? MAX_T : -MAX_T)));          // finish this turn first
    else if (mid(z.t) && z.t > MAX_T && z.t < 1 - MAX_T) limited = pForTurn(z.s, fwd ? MAX_T : 1 - MAX_T); // enter a turn at its edge
    if (limited !== null && (fwd ? limited < pRender : limited > pRender)) { pRender = limited; pVel = (pRender - prevP) / dt; }
    if (reduced || (Math.abs(pRender - target) < 2e-4 && Math.abs(pVel) < 2e-3)) { pRender = target; pVel = 0; glide = false; }
    update(false);
    if (pRender !== target) raf = reqFrame("spring", frame);
    else lastNow = 0;
  }
  function kick() { if (!raf) raf = reqFrame("kick", frame); }
  // web fonts load lazily: load every face the pages may use (its Latin range: italics, weights and the minor hands too)
  // before any page is measured. A face that only starts loading when the fitting first meets it is measured in a
  // fallback font, and its page is fitted wrong for good (the old wait for every picture used to hide this).
  if (document.fonts) {
    await fontCss;
    const latin = (f) => !f.unicodeRange || /U\+0+-0*FF\b/i.test(f.unicodeRange) || /^U\+0-10FFFF$/i.test(f.unicodeRange);
    await Promise.race([
      Promise.all([...document.fonts].filter(latin).map((f) => f.load().catch(() => {}))),
      new Promise((r) => setTimeout(r, 10000)),
    ]);
    await document.fonts.ready;
  }
  // …and every illustration without its size: an image that hasn't loaded yet measures 0 px tall, so its page would be
  // fitted as if it were nearly empty. The build gives every picture its width and height, so this waits for none of
  // them (it used to wait for every picture of the book to download before the book could open).
  await Promise.race([
    Promise.all(imgs.filter((i) => !i.hasAttribute("width")).map((i) => (i.complete ? 0 : new Promise((r) => { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); })))),
    new Promise((r) => setTimeout(r, 10000)),
  ]);
  // the fitting measures clones of the pages; Firefox loads a cloned image again (asynchronously, even from cache), so a
  // clone would measure 0 px tall: give every picture its intrinsic size up front (its box is then right before it loads)
  for (const i of imgs) if (i.naturalWidth && !i.hasAttribute("width")) { i.setAttribute("width", i.naturalWidth); i.setAttribute("height", i.naturalHeight); }
  await shapeFloats();
  fitReady = true;
  for (const q of vPages) fitPage(q);   // (pages whose words vanish are measured with every word present: before vanishRestore)
  for (const d of leafCache.values()) d.box.remove();   // rebuild clones with the fitted pages
  leafCache.clear();
  curS = -1;
  vanishRestore();   // (after fitting: the pages were measured with every word present)
  // decode the first spreads before lifting the curtain (on a slow line, not for longer than 1.5 s: they come in as they load)
  await Promise.race([Promise.all(imgs.slice(0, 4).map((i) => i.decode?.().catch(() => {}))), new Promise((r) => setTimeout(r, 1500))]);
  pRender = scrollPos();
  update(true);
  loading.classList.add("is-done");
  fitTimer = idle(fitIdle);
  mountNotes({
    root, stage, book, pages, volume: vol.volume || 1, build: data.build || "dev", pbar, psheet, whoRow, mapEl: M.map,
    mode: () => mode,
    visibleFaces: shownFaces,
    atRest: () => !gesture && (!F || F.kind !== "paper" || F.box.classList.contains("is-rest")),
    jumpToPage: (i) => jumpToSpread(pages[i]._spread),
    currentPage: () => +(contentPageAt(restingSpread())?.dataset.idx ?? 0),
    mapSheet: () => ({ key: mapSheet || "chult", title: M.sheets[mapSheet || "chult"]?.title || mapSheet || "" }),
    overlayOpen: () => !!(MV?.isOpen || !lb.hidden || !psheet.hidden),
    psShut,
  }).then((n) => { NT = n; if (n) api.notes = n; });
  const api = {
    /** vanishing pages: { id: [gone, total] }, and a reset (also: ?vanish-reset in the URL) */
    vanishState: () => Object.fromEntries(vPages.map((q) => [q.dataset.vanish, [vStore(q.dataset.vanish), vTotal.get(q.dataset.vanish)]])),
    vanishReset: () => { vanishReset(); vanishCheck(); },
    vanishPages: () => vPages.map((q) => [q.dataset.vanish, +q.dataset.idx]),
    jumpToSpread, jumpTurn, layout,
    spreadCount: () => leaves.length + 1,
    /** web edition (shelf.js): freeze / thaw this journal; show spread s at rest without touching the page scroll (frozen);
        where the closed book lies on screen (for the hand-over animation) */
    freeze(on) {
      frozen = !!on;
      root.classList.toggle("is-frozen", frozen);
      if (frozen) { gesture = null; clearPeek(true); }
      else { measureRoot(); layout(); }
      sphereCheck(); critterCheck();
    },
    place(s) {
      s = clamp(s, 0, segs.length - 1);
      gesture = null; pRender = restP(s); pVel = 0;
      update(true);
    },
    /** where the closed book lies on screen: as it lies now, or (which = "front" | "back", two-page layout) where it
        would lie shut on its front or back board, wherever it is open now */
    closedRect(which) {
      if (which && mode === "double") {
        const r = slotR.getBoundingClientRect(), k = r.width / PAGE_W, origin = r.left - curShift * k;
        return { x: origin - (PAGE_W / 2 + (which === "back" ? BOARD : 0)) * k, y: r.top - BOARD * k, w: (PAGE_W + BOARD) * k, h: (PAGE_H + 2 * BOARD) * k };
      }
      const { s } = locate(pRender);
      const el = s >= leaves.length ? slotL.querySelector(".tj-backcover") || slotL : $(".tj-leafbox:not(.is-parked) .tj-cover") || slotR;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },
    restingSpread: () => restingSpread(),
    /** scroll to segment s at local progress u (0..1), instantly — for tests/screenshots */
    seek(s, u = LEAD / segs[s].len) {
      const rootTop = root.getBoundingClientRect().top + scrollY;
      scrollTo({ top: rootTop + (segStart(s) + u * segs[s].len) * vh, behavior: "instant" });
      pRender = scrollPos(); pVel = 0; glide = false;
      update(true);
    },
    /** document scrollY for segment s at local progress u — for tests */
    scrollYFor(s, u) { return root.getBoundingClientRect().top + scrollY + (segStart(s) + u * segs[s].len) * vh; },
    /** scroll to segment s with its turn at progress t (0..1) — for tests/screenshots */
    seekTurn(s, t) {
      const turn = segs[s].turn;
      let lo = 0, hi = 1;
      for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; (turnEase(mid) < t ? (lo = mid) : (hi = mid)); }
      api.seek(s, 1 - turn + turn * lo);
    },
    spreadOfPage: (i) => pages[i]?._spread,
    pageCount: () => pages.length,
    openMap: () => MV?.open(mapGi, mapEnd),
    turnForward: () => turnForward(),
    turnBack: () => turnBack(),
    pageIndexOfMap: (id) => pages.findIndex((p) => p.dataset.map === id),
    /** waypoint index (route order) each page shows — for tests */
    pageWaypoints: () => pageWp.slice(),
    waypoints: () => M.wps.map((w) => ({ id: w.id, sheet: w.sheet, len: Math.round(w.len) })),
    autofit: () => fitted,
    /** fit every page now (they are otherwise fitted on demand and in idle time) */
    fitAll,
    autofill: () => fillLog,
    /** dev: can page i's notes be placed at its natural size (no fit/fill)? */
    notesOkUnfilled(i) {
      const probe = el("div", "tj-slot tj-slot-right");
      probe.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden";
      root.querySelector(".tj-stage").append(probe);
      const c = pages[i].cloneNode(true);
      for (const k of ["--fit", "--lhk", "--pk", "--fw"]) c.style.removeProperty(k);
      probe.append(c);
      const ok = notesPlaceable(c);
      probe.remove();
      return ok;
    },
    fillReport: () => pages.map((f) => ({ page: +f.dataset.idx, tab: f.dataset.tab, fill: Math.round((f._fill ?? 0) * 100), exempt: !!f._exempt })),
    /** dev: what is on screen right now (for frame-by-frame consistency checks) */
    frameState() {
      const { s, t } = locate(pRender);
      const shown = [...leafCache.entries()].filter(([, d]) => !d.box.classList.contains("is-parked") && !leafEl.hidden);
      const box = shown[0]?.[1]?.box;
      return { s, t: +t.toFixed(4), shown: shown.map(([k]) => k), mode: box ? (box.classList.contains("is-rest") ? "rest" : box.classList.contains("is-turned") ? "turned" : "fold") : "-",
        leafHidden: leafEl.hidden, kind: shown[0]?.[1]?.kind, gesture: gesture ? (gesture.anim ? "anim" : gesture.dragging ? "drag" : gesture.peek ? "peek" : "?") : "",
        L: facePage(slotL.firstElementChild)?.dataset.idx ?? null, R: facePage(slotR.firstElementChild)?.dataset.idx ?? null,
        corner: box && !box.classList.contains("is-rest") && !box.classList.contains("is-turned") && F?.P ? F.P.map((v) => Math.round(v)) : null, leaf: curS };
    },
    state: () => ({ target: scrollPos(), rendered: pRender, ...locate(pRender) }),
  };
  return api;
}

/* Two books on one desk: the web edition of the journal (brutenis.net/chult/; the claude.ai artifacts stay one book each).
   The book being read lives in the page flow and owns the scrolling; the other one waits frozen in a fixed, hidden dock
   (mounted only once it is about to be needed) and lies as a small closed book at the edge of the desk.
   Reading past the closed back cover of Book I brings Book II, closed, onto the desk; going back past Book II's closed
   front cover brings Book I back, closed on its last page. A click on the book at the edge swaps them too (the open
   book shuts into its cover at once). The swap: the closed book shrinks onto the edge of the desk while the other grows
   from there into its place, and the desk crossfades underneath (DM round 27).
   Expects mountJournal (journal.js) in the same module. */
async function mountShelf(cfg) {
  const flow = document.getElementById("tj-flow"), dock = document.getElementById("tj-dock");
  const q = new URLSearchParams(location.search);
  const opts = { noSnap: q.has("nosnap"), debug: q.has("debug") };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const books = cfg.books.map((b) => ({ ...b, api: null, root: null, mounting: null, json: null }));
  let cur = Math.max(0, books.findIndex((b) => location.hash === `#${b.id}`));
  let busy = false;

  // (asset URLs made absolute: a relative url() inside a CSS custom property resolves against the stylesheet using it)
  const fetchData = (b) => (b.json ??= fetch(b.data).then((r) => r.json()).then((d) => {
    for (const k in d.assets) d.assets[k] = new URL(d.assets[k], location.href).href;
    return d;
  }));
  const near = (i) => i + 1 < books.length ? books[i + 1] : books[i - 1];   // the other book (two of them)
  const canLeave = (b, dir) => !busy && books.indexOf(b) === cur && !!books[cur + dir];
  function mount(b, frozen) {
    return (b.mounting ??= (async () => {
      b.root = document.createElement("div");
      b.root.className = "tj-root";
      b.root.setAttribute("aria-label", `Oliver Lyonbrooke's journal, ${b.title}`);
      (frozen ? dock : flow).append(b.root);
      b.api = await mountJournal(b.root, { ...(await fetchData(b)), ...opts, frozen,
        canLeave: (dir) => canLeave(b, dir), leave: (dir) => swap(cur + dir, dir > 0 ? "start" : "end") });
      return b.api;
    })());
  }

  /* the other book, lying closed at the edge of the desk */
  const other = document.createElement("button");
  other.type = "button";
  other.className = "tj-shelf-other";
  other.innerHTML = `<div class="tj-shelf-thumb"></div><span class="tj-shelf-label"></span>`;
  document.body.append(other);
  // it lies in the lower right corner of the desk, about three fifths of it on the table and the rest beyond the edge
  // (DM round 28); if the party's portraits reach down that far, it slides further off the edge, and with too little of
  // it left on the desk (or on phones and portrait screens) it is put away
  function placeOther() {
    const R = books[cur].root;
    if (!R || R.classList.contains("is-single")) { other.classList.add("is-off"); return; }
    const width = Math.round(Math.min(230, Math.max(130, innerWidth * 0.115))), height = (width * BOARD_H) / BOARD_W;
    const left = innerWidth - width - Math.max(24, innerWidth * 0.03);
    let top = innerHeight - height * 0.6;
    const who = R.querySelector(".tj-who");
    if (who && !who.classList.contains("is-empty")) {
      const w = who.getBoundingClientRect();
      if (w.right > left - 20 && w.bottom + 12 > top) top = w.bottom + 12;
    }
    other.classList.toggle("is-off", innerHeight - top < 36);
    Object.assign(other.style, { left: `${left.toFixed(0)}px`, top: `${top.toFixed(0)}px`, width: `${width}px` });
    other.querySelector(".tj-shelf-card")?.style.setProperty("--k", (width / BOARD_W).toFixed(4));
  }
  addEventListener("resize", () => placeOther());
  // the who's-who grows a second row when more companions join (and briefly while portraits fade out): follow it
  const whoSize = new ResizeObserver(() => placeOther());
  const watchWho = () => { whoSize.disconnect(); const w = books[cur].root?.querySelector(".tj-who"); if (w) whoSize.observe(w); };
  const showOther = () => {
    const o = near(cur);
    watchWho();
    placeOther();
    const thumb = other.querySelector(".tj-shelf-thumb");
    if (thumb.dataset.book !== o.id) {   // the book's real front cover, scaled down to the button
      const c = card(o);
      c.style.setProperty("--k", ((parseFloat(other.style.width) || 160) / BOARD_W).toFixed(4));
      thumb.replaceChildren(c);
      thumb.dataset.book = o.id;
    }
    other.querySelector(".tj-shelf-label").textContent = o.title;
    other.setAttribute("aria-label", `Open ${o.title}`);
    other.hidden = false;
  };
  other.addEventListener("click", () => swap(books.indexOf(near(cur)), "start"));
  other.addEventListener("pointerenter", () => mount(near(cur), true));   // a hand reaching for it: get it ready
  other.addEventListener("focus", () => mount(near(cur), true));

  // while the books change places, no input reaches either journal; and the scroll that carried the reader across keeps
  // being swallowed until the wheel rests (QUIET_MS), so the arriving book lies closed until the next scroll. Gaps are
  // taken on the inputs' own time; an input that waited for a busy main thread (the arriving book settling in) may be
  // several notches merged, so within a second of the last one it still counts as the same spin.
  const QUIET_MS = 250, LATE_MS = 60, MERGED_MS = 1000;
  let lastInput = 0, settling = false;
  const block = (e) => {
    const now = performance.now(), at = e.timeStamp || now, gap = at - lastInput;
    lastInput = at;
    if (e.type === "keydown") { if (busy) { e.preventDefault(); e.stopImmediatePropagation(); } return; }
    if (busy || (settling && (gap < QUIET_MS || (now - at > LATE_MS && gap < MERGED_MS)))) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    settling = false;
  };
  for (const ev of ["wheel", "touchmove", "keydown"]) addEventListener(ev, block, { capture: true, passive: false });

  /* A closed book as the engine draws it (buildCover / buildBackCover from journal.js, styled by the journal's CSS inside
     a .tj-root of the book's volume): its front cover, and its back board (shown with .show-back). Design size
     BOARD_W × BOARD_H (a page and its board); placed and scaled by the caller. */
  const BOARD_W = 574, BOARD_H = 808;
  function card(b) {
    const c = document.createElement("div");
    c.className = "tj-root tj-shelf-card";
    c.dataset.volume = String(b.volume || 1);
    const flip = document.createElement("div"), front = buildCover(b.cover, b.mark || ""), back = buildBackCover(b.cover);
    flip.className = "tj-shelf-flip";
    front.classList.add("is-front"); back.classList.add("is-back");
    flip.append(front, back);
    c.append(flip);
    return c;
  }
  // a book turning over in flight, without 3D (backface-visibility proved unreliable): it narrows to its edge, the other
  // side takes over at that instant, and it widens again; both use the same symmetric easing, so the swap is unseen
  function turnOver(p, fromBack, toBack, dur) {
    p.classList.toggle("show-back", fromBack);
    if (fromBack === toBack) return [];
    const timing = { duration: dur, easing: "ease-in-out", fill: "forwards" };
    const was = p.querySelector(fromBack ? ".is-back" : ".is-front"), comes = p.querySelector(toBack ? ".is-back" : ".is-front");
    comes.style.visibility = "visible";
    return [
      p.querySelector(".tj-shelf-flip").animate([{ transform: "scaleX(1)" }, { transform: "scaleX(.02)", offset: 0.5 }, { transform: "scaleX(1)" }], timing),
      was.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }], timing),
      comes.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1, offset: 0.5 }, { opacity: 1 }], timing),
    ];
  }
  // the transform that moves a proxy lying at rect a onto rect b (centre to centre, scaled to b's width, a turn)
  const onto = (a, b, rot = 0) => `translate(${(b.x + b.w / 2 - a.x - a.w / 2).toFixed(1)}px, ${(b.y + b.h / 2 - a.y - a.h / 2).toFixed(1)}px) scale(${(b.w / BOARD_W).toFixed(4)}) rotate(${rot}deg)`;
  const still = (r, rot = 0) => `translate(0px, 0px) scale(${(r.w / BOARD_W).toFixed(4)}) rotate(${rot}deg)`;
  function proxy(b, r) {   // a stand-in for a closed book, flying above everything; laid out at rect r
    const p = card(b);
    p.classList.add("tj-shelf-fly");
    Object.assign(p.style, { left: `${(r.x + r.w / 2 - BOARD_W / 2).toFixed(1)}px`, top: `${(r.y + r.h / 2 - BOARD_H / 2).toFixed(1)}px` });
    p.k = r.w / BOARD_W;   // its scale at rest at r
    document.body.append(p);
    return p;
  }

  async function swap(j, land = "start") {
    if (busy || j === cur || !books[j]) return;
    busy = true;
    other.classList.add("is-busy");
    const from = books[cur], to = books[j];
    const ready = mount(to, true);   // (built while the books fly: the flight never waits for it)
    let pA = null, pB = null;
    try {
      // The book being read shuts at once into its closed cover (the proxy takes its place), and the other one flies to
      // where this one lies shut: both books share the layout, so that place is known before the other book is built.
      // (It used to close page by page first, then build the other book, and only then fly: seconds after the click.)
      const A = from.api, nA = A.spreadCount(), sA = A.restingSpread();
      const backA = sA >= nA - 1, backB = land === "end", open = sA > 0 && !backA;
      const rA = A.closedRect(backA ? "back" : "front"), rB = A.closedRect(backB ? "back" : "front");
      // the book in the corner, as laid out (its layout box, before the tilt)
      let rT = other.offsetWidth ? { x: other.offsetLeft, y: other.offsetTop, w: other.offsetWidth, h: other.offsetHeight } : { w: 0 };
      if (!rT.w) rT = { x: -0.15 * rB.w, y: innerHeight - 0.2 * rB.h, w: 0.4 * rB.w, h: 0.4 * rB.h };   // (phones: no book at the edge)
      const tilt = parseFloat(getComputedStyle(other).getPropertyValue("--tilt")) || -14;
      const dur = reduced ? 1 : 1350 * (+q.get("slowswap") || 1), ease = "cubic-bezier(.5,.05,.2,1)", t0 = performance.now();
      pA = proxy(from, rA); pB = proxy(to, rT);
      pA.style.transform = still(rA, 0);
      pB.style.transform = still(rT, tilt);
      other.hidden = true;
      from.root.classList.add("is-handing-off");   // its book (and the end card) give way to the proxy
      const anims = [
        pA.animate([{ transform: still(rA, 0) }, { transform: onto(rA, rT, tilt) }], { duration: dur, easing: ease, fill: "forwards" }),
        pB.animate([{ transform: still(rT, tilt) }, { transform: onto(rT, rB, 0) }], { duration: dur, easing: ease, fill: "forwards" }),
        ...turnOver(pA, backA, false, dur), ...turnOver(pB, false, backB, dur),
      ];
      if (open) anims.push(pA.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduced ? 1 : 220, easing: "ease-out" }));   // the open book fades into its cover
      // the other desk comes up under the books once the other book is ready: during the flight, or right after it
      let fade = null;
      const arrived = ready.then((B) => {
        B.place(backB ? B.spreadCount() - 1 : 0);
        to.root.classList.add("is-arriving");
        dock.classList.add("is-showing");
        const left = dur - (performance.now() - t0);
        fade = dock.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduced ? 1 : Math.max(350, left * 0.8), easing: "ease-in-out", fill: "forwards" });
        return B;
      });
      await Promise.all(anims.map((a) => a.finished));
      const B = await arrived;
      await fade.finished;
      // hand over, all in one task (one paint): the arriving book into the page flow, the leaving one into the dock
      dock.classList.remove("is-showing");
      for (const a of dock.getAnimations()) a.cancel();
      flow.append(to.root);
      dock.append(from.root);
      A.freeze(true);
      B.freeze(false);
      B.jumpToSpread(backB ? B.spreadCount() - 1 : 0, true);
      from.root.classList.remove("is-handing-off");
      to.root.classList.remove("is-arriving");
      cur = j;
      window.__tj = B;
      history.replaceState(null, "", `#${to.id}`);
      document.title = to.pageTitle || document.title;
      showOther();
      pA.remove();
      const p = pB;
      p.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: "forwards" }).finished.then(() => p.remove());
      pA = pB = null;
    } catch (err) {   // (the other book failed to load: put everything back as it was)
      console.error("[shelf] swap failed:", err);
      pA?.remove(); pB?.remove();
      from.root.classList.remove("is-handing-off");
      dock.classList.remove("is-showing");
      showOther();
    } finally {
      busy = false;
      settling = true;
      other.classList.remove("is-busy");
    }
  }

  await mount(books[cur], false);
  window.__tj = books[cur].api;
  showOther();
  // get the other book ready when it is about to be needed: near the edge that leads to it, and in idle time
  const warm = () => {
    if (busy) return;
    const A = books[cur].api, s = A.restingSpread(), n = A.spreadCount();
    const o = near(cur), toward = books.indexOf(o) > cur ? n - 1 - s : s;
    // (phones only fetch it: a second book built in the background doubles the memory, which a phone may not have)
    if (toward <= 4 && !books[cur].root.classList.contains("is-single")) mount(o, true);
    else fetchData(o);
  };
  addEventListener("scroll", () => { clearTimeout(warm.t); warm.t = setTimeout(warm, 400); }, { passive: true });
  setTimeout(warm, 3000);
  return { books, swap: (j) => swap(j) };
}

// --web boot: both books on one desk; their data files, covers and titles come as JSON on the page (see tools/export_web.py)
window.__shelf = await mountShelf(JSON.parse(document.getElementById("tj-shelf").textContent));
