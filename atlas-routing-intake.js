(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.atlasRoutingIntake = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const clean = (s) => String(s || "").trim().replace(/\s+/g, " ");
  const key = (s) => clean(s).toUpperCase();
  const number = (s) => /^\d{1,3}(?:,\d{3})*$|^\d+$/.test(s) ? Number(s.replaceAll(",", "")) : null;
  const skuPattern = /^CG[A-Z0-9]+(?:-[A-Z0-9.]+)+$/i;
  const orderBoxCount = lines => lines?.length && lines.every(line => Number.isSafeInteger(line.caseQty) && line.caseQty > 0)
    ? lines.reduce((sum, line) => sum + line.caseQty, 0) : null;

  function rows(words) {
    const result = [];
    for (const word of [...words].sort((a, b) => a.y - b.y || a.x - b.x)) {
      let row = result.find((r) => Math.abs(r.y - word.y) <= Math.max(r.h, word.h) * 0.55);
      if (!row) { row = { y: word.y, h: word.h, words: [] }; result.push(row); }
      row.words.push(word);
    }
    return result.map((r) => ({ ...r, words: r.words.sort((a, b) => a.x - b.x) })).sort((a, b) => a.y - b.y);
  }
  const textOf = (row) => row.words.map((w) => w.text).join(" ");
  function phrase(row, first, second) {
    const list = row.words;
    const label = word => key(word?.text).replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    for (let i = 0; i < list.length; i++) {
      if (label(list[i]) === `${first} ${second}` ||
          (["ITEM", "CASE"].includes(first) && label(list[i]) === `${first} ${second} SHIPPED`)) return list[i];
      if (label(list[i]) === first && label(list[i + 1]) === second) {
        return { ...list[i], w: list[i + 1].x + list[i + 1].w - list[i].x };
      }
    }
    return null;
  }
  const center = word => word.x + word.w / 2;
  function quantityHeaders(lines, ship, packingTitle) {
    const start = ship?.row.y ?? packingTitle?.y ?? 0;
    for (const row of lines.filter(r => r.y > start && r.y < 0.85)) {
      // Phone perspective can put words from the same printed header on
      // neighboring OCR rows. Match within the header's small vertical band.
      const header = { words: lines.filter(r => Math.abs(r.y - row.y) < 0.022)
        .flatMap(r => r.words).filter(w => !/^SHIPPED[.:]?$/i.test(w.text)).sort((a, b) => a.x - b.x) };
      const item = phrase(header, "ITEM", "QTY"), cases = phrase(header, "CASE", "QTY");
      if (!item || !cases || center(item) >= center(cases)) continue;
      const shipped = lines.filter(r => r.y >= row.y - 0.01 && r.y - row.y < 0.05)
        .flatMap(r => r.words.filter(w => /^SHIPPED[.:]?$/i.test(w.text)));
      const hasShipped = anchor => /\bSHIPPED[.:]?$/i.test(anchor.text) ||
        shipped.some(w => Math.abs(center(w) - center(anchor)) < 0.09);
      const ordered = header.words.find(w => /^ORDERED[.:]?$/i.test(w.text));
      const backOrdered = phrase(header, "BACK", "ORDERED");
      const anchors = [ordered && { name: "ordered", word: ordered }, backOrdered && { name: "backOrdered", word: backOrdered },
        { name: "itemQtyShipped", word: item }, { name: "caseQtyShipped", word: cases }].filter(Boolean).sort((a, b) => center(a.word) - center(b.word));
      const bands = Object.fromEntries(anchors.map((anchor, i) => [anchor.name, {
        left: i ? (center(anchors[i - 1].word) + center(anchor.word)) / 2 : 0,
        right: i + 1 < anchors.length ? (center(anchor.word) + center(anchors[i + 1].word)) / 2 : 1,
      }]));
      if (packingTitle && ship) {
        if (!hasShipped(item)) bands.itemQtyShipped = null;
        if (!hasShipped(cases)) bands.caseQtyShipped = null;
      }
      return { row, bands, firstQuantityX: Math.min(...anchors.map(a => a.word.x)), packing: Boolean(packingTitle && ship && hasShipped(item) && hasShipped(cases)) };
    }
    return null;
  }

  function normalizeHours(value) {
    const m=String(value).match(/\b(\d{1,2})(?::?([0-5]\d))?\s*(am|pm)?\s*(?:[-–]|to)\s*(\d{1,2})(?::?([0-5]\d))?\s*(am|pm)?\b/i);
    if(!m)return String(value).trim();
    const minutes=(h,min,ap)=>{h=Number(h);if(ap){if(h<1||h>12)return NaN;h=h%12+(/pm/i.test(ap)?12:0);}return h<=23?h*60+Number(min||0):NaN;};
    let start=minutes(m[1],m[2],m[3]),end=minutes(m[4],m[5],m[6]);
    if(!m[3]&&m[6]){const candidates=['am','pm'].map(ap=>minutes(m[1],m[2],ap)).filter(n=>n<end&&end-n<=12*60);if(candidates.length!==1)return String(value).trim();start=candidates[0];}
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return String(value).trim();
    const fmt=n=>`${Math.floor(n/60)%12||12}:${String(n%60).padStart(2,'0')} ${n<720?'AM':'PM'}`;
    return `${fmt(start)}–${fmt(end)}`;
  }
  // Recognize this company's printed form conservatively. Handwriting and
  // unrecognized layouts stay available in the photo for human review.
  function parsePage(page, index = 0) {
    const words = (page.words || []).filter((w) => typeof w.text === "string" && w.text.length <= 200 &&
      [w.x, w.y, w.w, w.h].every(Number.isFinite) && w.w > 0 && w.h > 0);
    const lines = rows(words), text = String(page.text || words.map((w) => w.text).join(" ")).slice(0, 100000);
    const issues = [], fields = { orderNumber: "", customer: "", address: "", city: "", timeWindow: "" };
    const evidence = { orderNumber: lines.flatMap(row => {
      const start = row.words.findIndex(w => /^SO(?:[-–\s]|$)/i.test(w.text));
      if (start < 0) return [];
      const tokens = [];
      for (const word of row.words.slice(start)) { tokens.push(word); if (/SO\s*[-–]?\s*US\s*[-–]?\s*\d{3,12}\b/i.test(tokens.map(w => w.text).join(" "))) break; }
      return tokens;
    }), lines: [] };
    const ids = [...new Set([...text.matchAll(/\bSO\s*[-–]?\s*US\s*[-–]?\s*(\d{3,12})\b/gi)].map((m) => `SO-US-${m[1]}`))];
    const referenceNumbers = (prefix, label) => [...new Set([
      ...[...text.matchAll(new RegExp(`\\b${prefix}\\s*[-–]\\s*US\\s*[-–]\\s*(\\d{3,12})\\b`, "gi"))].map((m) => `${prefix}-US-${m[1]}`),
      ...[...text.matchAll(new RegExp(`\\b${label}\\s*(?:number|no\\.?|#)\\s*[:#]?\\s*([A-Z0-9][A-Z0-9-]{0,79})\\b`, "gi"))].map((m) => key(m[1])).filter((s) => /\d/.test(s)),
    ])];
    const invoiceNumbers = referenceNumbers("INV", "Invoice"), fulfillmentNumbers = referenceNumbers("IF", "Item\\s+Fulfillment");
    if (ids.length === 1) fields.orderNumber = ids[0];
    else issues.push(ids.length ? "Different sales order numbers appear on this photo." : "Confirm the sales order number; none was confidently recognized.");
    const packingTitle = lines.find(r=>/Packing\s+Slip/i.test(textOf(r)));
    const ship = lines.map((r) => ({ row: r, heading: phrase(r, "SHIP", "TO") })).find((r) => r.heading);
    const tableHeaders = quantityHeaders(lines, ship, packingTitle);
    const table = tableHeaders?.row;
    const packing = Boolean(tableHeaders?.packing && packingTitle.y < ship.row.y && ship.row.y < table.y);
    if (ship) {
      const left = ship.heading.x - 0.01;
      const boundary = ship.row.words.find((w) => w.x > ship.heading.x + ship.heading.w + 0.05);
      const right = boundary?.x ?? Math.min(1, ship.heading.x + 0.37);
      const stop = lines.find((r) => r.y > ship.row.y + ship.row.h && /Pmt\s*Method|Payment\s*Method|Terms|PO\s*#|Sales\s*Rep|Ship\s*Via/i.test(textOf(r)));
      const end = Math.min(table?.y ?? 1, stop?.y ?? 1, ship.row.y + 0.20);
      const blockWords = lines.filter((r) => r.y > ship.row.y + ship.row.h * 0.6 && r.y < end)
        .map((r) => r.words.filter((w) => w.x >= left && w.x < right)).filter(r => r.length);
      const block = blockWords.map(r => r.map(w => w.text).join(" "));
      const cityIndex = block.findIndex((s) => /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/i.test(s));
      if (cityIndex > 0) {
        const streetIndex = block.findIndex((s) => /^\d+[A-Z-]?\s+\S/i.test(s));
        if (streetIndex >= 0 && streetIndex < cityIndex) {
          const customerRows = block.slice(0, streetIndex).map((value,i) => ({value,i})).filter(({value}) => !/\bPO\s*#?\s*\d|\bcoc\b|rec\.?\s*hrs|receiving|hours|\b(?:am|pm)\b|\d\s*(?:am|pm)|\(?\d{3}\)?[- .]\d{3}/i.test(value));
          fields.customer = customerRows.map(r=>r.value).join(" ");
          fields.address = block.slice(streetIndex, cityIndex + 1).join(", ");
          fields.city = block[cityIndex].replace(/,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?.*$/i, "").trim();
          evidence.customer = customerRows.flatMap(r=>blockWords[r.i]);
          evidence.address = blockWords.slice(streetIndex, cityIndex + 1).flat();
          evidence.city = blockWords[cityIndex];
        }
      }
      const times = block.filter((s) => /\b(?:[1-9]|1[0-2])(?::[0-5]\d)?\s*[AP]\.?M\.?\b|\b\d{1,2}:[0-5]\d\s*[-–]\s*\d{1,2}:[0-5]\d\b/i.test(s));
      for(const line of block) if(/\b(?:\d{2}:?\d{2})\s*(?:[-–]|to)\s*\d{2}:?\d{2}\b/.test(line)&&!times.includes(line))times.push(line);
      fields.timeWindow = times.map(normalizeHours).filter(Boolean).join(" · ").slice(0, 100);
      evidence.timeWindow = blockWords.filter((_, i) => times.includes(block[i])).flat();
    }
    if (!fields.address || !fields.customer) issues.push("Review the Ship To address and customer; the Bill To address is never substituted.");
    const items = [];
    const fallbackHeader = packingTitle && ship && lines.find(r => r.y > ship.row.y && r.y < 0.85 && /\bItem\b/i.test(textOf(r)));
    const itemStart = table?.y ?? fallbackHeader?.y;
    if (itemStart != null) {
      const firstQuantityX = tableHeaders?.firstQuantityX ?? 0.45;
      const printedSkus = [...new Set([...text.matchAll(/\bCG[A-Z0-9]+(?:\s*[-‐‑–—]\s*[A-Z0-9.]+)+/gi)]
        .map((m) => key(m[0].replace(/\s*[-‐‑–—]\s*/g, "-"))))];
      // Vision can split a printed SKU at hyphens or place adjacent tokens on
      // neighboring rows. Rejoin only spatially adjacent printed tokens left
      // of the quantity columns; never infer an absent color code.
      const skus = [];
      for (const first of words.filter(w => w.y > itemStart && w.x < firstQuantityX && /^CG[A-Z0-9]/i.test(w.text))) {
          if (first.x >= firstQuantityX || !/^CG[A-Z0-9]/i.test(first.text)) continue;
          let sku = { ...first, text: first.text.replace(/[‐‑–—]/g, "-") };
          let lastValid = skuPattern.test(sku.text) ? { ...sku } : /-$/.test(sku.text) && skuPattern.test(sku.text.slice(0, -1)) ? { ...sku, text: sku.text.slice(0, -1) } : null;
          const neighbors = words.filter(w => w !== first && w.x > first.x && w.x < firstQuantityX &&
            Math.abs(w.y - first.y) < Math.max(first.h * 1.5, 0.018)).sort((a, b) => a.x - b.x);
          for (const next of neighbors) {
            const part = next.text.replace(/[‐‑–—]/g, "-");
            if (next.x >= firstQuantityX || next.x - (sku.x + sku.w) > Math.max(sku.h * 1.5, 0.012) ||
                !/^[A-Z0-9.\-]+$/i.test(part) || !(/-$/.test(sku.text) || /^-/.test(part))) break;
            sku.text += part; sku.w = next.x + next.w - sku.x;
            sku.confidence = Number.isFinite(sku.confidence) && Number.isFinite(next.confidence) ? Math.min(sku.confidence, next.confidence) : undefined;
            if (skuPattern.test(sku.text)) lastValid = { ...sku };
          }
          if (lastValid) {
            // Skew can place the final color token on a neighboring OCR row.
            // Use it only when the complete OCR text has one unambiguous,
            // explicitly printed color extension of this exact base.
            const full = printedSkus.filter((s) => s.startsWith(`${key(lastValid.text)}-`) && /^(?:\d{4}|BK)$/.test(s.slice(lastValid.text.length + 1)));
            if (full.length === 1) {
              const suffix = full[0].slice(lastValid.text.length + 1);
              const evidence = words.filter(w => w.text.replace(/^[-‐‑–—]/, "") === suffix && Math.abs(w.y - lastValid.y) < 0.04 && w.x < firstQuantityX);
              lastValid.confidence = Number.isFinite(lastValid.confidence) && evidence.length === 1 && Number.isFinite(evidence[0].confidence) ? Math.min(lastValid.confidence, evidence[0].confidence) : undefined;
              lastValid.text = full[0];
            }
            else if (full.length > 1 || /-$/.test(sku.text)) issues.push(`${lastValid.text}: confirm the complete printed SKU and color suffix.`);
            skus.push(lastValid);
          }
      }
      skus.forEach((sku, i) => {
        const nextY = skus[i + 1]?.y ?? 1;
        const footer = lines.find(r => r.y > sku.y && /^(?:Subtotal|Shipping|Tax Total|Total)\b/i.test(textOf(r)));
        const end = Math.min(nextY - sku.h * 0.3, footer?.y ?? 1, sku.y + 0.075);
        const nearby = words.filter(w => w.y >= sku.y - sku.h && w.y < end && number(w.text) != null);
        const at = band => band ? nearby.filter(w => center(w) >= band.left && center(w) < band.right) : [];
        const c = at(tableHeaders?.bands.caseQtyShipped), u = at(tableHeaders?.bands.itemQtyShipped);
        const caseQty = c.length === 1 && number(c[0].text) > 0 && number(c[0].text) <= 1000000 ? number(c[0].text) : null;
        const itemQty = u.length === 1 && number(u[0].text) > 0 && number(u[0].text) <= 1000000000 ? number(u[0].text) : null;
        if (caseQty == null) issues.push(`${sku.text}: confirm Case Qty Shipped (Boxes); Item Qty was not used as a substitute.`);
        if ([sku, ...c, ...u].some((w) => w.confidence != null && w.confidence < 0.85)) issues.push(`${sku.text}: photo reading is uncertain; verify the printed SKU and quantities.`);
        items.push({ sku: key(sku.text), caseQty, itemQty, source: index + 1 });
        evidence.lines.push({ sku: [sku], caseQty: c, itemQty: u });
      });
    }
    if (!items.length) issues.push("No product rows were confidently recognized. Enter the SKU and Case Qty from the photo.");
    const packingSlip = packing ? text.match(/\bIF-(?:US-)?\d{3,12}\b/i)?.[0]?.toUpperCase() || "" : "";
    if (packingSlip && !fulfillmentNumbers.includes(packingSlip)) fulfillmentNumbers.push(packingSlip);
    return { ...fields, parserVersion: packing ? "packing-slip-v1" : "generic-v2", purchaseOrder: text.match(/\bPO\s*#?\s*(\d{3,12})\b/i)?.[1] || "", packingSlip, invoiceNumbers, fulfillmentNumbers, lines: items, ids, issues, evidence, checkOnDelivery: /\bCHECK\s+ON\s+DELIVERY\b/i.test(text), text, source: index + 1 };
  }

  function combinePages(pages) {
    const parsed = pages.map(parsePage), issues = parsed.flatMap((p) => p.issues.map((s) => `Photo ${p.source}: ${s}`));
    const ids = [...new Set(parsed.flatMap((p) => p.ids))];
    const result = { orderNumber: "", customer: "", address: "", city: "", timeWindow: "", invoiceNumbers: [], fulfillmentNumbers: [], lines: [], issues,
      checkOnDelivery: parsed.some((p) => p.checkOnDelivery), mixedOrders: ids.length > 1, pages: parsed };
    if (result.mixedOrders) {
      issues.unshift("These photos contain different sales orders. Remove the unrelated photos and read again before combining them.");
      return result;
    }
    for (const field of ["invoiceNumbers", "fulfillmentNumbers"]) result[field] = [...new Set(parsed.flatMap((p) => p[field]))];
    for (const field of ["orderNumber", "customer", "address", "city", "timeWindow"]) {
      const values = [...new Map(parsed.filter((p) => p[field]).map((p) => [key(p[field]), p[field]])).values()];
      if (values.length === 1) result[field] = values[0];
      else if (values.length > 1) issues.push(`Documents disagree on ${field.replace(/([A-Z])/g, " $1").toLowerCase()}; enter the correct value manually.`);
    }
    const bySku = new Map();
    for (const page of parsed) for (const line of page.lines) {
      const prior = bySku.get(line.sku);
      if (!prior) bySku.set(line.sku, { ...line, sources: [line.source], conflicting: false });
      else {
        // An unreadable value is not a disagreement. Keep known quantities
        // across documents, but never sum them or resolve a real conflict by
        // choosing the last photo. Repeated rows on one photo remain ambiguous.
        const quantities = ["caseQty", "itemQty"];
        if (prior.sources.includes(line.source) || quantities.some((field) =>
          prior[field] != null && line[field] != null && prior[field] !== line[field])) {
          prior.conflicting = true;
          issues.push(`${line.sku}: repeated or conflicting quantities; confirm the complete order quantity. Documents are not added together.`);
        }
        for (const field of quantities) if (prior[field] == null && line[field] != null) prior[field] = line[field];
        prior.sources.push(line.source);
      }
    }
    result.lines = [...bySku.values()].map(({ conflicting, ...line }) => ({ ...line,
      caseQty: conflicting ? null : line.caseQty, itemQty: conflicting ? null : line.itemQty,
      uncertain: conflicting || line.caseQty == null }));
    result.issues = [...new Set(issues)];
    return result;
  }

  async function preparePhoto(file, signal) {
    if (!file || file.size > 15 * 1024 * 1024 || !/^image\/(?:jpeg|png|webp|heic|heif)$/i.test(file.type)) throw new Error("Choose a JPEG, PNG, WebP or HEIC photo smaller than 15 MB.");
    if (signal?.aborted) throw new DOMException("Canceled", "AbortError");
    let bitmap;
    try { bitmap = await createImageBitmap(file); }
    catch { throw new Error("This image format could not be opened. Use a JPEG or PNG photo."); }
    try {
      if (signal?.aborted) throw new DOMException("Canceled", "AbortError");
      const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      // Re-encoding strips EXIF/GPS metadata; originals are never overwritten.
      let data;
      for (const quality of [0.88, 0.78, 0.66, 0.54]) { data = canvas.toDataURL("image/jpeg", quality).split(",")[1]; if (data?.length <= 2800000) break; }
      canvas.width = canvas.height = 1;
      if (!data || data.length > 2800000) throw new Error("This photo is too detailed to read in the preview. Crop to the order and try again.");
      return data;
    } finally { bitmap.close(); }
  }
  // Capture is independent of network latency. One reader runs at a time;
  // sealing a group never waits for OCR before the next order can be captured.
  function createPhotoQueue({ read, accept, changed = () => {} }) {
    let jobs = [], generation = 0, running = false;
    let controller = new AbortController();
    const notify = () => changed(jobs);
    async function pump() {
      if (running) return;
      running = true;
      const version = generation, signal = controller.signal;
      try {
        while (version === generation) {
          const job = jobs.find(item => item.status === "reading" && (item.pages.length < item.photos.length || item.sealed));
          if (!job) break;
          try {
            if (job.pages.length < job.photos.length) {
              const page = await read(job.photos[job.pages.length], signal);
              if (version !== generation) return;
              job.pages.push(page); notify();
            } else {
              job.result = combinePages(job.pages);
              job.status = "checking"; notify();
              await accept(job, () => version === generation && !signal.aborted);
              if (version !== generation) return;
              if (job.status === "checking") job.status = "review";
              notify();
            }
          } catch (error) {
            if (version !== generation) return;
            job.status = "review"; job.message = error.message || "Photo reading needs review."; notify();
          }
        }
      } finally { if (version === generation) running = false; }
    }
    return {
      jobs: () => jobs,
      add(photos, context, job = null) {
        if (!photos.length) return job;
        if (jobs.reduce((count, item) => count + item.photos.length, 0) + photos.length > 30 ||
            (job?.photos.length || 0) + photos.length > 20 || (!job && jobs.length >= 10)) throw new Error("Finish this batch before adding more photos (30 photos, 10 orders maximum).");
        if (photos.some(photo => !photo.file || photo.file.size > 15 * 1024 * 1024 || !/^image\/(?:jpeg|png|webp|heic|heif)$/i.test(photo.file.type))) throw new Error("Use JPEG, PNG, WebP or HEIC photos smaller than 15 MB.");
        if (job && (!jobs.includes(job) || job.sealed)) throw new Error("This order is already queued. Start the next order.");
        if (!job) { job = { ...context, photos: [], pages: [], sealed: false, status: "reading", message: "" }; jobs.push(job); }
        job.photos.push(...photos); job.status = "reading"; job.message = ""; notify(); void pump(); return job;
      },
      seal(job) { if (job && jobs.includes(job)) { job.sealed = true; notify(); void pump(); } },
      reset() { generation++; controller.abort(); controller = new AbortController(); jobs = []; running = false; notify(); },
    };
  }

  function assessOrderReading(result, pages, catalog, core) {
    const parsed = result?.pages || pages.map(parsePage), blockingIssues = [], warnings = [];
    const weak = words => words?.some(w => !Number.isFinite(w.confidence) || w.confidence < 0.85);
    const field = (entries, optional = false) => {
      const values = [...new Map(entries.filter(e => e.value !== null && e.value !== "").map(e => [key(e.value), e.value])).values()];
      const value = values.length === 1 ? values[0] : "";
      const status = values.length > 1 ? "conflicting" : !values.length ? optional ? "confirmed" : "missing"
        : entries.some(e => e.value === value && !weak(e.words)) ? "confirmed" : "confirm_required";
      return { value, status, candidates: values };
    };
    const fields = {};
    for (const name of ["orderNumber", "customer", "address", "city", "timeWindow"]) {
      fields[name] = field(parsed.map(p => ({ value: p[name], words: p.evidence?.[name] })), name === "timeWindow");
    }
    if (result?.mixedOrders) fields.orderNumber.status = "conflicting";
    fields.lines = (result?.lines || []).map(line => {
      const entries = parsed.flatMap(p => p.lines.map((l, i) => ({ line: l, evidence: p.evidence?.lines[i], page: p })).filter(e => e.line.sku === line.sku));
      const sku = field(entries.map(e => ({ value: e.line.sku, words: e.evidence?.sku })));
      const caseQty = field(entries.map(e => ({ value: e.line.caseQty, words: e.evidence?.caseQty })));
      const match = core.selectSpecification(catalog, line.sku);
      if (match.status !== "found" || entries.some(e => e.page.issues.some(i => i.includes(line.sku) && i.includes("complete printed SKU")))) sku.status = "confirm_required";
      if (entries.some(e => e.page.lines.filter(l => l.sku === line.sku).length > 1) || entries.some(e => e.line.itemQty != null && entries.some(other => other.line.itemQty != null && other.line.itemQty !== e.line.itemQty))) caseQty.status = "conflicting";
      const units = Number(match.row?.caseQty);
      if (caseQty.status === "confirmed" && (caseQty.value < 1 || !Number.isSafeInteger(caseQty.value) || caseQty.value > 1000000 ||
          entries.some(e => e.line.itemQty != null && (!Number.isSafeInteger(e.line.itemQty) || e.line.itemQty < 1 || (units > 0 && caseQty.value * units !== e.line.itemQty))))) caseQty.status = "confirm_required";
      return { sku, caseQty };
    });
    for (const [name, value] of Object.entries(fields)) {
      if (name === "lines") continue;
      if (value.status !== "confirmed") blockingIssues.push(`Please confirm ${name.replace(/([A-Z])/g, " $1").toLowerCase()}.`);
    }
    fields.lines.forEach((line, i) => {
      if (line.sku.status !== "confirmed") blockingIssues.push(`Item ${i + 1}: please confirm the complete SKU.`);
      if (line.caseQty.status !== "confirmed") blockingIssues.push(`Item ${i + 1}: please confirm the box count against the printed quantities.`);
    });
    if (!fields.lines.length) blockingIssues.push("No product rows were recognized. Add a clearer photo or enter the SKU and boxes.");
    if (!pages.some(p => p.words?.length)) blockingIssues.push("No readable text found. Take a clearer photo.");
    return { ready: !blockingIssues.length, fields, blockingIssues, warnings };
  }
  function quickReadingIssues(result, pages, catalog, core) {
    return assessOrderReading(result, pages, catalog, core).blockingIssues;
  }
  // The document workflow owns only transient photos and review state. Existing
  // routing callbacks remain responsible for permissions, cutoff, saves and plans.
  function createDocumentFlow({ host, icon, snapshot, read, submit, optimize, save, edit, remove, map, cancelPlan, exit = () => {}, upload }) {
    const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const dialog = document.createElement("dialog"); dialog.className = "atlas-document-flow";
    dialog.setAttribute("aria-label", "Delivery order intake"); host.append(dialog);
    const viewport = () => { if(window.visualViewport){dialog.style.setProperty("--atlas-scanner-height",`${window.visualViewport.height}px`);dialog.style.setProperty("--atlas-scanner-top",`${window.visualViewport.offsetTop}px`);} };
    window.visualViewport?.addEventListener("resize",viewport); window.visualViewport?.addEventListener("scroll",viewport); viewport();
    let screen = "ADD_DOCUMENT", photos = [], result = null, assessment = null, overrides = {}, generation = 0, controller = null, stream = null;
    let scanner = false, uploadedCount = 0, checkOverride = null, direct = false, cameraTimer = null, cameraTimeout = 8000;
    let date = null, owner = null, busy = false, error = "", added = null, replaceIndex = null, historyId = null, selectedPhoto = 0;
    const current = version => generation === version && dialog.open && owner === snapshot().owner && snapshot().active;
    const stopCamera = () => { stream?.getTracks().forEach(track => track.stop()); stream = null; };
    function cancel() { clearTimeout(cameraTimer); cameraTimer = null; generation++; controller?.abort(); controller = null; stopCamera(); cancelPlan(); busy = false; }
    function clearPhotos() { photos.forEach(p => URL.revokeObjectURL(p.url)); photos = []; result = assessment = null; overrides = {}; checkOverride = null; }
    function close(fromBack = false) {
      cancel(); clearPhotos(); added = null; dialog.close();
      if (!fromBack && historyId && window.history.state?.atlasDocumentFlow === historyId) window.history.back();
      historyId = null;
    }
    window.addEventListener("popstate", () => { if (dialog.open && historyId && window.history.state?.atlasDocumentFlow !== historyId) { close(true); if (direct) exit(); } });
    dialog.addEventListener("cancel", event => { event.preventDefault(); if (!busy || screen === "READING" || screen === "OPTIMIZING") { close(); if (direct) exit(); } });
    const button = (action, label, primary = false, disabled = false) => `<button type="button" class="atlas-document-button${primary ? " is-primary" : ""}" data-intake-action="${action}" ${disabled ? "disabled" : ""}>${label}</button>`;
    const heading = (title, caption = "") => `<p class="atlas-route-eyebrow">DELIVERY ROUTING</p><h2 tabindex="-1">${title}</h2>${caption ? `<p class="atlas-document-caption">${caption}</p>` : ""}`;
    const totalBoxes = order => orderBoxCount(order.lines);
    const reviewLines = () => (assessment?.fields.lines || []).map((line, i) => {
      const sku = String(overrides[`sku.${i}`] ?? line.sku.value).trim().toUpperCase();
      const rawBoxes = overrides[`caseQty.${i}`] ?? line.caseQty.value;
      return { sku, caseQty: rawBoxes !== "" && validField(`caseQty.${i}`, rawBoxes) ? Number(rawBoxes) : null,
        itemQty: result.lines[i]?.itemQty ?? null };
    });
    function validField(path, value) {
      const text = String(value).trim();
      if (path === "timeWindow") return true;
      if (path === "orderNumber") return /^SO-US-\d{3,12}$/i.test(text);
      if (path.startsWith("sku.")) return skuPattern.test(text);
      if (path.startsWith("caseQty.")) return Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 1000000;
      return Boolean(text);
    }
    function fieldRow(path, label, field, type = "text") {
      const reviewed = Object.hasOwn(overrides, path), value = reviewed ? overrides[path] : field.value;
      const confirmed = (reviewed || field.status === "confirmed") && validField(path, value);
      const input = path === "address" ? `<textarea data-intake-field="${path}" aria-label="${esc(label)}" rows="2" maxlength="300">${esc(value)}</textarea>` : `<input data-intake-field="${path}" aria-label="${esc(label)}" value="${esc(value)}" type="${type}" ${type === "number" ? 'min="1" max="1000000" step="1" inputmode="numeric"' : 'maxlength="300"'} />`;
      return `<div class="atlas-document-field ${path === "address" || path.startsWith("sku.") ? "is-wide" : ""} ${confirmed ? "is-confirmed" : "needs-confirmation"}"><label>${esc(label)}${input}</label><span data-intake-check>${confirmed ? icon("check") : "!"}</span>${!confirmed ? `<small>Please confirm this value.${field.candidates.length > 1 ? ` Readings: ${field.candidates.map(esc).join(" / ")}` : ""}</small><button type="button" data-intake-confirm="${path}">Confirm value</button>` : ""}</div>`;
    }
    function reviewedOrder() {
      if (!assessment || result?.mixedOrders) return null;
      const value = (path, field) => Object.hasOwn(overrides, path) ? overrides[path] : field.value;
      const confirmed = (path, field) => Object.hasOwn(overrides, path) || field.status === "confirmed";
      const order = { ...result, date, checkOnDelivery: checkOverride ?? result.checkOnDelivery, sourceCheckOnDelivery: result.checkOnDelivery, lines: [] };
      for (const name of ["orderNumber", "customer", "address", "city", "timeWindow"]) {
        const field = assessment.fields[name]; order[name] = String(value(name, field)).trim();
        if (scanner && name === "city" && overrides.address) order.city = String(overrides.address).match(/(?:,|^)([^,]+),?\s+[A-Z]{2}\s+\d{5}/i)?.[1]?.trim() || order.city;
        if ((!confirmed(name, field) && !(scanner && name === "city" && order.city)) || (name !== "timeWindow" && !order[name])) return null;
      }
      if (!/^SO-US-\d{3,12}$/i.test(order.orderNumber)) return null;
      for (const [i, line] of assessment.fields.lines.entries()) {
        const reviewed = reviewLines()[i];
        if (!confirmed(`sku.${i}`, line.sku) || !confirmed(`caseQty.${i}`, line.caseQty) ||
          !skuPattern.test(reviewed.sku) || reviewed.caseQty == null ||
          snapshot().core.selectSpecification(snapshot().catalog, reviewed.sku).status !== "found") return null;
        order.lines.push(reviewed);
      }
      const diagnostic = (name,original,reviewed,manual,evidenceName=name) => {
        const words=result.pages.flatMap(p=>p.evidence?.[evidenceName]||[]);
        const values=words.map(w=>w.confidence).filter(Number.isFinite);
        return {field:name,original:String(original??""),reviewed:String(reviewed??""),confidence:values.length?Math.min(...values):null,source:manual?"manual":result.pages[0]?.parserVersion==="packing-slip-v1"?"template":"generic"};
      };
      order.extraction = { parserVersion: result.pages?.[0]?.parserVersion || "generic-v2", purchaseOrder: result.pages?.[0]?.purchaseOrder || "", packingSlip: result.pages?.[0]?.packingSlip || "", fields: ["orderNumber","customer","address","timeWindow"].map(name=>diagnostic(name,result[name],order[name],Object.hasOwn(overrides,name))) };
      order.lines.forEach((line,i)=>{for(const name of ["sku","caseQty","itemQty"])order.extraction.fields.push({field:`lines.${i}.${name}`,original:String(result.lines[i]?.[name]??""),reviewed:String(line[name]??""),confidence:null,source:Object.hasOwn(overrides,`${name}.${i}`)?"manual":"generic"});});

      return order.lines.length ? order : null;
    }
    function render(focus = true) {
      const s = snapshot(); let content = "";
      if (screen === "ADD_DOCUMENT") content = heading("Add Delivery Order", "Choose how you want to add the order.") +
        `<div class="atlas-document-choices">${button("camera", `${icon("camera")}<span>Photograph Order<small>Take a clear photo of the paperwork</small></span>${icon("chevron")}`, true)}${button("photos", `${icon("upload")}<span>Choose from Photos</span>${icon("chevron")}`)}</div><p class="atlas-document-caption is-centered">One order at a time</p>`;
      if (["CAMERA_OPENING", "CAMERA_PERMISSION", "CAMERA_BLOCKED"].includes(screen)) content = heading("Scan Delivery Order", screen === "CAMERA_OPENING" ? "Opening your scanner…" : screen === "CAMERA_PERMISSION" ? "Allow camera access to photograph your order, or choose a photo." : "The camera could not open. Try again or choose a photo.") + (screen === "CAMERA_OPENING" ? '<div class="atlas-document-loader" aria-hidden="true"></div><p class="atlas-document-caption">Preparing camera and secure order upload</p>' : button("camera", screen === "CAMERA_PERMISSION" ? "Allow Camera" : "Try Again", true) + button("photos", "Choose from Photos"));
      if (screen === "CAPTURE") content = `<div class="atlas-document-camera"><video autoplay playsinline muted aria-label="Order camera preview"></video><span data-intake-camera-status>Starting camera…</span><div class="atlas-document-frame"></div><p>Fit the full page inside the frame</p></div><button type="button" data-intake-action="shutter" class="atlas-document-shutter" aria-label="Take order photo" disabled></button>${button("photos", "Choose from Photos")}`;
      if (screen === "READING" || screen === "OPTIMIZING") content = heading(screen === "READING" ? "Reading order" : "Optimizing route") + `<div class="atlas-document-loader" aria-hidden="true"></div><p class="atlas-document-caption">${screen === "READING" ? "Finding the delivery details…" : "Calculating stops, traffic and trip times…"}</p>${button("cancel-operation", "Cancel")}`;
      if (screen === "VERIFY") {
        content = `<div class="atlas-document-photo"><a href="${esc(photos[selectedPhoto]?.url)}" target="_blank" rel="noopener"><img src="${esc(photos[selectedPhoto]?.url)}" alt="Order page ${selectedPhoto + 1}; open full photo" /></a></div><div class="atlas-document-pages">${photos.map((p, i) => `<button type="button" data-intake-page="${i}" aria-pressed="${i === selectedPhoto}">Page ${i + 1}</button><button type="button" data-intake-remove-page="${i}" aria-label="Remove page ${i + 1}">×</button>`).join("")}</div>`;
        if (result?.mixedOrders) content += '<p class="atlas-document-error">These pages contain different sales orders. Remove the unrelated page before continuing.</p>';
        if (assessment) content += `<div class="atlas-document-fields">${[["orderNumber", "Order"], ["customer", "Customer"], ["address", "Ship to"]].map(([name, label]) => fieldRow(name, label, assessment.fields[name])).join("")}<details class="atlas-document-secondary" ${assessment.fields.city.status !== "confirmed" || assessment.fields.timeWindow.value || assessment.fields.timeWindow.status !== "confirmed" ? "open" : ""}><summary>City &amp; customer hours</summary>${fieldRow("city", "City", assessment.fields.city)}${fieldRow("timeWindow", "Hours", assessment.fields.timeWindow)}</details>${assessment.fields.lines.map((line, i) => fieldRow(`sku.${i}`, assessment.fields.lines.length > 1 ? `Item ${i + 1}` : "Item", line.sku) + fieldRow(`caseQty.${i}`, "Box count", line.caseQty, "number")).join("")}</div>`;
        if (!assessment?.fields.lines.length) content += '<p class="atlas-document-caption">No product rows found. Add a clearer page to read the SKU and boxes.</p>';
        if (result?.checkOnDelivery) content += '<p class="atlas-route-check-badge">CHECK ON DELIVERY</p>';
        content += button("append", `${icon("document")}Add another page`) + `<p class="atlas-document-caption is-centered">Check the details, then add the order.<br>Delivery day: ${esc(date)}</p>` + button("retake", "Retake photo");
        if (error) content += button("retry", "Read photos again");
      }
      if (screen === "ORDER_ADDED") content = `<div class="atlas-document-success">${icon("check")}</div>` + heading("Order added") + `<div class="atlas-document-card atlas-document-receipt">${[["document", added.orderNumber], ["user", added.customer], ["pin", added.city], ["box", `${totalBoxes(added)} boxes`]].map(([glyph, value]) => `<p>${icon(glyph)}<strong>${esc(value)}</strong></p>`).join("")}</div>${button("another", `${icon("camera")}Add Another Order`, true)}${button("finish", "Finish Adding Orders")}<p class="atlas-document-caption is-centered">${s.orders.length} orders · ${esc(s.date)}${s.dirty ? " · Save Route after planning" : ""}</p>`;
      if (screen === "ORDERS_READY") content = heading("Orders Ready") + `<p class="atlas-document-date">${icon("calendar")}${esc(s.date)}</p><div class="atlas-document-totals"><div>${icon("truck")}<strong>${s.orders.length}</strong>Deliveries</div><div>${icon("pallets")}<strong>${esc(s.pallets)}</strong>Pallets</div><div>${icon("box")}<strong>${s.orders.every(o => totalBoxes(o) != null) ? s.orders.reduce((n, o) => n + totalBoxes(o), 0) : "Needs review"}</strong>Boxes</div></div><div class="atlas-document-card">${s.orders.length ? s.orders.map(o => `<article class="atlas-document-order">${icon("user")}<div><strong>${esc(o.customer)}</strong><small>${esc(o.city)} · ${esc(o.orderNumber)}</small></div><span>${totalBoxes(o) == null ? "Needs review" : `${totalBoxes(o)} boxes`}</span><details><summary aria-label="Actions for ${esc(o.customer)}">•••</summary><button type="button" data-intake-edit="${esc(o.id)}">View / edit</button><button type="button" data-intake-remove="${esc(o.id)}" ${o.locked || !s.canEdit ? "disabled" : ""}>Remove</button></details></article>`).join("") : '<p>No orders for this day.</p>'}</div>${s.planIssue ? `<p class="atlas-document-caption">${esc(s.planIssue)}</p>` : ""}${button("optimize", `${icon("play")}Optimize Route`, true, !s.canOptimize)}${s.canEdit ? button("another", "Add another order") : ""}`;
      if (screen === "ROUTE_READY" || screen === "SAVED") {
        const plan = s.plan;
        content = heading(screen === "SAVED" ? "Route saved" : "Route Ready", screen === "SAVED" ? "Reviewed details and load settings are saved." : "Review the stops and trip estimates.");
        if (plan) content += `${plan.warnings?.length || plan.unscheduled?.length ? `<p class="atlas-document-error">Review needed · ${esc((plan.warnings || []).join(" "))} ${plan.unscheduled?.length || 0} unscheduled shipments</p>` : '<p class="atlas-document-ready">Route calculated · ready for review</p>'}${plan.trips.map(trip => `<article class="atlas-document-card atlas-document-trip"><h3>${icon("truck")}Trip ${trip.tripIndex + 1}<small>${esc(trip.driver)} · ${trip.vehicle === "truck" ? "Box Truck" : "Cargo Van"}</small></h3><p>${icon("clock")}${esc(s.time(trip.departure))}–${esc(s.time(trip.returnTime))} · ${trip.visits.reduce((sum, v) => sum + trip.shipments[v.stopIndex].palletSpaces, 0)} pallets</p><ol>${trip.visits.map(v => `<li><strong>${esc(trip.shipments[v.stopIndex].customer)}</strong><small>${esc(trip.locations[v.stopIndex]?.formattedAddress || "")}</small></li>`).join("")}<li><strong>Return to Warehouse</strong></li></ol><footer>${(trip.distanceMeters / 1609.344).toFixed(1)} mi <span>${Math.round((Date.parse(trip.returnTime) - Date.parse(trip.departure)) / 60000)} min trip</span></footer></article>`).join("")}`;
        content += button("save", screen === "SAVED" ? "Saved" : `${icon("template")}Save Route`, true, screen === "SAVED" || !s.canSave || !plan?.complete) + button("map", `${icon("map")}View Map`);
      }
      if(scanner){
        if(screen === "ADD_DOCUMENT") content = `<div class="atlas-scanner-hero">${icon("camera")}</div>`+heading("Scan Delivery Order","Photograph one packing slip at a time.")+button("camera",`${icon("camera")}Take Photo`,true)+button("photos","Choose from Photos")+`<p class="atlas-document-caption is-centered">Orders uploaded today <strong>${s.uploadedToday ?? uploadedCount}</strong></p>`;
        if(screen === "READING") content = `<div class="atlas-document-photo"><img src="${esc(photos[selectedPhoto]?.url)}" alt="Original order photo" /></div><div class="atlas-document-loader"></div>`+heading("Reading order…","Finding the delivery details.")+button("cancel-operation","Cancel");
        if(screen === "VERIFY" && assessment){
          const fields=assessment.fields, lines=reviewLines(), boxes=totalBoxes({lines});
          content=heading("Check these details")+`<div class="atlas-document-fields">${[["orderNumber","Sales order"],["customer","Customer"],["address","Delivery address"],["timeWindow","Receiving hours"]].map(([n,label])=>fieldRow(n,label,fields[n])).join("")}${lines.length ? fields.lines.map((line,i)=>fieldRow(`sku.${i}`,fields.lines.length>1?`Item ${i+1} SKU`:"SKU",line.sku)+fieldRow(`caseQty.${i}`,fields.lines.length>1?`Item ${i+1} boxes`:"Boxes",line.caseQty,"number")).join("") : '<p class="atlas-document-caption">No item details were captured. Retake the photo or add a clearer page.</p>'}${lines.length>1?`<p class="atlas-document-caption">Total boxes: <strong data-intake-box-total>${boxes==null?"Needs review":boxes}</strong></p>`:""}</div><label class="atlas-scanner-check"><input type="checkbox" data-scanner-check ${(checkOverride??result.checkOnDelivery)?"checked":""}/><span><strong>Check on delivery</strong><small>Adds CHECK ON DELIVERY to order notes</small></span></label>`+button("append","Add another page")+ (photos.length>1 ? `<div class="atlas-document-pages">${photos.map((p,i)=>`<button type="button" data-intake-remove-page="${i}">Remove page ${i+1}</button>`).join("")}</div>` : "");
          if(result.mixedOrders)content+='<p class="atlas-document-error">Different sales orders detected. Retake only this order.</p>';
        }
        if(screen === "ORDER_ADDED")content=`<div class="atlas-document-success">${icon("check")}</div>`+heading(added.duplicate?"Order already uploaded":"Order Uploaded",`${esc(added.orderNumber)} is saved for ${esc(added.date||date)} and ready on desktop.`)+button("another","Scan Another Order",true)+button("done","Done");
      }
      dialog.innerHTML = `<header class="atlas-document-header"><button type="button" data-intake-action="back" ${busy && !["READING", "OPTIMIZING"].includes(screen) ? "disabled" : ""}>‹ <span>${scanner ? "Back to ATLAS" : ["ROUTE_READY", "SAVED"].includes(screen) ? "Orders" : "Today’s Routes"}</span></button><img src="./atlas-brand-landscape-dark.svg?v=128" alt="ATLAS" />${scanner ? `<small class="atlas-scanner-title">${screen==="VERIFY"?"Review Order":"Order Scanner"}</small>` : ""}</header><main class="atlas-document-content" aria-live="polite" data-intake-screen="${screen}">${content}<p class="atlas-document-error" role="alert">${esc(error)}</p></main>${screen === "VERIFY" ? `<footer class="atlas-document-submit">${button("add", scanner ? "Upload Order" : "Add Order", true, !reviewedOrder())}${scanner ? button("retake","Retake") : ""}</footer>` : ""}<input type="file" accept="image/*" multiple data-intake-files hidden />`;
      dialog.querySelector("[data-intake-files]").addEventListener("change", event => { void addPhotos([...event.target.files]); event.target.value = ""; });
      if (focus) { dialog.scrollTop = 0; dialog.querySelector("h2")?.focus({ preventScroll: true }); }
    }
    function assess() {
      const previous = result, previousOverrides = overrides;
      const pages = photos.map(p => p.page).filter(Boolean); result = combinePages(pages);
      assessment = assessOrderReading(result, pages, snapshot().catalog, snapshot().core);
      overrides = {};
      // Carry explicit corrections forward by SKU, never by a shifting row index.
      // New disagreement always needs a fresh confirmation.
      for (const [path, value] of Object.entries(previousOverrides)) {
        if (!path.includes(".")) { if (assessment.fields[path]?.status !== "conflicting") overrides[path] = value; continue; }
        const [name, index] = path.split("."), sku = previous?.lines[Number(index)]?.sku;
        const next = result.lines.findIndex(line => line.sku === sku);
        if (next >= 0 && assessment.fields.lines[next][name].status !== "conflicting") overrides[`${name}.${next}`] = value;
      }
    }
    async function readPending() {
      cancel(); const version = generation; controller = new AbortController(); const signal = controller.signal;
      screen = "READING"; error = ""; render();
      try {
        for (const photo of photos) if (!photo.page) { const page = await read(photo.file, signal); if (!current(version)) return; photo.page = page; }
        if (!current(version)) return; assess();
        if (!photos.some(p => p.page?.words?.length)) error = "No readable text found. Take a clearer photo of the full page.";
        screen = "VERIFY"; render();
      } catch (e) { if (current(version)) { error = e.name === "AbortError" ? "Reading canceled. No order was added." : `Could not read this photo. ${e.message || "Check your connection and try again."}`; screen = "VERIFY"; assess(); render(); } }
      finally { if (current(version)) controller = null; }
    }
    async function addPhotos(files) {
      if (!files.length || busy) return;
      if ((replaceIndex == null ? photos.length : photos.length - 1) + files.length > 20 || files.some(f => f.size > 15 * 1024 * 1024 || !/^image\/(jpeg|png|webp|heic|heif)$/i.test(f.type))) { error = "Choose up to 20 photos of this order, each smaller than 15 MB."; render(); return; }
      stopCamera();
      if (!date) date = snapshot().intakeDate;
      const additions = files.map(file => ({ file, url: URL.createObjectURL(file), page: null }));
      if (replaceIndex != null) { URL.revokeObjectURL(photos[replaceIndex].url); photos.splice(replaceIndex, 1, ...additions); selectedPhoto = replaceIndex; replaceIndex = null; overrides = {}; }
      else { selectedPhoto = photos.length; photos.push(...additions); }
      await readPending();
    }
    async function camera() {
      cancel(); screen = "CAMERA_OPENING"; error = ""; render(); const version = generation;
      dialog.dataset.scannerStartup = "opening"; const attemptTimeout = cameraTimeout; cameraTimeout = 8000;
      cameraTimer = setTimeout(() => {
        if (!current(version)) return;
        cancel(); screen = "CAMERA_BLOCKED"; dialog.dataset.scannerStartup = "blocked"; render();
      }, attemptTimeout);
      try {
        const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1440 }, height: { ideal: 1920 } }, audio: false });
        if (!current(version)) { media.getTracks().forEach(t => t.stop()); return; }
        stream = media; screen = "CAPTURE"; render();
        const video = dialog.querySelector("video"); video.srcObject = media; await video.play();
        if (!current(version) || screen !== "CAPTURE") return;
        clearTimeout(cameraTimer); cameraTimer = null; dialog.dataset.scannerStartup = "ready";
        dialog.querySelector("[data-intake-camera-status]").textContent = "Ready"; dialog.querySelector('[data-intake-action="shutter"]').disabled = false;
      } catch (e) {
        if (!current(version)) return;
        clearTimeout(cameraTimer); cameraTimer = null; stopCamera();
        screen = e.name === "NotAllowedError" || e.name === "SecurityError" ? "CAMERA_PERMISSION" : "CAMERA_BLOCKED";
        dialog.dataset.scannerStartup = screen === "CAMERA_PERMISSION" ? "permission-needed" : "blocked";
        render();
      }
    }
    dialog.addEventListener("input", event => {
      if(event.target.matches("[data-scanner-check]")){checkOverride=event.target.checked;return;}
      const path = event.target.dataset.intakeField; if (!path) return;
      overrides[path] = event.target.value; const row = event.target.closest(".atlas-document-field"), valid = validField(path, event.target.value);
      row.classList.toggle("needs-confirmation", !valid); row.classList.toggle("is-confirmed", valid); row.querySelector("[data-intake-check]").innerHTML = valid ? icon("check") : "!";
      if (valid) { row.querySelector("small")?.remove(); row.querySelector("button")?.remove(); }
      if (scanner && /^(?:sku|caseQty)\.\d+$/.test(path)) {
        const lines = reviewLines(), boxes = orderBoxCount(lines);
        const total = dialog.querySelector('[data-intake-box-total]'); if (total) total.textContent = boxes == null ? "Needs review" : String(boxes);
      }
      dialog.querySelector('[data-intake-action="add"]').disabled = !reviewedOrder();
    });
    dialog.addEventListener("click", async event => {
      const target = event.target.closest("button"); if (!target) return;
      const action = target.dataset.intakeAction;
      if (busy && !["back", "cancel-operation"].includes(action)) return;
      if (target.hasAttribute("data-intake-confirm")) { const input = target.closest(".atlas-document-field").querySelector("input,textarea"); overrides[target.dataset.intakeConfirm] = input.value; render(false); return; }
      if (target.hasAttribute("data-intake-page")) { selectedPhoto = Number(target.dataset.intakePage); render(false); return; }
      if (target.hasAttribute("data-intake-remove-page")) { cancel(); const [p] = photos.splice(Number(target.dataset.intakeRemovePage), 1); URL.revokeObjectURL(p.url); selectedPhoto = 0; overrides = {}; if (!photos.length) { clearPhotos(); screen = "ADD_DOCUMENT"; render(); } else await readPending(); return; }
      if (target.hasAttribute("data-intake-edit")) { close(); edit(target.dataset.intakeEdit); return; }
      if (target.hasAttribute("data-intake-remove")) { try { remove(target.dataset.intakeRemove); } catch (e) { error = e.message; } render(false); return; }
      if (action === "done" || (action === "back" && (scanner || direct))) { if(!busy){close();exit();} return; }
      if (action === "back") { if (["ROUTE_READY", "SAVED"].includes(screen)) { screen = "ORDERS_READY"; render(); } else if (!busy || ["READING", "OPTIMIZING"].includes(screen)) close(); }
      if (action === "camera") await camera();
      if (action === "photos") dialog.querySelector("[data-intake-files]").click();
      if (action === "shutter") {
        const video = dialog.querySelector("video"), canvas = document.createElement("canvas"); if (!video?.videoWidth) return;
        canvas.width = video.videoWidth; canvas.height = video.videoHeight; canvas.getContext("2d").drawImage(video, 0, 0);
        const version = generation; target.disabled = true; const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.92)); canvas.width = canvas.height = 1;
        if (blob && current(version)) await addPhotos([new File([blob], "order.jpg", { type: "image/jpeg" })]);
      }
      if (action === "append") { replaceIndex = null; screen = "ADD_DOCUMENT"; error = ""; render(); }
      if (action === "retake") { replaceIndex = selectedPhoto; await camera(); }
      if (action === "retry") await readPending();
      if (action === "cancel-operation") { cancel(); screen = screen === "OPTIMIZING" ? "ORDERS_READY" : "VERIFY"; if (photos.length) assess(); error = "Canceled. Your order details are still here."; render(); }
      if (action === "another") { cancel(); clearPhotos(); date = null; added = null; screen = "ADD_DOCUMENT"; error = ""; render(); }
      if (action === "finish") { screen = "ORDERS_READY"; error = ""; render(); }
      if (action === "map") { close(); map(); }
      if (["add", "optimize", "save"].includes(action)) {
        const order = action === "add" ? reviewedOrder() : null;
        if (action === "add" && !order) return;
        busy = true; error = ""; const version = generation; target.disabled = true;
        if (action === "optimize") { screen = "OPTIMIZING"; render(); }
        else dialog.querySelector('[data-intake-action="back"]').disabled = true;
        try {
          if (action === "add") { const saved = await (scanner ? upload(order) : submit(order)); if (!current(version)) return; added = saved; if(scanner&&!saved.duplicate)uploadedCount++; clearPhotos(); screen = "ORDER_ADDED"; }
          if (action === "optimize") { await optimize(); if (!current(version)) return; screen = "ROUTE_READY"; }
          if (action === "save") { await save(); if (!current(version)) return; screen = "SAVED"; }
        } catch (e) { if (current(version)) { error = e.message || "Please try again."; if (action === "optimize") screen = "ORDERS_READY"; } }
        finally { if (current(version)) { busy = false; render(); } }
      }
    });
    return {
      open(initial = "ADD_DOCUMENT", options = {}) {
        if (dialog.open) return;
        const s = snapshot(); if (!s.active || (["ADD_DOCUMENT", "CAPTURE"].includes(initial) && !s.canEdit)) return;
        direct = options.direct === true; cameraTimeout = options.timeout || 8000;
        scanner = s.scanner === true; dialog.classList.toggle("is-scanner",scanner); if(owner!==s.owner)uploadedCount=0;
        cancel(); clearPhotos(); owner = s.owner; date = null; selectedPhoto = 0; replaceIndex = null; screen = initial; error = "";
        historyId = `intake-${Date.now()}`; window.history.pushState({ ...window.history.state, atlasDocumentFlow: historyId }, "");
        dialog.showModal(); render();
        if (initial === "CAPTURE") void camera();
      },
      choosePhotos: () => dialog.querySelector("[data-intake-files]")?.click(),
      reset: close, active: () => dialog.open,
    };
  }
  return { parsePage, normalizeHours, combinePages, orderBoxCount, preparePhoto, createPhotoQueue, assessOrderReading, quickReadingIssues, createDocumentFlow };
});
