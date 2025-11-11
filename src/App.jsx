import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

function App() {
  const videoRef = useRef(null);
  const [result, setResult] = useState("");
  const [qrCropped, setQrCropped] = useState(null);       // step 2 output: QR-only sharpened
  const [qrCropped36, setQrCropped36] = useState(null);   // step 3 output: 36% center crop of above

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
            width: { ideal: 1920 },
            height: { ideal: 1080 },
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

            // --- Step 1: crop to the QR only (using bounding box of resultPoints) ---

            const pts =
              (res.getResultPoints && res.getResultPoints()) ||
              res.resultPoints ||
              [];

            if (!pts || pts.length < 3) {
              console.warn("Not enough points to reliably crop QR.");
            }

            // If we have points, compute bounding box, else fallback to center-ish box
            let x, y, w, h;
            if (pts && pts.length >= 3) {
              const xs = pts.map((p) => (p.getX ? p.getX() : p.x));
              const ys = pts.map((p) => (p.getY ? p.getY() : p.y));

              const minX = Math.min(...xs);
              const maxX = Math.max(...xs);
              const minY = Math.min(...ys);
              const maxY = Math.max(...ys);

              x = minX;
              y = minY;
              w = maxX - minX;
              h = maxY - minY;

              // add padding so we fully include QR modules
              const pad = 0.15 * Math.max(w, h); // 15% padding
              x = Math.max(0, x - pad);
              y = Math.max(0, y - pad);
              w = Math.min(vw - x, w + pad * 2);
              h = Math.min(vh - y, h + pad * 2);
            } else {
              // fallback: center square
              const size = Math.min(vw, vh) * 0.5;
              x = (vw - size) / 2;
              y = (vh - size) / 2;
              w = h = size;
            }

            // Draw QR-only crop
            const qrCanvas = document.createElement("canvas");
            const qrCtx = qrCanvas.getContext("2d");
            qrCanvas.width = w;
            qrCanvas.height = h;

            qrCtx.drawImage(v, x, y, w, h, 0, 0, w, h);

            // --- Step 2: sharpen the QR-only crop ---

            const qrImageData = qrCtx.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
            const sharpenedData = applySharpen(qrImageData);
            qrCtx.putImageData(sharpenedData, 0, 0);

            const qrSharpenedDataUrl = qrCanvas.toDataURL("image/png");
            setQrCropped(qrSharpenedDataUrl);

            // --- Step 3: 36% center crop from the sharpened QR crop ---

            const baseSize = Math.min(qrCanvas.width, qrCanvas.height);
            const cropSize36 = 0.36 * baseSize;

            const cx = qrCanvas.width / 2;
            const cy = qrCanvas.height / 2;

            let x36 = cx - cropSize36 / 2;
            let y36 = cy - cropSize36 / 2;

            if (x36 < 0) x36 = 0;
            if (y36 < 0) y36 = 0;
            if (x36 + cropSize36 > qrCanvas.width)
              x36 = qrCanvas.width - cropSize36;
            if (y36 + cropSize36 > qrCanvas.height)
              y36 = qrCanvas.height - cropSize36;

            const innerCanvas = document.createElement("canvas");
            const innerCtx = innerCanvas.getContext("2d");
            innerCanvas.width = cropSize36;
            innerCanvas.height = cropSize36;

            innerCtx.drawImage(
              qrCanvas,
              x36,
              y36,
              cropSize36,
              cropSize36,
              0,
              0,
              cropSize36,
              cropSize36
            );

            const qr36DataUrl = innerCanvas.toDataURL("image/png");
            setQrCropped36(qr36DataUrl);

            // --- Cleanup: stop scanning & camera ---

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

  // Simple sharpen with 3x3 kernel [0 -1 0; -1 5 -1; 0 -1 0]
  function applySharpen(imageData) {
    const { width, height, data } = imageData;
    const out = new Uint8ClampedArray(data.length);
    const stride = width * 4;
    const k = [0, -1, 0, -1, 5, -1, 0, -1, 0];

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width + x) * 4;

        for (let c = 0; c < 3; c++) {
          let sum =
            data[idx - stride - 4 + c] * k[0] + // tl
            data[idx - stride + c] * k[1] + // t
            data[idx - stride + 4 + c] * k[2] + // tr
            data[idx - 4 + c] * k[3] + // l
            data[idx + c] * k[4] + // center
            data[idx + 4 + c] * k[5] + // r
            data[idx + stride - 4 + c] * k[6] + // bl
            data[idx + stride + c] * k[7] + // b
            data[idx + stride + 4 + c] * k[8]; // br

          if (sum < 0) sum = 0;
          if (sum > 255) sum = 255;
          out[idx + c] = sum;
        }

        // alpha
        out[idx + 3] = data[idx + 3];
      }
    }

    // Copy border pixels unchanged
    for (let x = 0; x < width; x++) {
      for (const y of [0, height - 1]) {
        const idx = (y * width + x) * 4;
        out[idx] = data[idx];
        out[idx + 1] = data[idx + 1];
        out[idx + 2] = data[idx + 2];
        out[idx + 3] = data[idx + 3];
      }
    }
    for (let y = 0; y < height; y++) {
      for (const x of [0, width - 1]) {
        const idx = (y * width + x) * 4;
        out[idx] = data[idx];
        out[idx + 1] = data[idx + 1];
        out[idx + 2] = data[idx + 2];
        out[idx + 3] = data[idx + 3];
      }
    }

    return new ImageData(out, width, height);
  }

  return (
    <div style={{ textAlign: "center", padding: "20px" }}>
      <h2>QR Test App</h2>

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

      {(qrCropped || qrCropped36) && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: "20px",
            flexWrap: "wrap",
            marginTop: "20px",
          }}
        >
          {qrCropped && (
            <div>
              <h4>QR-only (sharpened)</h4>
              <img
                src={qrCropped}
                alt="QR cropped sharpened"
                style={{
                  maxWidth: "260px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
            </div>
          )}

          {qrCropped36 && (
            <div>
              <h4>Center 36% of QR</h4>
              <img
                src={qrCropped36}
                alt="Center 36% of QR"
                style={{
                  maxWidth: "260px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
