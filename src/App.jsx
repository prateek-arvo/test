import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

function App() {
  const videoRef = useRef(null);

  const [result, setResult] = useState("");
  const [qrCropped, setQrCropped] = useState(null);      // QR crop (after optional sharpen)
  const [centerCrop, setCenterCrop] = useState(null);    // Center patch from QR (no extra sharpen)

  // Toggle this to compare behavior
  const USE_MILD_SHARPEN = true;
  const CENTER_FRACTION = 0.5; // 50% center patch (safer than 36%)

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

            // ---------- Step 1: crop QR (bbox + padding) ----------
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
              const pad = 0.15 * Math.max(boxW, boxH); // 15% padding

              x = Math.max(0, Math.floor(minX - pad));
              y = Math.max(0, Math.floor(minY - pad));
              w = Math.min(vw - x, Math.floor(boxW + pad * 2));
              h = Math.min(vh - y, Math.floor(boxH + pad * 2));
            } else {
              // Fallback: center box, still integer + safe
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

            // ---------- Step 2: [optional] mild sharpen on full QR once ----------
            if (USE_MILD_SHARPEN) {
              const qrImageData = qrCtx.getImageData(0, 0, w, h);
              const qrSharpData = applyMildSharpen(qrImageData);
              qrCtx.putImageData(qrSharpData, 0, 0);
            }

            setQrCropped(qrCanvas.toDataURL("image/png"));

            // ---------- Step 3: center patch from (possibly sharpened) QR ----------
            const baseSize = Math.min(qrCanvas.width, qrCanvas.height);
            const patchSize = Math.floor(baseSize * CENTER_FRACTION);

            const cx = Math.floor(qrCanvas.width / 2);
            const cy = Math.floor(qrCanvas.height / 2);

            let px = cx - Math.floor(patchSize / 2);
            let py = cy - Math.floor(patchSize / 2);

            if (px < 0) px = 0;
            if (py < 0) py = 0;
            if (px + patchSize > qrCanvas.width)
              px = qrCanvas.width - patchSize;
            if (py + patchSize > qrCanvas.height)
              py = qrCanvas.height - patchSize;

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

            // No extra sharpen here: keep CDP structure intact
            setCenterCrop(centerCanvas.toDataURL("image/png"));

            // ---------- Cleanup ----------
            if (controls) controls.stop();
            if (currentStream) {
              currentStream.getTracks().forEach((t) => t.stop());
            }
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
    };
  }, []);

  // Mild sharpen (less aggressive than classic 0 -1 0 / -1 5 -1 / 0 -1 0)
  // Center weight tuned to 4.2 instead of 5 to reduce haloing.
  function applyMildSharpen(imageData) {
    const { width, height, data } = imageData;
    const out = new Uint8ClampedArray(data.length);
    const stride = width * 4;

    const k = [0, -1, 0, -1, 4.2, -1, 0, -1, 0];

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width + x) * 4;

        for (let c = 0; c < 3; c++) {
          const tl = data[idx - stride - 4 + c];
          const t = data[idx - stride + c];
          const tr = data[idx - stride + 4 + c];
          const l = data[idx - 4 + c];
          const m = data[idx + c];
          const r = data[idx + 4 + c];
          const bl = data[idx + stride - 4 + c];
          const b = data[idx + stride + c];
          const br = data[idx + stride + 4 + c];

          let val =
            k[0] * tl +
            k[1] * t +
            k[2] * tr +
            k[3] * l +
            k[4] * m +
            k[5] * r +
            k[6] * bl +
            k[7] * b +
            k[8] * br;

          if (val < 0) val = 0;
          if (val > 255) val = 255;
          out[idx + c] = val;
        }

        out[idx + 3] = data[idx + 3]; // alpha
      }
    }

    // Copy borders unchanged
    for (let i = 0; i < data.length; i += 4) {
      if (out[i + 3] === 0) {
        out[i] = data[i];
        out[i + 1] = data[i + 1];
        out[i + 2] = data[i + 2];
        out[i + 3] = data[i + 3];
      }
    }

    return new ImageData(out, width, height);
  }

  return (
    <div style={{ textAlign: "center", padding: "20px" }}>
      <h2>QR CDP Extractor</h2>

      <video
        ref={videoRef}
        style={{
          width: "100%",
          maxWidth: "500px",
          border: "1px solid #ccc",
          borderRadius: "8px",
        }}
      />

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

      {(qrCropped || centerCrop) && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: "18px",
            flexWrap: "wrap",
            marginTop: "20px",
          }}
        >
          {qrCropped && (
            <div>
              <h4>QR crop {USE_MILD_SHARPEN ? "(mild sharpen)" : ""}</h4>
              <img
                src={qrCropped}
                alt="QR cropped"
                style={{
                  maxWidth: "200px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
            </div>
          )}

          {centerCrop && (
            <div>
              <h4>Center {CENTER_FRACTION * 100}% (no extra sharpen)</h4>
              <img
                src={centerCrop}
                alt="Center patch"
                style={{
                  maxWidth: "200px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
              <p
                style={{
                  fontSize: "11px",
                  color: "#666",
                  marginTop: "4px",
                }}
              >
                Use this patch as Siamese CNN input.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
