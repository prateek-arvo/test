import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

function App() {
  const videoRef = useRef(null);
  const videoTrackRef = useRef(null);

  const [result, setResult] = useState("");

  const [qrBase, setQrBase] = useState(null);
  const [centerBase, setCenterBase] = useState(null);

  const [qrSharp, setQrSharp] = useState(null);
  const [centerSharp, setCenterSharp] = useState(null);

  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const [sharpAmount, setSharpAmount] = useState(0.35); // default intensity

  const CENTER_FRACTION = 0.4; // center crop size

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
            const qrCtx = qrCanvas.getContext("2d");
            qrCanvas.width = w;
            qrCanvas.height = h;
            qrCtx.drawImage(v, x, y, w, h, 0, 0, w, h);
            const qrUrl = qrCanvas.toDataURL("image/png");
            setQrBase(qrUrl);

            // Center crop
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
            const centerCtx = centerCanvas.getContext("2d");
            centerCanvas.width = patchSize;
            centerCanvas.height = patchSize;
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

            // Initialize sharpened previews
            setQrSharp(applySharpenToURL(qrUrl, sharpAmount));
            setCenterSharp(applySharpenToURL(centerUrl, sharpAmount));

            if (controls) controls.stop();
            if (currentStream) currentStream.getTracks().forEach((t) => t.stop());
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

  // 🔦 Torch toggle
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

  // --------- Sharpen helpers ---------
  const applySharpenToURL = (url, amount) => {
    const img = new Image();
    img.src = url;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    return new Promise((resolve) => {
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, img.width, img.height);
        const sharpened = applyUnsharp(data, amount);
        ctx.putImageData(sharpened, 0, 0);
        resolve(canvas.toDataURL("image/png"));
      };
    });
  };

  useEffect(() => {
    if (!qrBase || !centerBase) return;
    (async () => {
      const q = await applySharpenToURL(qrBase, sharpAmount);
      const c = await applySharpenToURL(centerBase, sharpAmount);
      setQrSharp(q);
      setCenterSharp(c);
    })();
  }, [sharpAmount, qrBase, centerBase]);

  function applyUnsharp(imageData, amount = 0.35) {
    const { width, height, data } = imageData;
    const len = data.length;
    const blur = new Uint8ClampedArray(len);
    const w4 = width * 4;
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
        val = Math.max(0, Math.min(255, val));
        out[i + c] = val;
      }
      out[i + 3] = data[i + 3];
    }
    return new ImageData(out, width, height);
  }

  const captured = qrBase && centerBase;

  return (
    <div style={{ textAlign: "center", padding: "20px" }}>
      <h2>QR → CDP Extractor (Adjustable Sharpness)</h2>

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

      {captured && (
        <>
          <div style={{ marginTop: "20px" }}>
            <label>
              <b>Sharpness: </b>{sharpAmount.toFixed(2)}
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={sharpAmount}
              onChange={(e) => setSharpAmount(parseFloat(e.target.value))}
              style={{ width: "250px", marginLeft: "10px" }}
            />
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
              <h4>QR crop (raw)</h4>
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

            <div>
              <h4>QR crop (adjusted)</h4>
              <img
                src={qrSharp}
                alt="QR sharpened"
                style={{
                  maxWidth: "180px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
            </div>

            <div>
              <h4>Center 40% (raw)</h4>
              <img
                src={centerBase}
                alt="center raw"
                style={{
                  maxWidth: "180px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
            </div>

            <div>
              <h4>Center 40% (adjusted)</h4>
              <img
                src={centerSharp}
                alt="center sharpened"
                style={{
                  maxWidth: "180px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default App;
