import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

function App() {
  const videoRef = useRef(null);
  const [result, setResult] = useState("");
  const [snapshotFull, setSnapshotFull] = useState(null);
  const [snapshotCropped, setSnapshotCropped] = useState(null);

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

            // Capture full frame
            const fullCanvas = document.createElement("canvas");
            const fullCtx = fullCanvas.getContext("2d");
            fullCanvas.width = vw;
            fullCanvas.height = vh;
            fullCtx.drawImage(v, 0, 0, vw, vh);
            const fullDataUrl = fullCanvas.toDataURL("image/png");
            setSnapshotFull(fullDataUrl);

            // Determine QR center for crop
            const pts =
              (res.getResultPoints && res.getResultPoints()) ||
              res.resultPoints ||
              [];
            let cx = vw / 2;
            let cy = vh / 2;

            if (pts.length >= 1) {
              const xs = pts.map((p) => (p.getX ? p.getX() : p.x));
              const ys = pts.map((p) => (p.getY ? p.getY() : p.y));
              cx = (Math.min(...xs) + Math.max(...xs)) / 2;
              cy = (Math.min(...ys) + Math.max(...ys)) / 2;
            }

            // 36% square centered on QR
            const cropSize = 0.36 * Math.min(vw, vh);
            let x = cx - cropSize / 2;
            let y = cy - cropSize / 2;
            if (x < 0) x = 0;
            if (y < 0) y = 0;
            if (x + cropSize > vw) x = vw - cropSize;
            if (y + cropSize > vh) y = vh - cropSize;

            const cropCanvas = document.createElement("canvas");
            const cropCtx = cropCanvas.getContext("2d");
            cropCanvas.width = cropSize;
            cropCanvas.height = cropSize;

            cropCtx.drawImage(
              v,
              x,
              y,
              cropSize,
              cropSize,
              0,
              0,
              cropSize,
              cropSize
            );

            // Apply sharpen
            const imgData = cropCtx.getImageData(0, 0, cropSize, cropSize);
            const sharpened = applySharpen(imgData);
            cropCtx.putImageData(sharpened, 0, 0);
            const cropDataUrl = cropCanvas.toDataURL("image/png");

            setSnapshotCropped(cropDataUrl);

            // Stop camera
            if (controls) controls.stop();
            if (currentStream) {
              currentStream.getTracks().forEach((t) => t.stop());
            }
          }
        );
      } catch (err) {
        console.error("Camera or decoding error:", err);
      }
    };

    startCameraAndScan();

    return () => {
      if (controls) controls.stop();
      if (currentStream) currentStream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Simple 3x3 sharpen filter
  function applySharpen(imageData) {
    const { width, height, data } = imageData;
    const out = new Uint8ClampedArray(data.length);
    const w = width * 4;
    const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        for (let c = 0; c < 3; c++) {
          let i = (y * width + x) * 4 + c;
          let sum =
            data[i - w - 4] * kernel[0] +
            data[i - w] * kernel[1] +
            data[i - w + 4] * kernel[2] +
            data[i - 4] * kernel[3] +
            data[i] * kernel[4] +
            data[i + 4] * kernel[5] +
            data[i + w - 4] * kernel[6] +
            data[i + w] * kernel[7] +
            data[i + w + 4] * kernel[8];

          out[i] = Math.min(255, Math.max(0, sum));
        }
        out[(y * width + x) * 4 + 3] = data[(y * width + x) * 4 + 3];
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

      {(snapshotFull || snapshotCropped) && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: "20px",
            flexWrap: "wrap",
            marginTop: "20px",
          }}
        >
          {snapshotFull && (
            <div>
              <h4>Original Frame</h4>
              <img
                src={snapshotFull}
                alt="Full Frame"
                style={{
                  maxWidth: "260px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
            </div>
          )}

          {snapshotCropped && (
            <div>
              <h4>Cropped & Sharpened (36%)</h4>
              <img
                src={snapshotCropped}
                alt="Cropped QR"
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
