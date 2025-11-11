import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

const BOX_FRACTION = 0.5;        // fixed capture box size (50% of video)
const CENTER_FRACTION = 0.4;     // center patch from captured box
const MAX_BUFFER = 12;           // how many frames to keep in history

function App() {
  const videoRef = useRef(null);
  const videoTrackRef = useRef(null);
  const frameBufferRef = useRef([]); // [{ url, sharpness }]

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
    let rafId = null;

    frameBufferRef.current = [];

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

        // Start frame buffering loop (captures only the bounding box region)
        const startFrameBufferLoop = () => {
          const loop = () => {
            // If we've already locked on a QR, just keep looping until cancelled
            if (!videoRef.current || !videoRef.current.videoWidth || !videoRef.current.videoHeight) {
              rafId = requestAnimationFrame(loop);
              return;
            }

            if (!locked) {
              const v = videoRef.current;
              const vw = v.videoWidth;
              const vh = v.videoHeight;

              const boxW = Math.floor(vw * BOX_FRACTION);
              const boxH = Math.floor(vh * BOX_FRACTION);
              const x = Math.floor((vw - boxW) / 2);
              const y = Math.floor((vh - boxH) / 2);

              const canvas = document.createElement("canvas");
              canvas.width = boxW;
              canvas.height = boxH;
              const ctx = canvas.getContext("2d");
              ctx.drawImage(v, x, y, boxW, boxH, 0, 0, boxW, boxH);

              const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const sharpness = computeSharpness(imgData);
              const url = canvas.toDataURL("image/png");

              const buf = frameBufferRef.current;
              buf.push({ url, sharpness });
              if (buf.length > MAX_BUFFER) buf.shift();
            }

            rafId = requestAnimationFrame(loop);
          };

          rafId = requestAnimationFrame(loop);
        };

        startFrameBufferLoop();

        // Start QR decode; on success, pick best frame from buffer
        controls = await codeReader.decodeFromVideoDevice(
          undefined,
          videoRef.current,
          (res, err) => {
            if (!res || locked) return;

            locked = true;

            const text = res.getText ? res.getText() : res.text;
            setResult(text || "");

            // Choose sharpest frame from buffer, or fallback capture
            const buf = frameBufferRef.current;
            if (buf && buf.length > 0) {
              const best = buf.reduce((a, b) =>
                b.sharpness > a.sharpness ? b : a
              );
              handleCapturedBox(best.url);
            } else {
              // Fallback: capture once from the bounding box now
              if (videoRef.current) {
                const v = videoRef.current;
                const vw = v.videoWidth;
                const vh = v.videoHeight;
                const boxW = Math.floor(vw * BOX_FRACTION);
                const boxH = Math.floor(vh * BOX_FRACTION);
                const x = Math.floor((vw - boxW) / 2);
                const y = Math.floor((vh - boxH) / 2);

                const canvas = document.createElement("canvas");
                canvas.width = boxW;
                canvas.height = boxH;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(v, x, y, boxW, boxH, 0, 0, boxW, boxH);
                const url = canvas.toDataURL("image/png");
                handleCapturedBox(url);
              }
            }

            // Stop scanning & camera
            if (controls) controls.stop();
            if (currentStream) {
              currentStream.getTracks().forEach((t) => t.stop());
            }
            videoTrackRef.current = null;
            setTorchOn(false);
            frameBufferRef.current = [];

            if (rafId) cancelAnimationFrame(rafId);
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
      frameBufferRef.current = [];
      if (rafId) cancelAnimationFrame(rafId);
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

  // Handle captured bounding box (set qrBase & centerBase)
  function handleCapturedBox(boxUrl) {
    if (!boxUrl) return;
    setQrBase(boxUrl);

    const img = new Image();
    img.src = boxUrl;
    img.onload = () => {
      const { width, height } = img;
      const baseSize = Math.min(width, height);
      const patchSize = Math.floor(baseSize * CENTER_FRACTION);
      const cx = Math.floor(width / 2);
      const cy = Math.floor(height / 2);

      let px = cx - Math.floor(patchSize / 2);
      let py = cy - Math.floor(patchSize / 2);
      if (px < 0) px = 0;
      if (py < 0) py = 0;
      if (px + patchSize > width) px = width - patchSize;
      if (py + patchSize > height) py = height - patchSize;

      const centerCanvas = document.createElement("canvas");
      centerCanvas.width = patchSize;
      centerCanvas.height = patchSize;
      const centerCtx = centerCanvas.getContext("2d");
      centerCtx.drawImage(
        img,
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
    };
  }

  // Recompute processed previews whenever sliders or base images change
  useEffect(() => {
    if (!qrBase) return;
    processImage(qrBase, sharpAmount, contrast, brightness, setQrProcessed);
  }, [qrBase, sharpAmount, contrast, brightness]);

  useEffect(() => {
    if (!centerBase) return;
    processImage(centerBase, sharpAmount, contrast, brightness, setCenterProcessed);
  }, [centerBase, sharpAmount, contrast, brightness]);

  // --- Image processing helpers ---

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

  // Brightness [-0.5,0.5], Contrast [0.5,2]
  function applyBrightnessContrast(imageData, contrastVal, brightnessVal) {
    const { data } = imageData;
    // new = ((old/255 - 0.5) * contrast + 0.5 + brightness) * 255
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

  // Unsharp mask (gentle)
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

  // Simple gradient-based sharpness metric
  function computeSharpness(imageData) {
    const { width, height, data } = imageData;
    let sum = 0;
    let count = 0;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4;

        const left =
          (data[i - 4] + data[i - 3] + data[i - 2]) / 3;
        const right =
          (data[i + 4] + data[i + 5] + data[i + 6]) / 3;

        const upIndex = i - width * 4;
        const downIndex = i + width * 4;
        const up =
          (data[upIndex] + data[upIndex + 1] + data[upIndex + 2]) / 3;
        const down =
          (data[downIndex] + data[downIndex + 1] + data[downIndex + 2]) / 3;

        const gx = right - left;
        const gy = down - up;
        sum += gx * gx + gy * gy;
        count++;
      }
    }

    return count ? sum / count : 0;
  }

  const captured = qrBase && centerBase;

  return (
    <div style={{ textAlign: "center", padding: "20px" }}>
      <h2>QR → CDP Extractor (Sharpest Frame Capture)</h2>

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
        {/* Fixed bounding box overlay */}
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: `${BOX_FRACTION * 100}%`,
            height: `${BOX_FRACTION * 100}%`,
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
              <h4>QR box (raw, sharpest)</h4>
              <img
                src={qrBase}
                alt="QR raw"
                style={{
                  maxWidth: "180px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
            </div>

            {qrProcessed && (
              <div>
                <h4>QR box (adjusted)</h4>
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
