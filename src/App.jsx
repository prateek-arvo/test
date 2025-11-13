import React, { useEffect, useRef, useState } from "react";

/** --- Tunables --- */
const OPENCV_SRC = "https://docs.opencv.org/4.x/opencv.js"; // host locally if you prefer
const BOX_FRACTION = 0.5;      // fraction of min(videoWidth, videoHeight) for square aim box
const CENTER_FRACTION = 0.4;   // center patch from QR crop
const STABILITY_FRAMES = 4;    // frames that must agree before cropping
const POSITION_TOL_PX = 8;     // allowed movement of QR center between frames
const SIZE_TOL_RATIO = 0.18;   // allowed size change between frames
const PADDING_RATIO = 0.05;    // small padding around QR (set 0 for none)

/** Utility: lazy-load OpenCV.js */
function useOpenCV(src = OPENCV_SRC) {
  const [ready, setReady] = useState(!!(window.cv && window.cv.Mat));
  const [error, setError] = useState("");

  useEffect(() => {
    if (ready) return;

    let script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      try {
        if (window.cv && window.cv['onRuntimeInitialized'] !== undefined) {
          window.cv['onRuntimeInitialized'] = () => setReady(true);
        } else if (window.cv && window.cv.Mat) {
          setReady(true);
        } else {
          // Poll (some builds take a tick)
          const id = setInterval(() => {
            if (window.cv && window.cv.Mat) {
              clearInterval(id);
              setReady(true);
            }
          }, 50);
          setTimeout(() => clearInterval(id), 5000);
        }
      } catch (e) {
        setError("OpenCV loaded but failed to initialize.");
      }
    };
    script.onerror = () => setError("Failed to load OpenCV.js (network/CORS).");
    document.head.appendChild(script);

    return () => {
      // Do not remove the script on unmount during hot reloads; safer to leave it.
    };
  }, [ready, src]);

  return { cvReady: ready, cvError: error };
}

export default function App() {
  const { cvReady, cvError } = useOpenCV();

  const videoRef = useRef(null);
  const videoTrackRef = useRef(null);
  const workCanvasRef = useRef(null);
  const qrBoxHistoryRef = useRef([]);
  const rafRef = useRef(0);
  const lockedRef = useRef(false);

  const [camReady, setCamReady] = useState(false);
  const [errors, setErrors] = useState([]);

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

  // Start camera on button click (user gesture helps autoplay policies)
  const handleStartCamera = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("getUserMedia not supported in this browser.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        },
      });
      const [track] = stream.getVideoTracks();
      videoTrackRef.current = track;

      // Torch support (Android Chrome)
      try {
        const caps = track.getCapabilities?.();
        setTorchSupported(!!(caps && "torch" in caps));
      } catch {
        setTorchSupported(false);
      }

      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      // Mobile quirks: muted + playsInline helps autoplay
      videoRef.current.muted = true;
      videoRef.current.setAttribute("playsinline", "true");

      try {
        await videoRef.current.play();
      } catch (e) {
        // Some browsers still need another tap; show user-friendly hint
        pushError("Tap the video to start playback (autoplay blocked).");
        videoRef.current.addEventListener(
          "click",
          async () => {
            try {
              await videoRef.current.play();
            } catch (err) {
              pushError("Video playback blocked by browser policy.");
            }
          },
          { once: true }
        );
      }

      setCamReady(true);
      // If OpenCV is already ready, kick off detection
      if (cvReady) startDetectionLoop();
    } catch (e) {
      pushError(describeCamError(e));
    }
  };

  // If OpenCV becomes ready after camera, start detection
  useEffect(() => {
    if (cvReady && camReady) startDetectionLoop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cvReady, camReady]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current || 0);
      stopCamera();
    };
  }, []);

  function stopCamera() {
    const stream = videoRef.current?.srcObject;
    if (stream && stream.getTracks) {
      stream.getTracks().forEach((t) => t.stop());
    }
    videoTrackRef.current = null;
    setTorchOn(false);
  }

  function startDetectionLoop() {
    if (!workCanvasRef.current) {
      workCanvasRef.current = document.createElement("canvas");
    }
    lockedRef.current = false;
    qrBoxHistoryRef.current = [];

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      if (lockedRef.current) return;
      const v = videoRef.current;
      if (!v || !v.videoWidth || !v.videoHeight) return;

      const vw = v.videoWidth;
      const vh = v.videoHeight;

      // Square aim box in video coords
      const boxSize = Math.floor(Math.min(vw, vh) * BOX_FRACTION);
      const boxX = Math.floor((vw - boxSize) / 2);
      const boxY = Math.floor((vh - boxSize) / 2);
      const boxX2 = boxX + boxSize;
      const boxY2 = boxY + boxSize;

      // Draw to offscreen canvas
      const canvas = workCanvasRef.current;
      canvas.width = vw;
      canvas.height = vh;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(v, 0, 0, vw, vh);

      // OpenCV detect
      const cv = window.cv;
      if (!cv || !cv.Mat) return; // not ready yet
      let src = null;
      let points = new cv.Mat();
      try {
        src = cv.imread(canvas); // RGBA
        const detector = new cv.QRCodeDetector();
        const decoded = detector.detectAndDecode(src, points);
        detector.delete();

        if (!decoded || decoded.length === 0) {
          qrBoxHistoryRef.current = [];
          src.delete();
          points.delete();
          return;
        }

        const pts = matToPoints(points);
        if (!pts || pts.length < 4) {
          qrBoxHistoryRef.current = [];
          src.delete();
          points.delete();
          return;
        }

        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        let minX = Math.min(...xs);
        let maxX = Math.max(...xs);
        let minY = Math.min(...ys);
        let maxY = Math.max(...ys);
        const qrW = maxX - minX;
        const qrH = maxY - minY;

        // Require fully inside aim box
        if (minX < boxX || minY < boxY || maxX > boxX2 || maxY > boxY2) {
          qrBoxHistoryRef.current = [];
          src.delete();
          points.delete();
          return;
        }

        // Tight crop + optional padding
        const pad = PADDING_RATIO * Math.max(qrW, qrH);
        const cropX = Math.max(0, Math.floor(minX - pad));
        const cropY = Math.max(0, Math.floor(minY - pad));
        const cropW = Math.min(vw - cropX, Math.floor(qrW + pad * 2));
        const cropH = Math.min(vh - cropY, Math.floor(qrH + pad * 2));

        pushQrBox({ x: cropX, y: cropY, w: cropW, h: cropH });

        if (isStable()) {
          lockedRef.current = true;
          setResult(decoded);
          const stable = getAverageBox();
          if (stable) captureQrRegion(v, stable);
          stopCamera();
          cancelAnimationFrame(rafRef.current || 0);
          qrBoxHistoryRef.current = [];
        }

        src.delete();
        points.delete();
      } catch (err) {
        pushError("OpenCV detect error: " + (err?.message || String(err)));
        if (src) src.delete();
        points.delete();
      }
    };

    cancelAnimationFrame(rafRef.current || 0);
    loop();
  }

  /** Torch toggle */
  const handleToggleTorch = async () => {
    const track = videoTrackRef.current;
    if (!track?.getCapabilities || !track?.applyConstraints) return;
    try {
      const caps = track.getCapabilities();
      if (!caps?.torch) return;
      const newValue = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: newValue }] });
      setTorchOn(newValue);
    } catch (err) {
      pushError("Torch toggle failed or unsupported.");
    }
  };

  /** ---- Stability helpers ---- */
  function pushQrBox(box) {
    const hist = qrBoxHistoryRef.current;
    hist.push(box);
    if (hist.length > STABILITY_FRAMES) hist.shift();
  }

  function getAverageBox() {
    const hist = qrBoxHistoryRef.current;
    if (!hist.length) return null;
    let sx = 0, sy = 0, sw = 0, sh = 0;
    for (const b of hist) {
      sx += b.x; sy += b.y; sw += b.w; sh += b.h;
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
      const sizeDrW = Math.abs(b.w - avg.w) / Math.max(1, avg.w);
      const sizeDrH = Math.abs(b.h - avg.h) / Math.max(1, avg.h);

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

  /** ---- Capture and post-crop helpers ---- */
  function captureQrRegion(video, box) {
    const { x, y, w, h } = box;

    // Tight QR crop
    const qrCanvas = document.createElement("canvas");
    qrCanvas.width = w;
    qrCanvas.height = h;
    const qrCtx = qrCanvas.getContext("2d");
    qrCtx.drawImage(video, x, y, w, h, 0, 0, w, h);
    const qrUrl = qrCanvas.toDataURL("image/png");
    setQrBase(qrUrl);

    // Center 40% from within the QR crop
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
      px, py, patchSize, patchSize,
      0, 0, patchSize, patchSize
    );
    const centerUrl = centerCanvas.toDataURL("image/png");
    setCenterBase(centerUrl);
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

  // Simple unsharp mask
  function applyUnsharp(imageData, amount = 0.3) {
    const { width, height, data } = imageData;
    const len = data.length;
    const blur = new Uint8ClampedArray(len);
    const w4 = width * 4;

    // 3x3 box blur
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

  // Convert OpenCV points Mat (4 points) to array of {x,y}
  function matToPoints(pointsMat) {
    const pts = [];
    // Try common layouts
    if (pointsMat.rows === 4 && pointsMat.cols === 1 && pointsMat.data32F) {
      for (let i = 0; i < 4; i++) {
        const x = pointsMat.data32F[i * 2];
        const y = pointsMat.data32F[i * 2 + 1];
        pts.push({ x, y });
      }
    } else if (pointsMat.rows === 1 && pointsMat.cols === 4 && pointsMat.data32F) {
      for (let i = 0; i < 4; i++) {
        const x = pointsMat.data32F[i * 2];
        const y = pointsMat.data32F[i * 2 + 1];
        pts.push({ x, y });
      }
    } else if (pointsMat.rows === 4 && pointsMat.cols === 2 && pointsMat.type() === window.cv.CV_32F) {
      for (let i = 0; i < 4; i++) {
        const x = pointsMat.floatAt(i, 0);
        const y = pointsMat.floatAt(i, 1);
        pts.push({ x, y });
      }
    }
    return pts;
  }

  function pushError(msg) {
    setErrors((prev) => [...prev, msg]);
    console.error(msg);
  }

  function describeCamError(e) {
    const msg = e?.message || String(e);
    if (msg.includes("NotAllowedError")) return "Camera access denied. Check site permissions.";
    if (msg.includes("NotFoundError")) return "No camera found. Is a camera available?";
    if (msg.includes("NotReadableError")) return "Camera is busy or in use by another app.";
    if (msg.includes("OverconstrainedError")) return "Requested camera constraints not supported.";
    return "Camera error: " + msg;
  }

  const captured = qrBase && centerBase;

  return (
    <div style={{ textAlign: "center", padding: "20px" }}>
      <h2>QR → CDP Extractor (OpenCV.js, Box-Aimed, QR-Only Stable Crop)</h2>

      {!camReady && (
        <button
          onClick={handleStartCamera}
          style={{
            padding: "10px 16px",
            borderRadius: 8,
            border: "1px solid #ccc",
            background: "#111",
            color: "#fff",
            cursor: "pointer",
            marginBottom: 10,
          }}
        >
          Start Scanner
        </button>
      )}

      {!cvReady && (
        <div style={{ marginBottom: 10, color: "#666" }}>
          Loading OpenCV.js… {cvError && <span style={{ color: "crimson" }}>{cvError}</span>}
        </div>
      )}

      <div style={{ position: "relative", display: "inline-block" }}>
        <video
          ref={videoRef}
          style={{
            width: "100%",
            maxWidth: "500px",
            border: "1px solid #ccc",
            borderRadius: "8px",
            background: "#000",
          }}
          muted
          playsInline
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
        {torchSupported && camReady && (
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

      {errors.length > 0 && (
        <div style={{ marginTop: 12, color: "crimson", textAlign: "left", maxWidth: 520, marginInline: "auto" }}>
          <b>Issues:</b>
          <ul>
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

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
