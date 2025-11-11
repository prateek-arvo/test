import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

function App() {
  const videoRef = useRef(null);
  const videoTrackRef = useRef(null);

  const [result, setResult] = useState("");

  const [qrBase, setQrBase] = useState(null);
  const [qrSharp, setQrSharp] = useState(null);
  const [centerBase, setCenterBase] = useState(null);
  const [centerSharp, setCenterSharp] = useState(null);

  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // UI toggles (post-capture)
  const [useQrSharpen, setUseQrSharpen] = useState(false);
  const [useCenterSharpen, setUseCenterSharpen] = useState(false);

  const CENTER_FRACTION = 0.4; // 40% center crop
  const UNSHARP_AMOUNT = 0.35; // gentle

  useEffect(() => {
    const codeReader = new BrowserQRCodeReader();
    let currentStream = null;
    let controls = null;
    let locked = false;

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

        // Torch capability (Android Chrome)
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
            if (locked || !res) return;
            locked = true;

            const text = res.getText ? res.getText() : res.text;
            setResult(text);

            const v = videoRef.current;
            const vw = v.videoWidth;
            const vh = v.videoHeight;

            // ---------- Step 1: QR crop (bbox + padding) ----------
            const pts =
              (res.getResultPoints && res.getResultPoints()) ||
              res.resultPoints ||
              [];

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
              const pad = 0.15 * Math.max(boxW, boxH);

              x = Math.max(0, Math.floor(minX - pad));
              y = Math.max(0, Math.floor(minY - pad));
              w = Math.min(vw - x, Math.floor(boxW + pad * 2));
              h = Math.min(vh - y, Math.floor(boxH + pad * 2));
            } else {
              const size = Math.floor(Math.min(vw, vh) * 0.5);
              x = Math.floor((vw - size) / 2);
              y = Math.floor((vh - size) / 2);
              w = h = size;
            }

            const qrCanvas = document.createElement("canvas");
            qrCanvas.width = w;
            qrCanvas.height = h;
            const qrCtx = qrCanvas.getContext("2d");
            qrCtx.drawImage(v, x, y, w, h, 0, 0, w, h);

            const qrBaseUrl = qrCanvas.toDataURL("image/png");
            setQrBase(qrBaseUrl);

            // ---------- Step 2: Sharpened QR (separate canvas) ----------
            const qrImgData = qrCtx.getImageData(0, 0, w, h);
            const qrSharpData = applyUnsharp(qrImgData, UNSHARP_AMOUNT);
            const qrSharpCanvas = document.createElement("canvas");
            qrSharpCanvas.width = w;
            qrSharpCanvas.height = h;
            qrSharpCanvas.getContext("2d").putImageData(qrSharpData, 0, 0);
            const qrSharpUrl = qrSharpCanvas.toDataURL("image/png");
            setQrSharp(qrSharpUrl);

            // ---------- Step 3: Center 40% from *base* QR ----------
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

            const centerBaseUrl = centerCanvas.toDataURL("image/png");
            setCenterBase(centerBaseUrl);

            // ---------- Step 4: Sharpened center (from base center) ----------
            const cData = centerCtx.getImageData(0, 0, patchSize, patchSize);
            const cSharpData = applyUnsharp(cData, UNSHARP_AMOUNT);
            const centerSharpCanvas = document.createElement("canvas");
            centerSharpCanvas.width = patchSize;
            centerSharpCanvas.height = patchSize;
            centerSharpCanvas
              .getContext("2d")
              .putImageData(cSharpData, 0, 0);
            const centerSharpUrl = centerSharpCanvas.toDataURL("image/png");
            setCenterSharp(centerSharpUrl);

            // Default toggles off so you see raw first
            setUseQrSharpen(false);
            setUseCenterSharpen(false);

            // ---------- Cleanup camera ----------
            if (controls) controls.stop();
            if (currentStream) {
              currentStream.getTracks().forEach((t) => t.stop());
            }
            videoTrackRef.current = null;
            setTorchOn(false);
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
    };
  }, []);

  // 🔦 Torch toggle (Android Chrome where supported)
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

  // Unsharp mask: out = orig + amount * (orig - blur)
  // Gentle, brightness-preserving, safe for comparison.
  function applyUnsharp(imageData, amount = 0.35) {
    const { width, height, data } = imageData;
    const len = data.length;
    const blur = new Uint8ClampedArray(len);
    const w4 = width * 4;

    // 3x3 box blur (very cheap)
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

  const hasCaptured =
    qrBase || qrSharp || centerBase || centerSharp;

  return (
    <div style={{ textAlign: "center", padding: "20px" }}>
      <h2>QR → CDP Extractor (with toggles)</h2>

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

      {hasCaptured && (
        <>
          {/* Toggles appear only after capture */}
          <div
            style={{
              marginTop: "16px",
              display: "flex",
              justifyContent: "center",
              gap: "24px",
              flexWrap: "wrap",
              fontSize: "13px",
            }}
          >
            <label>
              <input
                type="checkbox"
                checked={useQrSharpen}
                onChange={(e) => setUseQrSharpen(e.target.checked)}
              />{" "}
              Show sharpened QR crop
            </label>
            <label>
              <input
                type="checkbox"
                checked={useCenterSharpen}
                onChange={(e) =>
                  setUseCenterSharpen(e.target.checked)
                }
              />{" "}
              Show sharpened center crop
            </label>
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
            {/* QR base */}
            {qrBase && (
              <div>
                <h4>QR crop (raw)</h4>
                <img
                  src={qrBase}
                  alt="QR cropped raw"
                  style={{
                    maxWidth: "180px",
                    borderRadius: "8px",
                    border: "1px solid #ddd",
                  }}
                />
              </div>
            )}

            {/* QR sharpened (toggle) */}
            {qrSharp && useQrSharpen && (
              <div>
                <h4>QR crop (sharpened)</h4>
                <img
                  src={qrSharp}
                  alt="QR cropped sharpened"
                  style={{
                    maxWidth: "180px",
                    borderRadius: "8px",
                    border: "1px solid #ddd",
                  }}
                />
              </div>
            )}

            {/* Center base */}
            {centerBase && (
              <div>
                <h4>Center 40% (raw)</h4>
                <img
                  src={centerBase}
                  alt="Center 40% raw"
                  style={{
                    maxWidth: "180px",
                    borderRadius: "8px",
                    border: "1px solid #ddd",
                  }}
                />
              </div>
            )}

            {/* Center sharpened (toggle) */}
            {centerSharp && useCenterSharpen && (
              <div>
                <h4>Center 40% (sharpened)</h4>
                <img
                  src={centerSharp}
                  alt="Center 40% sharpened"
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
