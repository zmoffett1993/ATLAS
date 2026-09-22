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
    for (let i = 0; i < list.length; i++) {
      if (key(list[i].text) === `${first} ${second}`) return list[i];
      if (key(list[i].text) === first && key(list[i + 1]?.text) === second) {
        return { ...list[i], w: list[i + 1].x + list[i + 1].w - list[i].x };
      }
    }
    return null;
  }

  // Recognize this company's printed form conservatively. Handwriting and
  // unrecognized layouts stay available in the photo for human review.
  function parsePage(page, index = 0) {
    const words = (page.words || []).filter((w) => typeof w.text === "string" && w.text.length <= 200 &&
      [w.x, w.y, w.w, w.h].every(Number.isFinite) && w.w > 0 && w.h > 0);
    const lines = rows(words), text = String(page.text || words.map((w) => w.text).join(" ")).slice(0, 100000);
    const issues = [], fields = { orderNumber: "", customer: "", address: "", city: "", timeWindow: "" };
    const ids = [...new Set([...text.matchAll(/\bSO\s*[-–]?\s*US\s*[-–]?\s*(\d{3,12})\b/gi)].map((m) => `SO-US-${m[1]}`))];
    const referenceNumbers = (prefix, label) => [...new Set([
      ...[...text.matchAll(new RegExp(`\\b${prefix}\\s*[-–]\\s*US\\s*[-–]\\s*(\\d{3,12})\\b`, "gi"))].map((m) => `${prefix}-US-${m[1]}`),
      ...[...text.matchAll(new RegExp(`\\b${label}\\s*(?:number|no\\.?|#)\\s*[:#]?\\s*([A-Z0-9][A-Z0-9-]{0,79})\\b`, "gi"))].map((m) => key(m[1])).filter((s) => /\d/.test(s)),
    ])];
    const invoiceNumbers = referenceNumbers("INV", "Invoice"), fulfillmentNumbers = referenceNumbers("IF", "Item\\s+Fulfillment");
    if (ids.length === 1) fields.orderNumber = ids[0];
    else issues.push(ids.length ? "Different sales order numbers appear on this photo." : "Confirm the sales order number; none was confidently recognized.");
    const table = lines.find((r) => phrase(r, "CASE", "QTY") && phrase(r, "ITEM", "QTY"));
    const ship = lines.map((r) => ({ row: r, heading: phrase(r, "SHIP", "TO") })).find((r) => r.heading);
    if (ship) {
      const left = ship.heading.x - 0.01;
      const boundary = ship.row.words.find((w) => w.x > ship.heading.x + ship.heading.w + 0.05);
      const right = boundary?.x ?? Math.min(1, ship.heading.x + 0.37);
      const stop = lines.find((r) => r.y > ship.row.y + ship.row.h && /Pmt\s*Method|Payment\s*Method|Terms|PO\s*#|Sales\s*Rep|Ship\s*Via/i.test(textOf(r)));
      const end = Math.min(table?.y ?? 1, stop?.y ?? 1, ship.row.y + 0.20);
      const block = lines.filter((r) => r.y > ship.row.y + ship.row.h * 0.6 && r.y < end)
        .map((r) => r.words.filter((w) => w.x >= left && w.x < right).map((w) => w.text).join(" ")).filter(Boolean);
      const cityIndex = block.findIndex((s) => /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/i.test(s));
      if (cityIndex > 0) {
        const streetIndex = block.findIndex((s) => /^\d+[A-Z-]?\s+\S/i.test(s));
        if (streetIndex >= 0 && streetIndex < cityIndex) {
          fields.customer = block.slice(0, streetIndex).join(" ");
          fields.address = block.slice(streetIndex, cityIndex + 1).join(", ");
          fields.city = block[cityIndex].replace(/,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?.*$/i, "").trim();
        }
      }
      const times = block.filter((s) => /\b(?:[1-9]|1[0-2])(?::[0-5]\d)?\s*[AP]\.?M\.?\b|\b\d{1,2}:[0-5]\d\s*[-–]\s*\d{1,2}:[0-5]\d\b/i.test(s));
      fields.timeWindow = times.join(" · ").slice(0, 100);
    }
    if (!fields.address || !fields.customer) issues.push("Review the Ship To address and customer; the Bill To address is never substituted.");
    const items = [];
    if (table) {
      const cases = phrase(table, "CASE", "QTY"), units = phrase(table, "ITEM", "QTY");
      const caseX = cases.x + cases.w / 2, unitX = units.x + units.w / 2;
      const tolerance = Math.max(0.018, Math.abs(caseX - unitX) * 0.42);
      const printedSkus = [...new Set([...text.matchAll(/\bCG[A-Z0-9]+(?:\s*[-‐‑–—]\s*[A-Z0-9.]+)+/gi)]
        .map((m) => key(m[0].replace(/\s*[-‐‑–—]\s*/g, "-"))))];
      // Vision can split a printed SKU at hyphens. Rejoin only adjacent tokens
      // on the same row, left of the quantity columns; never infer a color code.
      const skus = [];
      for (const row of lines.filter((r) => r.y > table.y)) {
        for (let i = 0; i < row.words.length; i++) {
          const first = row.words[i];
          if (first.x >= units.x || !/^CG[A-Z0-9]/i.test(first.text)) continue;
          let sku = { ...first, text: first.text.replace(/[‐‑–—]/g, "-") };
          let lastValid = skuPattern.test(sku.text) ? { ...sku } : null;
          while (i + 1 < row.words.length) {
            const next = row.words[i + 1], part = next.text.replace(/[‐‑–—]/g, "-");
            if (next.x >= units.x || next.x - (sku.x + sku.w) > Math.max(sku.h * 1.5, 0.012) ||
                !/^[A-Z0-9.\-]+$/i.test(part) || !(/-$/.test(sku.text) || /^-/.test(part))) break;
            sku.text += part; sku.w = next.x + next.w - sku.x;
            if (next.confidence != null) sku.confidence = Math.min(sku.confidence ?? 1, next.confidence);
            if (skuPattern.test(sku.text)) lastValid = { ...sku };
            i++;
          }
          if (lastValid) {
            // Skew can place the final color token on a neighboring OCR row.
            // Use it only when the complete OCR text has one unambiguous,
            // explicitly printed four-digit extension of this exact base.
            const full = printedSkus.filter((s) => s.startsWith(`${key(lastValid.text)}-`) && /^\d{4}$/.test(s.slice(lastValid.text.length + 1)));
            if (full.length === 1) lastValid.text = full[0];
            else if (full.length > 1 || /-$/.test(sku.text)) issues.push(`${lastValid.text}: confirm the complete printed SKU and color suffix.`);
            skus.push(lastValid);
          }
        }
      }
      skus.forEach((sku, i) => {
        const nextY = skus[i + 1]?.y ?? 1;
        const nearby = words.filter((w) => w.y >= sku.y - sku.h * 0.5 && w.y < Math.min(nextY - sku.h * 0.3, sku.y + Math.max(sku.h * 2.4, 0.025)));
        const at = (x) => nearby.filter((w) => Math.abs(w.x + w.w / 2 - x) < tolerance && number(w.text) != null);
        const c = at(caseX), u = at(unitX);
        const caseQty = c.length === 1 && number(c[0].text) > 0 && number(c[0].text) <= 1000000 ? number(c[0].text) : null;
        const itemQty = u.length === 1 && number(u[0].text) > 0 && number(u[0].text) <= 1000000000 ? number(u[0].text) : null;
        if (caseQty == null) issues.push(`${sku.text}: confirm Case Qty (boxes); Item Qty was not used as a substitute.`);
        if ([sku, ...c, ...u].some((w) => w.confidence != null && w.confidence < 0.85)) issues.push(`${sku.text}: photo reading is uncertain; verify the printed SKU and quantities.`);
        items.push({ sku: key(sku.text), caseQty, itemQty, source: index + 1 });
      });
    }
    if (!items.length) issues.push("No product rows were confidently recognized. Enter the SKU and Case Qty from the photo.");
    return { ...fields, invoiceNumbers, fulfillmentNumbers, lines: items, ids, issues, checkOnDelivery: /\bCHECK\s+ON\s+DELIVERY\b/i.test(text), text, source: index + 1 };
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
      const data = canvas.toDataURL("image/jpeg", 0.88).split(",")[1];
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

  function quickReadingIssues(result, pages, catalog, core) {
    const issues = [...(result?.issues || [])];
    if (!result || result.mixedOrders || ![result.orderNumber, result.customer, result.address, result.city].every(Boolean) || !result.lines.length) issues.push("Confirm the order number, Ship To address, SKU and boxes.");
    // Auto-add requires confidence for the entire reading, not just its SKU.
    if (!pages.length || pages.some(page => !page.words?.length || page.words.some(word => !Number.isFinite(word.confidence) || word.confidence < 0.85))) issues.push("Some text is uncertain. Check the photo before adding this order.");
    for (const line of result?.lines || []) {
      const match = core.selectSpecification(catalog, line.sku);
      if (match.status !== "found" || !Number.isSafeInteger(line.caseQty) || line.caseQty < 1 || line.caseQty > 1000000 || line.uncertain) issues.push(`${line.sku}: confirm the SKU and box count.`);
      const units = Number(match.row?.caseQty);
      if (line.itemQty != null && (!Number.isSafeInteger(line.itemQty) || line.itemQty < 1 || line.itemQty > 1000000000 || (units > 0 && line.caseQty * units !== line.itemQty))) issues.push(`${line.sku}: check units against the box count.`);
    }
    return [...new Set(issues)];
  }
  return { parsePage, combinePages, preparePhoto, createPhotoQueue, quickReadingIssues };
});
