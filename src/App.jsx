import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

function App() {
  const videoRef = useRef(null);
  const [result, setResult] = useState("");
  const [snapshot, setSnapshot] = useState(null);

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

        // Start continuous decoding from this video element
        controls = await codeReader.decodeFromVideoDevice(
          undefined,
          videoRef.current,
          (res, err) => {
            console.log(res)
            if (locked) return;
            if (res) {
              locked = true;
              setResult(res.getText());

              // Try to crop around QR using detected points
              const pts = res.getResultPoints?.() || res.resultPoints || [];

              if (pts.length >= 3 && videoRef.current) {
                const v = videoRef.current;
                const canvas = document.createElement("canvas");
                const ctx = canvas.getContext("2d");
                canvas.width = v.videoWidth;
                canvas.height = v.videoHeight;
                ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

                const xs = pts.map((p) => (p.getX ? p.getX() : p.x));
                const ys = pts.map((p) => (p.getY ? p.getY() : p.y));

                let x = Math.min(...xs);
                let y = Math.min(...ys);
                let w = Math.max(...xs) - x;
                let h = Math.max(...ys) - y;

                const padding = 0.25 * Math.max(w, h);
                x = Math.max(0, x - padding);
                y = Math.max(0, y - padding);
                w = Math.min(canvas.width - x, w + padding * 2);
                h = Math.min(canvas.height - y, h + padding * 2);

                const crop = document.createElement("canvas");
                const cropCtx = crop.getContext("2d");
                crop.width = w;
                crop.height = h;
                cropCtx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
                setSnapshot(crop.toDataURL("image/png"));
              }

              // Stop scanning & camera
              if (controls) controls.stop();
              if (currentStream)
                currentStream.getTracks().forEach((t) => t.stop());
            }
          }
        );
      } catch (e) {
        console.error("Camera or decoding error:", e);
      }
    };

    startCameraAndScan();

    // Cleanup on unmount
    return () => {
      if (controls) controls.stop();
      if (currentStream)
        currentStream.getTracks().forEach((t) => t.stop());
    };
  }, []);

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
      {snapshot && (
        <div style={{ marginTop: "16px" }}>
          <h3>Cropped QR</h3>
          <img
            src={snapshot}
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
  );
}

export default App;
