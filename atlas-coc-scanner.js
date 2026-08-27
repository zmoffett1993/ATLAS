(function (global) {
  "use strict";

  // The visible guide is the authority for every recognition attempt. Its live
  // DOM geometry is mapped through object-fit: cover into source-camera pixels.
  const ROI = Object.freeze({ width: 0.92, aspectRatio: 2.3 });
  const MAX_CAPTURE_WIDTH = 2560;
  const ONE_D_FORMATS = Object.freeze([
    "CODE_128", "CODE_39", "CODE_93", "ITF", "CODABAR",
    "EAN_13", "EAN_8", "UPC_A", "UPC_E",
  ]);
  let zxingReader = null;

  const cleanValue = (value) => String(value ?? "").trim().slice(0, 180);
  const now = () => global.performance?.now?.() ?? Date.now();

  function createCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  }

  function copyCanvas(source) {
    const copy = createCanvas(source.width, source.height);
    copy.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0);
    if (source.atlasRoiMap) copy.atlasRoiMap = source.atlasRoiMap;
    return copy;
  }

  function resizeCanvas(source, multiplier = 1, maximumWidth = 3200) {
    const scale = Math.max(1, Math.min(Number(multiplier) || 1, maximumWidth / source.width));
    const canvas = createCanvas(source.width * scale, source.height * scale);
    canvas.getContext("2d", { willReadFrequently: true }).drawImage(
      source, 0, 0, source.width, source.height, 0, 0, canvas.width, canvas.height,
    );
    return canvas;
  }

  function cropCanvas(source, region) {
    const sourceX = Math.max(0, Math.round(source.width * region.x));
    const sourceY = Math.max(0, Math.round(source.height * region.y));
    const sourceWidth = Math.max(1, Math.min(
      source.width - sourceX,
      Math.round(source.width * region.width),
    ));
    const sourceHeight = Math.max(1, Math.min(
      source.height - sourceY,
      Math.round(source.height * region.height),
    ));
    const canvas = createCanvas(sourceWidth, sourceHeight);
    canvas.getContext("2d", { willReadFrequently: true }).drawImage(
      source, sourceX, sourceY, sourceWidth, sourceHeight,
      0, 0, sourceWidth, sourceHeight,
    );
    return canvas;
  }

  function rotateCanvas(source, degrees) {
    const radians = Number(degrees || 0) * Math.PI / 180;
    const sine = Math.abs(Math.sin(radians));
    const cosine = Math.abs(Math.cos(radians));
    const width = Math.ceil(source.width * cosine + source.height * sine);
    const height = Math.ceil(source.width * sine + source.height * cosine);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.translate(width / 2, height / 2);
    context.rotate(radians);
    context.drawImage(source, -source.width / 2, -source.height / 2);
    return canvas;
  }

  const clamp = (value, minimum, maximum) =>
    Math.max(minimum, Math.min(maximum, Number(value) || 0));

  function positionFactor(token, axis) {
    const value = String(token || "center").trim().toLowerCase();
    if (value === "center") return 0.5;
    if (axis === "x" && value === "left") return 0;
    if (axis === "x" && value === "right") return 1;
    if (axis === "y" && value === "top") return 0;
    if (axis === "y" && value === "bottom") return 1;
    const percent = value.match(/^(-?\d+(?:\.\d+)?)%$/);
    return percent ? Number(percent[1]) / 100 : 0.5;
  }

  function objectPositionFactors(value) {
    const tokens = String(value || "50% 50%").trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 1) {
      if (["top", "bottom"].includes(tokens[0].toLowerCase()))
        return { x: 0.5, y: positionFactor(tokens[0], "y") };
      return { x: positionFactor(tokens[0], "x"), y: 0.5 };
    }
    return {
      x: positionFactor(tokens[0], "x"),
      y: positionFactor(tokens[1], "y"),
    };
  }

  function insetRect(rect, insets = {}) {
    const leftInset = Math.max(0, Number(insets.left) || 0);
    const rightInset = Math.max(0, Number(insets.right) || 0);
    const topInset = Math.max(0, Number(insets.top) || 0);
    const bottomInset = Math.max(0, Number(insets.bottom) || 0);
    const width = Math.max(0, (Number(rect?.width) || 0) - leftInset - rightInset);
    const height = Math.max(0, (Number(rect?.height) || 0) - topInset - bottomInset);
    return {
      left: (Number(rect?.left) || 0) + leftInset,
      top: (Number(rect?.top) || 0) + topInset,
      width,
      height,
    };
  }

  function guideContentRect(guide) {
    const rect = guide?.getBoundingClientRect?.();
    if (!rect) return null;
    const style = global.getComputedStyle?.(guide);
    const pixels = (value) => Math.max(0, Number.parseFloat(value) || 0);
    return insetRect(rect, {
      left: pixels(style?.borderLeftWidth),
      right: pixels(style?.borderRightWidth),
      top: pixels(style?.borderTopWidth),
      bottom: pixels(style?.borderBottomWidth),
    });
  }

  function mapVisibleRoiToSource({
    sourceWidth, sourceHeight, videoRect, roiRect,
    objectFit = "cover", objectPosition = "50% 50%",
  } = {}) {
    const sourceW = Number(sourceWidth);
    const sourceH = Number(sourceHeight);
    const previewW = Number(videoRect?.width);
    const previewH = Number(videoRect?.height);
    if (![sourceW, sourceH, previewW, previewH].every((value) => value > 0)) return null;

    const left = Math.max(Number(videoRect.left) || 0, Number(roiRect?.left) || 0);
    const top = Math.max(Number(videoRect.top) || 0, Number(roiRect?.top) || 0);
    const right = Math.min(
      (Number(videoRect.left) || 0) + previewW,
      (Number(roiRect?.left) || 0) + (Number(roiRect?.width) || 0),
    );
    const bottom = Math.min(
      (Number(videoRect.top) || 0) + previewH,
      (Number(roiRect?.top) || 0) + (Number(roiRect?.height) || 0),
    );
    if (right <= left || bottom <= top) return null;

    const roiX = left - (Number(videoRect.left) || 0);
    const roiY = top - (Number(videoRect.top) || 0);
    const roiW = right - left;
    const roiH = bottom - top;
    const fit = String(objectFit || "cover").toLowerCase();
    const scale = fit === "contain"
      ? Math.min(previewW / sourceW, previewH / sourceH)
      : Math.max(previewW / sourceW, previewH / sourceH);
    const renderedWidth = sourceW * scale;
    const renderedHeight = sourceH * scale;
    const position = objectPositionFactors(objectPosition);
    const hiddenX = (renderedWidth - previewW) * position.x;
    const hiddenY = (renderedHeight - previewH) * position.y;
    const sourceX = clamp((roiX + hiddenX) / scale, 0, sourceW);
    const sourceY = clamp((roiY + hiddenY) / scale, 0, sourceH);
    const sourceRight = clamp((roiX + roiW + hiddenX) / scale, sourceX, sourceW);
    const sourceBottom = clamp((roiY + roiH + hiddenY) / scale, sourceY, sourceH);
    if (sourceRight - sourceX < 1 || sourceBottom - sourceY < 1) return null;

    return Object.freeze({
      sourceWidth: sourceW,
      sourceHeight: sourceH,
      previewWidth: previewW,
      previewHeight: previewH,
      roiX,
      roiY,
      roiWidth: roiW,
      roiHeight: roiH,
      scale,
      renderedWidth,
      renderedHeight,
      hiddenX,
      hiddenY,
      sourceX,
      sourceY,
      sourceCropWidth: sourceRight - sourceX,
      sourceCropHeight: sourceBottom - sourceY,
      objectFit: fit,
      objectPosition: String(objectPosition || "50% 50%"),
    });
  }

  function debugEnabled() {
    try {
      return global.localStorage?.getItem("atlasCocRoiDebug") === "1" ||
        new URLSearchParams(global.location?.search || "").get("atlasCocRoiDebug") === "1";
    } catch {
      return false;
    }
  }

  function logRoiMap(map) {
    if (!debugEnabled() || !map) return;
    console.debug("[ATLAS COC ROI]", {
      source: `${map.sourceWidth} × ${map.sourceHeight}`,
      preview: `${map.previewWidth.toFixed(1)} × ${map.previewHeight.toFixed(1)}`,
      roiDisplay: {
        x: map.roiX.toFixed(1), y: map.roiY.toFixed(1),
        width: map.roiWidth.toFixed(1), height: map.roiHeight.toFixed(1),
      },
      scale: map.scale.toFixed(5),
      hidden: { x: map.hiddenX.toFixed(1), y: map.hiddenY.toFixed(1) },
      sourceRoi: {
        x: map.sourceX.toFixed(1), y: map.sourceY.toFixed(1),
        width: map.sourceCropWidth.toFixed(1), height: map.sourceCropHeight.toFixed(1),
      },
      objectFit: map.objectFit,
      objectPosition: map.objectPosition,
    });
  }

  function logRecognitionTrace(trace) {
    if (debugEnabled()) console.debug("[ATLAS COC RECOGNITION]", trace);
  }

  function captureRoi(video, guide, targetCanvas) {
    if (!video?.videoWidth || !video?.videoHeight || !guide || !targetCanvas) return null;
    const videoRect = video.getBoundingClientRect?.();
    // The employee frames the label inside the blue border. Map that exact
    // content box, not the outer border box whose pixels are visually covered.
    const roiRect = guideContentRect(guide);
    if (!videoRect || !roiRect) return null;
    const style = global.getComputedStyle?.(video);
    const map = mapVisibleRoiToSource({
      sourceWidth: video.videoWidth,
      sourceHeight: video.videoHeight,
      videoRect,
      roiRect,
      objectFit: style?.objectFit || "cover",
      objectPosition: style?.objectPosition || "50% 50%",
    });
    if (!map) return null;
    const sourceX = map.sourceX;
    const sourceY = map.sourceY;
    const sourceWidth = map.sourceCropWidth;
    const sourceHeight = map.sourceCropHeight;
    const outputWidth = Math.min(MAX_CAPTURE_WIDTH, sourceWidth);
    const outputHeight = Math.max(1, Math.round((sourceHeight / sourceWidth) * outputWidth));
    targetCanvas.width = Math.max(1, Math.round(outputWidth));
    targetCanvas.height = outputHeight;
    const context = targetCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(
      video, sourceX, sourceY, sourceWidth, sourceHeight,
      0, 0, targetCanvas.width, targetCanvas.height,
    );
    targetCanvas.atlasRoiMap = map;
    logRoiMap(map);
    return targetCanvas;
  }

  function qualityScore(canvas) {
    const context = canvas?.getContext?.("2d", { willReadFrequently: true });
    if (!context || !canvas.width || !canvas.height) return 0;
    const sampleWidth = Math.min(320, canvas.width);
    const sampleHeight = Math.max(1, Math.round((canvas.height / canvas.width) * sampleWidth));
    const sample = createCanvas(sampleWidth, sampleHeight);
    const sampleContext = sample.getContext("2d", { willReadFrequently: true });
    sampleContext.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
    const pixels = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight).data;
    let light = 0;
    let lightSquared = 0;
    let edges = 0;
    let clipped = 0;
    let prior = 0;
    const count = pixels.length / 4;
    for (let index = 0; index < pixels.length; index += 4) {
      const value = pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
      light += value;
      lightSquared += value * value;
      if (value < 8 || value > 247) clipped += 1;
      if (index > 0) edges += Math.abs(value - prior);
      prior = value;
    }
    const mean = light / count;
    const variance = Math.max(0, (lightSquared / count) - (mean * mean));
    const edgeMean = edges / Math.max(1, count - 1);
    const exposure = 1 - Math.min(1, Math.abs(mean - 132) / 132);
    const clippingPenalty = 1 - Math.min(0.8, clipped / count);
    return (Math.sqrt(variance) * 0.45 + edgeMean * 1.4 + exposure * 22) * clippingPenalty;
  }

  function imageVariant(source, mode) {
    const canvas = copyCanvas(source);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    if (mode === "sharpen") {
      const original = new Uint8ClampedArray(image.data);
      const width = canvas.width;
      const height = canvas.height;
      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const offset = (y * width + x) * 4;
          for (let channel = 0; channel < 3; channel += 1) {
            const value = original[offset + channel] * 5
              - original[offset - 4 + channel]
              - original[offset + 4 + channel]
              - original[offset - width * 4 + channel]
              - original[offset + width * 4 + channel];
            image.data[offset + channel] = Math.max(0, Math.min(255, value));
          }
        }
      }
      context.putImageData(image, 0, 0);
      return canvas;
    }
    for (let index = 0; index < image.data.length; index += 4) {
      const gray = image.data[index] * 0.299 + image.data[index + 1] * 0.587 + image.data[index + 2] * 0.114;
      let value = gray;
      if (mode === "contrast") value = Math.max(0, Math.min(255, (gray - 128) * 1.75 + 128));
      if (mode === "strong-contrast") value = Math.max(0, Math.min(255, (gray - 128) * 2.15 + 128));
      if (mode === "threshold") value = gray > 154 ? 255 : 0;
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  function humanReadableTextRegion(source, mode = "original") {
    // The exact blue-guide ROI is the only source. This internal crop excludes
    // most barcode bars so single-line OCR can focus on the printed value.
    const line = resizeCanvas(cropCanvas(source, {
      x: 0, y: 0.5, width: 1, height: 0.47,
    }), 3, 3200);
    return mode === "original" ? line : imageVariant(line, mode);
  }

  function textBand(source) {
    return humanReadableTextRegion(source, "strong-contrast");
  }

  function labelFieldsRegion(source) {
    return imageVariant(cropCanvas(source, {
      x: 0, y: 0, width: 1, height: 0.7,
    }), "contrast");
  }

  function buildOcrPasses(source) {
    return [
      { id: "original", status: "Reading the complete label…", create: () => copyCanvas(source), mode: "sparse" },
      { id: "fields", status: "Finding Model and Batch fields…", create: () => labelFieldsRegion(source), mode: "block" },
      { id: "human-line", status: "Reading the text below the barcode…", create: () => humanReadableTextRegion(source), mode: "line" },
      { id: "human-line-contrast", status: "Checking wrapped barcode text…", create: () => humanReadableTextRegion(source, "strong-contrast"), mode: "line" },
      { id: "human-line-threshold", status: "Verifying barcode-text characters…", create: () => humanReadableTextRegion(source, "threshold"), mode: "line" },
      { id: "sharpened", status: "Checking faded and wrapped characters…", create: () => imageVariant(source, "sharpen"), mode: "sparse" },
    ];
  }

  function resultValue(result) {
    return cleanValue(result?.rawValue ?? result?.getText?.() ?? "");
  }

  function zxingFormat(result) {
    const numeric = result?.getBarcodeFormat?.();
    const formats = global.ZXingBrowser?.BarcodeFormat;
    return cleanValue(formats?.[numeric] || numeric || "unknown");
  }

  function getZxingReader() {
    const zxing = global.ZXingBrowser;
    if (!zxing?.BrowserMultiFormatOneDReader) return null;
    if (!zxingReader) {
      zxingReader = new zxing.BrowserMultiFormatOneDReader();
      const formats = ONE_D_FORMATS.map((name) => zxing.BarcodeFormat?.[name])
        .filter((value) => Number.isInteger(value));
      if (formats.length) zxingReader.possibleFormats = formats;
    }
    return zxingReader;
  }

  async function detectNative(canvas, diagnostics = null) {
    if (!global.BarcodeDetector) {
      diagnostics?.errors?.push({ engine: "native", code: "UNAVAILABLE" });
      return [];
    }
    try {
      const supported = await global.BarcodeDetector.getSupportedFormats?.();
      const wanted = [
        "code_128", "code_39", "code_93", "itf", "codabar",
        "ean_13", "ean_8", "upc_a", "upc_e",
      ]
        .filter((format) => !supported?.length || supported.includes(format));
      if (diagnostics) diagnostics.formats.native = wanted;
      const detector = new global.BarcodeDetector(wanted.length ? { formats: wanted } : undefined);
      const results = await detector.detect(canvas);
      return results.map((result) => ({
        value: resultValue(result),
        format: cleanValue(result.format || "unknown"),
        engine: "native",
      })).filter((item) => item.value);
    } catch (error) {
      diagnostics?.errors?.push({
        engine: "native",
        code: cleanValue(error?.name || "DECODE_EXCEPTION"),
        message: cleanValue(error?.message || "Native barcode decode failed."),
      });
      return [];
    }
  }

  async function detectZxing(canvas, diagnostics = null) {
    try {
      const reader = getZxingReader();
      if (!reader) {
        diagnostics?.errors?.push({ engine: "zxing", code: "UNAVAILABLE" });
        return [];
      }
      if (diagnostics) diagnostics.formats.zxing = [...ONE_D_FORMATS];
      const result = reader.decodeFromCanvas(canvas);
      const value = resultValue(result);
      return value ? [{ value, format: zxingFormat(result), engine: "zxing" }] : [];
    } catch (error) {
      diagnostics?.errors?.push({
        engine: "zxing",
        code: cleanValue(error?.name || "NO_RESULT"),
        message: cleanValue(error?.message || "ZXing did not return a barcode."),
      });
      return [];
    }
  }

  function uniqueDetections(detections) {
    const values = new Map();
    detections.forEach((item) => {
      const key = cleanValue(item.value).toUpperCase();
      if (key && !values.has(key)) values.set(key, item);
    });
    return [...values.values()];
  }

  async function decodeFrame(canvas, {
    enhanced = false, isCancelled = () => false, onTrace = null,
  } = {}) {
    // Do not stop at the first decoded symbol. Cartons often show UPC, case,
    // product, and lot barcodes together; the parser must receive every viable
    // candidate so it can reject product codes and cross-check the lot.
    const builders = [{ id: "original", create: () => canvas }];
    if (enhanced) builders.push(
      { id: "grayscale", create: () => imageVariant(canvas, "grayscale") },
      { id: "contrast", create: () => imageVariant(canvas, "contrast") },
      { id: "sharpen", create: () => imageVariant(canvas, "sharpen") },
      { id: "threshold", create: () => imageVariant(canvas, "threshold") },
      { id: "rotate-positive", create: () => rotateCanvas(imageVariant(canvas, "contrast"), 2.5) },
      { id: "rotate-negative", create: () => rotateCanvas(imageVariant(canvas, "contrast"), -2.5) },
    );
    const startedAt = now();
    const diagnostics = {
      input: {
        width: Number(canvas?.width || 0),
        height: Number(canvas?.height || 0),
        sourceType: canvas?.constructor?.name || "Canvas",
      },
      formats: { native: [], zxing: [...ONE_D_FORMATS] },
      variants: [],
      errors: [],
      cancelled: false,
    };
    const found = [];
    try {
      for (const builder of builders) {
        if (isCancelled()) {
          diagnostics.cancelled = true;
          break;
        }
        // Give the UI a chance to paint the frozen photo and progress state
        // between expensive still-image variants on mobile Safari.
        await new Promise((resolve) => global.setTimeout(resolve, 0));
        if (isCancelled()) {
          diagnostics.cancelled = true;
          break;
        }
        const variantStartedAt = now();
        const source = builder.create();
        const errorStart = diagnostics.errors.length;
        const [native, zxing] = await Promise.all([
          detectNative(source, diagnostics), detectZxing(source, diagnostics),
        ]);
        const candidates = [...native, ...zxing];
        found.push(...candidates);
        diagnostics.variants.push({
          id: builder.id,
          width: source.width,
          height: source.height,
          candidates: candidates.map((item) => ({ ...item })),
          errors: diagnostics.errors.slice(errorStart),
          durationMs: Math.round(now() - variantStartedAt),
        });
      }
      return uniqueDetections(found);
    } finally {
      const selected = uniqueDetections(found);
      diagnostics.rawCandidates = selected.map((item) => ({ ...item }));
      diagnostics.durationMs = Math.round(now() - startedAt);
      try { onTrace?.(diagnostics); } catch {}
    }
  }

  async function configureTrack(track) {
    const capabilities = track?.getCapabilities?.() || {};
    const advanced = [];
    if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")) {
      advanced.push({ focusMode: "continuous" });
    }
    if (Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes("continuous")) {
      advanced.push({ exposureMode: "continuous" });
    }
    if (advanced.length) {
      try { await track.applyConstraints({ advanced }); } catch {}
    }
    return true;
  }

  global.AtlasCocScannerV2 = Object.freeze({
    ROI,
    insetRect,
    guideContentRect,
    mapVisibleRoiToSource,
    captureRoi,
    copyCanvas,
    resizeCanvas,
    cropCanvas,
    rotateCanvas,
    qualityScore,
    imageVariant,
    labelFieldsRegion,
    humanReadableTextRegion,
    textBand,
    buildOcrPasses,
    decodeFrame,
    configureTrack,
    debugEnabled,
    logRecognitionTrace,
  });
})(window);
