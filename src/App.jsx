import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

const BOX_FRACTION = 0.5;       // fraction of min(videoWidth, videoHeight) for the square aim box
const CENTER_FRACTION = 0.4;    // center patch from QR crop

// Auto-crop / stability controls
const STABILITY_FRAMES = 4;     // how many recent frames must agree
const POSITION_TOL_PX = 8;      // allowed movement of QR center
const SIZE_TOL_RATIO = 0.18;    // allowed size change
const PADDING_RATIO = 0.05;     // small padding around QR; set 0 for zero extra

function App() {
  const videoRef = useRef(null);
  const videoTrackRef = useRef(null);
  const qrBoxHistoryRef = useRef([]); // recent QR boxes for stability

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

  useEffect(() => {
    const codeReader = new BrowserQRCodeReader();
    let currentStream = null;
    let controls = null;
    let locked = false;

    qrBoxHistoryRef.current = [];

    const startCameraAndScan = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 2560 },
            height: { ideal: 1440 },
          },
        });

        currentStream = stream;
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

        controls = await codeReader.decodeFromVideoDevice(
          undefined,
          videoRef.current,
          (res, err) => {
            if (!res || locked || !videoRef.current) return;

            const v = videoRef.current;
            const vw = v.videoWidth;
            const vh = v.videoHeight;
            if (!vw || !vh) return;

            // --- Compute square bounding box in video coords ---
            const boxSize = Math.floor(Math.min(vw, vh) * BOX_FRACTION);
            const boxX = Math.floor((vw - boxSize) / 2);
            const boxY = Math.floor((vh - boxSize) / 2);
            const boxX2 = boxX + boxSize;
            const boxY2 = boxY + boxSize;

            // --- QR bounding box from resultPoints ---
            const pts =
              (res.getResultPoints && res.getResultPoints()) ||
              res.resultPoints ||
              [];

            if (!pts || pts.length < 3) return;

            const xs = pts.map((p) => (p.getX ? p.getX() : p.x));
            const ys = pts.map((p) => (p.getY ? p.getY() : p.y));
            let minX = Math.min(...xs);
            let maxX = Math.max(...xs);
            let minY = Math.min(...ys);
            let maxY = Math.max(...ys);

            let qrW = maxX - minX;
            let qrH = maxY - minY;

            // Require QR to be fully inside the visible square bounding box
            if (
              minX < boxX ||
              minY < boxY ||
              maxX > boxX2 ||
              maxY > boxY2
            ) {
              // Ignore detections outside / crossing the box
              qrBoxHistoryRef.current = [];
              return;
            }

            // Apply small padding only around QR (still within video bounds)
            const pad = PADDING_RATIO * Math.max(qrW, qrH);
            let cropX = Math.max(0, Math.floor(minX - pad));
            let cropY = Math.max(0, Math.floor(minY - pad));
            let cropW = Math.min(vw - cropX, Math.floor(qrW + pad * 2));
            let cropH = Math.min(vh - cropY, Math.floor(qrH + pad * 2));

            const qrBox = { x: cropX, y: cropY, w: cropW, h: cropH };
            pushQrBox(qrBox);

            // Only proceed once box has been stable over several frames
            if (!isStable()) return;

            locked = true;

            const text = res.getText ? res.getText() : res.text;
            setResult(text || "");

            const stableBox = getAverageBox();
            if (stableBox) {
              captureQrRegion(v, stableBox);
            }

            // Stop scanning & camera after capture
            if (controls) controls.stop();
            if (currentStream) {
              currentStream.getTracks().forEach((t) => t.stop());
            }
            videoTrackRef.current = null;
            setTorchOn(false);
            qrBoxHistoryRef.current = [];
          }
        );
      } catch (e) {
        console.error("Camera or decoding error:", e);
      }
    };

    startCameraAndScan();

    return () => {
      if (controls) controls.stop();
      if (currentStream) {
        currentStream.getTracks().forEach((t) => t.stop());
      }
      videoTrackRef.current = null;
      setTorchOn(false);
      qrBoxHistoryRef.current = [];
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

  // --- Stability helpers (for slow/robust auto-crop) ---

  function pushQrBox(box) {
    const hist = qrBoxHistoryRef.current;
    hist.push(box);
    if (hist.length > STABILITY_FRAMES) hist.shift();
  }

  function getAverageBox() {
    const hist = qrBoxHistoryRef.current;
    if (!hist.length) return null;
    let sx = 0,
      sy = 0,
      sw = 0,
      sh = 0;
    for (const b of hist) {
      sx += b.x;
      sy += b.y;
      sw += b.w;
      sh += b.h;
    }
    const n = hist.length;
    return {
      x: Math.round(sx / n),
      y: Math.round(sy / n),
      w: Math.round(sw / n),
      h: Math.round(sh / n),
    };
  }

  function isStable() {
    const hist = qrBoxHistoryRef.current;
    if (hist.length < STABILITY_FRAMES) return false;

    const avg = getAverageBox();
    if (!avg) return false;

    for (const b of hist) {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const cax = avg.x + avg.w / 2;
      const cay = avg.y + avg.h / 2;

      const centerDx = Math.abs(cx - cax);
      const centerDy = Math.abs(cy - cay);
      const sizeDrW = Math.abs(b.w - avg.w) / avg.w;
      const sizeDrH = Math.abs(b.h - avg.h) / avg.h;

      if (
        centerDx > POSITION_TOL_PX ||
        centerDy > POSITION_TOL_PX ||
        sizeDrW > SIZE_TOL_RATIO ||
        sizeDrH > SIZE_TOL_RATIO
      ) {
        return false;
      }
    }

    return true;
  }

  // --- Capture: tight QR-only crop based on stable box ---

  function captureQrRegion(video, box) {
    const { x, y, w, h } = box;

    const qrCanvas = document.createElement("canvas");
    qrCanvas.width = w;
    qrCanvas.height = h;
    const qrCtx = qrCanvas.getContext("2d");
    qrCtx.drawImage(video, x, y, w, h, 0, 0, w, h);

    const qrUrl = qrCanvas.toDataURL("image/png");
    setQrBase(qrUrl);

    // Center 40% from within qr-only crop
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
  }

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

  const captured = qrBase && centerBase;

  return (
    <div style={{ textAlign: "center", padding: "20px" }}>
      <h2>QR → CDP Extractor (Box-Aimed, QR-Only Stable Crop)</h2>

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
              <h4>QR (tight crop)</h4>
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
              <h4>Center 40% (raw)</h4>
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
