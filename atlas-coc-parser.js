(function (global) {
  "use strict";

  const MIN_OCR_CONFIDENCE = 82;
  const MIN_OCR_ONLY_CONFIDENCE = 88;
  const MIN_MODEL_BATCH_CONFIDENCE = 78;
  const MIN_PREFIX_OCR_CONFIDENCE = 62;
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

  function skuBoundarySignatures(modelValue) {
    const model = clean(modelValue).toUpperCase();
    const parts = model.split("-").map(canonical).filter(Boolean);
    if (parts.length < 2) return [];
    // Warehouse lot values omit the product-family segment (for example
    // CGUB1 or CGAC1) and prepend the remaining SKU structure to the real lot.
    // This full derived signature is authoritative; short color-only suffixes
    // are deliberately excluded because they can occur inside legitimate lots.
    const signature = parts.slice(1).join("");
    return signature.length >= 4 ? [signature] : [];
  }

  function modernPrefixes(modelValue) {
    return skuBoundarySignatures(modelValue);
  }

  function canonicalRangeEnd(rawValue, start, length) {
    const raw = clean(rawValue);
    const indexes = [];
    for (let index = 0; index < raw.length; index += 1) {
      if (/[A-Z0-9]/i.test(raw[index])) indexes.push(index + 1);
    }
    return indexes[start + length - 1] ?? -1;
  }

  function prefixMatch(normalizedCandidate, signature, allowFuzzyPrefix) {
    const exactAt = normalizedCandidate.indexOf(signature);
    if (exactAt >= 0 && exactAt <= 4) {
      return { accepted: true, start: exactAt, exact: true, fuzzy: false, distance: 0 };
    }
    if (!allowFuzzyPrefix || normalizedCandidate.length < signature.length) return null;
    const maximumStart = Math.min(4, normalizedCandidate.length - signature.length);
    for (let start = 0; start <= maximumStart; start += 1) {
      const candidatePrefix = normalizedCandidate.slice(start, start + signature.length);
      const equivalent = ocrEquivalent(candidatePrefix) === ocrEquivalent(signature);
      const distance = equivalent ? 0 : levenshtein(candidatePrefix, signature);
      // A long, SKU-derived boundary may contain two OCR substitutions under
      // wrap/glare. This never edits the unknown lot, and fuzzy boundaries are
      // accepted by confidence logic only when independent OCR passes resolve
      // to the same untouched lot.
      const maximumDistance = signature.length >= 8 ? 2 : 1;
      if (equivalent || distance <= maximumDistance) {
        return { accepted: true, start, exact: false, fuzzy: true, distance };
      }
    }
    return null;
  }

  function parseLotCandidate(rawValue, expectedSku = "", {
    source = "unknown", allowFuzzyPrefix = false,
  } = {}) {
    const rawCandidate = clean(rawValue).toUpperCase();
    const normalizedCandidate = canonical(rawCandidate);
    const normalizedSku = canonical(expectedSku);
    const base = {
      rawCandidate,
      normalizedCandidate,
      expectedSku: clean(expectedSku).toUpperCase(),
      matchedSkuBoundary: "",
      cleanLot: "",
      parseMethod: "",
      source,
      confidenceSignals: {
        prefixExact: false,
        prefixFuzzy: false,
        directLot: false,
      },
    };
    if (!rawCandidate || isIrrelevantBarcode(rawCandidate)) {
      return { ...base, accepted: false, reason: "irrelevant_product_code" };
    }

    for (const signature of skuBoundarySignatures(expectedSku)) {
      const match = prefixMatch(normalizedCandidate, signature, allowFuzzyPrefix);
      if (!match) continue;
      const boundary = canonicalRangeEnd(rawCandidate, match.start, signature.length);
      const lot = cleanLot(rawCandidate.slice(boundary).replace(/^[^A-Z0-9]+/i, ""));
      if (!validLotShape(lot)) {
        return {
          ...base,
          accepted: false,
          reason: "sku_prefix_parse_failed",
          matchedSkuBoundary: signature,
        };
      }
      return {
        ...base,
        accepted: true,
        matchedSkuBoundary: signature,
        cleanLot: lot,
        parseMethod: match.fuzzy ? "known_sku_boundary_ocr" : "known_sku_boundary",
        prefixStart: match.start,
        confidenceSignals: {
          prefixExact: match.exact,
          prefixFuzzy: match.fuzzy,
          directLot: false,
          prefixDistance: match.distance,
        },
      };
    }

    const boundaryOnly = skuBoundarySignatures(expectedSku).includes(normalizedCandidate);
    if (normalizedCandidate === normalizedSku || boundaryOnly) {
      return { ...base, accepted: false, reason: "sku_only_candidate" };
    }
    if (DIRECT_LOT_PATTERN.test(rawCandidate)) {
      return {
        ...base,
        accepted: true,
        cleanLot: cleanLot(rawCandidate),
        parseMethod: "direct_lot",
        confidenceSignals: { prefixExact: false, prefixFuzzy: false, directLot: true },
      };
    }
    return { ...base, accepted: false, reason: "unclassified_candidate" };
  }

  function parseModernBarcode(barcodeValue, modelValue = "", { allowSkuPrefix = true } = {}) {
    const rawBarcode = clean(barcodeValue).toUpperCase();
    const parsed = parseLotCandidate(rawBarcode, modelValue, {
      source: "barcode",
      allowFuzzyPrefix: false,
    });
    if (parsed.accepted && (allowSkuPrefix || !parsed.matchedSkuBoundary)) {
      return {
        accepted: true,
        lot: parsed.cleanLot,
        rawBarcode,
        model: clean(modelValue).toUpperCase(),
        matchedPrefix: parsed.matchedSkuBoundary,
        rule: parsed.matchedSkuBoundary ? "known_model_prefix" : "direct_lot",
        score: parsed.matchedSkuBoundary ? 100 : 90,
        parseDetails: parsed,
      };
    }
    return {
      accepted: false,
      reason: parsed.reason === "irrelevant_product_code"
        ? "irrelevant_product_code"
        : "unclassified_barcode",
      rawBarcode,
      parseDetails: parsed,
    };
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
    if (!rawBatch) return { accepted: false, reason: "structured_batch_missing" };
    const parsed = parseLotCandidate(rawBatch, modelValue, {
      source: "structured_batch_ocr",
      allowFuzzyPrefix: true,
    });
    if (parsed.accepted) {
      return {
        accepted: true,
        lot: parsed.cleanLot,
        rawBatch,
        matchedPrefix: parsed.matchedSkuBoundary,
        rule: parsed.matchedSkuBoundary
          ? (parsed.prefixStart ? "sku_boundary_after_supplier_marker" : "known_model_prefix")
          : "clean_structured_batch",
        parseDetails: parsed,
      };
    }
    return {
      accepted: false,
      reason: parsed.reason === "sku_prefix_parse_failed"
        ? "sku_prefix_parse_failed"
        : "structured_batch_invalid",
      rawBatch,
      parseDetails: parsed,
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

  function classifyBarcodes(values = [], model = "", options = {}) {
    return [...new Set(values.map(clean).filter(Boolean))]
      .map((value) => parseModernBarcode(value, model, options))
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  }

  function parsePrintedCandidate(value, expectedModel, {
    evidenceSource = "printed_text_ocr", allowFuzzyPrefix = true,
  } = {}) {
    const rawSource = clean(value);
    if (!rawSource) return { accepted: false, reason: "empty_printed_value", source: rawSource };
    const parsed = parseLotCandidate(rawSource, expectedModel, {
      source: evidenceSource,
      allowFuzzyPrefix,
    });
    if (!parsed.accepted) return { ...parsed, source: rawSource };
    return {
      accepted: true,
      lot: parsed.cleanLot,
      rawBarcode: rawSource,
      source: rawSource,
      matchedPrefix: parsed.matchedSkuBoundary,
      rule: parsed.matchedSkuBoundary
        ? (parsed.prefixStart ? "sku_boundary_after_supplier_marker" : "known_model_prefix")
        : "direct_lot",
      score: parsed.confidenceSignals.prefixExact ? 100
        : parsed.confidenceSignals.prefixFuzzy ? 94 : 90,
      parseDetails: parsed,
    };
  }

  function rankOcrCandidates(readings = [], expectedModel = "") {
    const groups = new Map();
    const rejected = [];
    readings.forEach((reading, readingIndex) => {
      const text = String(reading?.text ?? "");
      const fields = extractLabelFields(text);
      const readingConfidence = Math.max(0, Math.min(100, Number(reading?.confidence) || 0));
      const batchConfidence = Math.max(
        readingConfidence,
        Number(reading?.fieldConfidence?.batch) || 0,
      );
      const values = [
        fields.batch ? { value: fields.batch, structuredBatch: fields.hasStructuredBatch } : null,
        ...extractHumanReadableCandidates(text).map((value) => ({ value, structuredBatch: false })),
      ].filter(Boolean);
      const perReading = new Map();
      values.forEach(({ value, structuredBatch }) => {
        const parsed = parsePrintedCandidate(value, expectedModel, {
          evidenceSource: structuredBatch ? "structured_batch_ocr" : "printed_text_ocr",
          allowFuzzyPrefix: true,
        });
        if (!parsed.accepted) {
          rejected.push({
            readingId: clean(reading?.id || `pass-${readingIndex + 1}`),
            rawCandidate: clean(value),
            reason: parsed.reason,
          });
          return;
        }
        const key = canonical(parsed.lot);
        const evidence = {
          ...parsed,
          readingId: clean(reading?.id || `pass-${readingIndex + 1}`),
          confidence: structuredBatch ? batchConfidence : readingConfidence,
          structuredBatch,
        };
        const prior = perReading.get(key);
        if (!prior || evidence.score > prior.score || evidence.confidence > prior.confidence) {
          perReading.set(key, evidence);
        }
      });
      perReading.forEach((evidence, key) => {
        const group = groups.get(key) || {
          lot: evidence.lot,
          votes: 0,
          bestConfidence: 0,
          prefixExactVotes: 0,
          prefixFuzzyVotes: 0,
          structuredBatchVotes: 0,
          evidence: [],
        };
        group.votes += 1;
        group.bestConfidence = Math.max(group.bestConfidence, evidence.confidence);
        group.prefixExactVotes += Number(Boolean(evidence.parseDetails?.confidenceSignals?.prefixExact));
        group.prefixFuzzyVotes += Number(Boolean(evidence.parseDetails?.confidenceSignals?.prefixFuzzy));
        group.structuredBatchVotes += Number(Boolean(evidence.structuredBatch));
        group.evidence.push(evidence);
        groups.set(key, group);
      });
    });

    const ranked = [...groups.values()].map((group) => {
      const strong = (
        group.structuredBatchVotes > 0 && group.bestConfidence >= MIN_MODEL_BATCH_CONFIDENCE
      ) || (
        group.prefixExactVotes > 0 && group.bestConfidence >= MIN_MODEL_BATCH_CONFIDENCE
      ) || (
        group.prefixExactVotes >= 2 && group.bestConfidence >= MIN_PREFIX_OCR_CONFIDENCE
      ) || (
        group.prefixFuzzyVotes >= 2 && group.bestConfidence >= MIN_PREFIX_OCR_CONFIDENCE
      ) || (
        group.votes >= 2 && group.bestConfidence >= MIN_MODEL_BATCH_CONFIDENCE
      ) || group.bestConfidence >= MIN_OCR_ONLY_CONFIDENCE;
      const structuralScore = group.prefixExactVotes * 30 + group.prefixFuzzyVotes * 20 +
        group.structuredBatchVotes * 20;
      return {
        ...group,
        strong,
        structuralScore,
        rankScore: group.votes * 100 + structuralScore + group.bestConfidence,
      };
    }).sort((left, right) => right.rankScore - left.rankScore);
    const strongGroups = ranked.filter((group) => group.strong);
    return {
      ranked,
      selected: strongGroups[0] || null,
      ambiguous: strongGroups.length > 1 &&
        canonical(strongGroups[0].lot) !== canonical(strongGroups[1].lot),
      rejected,
    };
  }

  function evaluateCapture({
    barcodes = [], ocrText = "", ocrConfidence = 0, fieldConfidence = 0,
    sku = "", barcodeDetections = [], ocrReadings = [],
  } = {}) {
    const fields = extractLabelFields(ocrText);
    const expectedModel = clean(sku || fields.model).toUpperCase();
    const detectedModel = clean(fields.model).toUpperCase();
    const compatibility = modelCompatibility(detectedModel, expectedModel);
    const confidence = Number.isFinite(Number(ocrConfidence))
      ? Math.max(0, Math.min(100, Number(ocrConfidence)))
      : 0;
    const trustedFieldConfidence = Number.isFinite(Number(fieldConfidence))
      ? Math.max(0, Math.min(100, Number(fieldConfidence)))
      : 0;
    const evidenceReadings = ocrReadings.length ? ocrReadings : [{
      id: "combined",
      text: ocrText,
      confidence,
      fieldConfidence: { batch: trustedFieldConfidence },
    }];

    // The expected COC SKU is authoritative context for every candidate. The
    // parser no longer waits for MODEL NO. to appear inside a barcode-focused
    // ROI before it is allowed to strip the SKU-derived product boundary.
    const barcodeResults = classifyBarcodes(barcodes, expectedModel, { allowSkuPrefix: true });
    const acceptedBarcodes = barcodeResults.filter((candidate) => candidate.accepted);
    const distinctBarcodeLots = [...new Set(
      acceptedBarcodes.map((candidate) => canonical(candidate.lot)).filter(Boolean),
    )];
    const barcode = acceptedBarcodes[0] || null;
    const ocrEvidence = rankOcrCandidates(evidenceReadings, expectedModel);
    const printed = ocrEvidence.selected;
    const printedLead = printed?.evidence?.slice().sort((left, right) =>
      (right.score + right.confidence) - (left.score + left.confidence),
    )[0] || null;
    const boundaryDetected = Boolean(
      barcode?.matchedPrefix || ocrEvidence.ranked.some((group) =>
        group.evidence.some((item) => item.matchedPrefix)),
    );
    const labelClass = fields.hasStructuredModel || fields.hasStructuredBatch || boundaryDetected
      ? "model_batch"
      : "direct_lot";
    const barcodeFormat = clean(
      barcodeDetections.find((item) => canonical(item?.value) === canonical(barcode?.rawBarcode))?.format,
    );
    const ocrCandidates = ocrEvidence.ranked.map((group) => ({
      lot: group.lot,
      votes: group.votes,
      bestConfidence: group.bestConfidence,
      prefixExactVotes: group.prefixExactVotes,
      prefixFuzzyVotes: group.prefixFuzzyVotes,
      structuredBatchVotes: group.structuredBatchVotes,
      strong: group.strong,
      rawCandidates: group.evidence.map((item) => item.source),
    }));
    const hasOcrResult = evidenceReadings.some((reading) => canonical(reading?.text));
    const skuPrefixParseFailed = barcodeResults.some(
      (candidate) => candidate.parseDetails?.reason === "sku_prefix_parse_failed",
    ) || ocrEvidence.rejected.some((candidate) => candidate.reason === "sku_prefix_parse_failed");
    const failureSignals = [
      barcodes.length ? "" : "NO_BARCODE_RESULT",
      hasOcrResult ? "" : "NO_OCR_RESULT",
      skuPrefixParseFailed ? "SKU_PREFIX_PARSE_FAILED" : "",
    ].filter(Boolean);
    const common = {
      labelClass,
      rawBatchText: fields.batch,
      model: detectedModel,
      expectedModel,
      confidence,
      barcodeCandidates: barcodeResults,
      ocrCandidates,
      ocrRejectedCandidates: ocrEvidence.rejected,
      failureSignals,
    };

    if (distinctBarcodeLots.length > 1) {
      return {
        ...common,
        status: "rescan",
        reason: "ambiguous_barcode_lot",
        failureCode: "AMBIGUOUS_LOT",
        confidenceState: "needs_verification",
      };
    }
    if (detectedModel && !compatibility.accepted) {
      return {
        ...common,
        status: "rescan",
        reason: "model_sku_mismatch",
        failureCode: "SKU_MISMATCH",
        confidenceState: "needs_verification",
        rawBarcode: barcode?.rawBarcode || "",
      };
    }
    if (ocrEvidence.ambiguous) {
      return {
        ...common,
        status: "rescan",
        reason: "ambiguous_printed_lot",
        failureCode: "AMBIGUOUS_LOT",
        confidenceState: "needs_verification",
        candidateLot: printed?.lot || "",
      };
    }

    if (barcode) {
      const printedMatches = printed && canonical(printed.lot) === canonical(barcode.lot);
      if (printed && !printedMatches) {
        return {
          ...common,
          status: "mismatch",
          reason: "barcode_print_mismatch",
          failureCode: "SOURCE_CONFLICT",
          confidenceState: "needs_verification",
          lot: barcode.lot,
          printedLot: printed.lot,
          rawBarcode: barcode.rawBarcode,
          rawBatchText: printedLead?.source || fields.batch,
          model: detectedModel || expectedModel || barcode.model,
          captureMethod: "barcode",
          validationMethod: "barcode_print_mismatch",
          barcodeFormat,
          confidence: Math.max(confidence, printed.bestConfidence),
        };
      }
      return {
        ...common,
        status: "confirm",
        lot: barcode.lot,
        confidenceState: printedMatches ? "verified" : "recognized",
        rawBarcode: barcode.rawBarcode,
        rawBatchText: printedMatches ? printedLead?.source || fields.batch : fields.batch,
        model: detectedModel || expectedModel || barcode.model,
        captureMethod: printedMatches ? "barcode_ocr" : "barcode",
        validationMethod: printedMatches ? "barcode_print_match" : barcode.rule,
        modelMatchMethod: compatibility.method,
        barcodeFormat,
        confidence: Math.max(confidence, printedMatches ? printed.bestConfidence : 0),
      };
    }

    if (printed && printedLead) {
      const isLegacy = printedLead.rule === "sku_boundary_after_supplier_marker";
      const isStructured = Boolean(printedLead.structuredBatch);
      const prefixFuzzy = Boolean(printedLead.parseDetails?.confidenceSignals?.prefixFuzzy);
      return {
        ...common,
        status: "confirm",
        lot: printed.lot,
        confidenceState: "recognized",
        rawBarcode: "",
        rawBatchText: printedLead.source,
        model: detectedModel || expectedModel,
        captureMethod: isLegacy ? "legacy_ocr"
          : isStructured ? "printed_batch_ocr" : "printed_text_ocr",
        validationMethod: printedLead.matchedPrefix
          ? (prefixFuzzy ? "ocr_sku_prefix_consensus" : "ocr_sku_prefix")
          : "ocr_direct_lot",
        modelMatchMethod: compatibility.method,
        confidence: printed.bestConfidence,
      };
    }

    const parsedButWeak = ocrEvidence.ranked[0] || null;
    const productBarcodeOnly = barcodeResults.length > 0 &&
      barcodeResults.every((candidate) => candidate.reason === "irrelevant_product_code");
    return {
      ...common,
      status: "rescan",
      reason: productBarcodeOnly ? "lot_barcode_not_identified"
        : parsedButWeak ? "low_ocr_confidence" : "label_fields_not_verified",
      failureCode: skuPrefixParseFailed ? "SKU_PREFIX_PARSE_FAILED"
        : parsedButWeak ? "CONFIDENCE_TOO_LOW" : "NO_VALID_CANDIDATE",
      confidenceState: "needs_verification",
      candidateLot: parsedButWeak?.lot || "",
    };
  }

  global.AtlasCocParser = Object.freeze({
    MIN_OCR_CONFIDENCE,
    MIN_OCR_ONLY_CONFIDENCE,
    MIN_MODEL_BATCH_CONFIDENCE,
    MIN_PREFIX_OCR_CONFIDENCE,
    LEGACY_RULES,
    canonical,
    cleanLot,
    isIrrelevantBarcode,
    skuBoundarySignatures,
    modernPrefixes,
    parseLotCandidate,
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
    parsePrintedCandidate,
    rankOcrCandidates,
    evaluateCapture,
  });
})(window);
