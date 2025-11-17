import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

const BOX_FRACTION = 0.5;       // fraction of min(videoWidth, videoHeight) for the square aim box
const CENTER_FRACTION = 0.4;    // center patch from QR crop
const PADDING_RATIO = 0.05;     // small padding around QR; set 0 for zero extra

// multi-frame merge params
const BURST_FRAMES = 5;         // how many frames to merge
const FRAME_DELAY_MS = 30;      // delay between frames in ms

function App() {
  const videoRef = useRef(null);
  const videoTrackRef = useRef(null);
  const streamRef = useRef(null); // keep stream so we can stop it on capture

  const [result, setResult] = useState("");

  const [qrBase, setQrBase] = useState(null);
  const [centerBase, setCenterBase] = useState(null);

  const [qrProcessed, setQrProcessed] = useState(null);
  const [centerProcessed, setCenterProcessed] = useState(null);

  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // Post-capture tuning
  const [sharpAmount, setSharpAmount] = useState(0.3); // 0–1
  const [contrast, setContrast] = useState(1.0);       // 0.5–2
  const [brightness, setBrightness] = useState(0.0);   // -0.3–0.3

  const [capturing, setCapturing] = useState(false);

  // --- Start camera only (no live decoding) ---
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
      // Cleanup on unmount
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

  // Helper: stop camera / live stream
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

  // --- Multi-frame capture & merge inside bounding box ---
  async function captureMergedROI(video, frames = BURST_FRAMES, delayMs = FRAME_DELAY_MS) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) throw new Error("Video not ready");

    const boxSize = Math.floor(Math.min(vw, vh) * BOX_FRACTION);
    const boxX = Math.floor((vw - boxSize) / 2);
    const boxY = Math.floor((vh - boxSize) / 2);

    // Canvas for full frame
    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = vw;
    frameCanvas.height = vh;
    const frameCtx = frameCanvas.getContext("2d");

    // ROI canvas & accumulator
    const roiCanvas = document.createElement("canvas");
    roiCanvas.width = boxSize;
    roiCanvas.height = boxSize;
    const roiCtx = roiCanvas.getContext("2d");

    const acc = new Float32Array(boxSize * boxSize * 4);

    for (let i = 0; i < frames; i++) {
      frameCtx.drawImage(video, 0, 0, vw, vh);

      const imgData = frameCtx.getImageData(boxX, boxY, boxSize, boxSize);
      const data = imgData.data;

      for (let j = 0; j < data.length; j++) {
        acc[j] += data[j];
      }

      if (i < frames - 1) {
        // small delay so frames differ slightly
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    // build averaged ImageData
    const out = new Uint8ClampedArray(boxSize * boxSize * 4);
    const invN = 1 / frames;
    for (let i = 0; i < acc.length; i++) {
      out[i] = Math.round(acc[i] * invN);
    }
    const mergedImageData = new ImageData(out, boxSize, boxSize);
    roiCtx.putImageData(mergedImageData, 0, 0);

    return roiCanvas;
  }

  // --- Capture button: multi-frame merge, then ZXing + crops ---

  const handleCaptureBox = async () => {
    if (!videoRef.current || capturing) return;
    const v = videoRef.current;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) {
      console.warn("Video not ready / no dimensions yet.");
      return;
    }

    setCapturing(true);
    try {
      // 1) Multi-frame merge inside bounding box → roiCanvas
      const roiCanvas = await captureMergedROI(v);

      // 2) Run ZXing on merged ROI via data URL (no img.onload)
      const dataUrl = roiCanvas.toDataURL("image/png");
      const reader = new BrowserQRCodeReader();

      let res;
      try {
        res = await reader.decodeFromImageUrl(dataUrl);
      } catch (err) {
        console.error("ZXing decode error:", err);
        alert("No QR detected in the merged area. Try again closer / steadier.");
        setCapturing(false); // allow retry, keep camera on
        return;
      }

      if (!res) {
        alert("No QR detected in the merged area.");
        setCapturing(false);
        return;
      }

      const text = res.getText ? res.getText() : res.text;
      setResult(text || "");

      // 3) QR bounding box from resultPoints in ROI coordinates (0..boxSize)
      const pts =
        (res.getResultPoints && res.getResultPoints()) ||
        res.resultPoints ||
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

      // 4) Tight QR-only crop from merged ROI
      const qrCanvas = document.createElement("canvas");
      qrCanvas.width = w;
      qrCanvas.height = h;
      const qrCtx = qrCanvas.getContext("2d");
      qrCtx.drawImage(roiCanvas, x, y, w, h, 0, 0, w, h);
      const qrUrl = qrCanvas.toDataURL("image/png");
      setQrBase(qrUrl);

      // 5) Center 40% from within that QR crop
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
      setCenterBase(centerUrl);

      // 6) ✅ Stop live stream now that we captured the photo
      stopCamera();
      setCapturing(false);
    } catch (err) {
      console.error(err);
      alert("Capture failed. Try again.");
      setCapturing(false);
    }
  };

  // --- Post-capture processing ---

  useEffect(() => {
    if (!qrBase) return;
    processImage(qrBase, sharpAmount, contrast, brightness, setQrProcessed);
  }, [qrBase, sharpAmount, contrast, brightness]);

  useEffect(() => {
    if (!centerBase) return;
    processImage(centerBase, sharpAmount, contrast, brightness, setCenterProcessed);
  }, [centerBase, sharpAmount, contrast, brightness]);

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

  const captured = qrBase && centerBase;

  return (
    <div style={{ textAlign: "center", padding: "20px" }}>
      <h2>QR → CDP Extractor (Multi-frame Merge from Box)</h2>

      <button
        onClick={handleCaptureBox}
        disabled={capturing}
        style={{
          padding: "10px 16px",
          borderRadius: 8,
          border: "1px solid #ccc",
          cursor: capturing ? "default" : "pointer",
          marginBottom: 12,
          opacity: capturing ? 0.7 : 1,
        }}
      >
        {capturing ? "Capturing…" : "Capture Box (Multi-frame)"}
      </button>

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
        {/* Square bounding box overlay (aim region) */}
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

      {result && (
        <div style={{ marginTop: "16px" }}>
          <h3>QR Content</h3>
          <p
            style={{
              padding: "8px 12px",
              borderRadius: "6px",
              border: "1px solid "#ddd",
              display: "inline-block",
              maxWidth: "90%",
              wordBreak: "break-all",
            }}
          >
            {result}
          </p>
        </div>
      )}

      {captured && (
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
                onChange={(e) =>
                  setSharpAmount(parseFloat(e.target.value))
                }
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
                onChange={(e) =>
                  setContrast(parseFloat(e.target.value))
                }
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
                onChange={(e) =>
                  setBrightness(parseFloat(e.target.value))
                }
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
              <h4>QR (tight, merged)</h4>
              <img
                src={qrBase}
                alt="QR tight"
                style={{
                  maxWidth: "180px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
            </div>

            {qrProcessed && (
              <div>
                <h4>QR (adjusted)</h4>
                <img
                  src={qrProcessed}
                  alt="QR adjusted"
                  style={{
                    maxWidth: "180px",
                    borderRadius: "8px",
                    border: "1px solid #ddd",
                  }}
                />
              </div>
            )}

            <div>
              <h4>Center 40% (raw merged)</h4>
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

            {centerProcessed && (
              <div>
                <h4>Center 40% (adjusted)</h4>
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
