(function (global) {
  "use strict";

  const MIN_OCR_CONFIDENCE = 82;
  const MAX_VALUE_LENGTH = 140;
  const IRRELEVANT_EXACT_CODES = new Set(["10810490030091"]);
  const LEGACY_RULES = Object.freeze([
    Object.freeze({
      id: "cgac1-color-pair",
      modelPattern: /^CGAC1-/i,
      suffixSegments: 2,
    }),
  ]);

  const clean = (value) => String(value ?? "").trim().slice(0, MAX_VALUE_LENGTH);
  const canonical = (value) => clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const cleanLot = (value) => clean(value).toUpperCase().replace(/\s+/g, "");

  function isIrrelevantBarcode(value) {
    const raw = clean(value);
    const normalized = canonical(raw);
    if (!normalized || IRRELEVANT_EXACT_CODES.has(normalized)) return true;
    return /^\d{8,18}$/.test(normalized);
  }

  function canonicalBoundaryEnd(rawValue, canonicalBoundary, startAt = 0) {
    const raw = clean(rawValue);
    const boundary = canonical(canonicalBoundary);
    if (!raw || !boundary) return -1;
    let normalized = "";
    const endIndexes = [];
    for (let index = 0; index < raw.length; index += 1) {
      if (/[A-Z0-9]/i.test(raw[index])) {
        normalized += raw[index].toUpperCase();
        endIndexes.push(index + 1);
      }
    }
    const matchAt = normalized.indexOf(boundary, startAt);
    if (matchAt < 0) return -1;
    return endIndexes[matchAt + boundary.length - 1] ?? -1;
  }

  function modernPrefixes(modelValue) {
    const model = clean(modelValue).toUpperCase();
    const parts = model.split("-").map(canonical).filter(Boolean);
    if (parts.length < 2) return [];
    const withoutFamily = parts.slice(1).join("");
    const candidates = new Set([withoutFamily]);
    if (parts.length > 2) candidates.add(parts.slice(-2).join(""));
    candidates.add(parts[parts.length - 1]);
    return [...candidates].filter((value) => value.length >= 2)
      .sort((left, right) => right.length - left.length);
  }

  function parseModernBarcode(barcodeValue, modelValue = "") {
    const rawBarcode = clean(barcodeValue).toUpperCase();
    const normalized = canonical(rawBarcode);
    if (isIrrelevantBarcode(rawBarcode)) {
      return { accepted: false, reason: "irrelevant_product_code", rawBarcode };
    }
    for (const prefix of modernPrefixes(modelValue)) {
      if (!normalized.startsWith(prefix)) continue;
      const boundary = canonicalBoundaryEnd(rawBarcode, prefix);
      const lot = cleanLot(rawBarcode.slice(boundary).replace(/^[^A-Z0-9]+/i, ""));
      if (canonical(lot).length >= 6) {
        return {
          accepted: true,
          lot,
          rawBarcode,
          model: clean(modelValue).toUpperCase(),
          rule: "known_model_prefix",
          score: 100,
        };
      }
    }
    if (/^[A-Z]{3,6}\d{6,}(?:-\d+)?$/i.test(rawBarcode)) {
      return {
        accepted: true,
        lot: rawBarcode,
        rawBarcode,
        model: clean(modelValue).toUpperCase(),
        rule: "direct_lot",
        score: 90,
      };
    }
    return { accepted: false, reason: "unclassified_barcode", rawBarcode };
  }

  function extractField(textValue, labelPattern) {
    const lines = String(textValue ?? "").toUpperCase().split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim());
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!labelPattern.test(line)) continue;
      const inline = line.replace(labelPattern, "").replace(/^\s*[:#.-]\s*/, "").trim();
      if (/[A-Z0-9]/.test(inline)) return clean(inline);
      const next = lines[index + 1] || "";
      if (/[A-Z0-9]/.test(next)) return clean(next);
    }
    return "";
  }

  function extractLabelFields(textValue) {
    return {
      model: extractField(textValue, /^.*?\bMODEL\s*(?:NO|NUMBER|#)?\b/i),
      batch: extractField(textValue, /^.*?\b(?:BATCH|LOT)\s*(?:NO|NUMBER|#)?\b/i),
    };
  }

  function legacyRuleForModel(modelValue, rules = LEGACY_RULES) {
    const model = clean(modelValue).toUpperCase();
    return rules.find((rule) => rule.modelPattern.test(model)) || null;
  }

  function extractLegacyLot(modelValue, batchValue, rules = LEGACY_RULES) {
    const model = clean(modelValue).toUpperCase();
    const rawBatch = clean(batchValue).toUpperCase();
    const rule = legacyRuleForModel(model, rules);
    if (!rule || !rawBatch) return { accepted: false, reason: "legacy_rule_not_found" };
    const parts = model.split("-").filter(Boolean);
    if (parts.length <= rule.suffixSegments) {
      return { accepted: false, reason: "legacy_model_suffix_missing", rule: rule.id };
    }
    const suffix = parts.slice(-rule.suffixSegments).join("");
    const boundary = canonicalBoundaryEnd(rawBatch, suffix);
    if (boundary < 0) {
      return { accepted: false, reason: "legacy_boundary_not_found", rule: rule.id };
    }
    const lot = cleanLot(rawBatch.slice(boundary));
    if (canonical(lot).length < 6) {
      return { accepted: false, reason: "legacy_lot_invalid", rule: rule.id };
    }
    return {
      accepted: true,
      lot,
      model,
      rawBatch,
      matchedSuffix: suffix,
      rule: rule.id,
    };
  }

  function levenshtein(leftValue, rightValue) {
    const left = canonical(leftValue);
    const right = canonical(rightValue);
    const row = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      let prior = row[0];
      row[0] = leftIndex;
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        const saved = row[rightIndex];
        row[rightIndex] = Math.min(
          row[rightIndex] + 1,
          row[rightIndex - 1] + 1,
          prior + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
        );
        prior = saved;
      }
    }
    return row[right.length];
  }

  function findSimilarLot(lotValue, existingLots = []) {
    const target = canonical(lotValue);
    if (!target) return null;
    const candidates = existingLots.map((item) => {
      const value = typeof item === "string" ? item : item?.lot;
      return { item, value: cleanLot(value), normalized: canonical(value) };
    }).filter((entry) => entry.normalized && entry.normalized !== target)
      .map((entry) => ({ ...entry, distance: levenshtein(target, entry.normalized) }))
      .sort((left, right) => left.distance - right.distance);
    const closest = candidates[0];
    if (!closest) return null;
    const threshold = target.length >= 12 ? 2 : 1;
    if (closest.distance > threshold || Math.abs(closest.normalized.length - target.length) > 1)
      return null;
    return closest;
  }

  function classifyBarcodes(values = [], model = "") {
    return [...new Set(values.map(clean).filter(Boolean))]
      .map((value) => parseModernBarcode(value, model))
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  }

  function evaluateCapture({ barcodes = [], ocrText = "", ocrConfidence = 0 } = {}) {
    const fields = extractLabelFields(ocrText);
    const barcodeResults = classifyBarcodes(barcodes, fields.model);
    const barcode = barcodeResults.find((candidate) => candidate.accepted) || null;
    const confidence = Number.isFinite(Number(ocrConfidence))
      ? Math.max(0, Math.min(100, Number(ocrConfidence)))
      : 0;

    if (barcode) {
      const printedBatch = cleanLot(fields.batch);
      if (printedBatch && canonical(printedBatch) !== canonical(barcode.lot)) {
        return {
          status: "mismatch",
          reason: "barcode_print_mismatch",
          lot: barcode.lot,
          printedLot: printedBatch,
          rawBarcode: barcode.rawBarcode,
          rawBatchText: fields.batch,
          model: fields.model || barcode.model,
          captureMethod: "barcode",
          validationMethod: "barcode_print_mismatch",
          confidence,
          barcodeCandidates: barcodeResults,
        };
      }
      return {
        status: "confirm",
        lot: barcode.lot,
        rawBarcode: barcode.rawBarcode,
        rawBatchText: fields.batch,
        model: fields.model || barcode.model,
        captureMethod: printedBatch ? "barcode_ocr" : "barcode",
        validationMethod: printedBatch ? "barcode_print_match" : barcode.rule,
        confidence,
        barcodeCandidates: barcodeResults,
      };
    }

    if (fields.model && fields.batch) {
      if (confidence < MIN_OCR_CONFIDENCE) {
        return {
          status: "rescan",
          reason: "low_ocr_confidence",
          rawBatchText: fields.batch,
          model: fields.model,
          confidence,
          barcodeCandidates: barcodeResults,
        };
      }
      const legacy = extractLegacyLot(fields.model, fields.batch);
      if (legacy.accepted) {
        return {
          status: "confirm",
          lot: legacy.lot,
          rawBarcode: "",
          rawBatchText: legacy.rawBatch,
          model: legacy.model,
          captureMethod: "legacy_ocr",
          validationMethod: legacy.rule,
          confidence,
          barcodeCandidates: barcodeResults,
        };
      }
      return {
        status: "rescan",
        reason: legacy.reason,
        rawBatchText: fields.batch,
        model: fields.model,
        confidence,
        barcodeCandidates: barcodeResults,
      };
    }

    return {
      status: "rescan",
      reason: barcodeResults.some((candidate) => candidate.reason === "irrelevant_product_code")
        ? "lot_barcode_not_identified"
        : "label_fields_not_verified",
      confidence,
      barcodeCandidates: barcodeResults,
    };
  }

  global.AtlasCocParser = Object.freeze({
    MIN_OCR_CONFIDENCE,
    LEGACY_RULES,
    canonical,
    cleanLot,
    isIrrelevantBarcode,
    modernPrefixes,
    parseModernBarcode,
    extractLabelFields,
    extractLegacyLot,
    levenshtein,
    findSimilarLot,
    classifyBarcodes,
    evaluateCapture,
  });
})(window);
