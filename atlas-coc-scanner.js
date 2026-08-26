(function (global) {
  "use strict";

  const ROI = Object.freeze({ x: 0.04, y: 0.12, width: 0.92, height: 0.76 });
  const MAX_CAPTURE_WIDTH = 2400;
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
    for (let index = 0; index < image.data.length; index += 4) {
      const gray = image.data[index] * 0.299 + image.data[index + 1] * 0.587 + image.data[index + 2] * 0.114;
      let value = gray;
      if (mode === "contrast") value = Math.max(0, Math.min(255, (gray - 128) * 1.75 + 128));
      if (mode === "threshold") value = gray > 154 ? 255 : 0;
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  function textBand(source) {
    const sourceY = Math.round(source.height * 0.45);
    const band = createCanvas(source.width, source.height - sourceY);
    band.getContext("2d", { willReadFrequently: true }).drawImage(
      source, 0, sourceY, source.width, source.height - sourceY,
      0, 0, band.width, band.height,
    );
    return imageVariant(band, "contrast");
  }

  function labelFieldsRegion(source) {
    const regionHeight = Math.max(1, Math.round(source.height * 0.52));
    const region = createCanvas(source.width, regionHeight);
    region.getContext("2d", { willReadFrequently: true }).drawImage(
      source, 0, 0, source.width, regionHeight,
      0, 0, region.width, region.height,
    );
    return imageVariant(region, "contrast");
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

  async function decodeFrame(canvas, { enhanced = false } = {}) {
    const sources = [canvas];
    if (enhanced) sources.push(
      imageVariant(canvas, "grayscale"),
      imageVariant(canvas, "contrast"),
      imageVariant(canvas, "threshold"),
    );
    const found = [];
    for (const source of sources) {
      const [native, zxing] = await Promise.all([detectNative(source), detectZxing(source)]);
      found.push(...native, ...zxing);
      if (found.length) break;
    }
    return uniqueDetections(found);
  }

  async function configureTrack(track) {
    const capabilities = track?.getCapabilities?.() || {};
    const advanced = [];
    if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")) {
      advanced.push({ focusMode: "continuous" });
    }
    if (capabilities.zoom && Number.isFinite(Number(capabilities.zoom.min))) {
      const minimum = Number(capabilities.zoom.min);
      const maximum = Number(capabilities.zoom.max);
      const preferred = Math.min(maximum, Math.max(minimum, minimum + ((maximum - minimum) * 0.18)));
      advanced.push({ zoom: preferred });
    }
    if (advanced.length) {
      try { await track.applyConstraints({ advanced }); } catch {}
    }
    return {
      torch: Boolean(capabilities.torch),
      zoom: capabilities.zoom ? {
        min: Number(capabilities.zoom.min),
        max: Number(capabilities.zoom.max),
        step: Number(capabilities.zoom.step) || 0.1,
      } : null,
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

  async function setZoom(track, value) {
    try {
      await track?.applyConstraints?.({ advanced: [{ zoom: Number(value) }] });
      return true;
    } catch {
      return false;
    }
  }

  global.AtlasCocScannerV2 = Object.freeze({
    ROI,
    captureRoi,
    copyCanvas,
    qualityScore,
    imageVariant,
    labelFieldsRegion,
    textBand,
    decodeFrame,
    configureTrack,
    setTorch,
    setZoom,
  });
})(window);
