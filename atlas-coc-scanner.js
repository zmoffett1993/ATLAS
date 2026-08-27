(function (global) {
  "use strict";

  // The guide is deliberately tall enough to include Model/Batch fields, the
  // barcode, and its human-readable value in one employee-framed photograph.
  const ROI = Object.freeze({ x: 0.035, y: 0.08, width: 0.93, height: 0.84 });
  const MAX_CAPTURE_WIDTH = 2560;
  const ONE_D_FORMATS = Object.freeze([
    "CODE_128", "CODE_39", "CODE_93", "ITF", "CODABAR",
    "EAN_13", "EAN_8", "UPC_A", "UPC_E",
  ]);
  let zxingReader = null;

  const cleanValue = (value) => String(value ?? "").trim().slice(0, 180);

  function createCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  }

  function copyCanvas(source) {
    const copy = createCanvas(source.width, source.height);
    copy.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0);
    return copy;
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

  function captureRoi(video, targetCanvas) {
    if (!video?.videoWidth || !video?.videoHeight || !targetCanvas) return null;
    const sourceX = Math.round(video.videoWidth * ROI.x);
    const sourceY = Math.round(video.videoHeight * ROI.y);
    const sourceWidth = Math.round(video.videoWidth * ROI.width);
    const sourceHeight = Math.round(video.videoHeight * ROI.height);
    const outputWidth = Math.min(MAX_CAPTURE_WIDTH, sourceWidth);
    const outputHeight = Math.max(360, Math.round((sourceHeight / sourceWidth) * outputWidth));
    targetCanvas.width = outputWidth;
    targetCanvas.height = outputHeight;
    const context = targetCanvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(
      video, sourceX, sourceY, sourceWidth, sourceHeight,
      0, 0, outputWidth, outputHeight,
    );
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

  function textBand(source) {
    return imageVariant(cropCanvas(source, {
      x: 0, y: 0.42, width: 1, height: 0.58,
    }), "strong-contrast");
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
      { id: "barcode-text", status: "Reading text below the barcode…", create: () => textBand(source), mode: "sparse" },
      { id: "sharpened", status: "Checking faded and wrapped characters…", create: () => imageVariant(source, "sharpen"), mode: "sparse" },
      { id: "high-contrast", status: "Verifying the strongest label candidates…", create: () => imageVariant(labelFieldsRegion(source), "threshold"), mode: "block" },
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

  async function detectNative(canvas) {
    if (!global.BarcodeDetector) return [];
    try {
      const supported = await global.BarcodeDetector.getSupportedFormats?.();
      const wanted = [
        "code_128", "code_39", "code_93", "itf", "codabar",
        "ean_13", "ean_8", "upc_a", "upc_e",
      ]
        .filter((format) => !supported?.length || supported.includes(format));
      const detector = new global.BarcodeDetector(wanted.length ? { formats: wanted } : undefined);
      const results = await detector.detect(canvas);
      return results.map((result) => ({
        value: resultValue(result),
        format: cleanValue(result.format || "unknown"),
        engine: "native",
      })).filter((item) => item.value);
    } catch {
      return [];
    }
  }

  async function detectZxing(canvas) {
    try {
      const reader = getZxingReader();
      if (!reader) return [];
      const result = reader.decodeFromCanvas(canvas);
      const value = resultValue(result);
      return value ? [{ value, format: zxingFormat(result), engine: "zxing" }] : [];
    } catch {
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

  async function decodeFrame(canvas, { enhanced = false, isCancelled = () => false } = {}) {
    // Do not stop at the first decoded symbol. Cartons often show UPC, case,
    // product, and lot barcodes together; the parser must receive every viable
    // candidate so it can reject product codes and cross-check the lot.
    const builders = [() => canvas];
    if (enhanced) builders.push(
      () => imageVariant(canvas, "grayscale"),
      () => imageVariant(canvas, "contrast"),
      () => imageVariant(canvas, "sharpen"),
      () => imageVariant(canvas, "threshold"),
      () => rotateCanvas(imageVariant(canvas, "contrast"), 2.5),
      () => rotateCanvas(imageVariant(canvas, "contrast"), -2.5),
    );
    const found = [];
    for (const build of builders) {
      if (isCancelled()) return uniqueDetections(found);
      // Give the UI a chance to paint the frozen photo and progress state
      // between expensive still-image variants on mobile Safari.
      await new Promise((resolve) => global.setTimeout(resolve, 0));
      if (isCancelled()) return uniqueDetections(found);
      const source = build();
      const [native, zxing] = await Promise.all([detectNative(source), detectZxing(source)]);
      found.push(...native, ...zxing);
    }
    return uniqueDetections(found);
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
    return {
      torch: Boolean(capabilities.torch),
    };
  }

  async function setTorch(track, enabled) {
    try {
      await track?.applyConstraints?.({ advanced: [{ torch: Boolean(enabled) }] });
      return true;
    } catch {
      return false;
    }
  }

  global.AtlasCocScannerV2 = Object.freeze({
    ROI,
    captureRoi,
    copyCanvas,
    cropCanvas,
    rotateCanvas,
    qualityScore,
    imageVariant,
    labelFieldsRegion,
    textBand,
    buildOcrPasses,
    decodeFrame,
    configureTrack,
    setTorch,
  });
})(window);
