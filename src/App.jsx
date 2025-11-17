import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

// UpscalerJS + MAXIM Deblurring
import Upscaler from "upscaler";
import * as tf from "@tensorflow/tfjs";
import maximDeblurring from "@upscalerjs/maxim-deblurring";

const BOX_FRACTION = 0.5;       // fraction of min(videoWidth, videoHeight) for the square aim box
const CENTER_FRACTION = 0.4;    // center patch from QR crop (CDP region)
const PADDING_RATIO = 0.05;     // padding around QR

// Keep MAXIM input reasonably small to avoid heavy blocking
const MAXIM_INPUT_MAX = 192;    // max side length for CDP patch
const MAXIM_PATCH_SIZE = 64;
const MAXIM_PADDING = 8;

// Single Upscaler instance for deblurring
const deblurrer = new Upscaler({ model: maximDeblurring });

// Run UpscalerJS model on a canvas, return a new canvas
async function runUpscalerOnCanvas(inputCanvas, upscalerInstance) {
  const inputTensor = tf.browser.fromPixels(inputCanvas);

  const outputTensor = await upscalerInstance.upscale(inputTensor, {
    output: "tensor",
    patchSize: MAXIM_PATCH_SIZE,
    padding: MAXIM_PADDING,
  });

  const [outH, outW] = outputTensor.shape.slice(0, 2);
  const outCanvas = document.createElement("canvas");
  outCanvas.width = outW;
  outCanvas.height = outH;
  await tf.browser.toPixels(outputTensor, outCanvas);

  tf.dispose([inputTensor, outputTensor]);
  return outCanvas;
}

// Decode a canvas with ZXing by turning it into an Image element
async function decodeCanvasWithZXing(canvas, reader) {
  const src = canvas.toDataURL("image/png");
  const img = new Image();
  img.src = src;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
  });
  try {
    const res = await reader.decodeFromImageElement(img);
    return res;
  } catch (e) {
    console.error("ZXing decode error:", e);
    return null;
  }
}

function App() {
  const videoRef = useRef(null);
  const videoTrackRef = useRef(null);
  const streamRef = useRef(null);

  const [result, setResult] = useState("");

  const [centerBase, setCenterBase] = useState(null);       // raw CDP region
  const [centerDeblurred, setCenterDeblurred] = useState(null); // deblurred CDP

  const [centerProcessed, setCenterProcessed] = useState(null); // sliders output

  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // Post-processing controls on deblurred CDP
  const [sharpAmount, setSharpAmount] = useState(0.3);
  const [contrast, setContrast] = useState(1.0);
  const [brightness, setBrightness] = useState(0.0);

  const [capturing, setCapturing] = useState(false);
  const [isDeblurring, setIsDeblurring] = useState(false);

  // --- Start camera on mount ---
  useEffect(() => {
    let currentStream = null;

    const startCamera = async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          alert("Camera not supported in this browser.");
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 2560 },
            height: { ideal: 1440 },
          },
        });

        currentStream = stream;
        streamRef.current = stream;
        const [track] = stream.getVideoTracks();
        videoTrackRef.current = track;

        // Torch support (Android Chrome)
        try {
          const caps = track.getCapabilities?.();
          if (caps && "torch" in caps) setTorchSupported(true);
        } catch {
          setTorchSupported(false);
        }

        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute("playsinline", true);
        await videoRef.current.play();
      } catch (e) {
        console.error("Camera error:", e);
      }
    };

    startCamera();

    return () => {
      if (currentStream) {
        currentStream.getTracks().forEach((t) => t.stop());
      }
      streamRef.current = null;
      videoTrackRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setTorchOn(false);
    };
  }, []);

  // Torch toggle
  const handleToggleTorch = async () => {
    const track = videoTrackRef.current;
    if (!track || !track.getCapabilities || !track.applyConstraints) return;
    try {
      const caps = track.getCapabilities();
      if (!caps || !caps.torch) return;
      const newValue = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: newValue }] });
      setTorchOn(newValue);
    } catch (err) {
      console.warn("Torch toggle failed or unsupported:", err);
    }
  };

  // Stop camera feed
  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
    }
    streamRef.current = null;
    videoTrackRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setTorchOn(false);
    setTorchSupported(false);
  };

  // --- Capture button: decode first; if OK stop camera → CDP crop → deblur CDP ---
  const handleCaptureBox = async () => {
    if (!videoRef.current || capturing || isDeblurring) return;
    const v = videoRef.current;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) {
      console.warn("Video not ready / no dimensions yet.");
      return;
    }

    setCapturing(true);
    setResult("");
    setCenterBase(null);
    setCenterDeblurred(null);
    setCenterProcessed(null);

    try {
      // 1) Draw full frame to canvas
      const frameCanvas = document.createElement("canvas");
      frameCanvas.width = vw;
      frameCanvas.height = vh;
      const frameCtx = frameCanvas.getContext("2d");
      frameCtx.drawImage(v, 0, 0, vw, vh);

      // 2) Square bounding box in video coords
      const boxSize = Math.floor(Math.min(vw, vh) * BOX_FRACTION);
      const boxX = Math.floor((vw - boxSize) / 2);
      const boxY = Math.floor((vh - boxSize) / 2);

      // 3) Crop bounding box into ROI canvas
      const roiCanvas = document.createElement("canvas");
      roiCanvas.width = boxSize;
      roiCanvas.height = boxSize;
      const roiCtx = roiCanvas.getContext("2d");
      roiCtx.drawImage(
        frameCanvas,
        boxX,
        boxY,
        boxSize,
        boxSize,
        0,
        0,
        boxSize,
        boxSize
      );

      // 4) Decode QR from ROI (fast, no deblur yet)
      const reader = new BrowserQRCodeReader();
      const qrResult = await decodeCanvasWithZXing(roiCanvas, reader);
      if (!qrResult) {
        throw new Error("No QR detected in the box");
      }

      const text = qrResult.getText ? qrResult.getText() : qrResult.text;
      setResult(text || "");

      // 5) Tight QR bbox in ROI space
      const pts =
        (qrResult.getResultPoints && qrResult.getResultPoints()) ||
        qrResult.resultPoints ||
        [];

      const rw = roiCanvas.width;
      const rh = roiCanvas.height;

      let x, y, w, h;
      if (pts && pts.length >= 3) {
        const xs = pts.map((p) => (p.getX ? p.getX() : p.x));
        const ys = pts.map((p) => (p.getY ? p.getY() : p.y));
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const boxW = maxX - minX;
        const boxH = maxY - minY;
        const pad = PADDING_RATIO * Math.max(boxW, boxH);

        x = clamp(Math.floor(minX - pad), 0, rw - 1);
        y = clamp(Math.floor(minY - pad), 0, rh - 1);
        w = clamp(Math.floor(boxW + pad * 2), 1, rw - x);
        h = clamp(Math.floor(boxH + pad * 2), 1, rh - y);
      } else {
        // Fallback: center square inside ROI
        const size = Math.floor(Math.min(rw, rh) * 0.5);
        x = Math.floor((rw - size) / 2);
        y = Math.floor((rh - size) / 2);
        w = h = size;
      }

      // 6) Tight QR-only crop from ROI
      const qrCanvas = document.createElement("canvas");
      qrCanvas.width = w;
      qrCanvas.height = h;
      const qrCtx = qrCanvas.getContext("2d");
      qrCtx.drawImage(roiCanvas, x, y, w, h, 0, 0, w, h);

      // 7) CDP region = center 40% of QR crop
      const baseSize = Math.min(w, h);
      const patchSize = Math.floor(baseSize * CENTER_FRACTION);
      const cx = Math.floor(w / 2);
      const cy = Math.floor(h / 2);

      let px = cx - Math.floor(patchSize / 2);
      let py = cy - Math.floor(patchSize / 2);
      if (px < 0) px = 0;
      if (py < 0) py = 0;
      if (px + patchSize > w) px = w - patchSize;
      if (py + patchSize > h) py = h - patchSize;

      const centerCanvas = document.createElement("canvas");
      centerCanvas.width = patchSize;
      centerCanvas.height = patchSize;
      const centerCtx = centerCanvas.getContext("2d");
      centerCtx.drawImage(
        qrCanvas,
        px,
        py,
        patchSize,
        patchSize,
        0,
        0,
        patchSize,
        patchSize
      );
      const centerUrl = centerCanvas.toDataURL("image/png");
      setCenterBase(centerUrl); // show raw CDP region

      // ✅ Now that ZXing passed, stop camera feed
      stopCamera();

      // 8) Run deblurrer on CDP region in background
      deblurCdpInBackground(centerCanvas);
    } catch (err) {
      console.error(err);
      alert("Couldn’t decode a QR in the box. Try again closer / steadier.");
    } finally {
      setCapturing(false);
    }
  };

  // Background deblurring of CDP (center patch)
  const deblurCdpInBackground = (centerCanvas) => {
    setIsDeblurring(true);

    // Let React paint first, then run heavy work
    setTimeout(async () => {
      try {
        const cw = centerCanvas.width;
        const ch = centerCanvas.height;
        const maxSide = Math.max(cw, ch);
        const scale =
          maxSide > MAXIM_INPUT_MAX ? MAXIM_INPUT_MAX / maxSide : 1;

        // Downscale for MAXIM if needed
        const smallW = Math.max(1, Math.round(cw * scale));
        const smallH = Math.max(1, Math.round(ch * scale));

        const smallCanvas = document.createElement("canvas");
        smallCanvas.width = smallW;
        smallCanvas.height = smallH;
        const sctx = smallCanvas.getContext("2d");
        sctx.drawImage(centerCanvas, 0, 0, cw, ch, 0, 0, smallW, smallH);

        const enhancedCanvas = await runUpscalerOnCanvas(
          smallCanvas,
          deblurrer
        );

        const enhancedUrl = enhancedCanvas.toDataURL("image/png");
        setCenterDeblurred(enhancedUrl);
      } catch (err) {
        console.error("Deblurring failed:", err);
      } finally {
        setIsDeblurring(false);
      }
    }, 0);
  };

  // --- Post-processing sliders apply on deblurred CDP (fallback raw) ---

  useEffect(() => {
    const src = centerDeblurred || centerBase;
    if (!src) return;
    processImage(src, sharpAmount, contrast, brightness, setCenterProcessed);
  }, [centerBase, centerDeblurred, sharpAmount, contrast, brightness]);

  function processImage(url, sharpAmt, contrastVal, brightnessVal, cb) {
    const img = new Image();
    img.src = url;
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      let imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      imgData = applyBrightnessContrast(imgData, contrastVal, brightnessVal);
      if (sharpAmt > 0.001) {
        imgData = applyUnsharp(imgData, sharpAmt);
      }
      ctx.putImageData(imgData, 0, 0);
      cb(canvas.toDataURL("image/png"));
    };
  }

  function applyBrightnessContrast(imageData, contrastVal, brightnessVal) {
    const { data } = imageData;
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const old = data[i + c] / 255;
        let val = (old - 0.5) * contrastVal + 0.5 + brightnessVal;
        if (val < 0) val = 0;
        if (val > 1) val = 1;
        data[i + c] = Math.round(val * 255);
      }
    }
    return imageData;
  }

  function applyUnsharp(imageData, amount = 0.3) {
    const { width, height, data } = imageData;
    if (amount <= 0.001) return imageData;
    const len = data.length;
    const blur = new Uint8ClampedArray(len);
    const w4 = width * 4;

    // simple 3x3 box blur
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          sum += data[idx - w4 - 4 + c];
          sum += data[idx - w4 + c];
          sum += data[idx - w4 + 4 + c];
          sum += data[idx - 4 + c];
          sum += data[idx + c];
          sum += data[idx + 4 + c];
          sum += data[idx + w4 - 4 + c];
          sum += data[idx + w4 + c];
          sum += data[idx + w4 + 4 + c];
          blur[idx + c] = sum / 9;
        }
        blur[idx + 3] = data[idx + 3];
      }
    }

    const out = new Uint8ClampedArray(len);
    for (let i = 0; i < len; i += 4) {
      for (let c = 0; c < 3; c++) {
        const orig = data[i + c];
        const b = blur[i + c] || orig;
        let val = orig + amount * (orig - b);
        if (val < 0) val = 0;
        if (val > 255) val = 255;
        out[i + c] = val;
      }
      out[i + 3] = data[i + 3];
    }

    return new ImageData(out, width, height);
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  const hasCDP = centerBase != null;

  const renderDeblurStatus = () => {
    if (!isDeblurring) return null;
    return (
      <div style={{ marginTop: 8, fontSize: 13, color: "#555" }}>
        Enhancing CDP region (deblurring)…
      </div>
    );
  };

  return (
    <div style={{ textAlign: "center", padding: "20px" }}>
      <h2>QR → CDP Extractor (Decode → Stop Camera → Deblur CDP)</h2>

      <button
        onClick={handleCaptureBox}
        disabled={capturing || isDeblurring}
        style={{
          padding: "10px 16px",
          borderRadius: 8,
          border: "1px solid #ccc",
          cursor: capturing || isDeblurring ? "default" : "pointer",
          marginBottom: 12,
          opacity: capturing || isDeblurring ? 0.7 : 1,
        }}
      >
        {capturing ? "Capturing…" : "Capture Box"}
      </button>

      {/* Video only while camera is active */}
      {streamRef.current && (
        <div style={{ position: "relative", display: "inline-block" }}>
          <video
            ref={videoRef}
            style={{
              width: "100%",
              maxWidth: "500px",
              border: "1px solid #ccc",
              borderRadius: "8px",
            }}
          />
          {/* Square bounding box overlay */}
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              aspectRatio: "1 / 1",
              width: `${BOX_FRACTION * 100}%`,
              border: "2px solid #00ff99",
              borderRadius: "8px",
              boxSizing: "border-box",
              pointerEvents: "none",
            }}
          />
          {torchSupported && (
            <button
              onClick={handleToggleTorch}
              style={{
                position: "absolute",
                bottom: 10,
                right: 10,
                padding: "6px 10px",
                fontSize: "12px",
                borderRadius: "6px",
                border: "none",
                background: torchOn ? "#ffcc00" : "#333",
                color: torchOn ? "#000" : "#fff",
                cursor: "pointer",
                opacity: 0.9,
              }}
            >
              {torchOn ? "Flash ON" : "Flash OFF"}
            </button>
          )}
        </div>
      )}

      {renderDeblurStatus()}

      {result && (
        <div style={{ marginTop: "16px" }}>
          <h3>QR Content</h3>
          <p
            style={{
              padding: "8px 12px",
              borderRadius: "6px",
              border: "1px solid #ddd",
              display: "inline-block",
              maxWidth: "90%",
              wordBreak: "break-all",
            }}
          >
            {result}
          </p>
        </div>
      )}

      {hasCDP && (
        <>
          <div
            style={{
              marginTop: "20px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              alignItems: "center",
              fontSize: "13px",
            }}
          >
            <div>
              <label>Sharpness ({sharpAmount.toFixed(2)}): </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={sharpAmount}
                onChange={(e) => setSharpAmount(parseFloat(e.target.value))}
                style={{ width: "260px", marginLeft: "6px" }}
              />
            </div>
            <div>
              <label>Contrast ({contrast.toFixed(2)}): </label>
              <input
                type="range"
                min="0.5"
                max="2"
                step="0.05"
                value={contrast}
                onChange={(e) => setContrast(parseFloat(e.target.value))}
                style={{ width: "260px", marginLeft: "6px" }}
              />
            </div>
            <div>
              <label>Brightness ({brightness.toFixed(2)}): </label>
              <input
                type="range"
                min="-0.3"
                max="0.3"
                step="0.02"
                value={brightness}
                onChange={(e) => setBrightness(parseFloat(e.target.value))}
                style={{ width: "260px", marginLeft: "6px" }}
              />
            </div>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: "18px",
              flexWrap: "wrap",
              marginTop: "20px",
            }}
          >
            <div>
              <h4>CDP region (raw)</h4>
              <img
                src={centerBase}
                alt="Center raw"
                style={{
                  maxWidth: "180px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
            </div>

            {centerDeblurred && (
              <div>
                <h4>CDP region (deblurred)</h4>
                <img
                  src={centerDeblurred}
                  alt="Center deblurred"
                  style={{
                    maxWidth: "180px",
                    borderRadius: "8px",
                    border: "1px solid #ddd",
                  }}
                />
              </div>
            )}

            {centerProcessed && (
              <div>
                <h4>
                  CDP region (adjusted {centerDeblurred ? "deblurred" : "raw"})
                </h4>
                <img
                  src={centerProcessed}
                  alt="Center adjusted"
                  style={{
                    maxWidth: "180px",
                    borderRadius: "8px",
                    border: "1px solid #ddd",
                  }}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default App;
