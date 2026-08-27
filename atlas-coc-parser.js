(function (global) {
  "use strict";

  const MIN_OCR_CONFIDENCE = 82;
  const MIN_OCR_ONLY_CONFIDENCE = 88;
  const MIN_MODEL_BATCH_CONFIDENCE = 78;
  const MAX_VALUE_LENGTH = 140;
  const DIRECT_LOT_PATTERN = /^[A-Z]{3,8}\d{4,}(?:-\d+)?$/i;
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

  function parseModernBarcode(barcodeValue, modelValue = "", { allowSkuPrefix = true } = {}) {
    const rawBarcode = clean(barcodeValue).toUpperCase();
    const normalized = canonical(rawBarcode);
    if (isIrrelevantBarcode(rawBarcode)) {
      return { accepted: false, reason: "irrelevant_product_code", rawBarcode };
    }
    if (allowSkuPrefix) {
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
    }
    if (DIRECT_LOT_PATTERN.test(rawBarcode)) {
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
      const inline = line.replace(labelPattern, "").replace(/^\s*[:#.-]+\s*/, "").trim();
      if (/[A-Z0-9]/.test(inline)) return clean(inline);
      const next = lines[index + 1] || "";
      if (/[A-Z0-9]/.test(next)) return clean(next);
    }
    return "";
  }

  function extractStructuredField(textValue, kind) {
    const lines = String(textValue ?? "").toUpperCase().split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim());
    const labelPattern = kind === "model"
      ? /\bM[O0]DEL\s*(?:N[O0]|NUMBER|#)?\s*[.:#-]*/i
      : /\b(?:BATCH|LOT)\s*(?:N[O0]|NUMBER|#)?\s*[.:#-]*/i;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const match = line.match(labelPattern);
      if (!match) continue;
      const inline = line.slice((match.index || 0) + match[0].length)
        .replace(/^[^A-Z0-9]+/i, "").trim();
      if (/[A-Z0-9]/.test(inline)) return { found: true, value: clean(inline) };
      for (let offset = 1; offset <= 2; offset += 1) {
        const next = lines[index + offset] || "";
        if (!next) continue;
        if (/\b(?:M[O0]DEL|BATCH|LOT|CGIPO)\b/i.test(next)) break;
        if (/[A-Z0-9]/.test(next)) return { found: true, value: clean(next) };
      }
      return { found: true, value: "" };
    }
    return { found: false, value: "" };
  }

  function extractLabelFields(textValue) {
    const text = String(textValue ?? "").toUpperCase();
    const structuredModel = extractStructuredField(text, "model");
    const structuredBatch = extractStructuredField(text, "batch");
    const labeledModel = structuredModel.value || extractField(text, /^.*?\bM[O0]DEL\s*(?:N[O0]|NUMBER|#)?\b/i);
    const labeledBatch = structuredBatch.value || extractField(text, /^.*?\b(?:BATCH|LOT)\s*(?:N[O0]|NUMBER|#)?\b/i);
    return {
      model: labeledModel || clean(text.match(/\bCG[A-Z0-9]{2,}(?:-[A-Z0-9]{2,}){2,}\b/)?.[0]),
      batch: labeledBatch || clean(text.match(/\b[A-Z]{3,6}\d{4,}(?:-\d+)?\b/)?.[0]),
      hasStructuredModel: structuredModel.found,
      hasStructuredBatch: structuredBatch.found,
    };
  }

  function extractHumanReadableCandidates(textValue) {
    const fields = extractLabelFields(textValue);
    const excluded = new Set([canonical(fields.model), canonical(fields.batch)].filter(Boolean));
    const candidates = [];
    String(textValue ?? "").toUpperCase().split(/\r?\n/).forEach((line) => {
      const trimmed = line.replace(/^[^A-Z0-9]+|[^A-Z0-9./_-]+$/g, "").trim();
      const tokens = trimmed.match(/[A-Z0-9][A-Z0-9./_-]{7,79}/g) || [];
      tokens.forEach((token) => {
        const value = clean(token).replace(/[.,;:]+$/g, "");
        const normalized = canonical(value);
        if (!normalized || excluded.has(normalized)) return;
        if (/^(?:MODEL|NUMBER|BATCH|LOT|BARCODE|PRODUCT|QUANTITY|QTY)$/i.test(value)) return;
        candidates.push(value);
      });
    });
    return [...new Set(candidates)];
  }

  function modelsAgree(modelValue, skuValue) {
    const model = canonical(modelValue);
    const sku = canonical(skuValue);
    return Boolean(model && sku && model === sku);
  }

  function ocrEquivalent(value) {
    return canonical(value)
      .replaceAll("0", "O")
      .replaceAll("1", "I")
      .replaceAll("5", "S")
      .replaceAll("8", "B")
      .replaceAll("2", "Z")
      .replaceAll("6", "G");
  }

  function modelCompatibility(modelValue, skuValue) {
    const model = canonical(modelValue);
    const sku = canonical(skuValue);
    if (!model || !sku) return { accepted: true, method: "context_only", distance: 0 };
    if (model === sku) return { accepted: true, method: "exact", distance: 0 };
    if (model.length === sku.length && ocrEquivalent(model) === ocrEquivalent(sku)) {
      return { accepted: true, method: "ocr_equivalent", distance: 0 };
    }
    const distance = levenshtein(model, sku);
    const ratio = distance / Math.max(model.length, sku.length, 1);
    if (distance <= 2 && ratio <= 0.15) {
      return { accepted: true, method: "close_ocr", distance };
    }
    return { accepted: false, method: "mismatch", distance };
  }

  function validLotShape(value) {
    const lot = cleanLot(value);
    return canonical(lot).length >= 5 && /[A-Z]/i.test(lot) && /\d/.test(lot) &&
      /^[A-Z0-9][A-Z0-9./_-]*$/i.test(lot);
  }

  function parseStructuredBatch(batchValue, modelValue) {
    const rawBatch = clean(batchValue).toUpperCase();
    const normalized = canonical(rawBatch);
    if (!rawBatch) return { accepted: false, reason: "structured_batch_missing" };
    for (const prefix of modernPrefixes(modelValue)) {
      const matchAt = normalized.indexOf(prefix);
      // Legacy labels may add a short supplier marker (for example "AT")
      // before the product/color suffix. A match deeper in the value is not a
      // safe product boundary and must not trigger arbitrary truncation.
      if (matchAt < 0 || matchAt > 4) continue;
      const boundary = canonicalBoundaryEnd(rawBatch, prefix, matchAt);
      const lot = cleanLot(rawBatch.slice(boundary).replace(/^[^A-Z0-9]+/i, ""));
      if (validLotShape(lot)) {
        return {
          accepted: true,
          lot,
          rawBatch,
          matchedPrefix: prefix,
          rule: matchAt ? "sku_boundary_after_supplier_marker" : "known_model_prefix",
        };
      }
    }
    if (validLotShape(rawBatch)) {
      return {
        accepted: true,
        lot: cleanLot(rawBatch),
        rawBatch,
        matchedPrefix: "",
        rule: "clean_structured_batch",
      };
    }
    return { accepted: false, reason: "structured_batch_invalid", rawBatch };
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

  function classifyBarcodes(values = [], model = "", options = {}) {
    return [...new Set(values.map(clean).filter(Boolean))]
      .map((value) => parseModernBarcode(value, model, options))
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  }

  function parsePrintedCandidate(value, labelClass, expectedModel) {
    const source = clean(value);
    if (!source) return { accepted: false, reason: "empty_printed_value", source };
    if (labelClass === "model_batch") {
      const structured = parseStructuredBatch(source, expectedModel);
      if (structured.accepted) return { ...structured, rawBarcode: source, source };
      return { ...parseModernBarcode(source, expectedModel), source };
    }
    return {
      ...parseModernBarcode(source, "", { allowSkuPrefix: false }),
      source,
    };
  }

  function evaluateCapture({
    barcodes = [], ocrText = "", ocrConfidence = 0, fieldConfidence = 0,
    sku = "", barcodeDetections = [],
  } = {}) {
    const fields = extractLabelFields(ocrText);
    const expectedModel = clean(sku || fields.model).toUpperCase();
    const detectedModel = clean(fields.model).toUpperCase();
    const compatibility = modelCompatibility(detectedModel, expectedModel);
    const barcodeHasKnownSkuPrefix = modernPrefixes(expectedModel).some((prefix) =>
      barcodes.some((value) => canonical(value).startsWith(prefix)),
    );
    const labelClass = fields.hasStructuredModel || barcodeHasKnownSkuPrefix ||
      (fields.hasStructuredBatch && detectedModel && compatibility.accepted)
      ? "model_batch"
      : "direct_lot";
    const confidence = Number.isFinite(Number(ocrConfidence))
      ? Math.max(0, Math.min(100, Number(ocrConfidence)))
      : 0;
    const trustedFieldConfidence = Number.isFinite(Number(fieldConfidence))
      ? Math.max(0, Math.min(100, Number(fieldConfidence)))
      : 0;
    const batchEvidenceConfidence = Math.max(confidence, trustedFieldConfidence);
    const barcodeResults = classifyBarcodes(
      barcodes,
      labelClass === "model_batch" ? expectedModel : "",
      { allowSkuPrefix: labelClass === "model_batch" },
    );
    const acceptedBarcodes = barcodeResults.filter((candidate) => candidate.accepted);
    const distinctBarcodeLots = [...new Set(
      acceptedBarcodes.map((candidate) => canonical(candidate.lot)).filter(Boolean),
    )];
    const barcode = acceptedBarcodes[0] || null;
    const humanReads = extractHumanReadableCandidates(ocrText);
    const printedSources = [...new Set([fields.batch, ...humanReads].map(clean).filter(Boolean))];
    const printedResults = printedSources.map(
      (value) => parsePrintedCandidate(value, labelClass, expectedModel),
    );
    const labeledBatchResult = printedResults.find(
      (candidate) => candidate.source === fields.batch,
    ) || null;
    const trustedPrinted = printedResults.filter((candidate) => candidate.accepted && (
      (candidate.source === fields.batch && batchEvidenceConfidence >= MIN_MODEL_BATCH_CONFIDENCE) ||
      (candidate.source !== fields.batch && confidence >= MIN_OCR_ONLY_CONFIDENCE)
    ));
    const barcodeFormat = clean(
      barcodeDetections.find((item) => canonical(item?.value) === canonical(barcode?.rawBarcode))?.format,
    );

    if (distinctBarcodeLots.length > 1) {
      return {
        status: "rescan",
        reason: "ambiguous_barcode_lot",
        confidenceState: "needs_verification",
        labelClass,
        rawBatchText: fields.batch,
        model: detectedModel,
        expectedModel,
        barcodeCandidates: barcodeResults,
      };
    }

    if (barcode) {
      if (labelClass === "model_batch" && !compatibility.accepted) {
        return {
          status: "rescan",
          reason: "model_sku_mismatch",
          confidenceState: "needs_verification",
          labelClass,
          rawBarcode: barcode.rawBarcode,
          rawBatchText: fields.batch,
          model: detectedModel,
          expectedModel,
          confidence,
          barcodeCandidates: barcodeResults,
        };
      }
      const matchingPrinted = trustedPrinted.find(
        (candidate) => canonical(candidate.lot) === canonical(barcode.lot),
      );
      const labeledBatchLot = labeledBatchResult?.accepted
        ? labeledBatchResult.lot
        : cleanLot(fields.batch);
      if (fields.batch && batchEvidenceConfidence >= MIN_MODEL_BATCH_CONFIDENCE &&
        canonical(labeledBatchLot) !== canonical(barcode.lot)) {
        return {
          status: "mismatch",
          reason: "barcode_print_mismatch",
          confidenceState: "needs_verification",
          labelClass,
          lot: barcode.lot,
          printedLot: labeledBatchLot,
          rawBarcode: barcode.rawBarcode,
          rawBatchText: fields.batch,
          model: detectedModel || expectedModel || barcode.model,
          expectedModel,
          captureMethod: "barcode",
          validationMethod: "barcode_print_mismatch",
          barcodeFormat,
          confidence: batchEvidenceConfidence,
          barcodeCandidates: barcodeResults,
        };
      }
      const conflictingPrinted = trustedPrinted.find(
        (candidate) => canonical(candidate.lot) !== canonical(barcode.lot),
      );
      if (!matchingPrinted && conflictingPrinted) {
        return {
          status: "mismatch",
          reason: "barcode_print_mismatch",
          confidenceState: "needs_verification",
          labelClass,
          lot: barcode.lot,
          printedLot: conflictingPrinted.lot,
          rawBarcode: barcode.rawBarcode,
          rawBatchText: conflictingPrinted.source,
          model: detectedModel || expectedModel || barcode.model,
          expectedModel,
          captureMethod: "barcode",
          validationMethod: "barcode_print_mismatch",
          barcodeFormat,
          confidence,
          barcodeCandidates: barcodeResults,
        };
      }
      return {
        status: "confirm",
        lot: barcode.lot,
        confidenceState: matchingPrinted ? "verified" : "recognized",
        labelClass,
        rawBarcode: barcode.rawBarcode,
        rawBatchText: matchingPrinted?.source || fields.batch,
        model: detectedModel || expectedModel || barcode.model,
        expectedModel,
        captureMethod: matchingPrinted ? "barcode_ocr" : "barcode",
        validationMethod: matchingPrinted ? "barcode_print_match" : barcode.rule,
        modelMatchMethod: compatibility.method,
        barcodeFormat,
        confidence: Math.max(confidence, matchingPrinted ? batchEvidenceConfidence : 0),
        barcodeCandidates: barcodeResults,
      };
    }

    if (labelClass === "model_batch" && fields.batch) {
      if (!compatibility.accepted) {
        return {
          status: "rescan",
          reason: "model_sku_mismatch",
          confidenceState: "needs_verification",
          labelClass,
          rawBatchText: fields.batch,
          model: detectedModel,
          expectedModel,
          confidence: batchEvidenceConfidence,
          barcodeCandidates: barcodeResults,
        };
      }
      if (batchEvidenceConfidence < MIN_MODEL_BATCH_CONFIDENCE) {
        return {
          status: "rescan",
          reason: "low_ocr_confidence",
          confidenceState: "needs_verification",
          labelClass,
          candidateLot: labeledBatchResult?.accepted ? labeledBatchResult.lot : "",
          rawBatchText: fields.batch,
          model: detectedModel,
          expectedModel,
          confidence: batchEvidenceConfidence,
          barcodeCandidates: barcodeResults,
        };
      }
      if (labeledBatchResult?.accepted) {
        const isLegacy = labeledBatchResult.rule === "sku_boundary_after_supplier_marker";
        return {
          status: "confirm",
          lot: labeledBatchResult.lot,
          confidenceState: "recognized",
          labelClass,
          rawBarcode: "",
          rawBatchText: fields.batch,
          model: detectedModel || expectedModel,
          expectedModel,
          captureMethod: isLegacy ? "legacy_ocr" : "printed_batch_ocr",
          validationMethod: labeledBatchResult.rule,
          modelMatchMethod: compatibility.method,
          confidence: batchEvidenceConfidence,
          barcodeCandidates: barcodeResults,
        };
      }
    }

    if (confidence >= MIN_OCR_ONLY_CONFIDENCE) {
      const acceptedPrinted = printedResults.filter((candidate) => candidate.accepted);
      const distinctLots = [...new Set(acceptedPrinted.map((candidate) => canonical(candidate.lot)))];
      if (distinctLots.length === 1 && acceptedPrinted[0]) {
        const printed = acceptedPrinted[0];
        return {
          status: "confirm",
          lot: printed.lot,
          confidenceState: "recognized",
          labelClass,
          rawBarcode: "",
          rawBatchText: printed.source,
          model: detectedModel || expectedModel,
          expectedModel,
          captureMethod: fields.hasStructuredBatch ? "printed_batch_ocr" : "printed_text_ocr",
          validationMethod: printed.rule === "known_model_prefix"
            ? "ocr_sku_prefix"
            : "ocr_direct_lot",
          confidence,
          barcodeCandidates: barcodeResults,
        };
      }
      if (distinctLots.length > 1) {
        return {
          status: "rescan",
          reason: "ambiguous_printed_lot",
          confidenceState: "needs_verification",
          labelClass,
          model: detectedModel || expectedModel,
          expectedModel,
          confidence,
          barcodeCandidates: barcodeResults,
        };
      }
    }

    if (fields.batch) {
      return {
        status: "rescan",
        reason: confidence < MIN_OCR_CONFIDENCE ? "low_ocr_confidence" : "label_fields_not_verified",
        confidenceState: "needs_verification",
        labelClass,
        candidateLot: labeledBatchResult?.accepted ? labeledBatchResult.lot : "",
        rawBatchText: fields.batch,
        model: detectedModel,
        expectedModel,
        confidence,
        barcodeCandidates: barcodeResults,
      };
    }

    return {
      status: "rescan",
      reason: barcodeResults.some((candidate) => candidate.reason === "irrelevant_product_code")
        ? "lot_barcode_not_identified"
        : "label_fields_not_verified",
      confidenceState: "needs_verification",
      labelClass,
      model: detectedModel,
      expectedModel,
      confidence,
      barcodeCandidates: barcodeResults,
    };
  }

  global.AtlasCocParser = Object.freeze({
    MIN_OCR_CONFIDENCE,
    MIN_OCR_ONLY_CONFIDENCE,
    MIN_MODEL_BATCH_CONFIDENCE,
    LEGACY_RULES,
    canonical,
    cleanLot,
    isIrrelevantBarcode,
    modernPrefixes,
    parseModernBarcode,
    extractLabelFields,
    extractHumanReadableCandidates,
    modelsAgree,
    modelCompatibility,
    parseStructuredBatch,
    extractLegacyLot,
    levenshtein,
    findSimilarLot,
    classifyBarcodes,
    evaluateCapture,
  });
})(window);
