import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

function App() {
  const videoRef = useRef(null);
  const videoTrackRef = useRef(null);

  const [result, setResult] = useState("");
  const [qrCropped, setQrCropped] = useState(null);              // Step 1: QR cropped
  const [qrCroppedSharp, setQrCroppedSharp] = useState(null);    // Step 2: QR cropped + sharpened
  const [centerCrop, setCenterCrop] = useState(null);            // Step 3: center 36% from sharpened QR
  const [centerCropSharp, setCenterCropSharp] = useState(null);  // Step 4: sharpened center

  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

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

        // store track for torch control
        const [track] = stream.getVideoTracks();
        videoTrackRef.current = track;

        // detect torch support (mostly Chrome Android)
        try {
          const caps = track.getCapabilities?.();
          if (caps && "torch" in caps) {
            setTorchSupported(true);
          }
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

              x = minX;
              y = minY;
              w = maxX - minX;
              h = maxY - minY;

              const pad = 0.15 * Math.max(w, h); // 15% padding
              x = Math.max(0, x - pad);
              y = Math.max(0, y - pad);
              w = Math.min(vw - x, w + pad * 2);
              h = Math.min(vh - y, h + pad * 2);
            } else {
              // Fallback: center box
              const size = Math.min(vw, vh) * 0.5;
              x = (vw - size) / 2;
              y = (vh - size) / 2;
              w = h = size;
            }

            const qrCanvas = document.createElement("canvas");
            const qrCtx = qrCanvas.getContext("2d");
            qrCanvas.width = w;
            qrCanvas.height = h;
            qrCtx.drawImage(v, x, y, w, h, 0, 0, w, h);

            const qrCropUrl = qrCanvas.toDataURL("image/png");
            setQrCropped(qrCropUrl);

            // ---------- Step 2: sharpen the QR crop ----------
            const qrImageData = qrCtx.getImageData(
              0,
              0,
              qrCanvas.width,
              qrCanvas.height
            );
            const qrSharpData = applySharpen(qrImageData);
            qrCtx.putImageData(qrSharpData, 0, 0);

            const qrSharpUrl = qrCanvas.toDataURL("image/png");
            setQrCroppedSharp(qrSharpUrl);

            // ---------- Step 3: center 36% from sharpened QR ----------
            const baseSize = Math.min(qrCanvas.width, qrCanvas.height);
            const size36 = 0.36 * baseSize;

            const cx = qrCanvas.width / 2;
            const cy = qrCanvas.height / 2;

            let cx36 = cx - size36 / 2;
            let cy36 = cy - size36 / 2;

            if (cx36 < 0) cx36 = 0;
            if (cy36 < 0) cy36 = 0;
            if (cx36 + size36 > qrCanvas.width)
              cx36 = qrCanvas.width - size36;
            if (cy36 + size36 > qrCanvas.height)
              cy36 = qrCanvas.height - size36;

            const centerCanvas = document.createElement("canvas");
            const centerCtx = centerCanvas.getContext("2d");
            centerCanvas.width = size36;
            centerCanvas.height = size36;

            centerCtx.drawImage(
              qrCanvas,
              cx36,
              cy36,
              size36,
              size36,
              0,
              0,
              size36,
              size36
            );

            const centerUrl = centerCanvas.toDataURL("image/png");
            setCenterCrop(centerUrl);

            // ---------- Step 4: sharpen that center crop ----------
            const centerData = centerCtx.getImageData(
              0,
              0,
              size36,
              size36
            );
            const centerSharpData = applySharpen(centerData);
            centerCtx.putImageData(centerSharpData, 0, 0);

            const centerSharpUrl = centerCanvas.toDataURL("image/png");
            setCenterCropSharp(centerSharpUrl);

            // ---------- Cleanup ----------
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

  // Toggle flash/torch if supported
  const handleToggleTorch = async () => {
    const track = videoTrackRef.current;
    if (!track || !track.getCapabilities || !track.applyConstraints) return;

    try {
      const caps = track.getCapabilities();
      if (!caps || !caps.torch) return;

      const newValue = !torchOn;
      await track.applyConstraints({
        advanced: [{ torch: newValue }],
      });
      setTorchOn(newValue);
    } catch (err) {
      console.warn("Torch toggle failed or unsupported:", err);
    }
  };

  // 3x3 sharpen kernel
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
            data[idx - stride - 4 + c] * k[0] +
            data[idx - stride + c] * k[1] +
            data[idx - stride + 4 + c] * k[2] +
            data[idx - 4 + c] * k[3] +
            data[idx + c] * k[4] +
            data[idx + 4 + c] * k[5] +
            data[idx + stride - 4 + c] * k[6] +
            data[idx + stride + c] * k[7] +
            data[idx + stride + 4 + c] * k[8];

          out[idx + c] = Math.max(0, Math.min(255, sum));
        }
        out[idx + 3] = data[idx + 3]; // alpha
      }
    }

    // Copy untouched borders (simple handling)
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
      <h2>QR Test App</h2>

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

      {(qrCropped || qrCroppedSharp || centerCrop || centerCropSharp) && (
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
              <h4>QR crop</h4>
              <img
                src={qrCropped}
                alt="QR cropped"
                style={{
                  maxWidth: "180px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
            </div>
          )}

          {qrCroppedSharp && (
            <div>
              <h4>QR crop (sharpened)</h4>
              <img
                src={qrCroppedSharp}
                alt="QR cropped sharpened"
                style={{
                  maxWidth: "180px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
            </div>
          )}

          {centerCrop && (
            <div>
              <h4>Center 36% (from sharpened QR)</h4>
              <img
                src={centerCrop}
                alt="Center 36%"
                style={{
                  maxWidth: "180px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
            </div>
          )}

          {centerCropSharp && (
            <div>
              <h4>Center 36% (sharpened)</h4>
              <img
                src={centerCropSharp}
                alt="Center 36% sharpened"
                style={{
                  maxWidth: "180px",
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
