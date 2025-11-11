import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

function App() {
  const videoRef = useRef(null);
  const videoTrackRef = useRef(null);

  const [result, setResult] = useState("");
  const [qrCropped, setQrCropped] = useState(null);
  const [qrCroppedSharp, setQrCroppedSharp] = useState(null);
  const [centerCrop, setCenterCrop] = useState(null);
  const [centerCropSharp, setCenterCropSharp] = useState(null);

  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const CENTER_FRACTION = 0.4; // 40% center crop
  const USE_MILD_SHARPEN = true; // one mild sharpen pass

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

        // Detect torch support
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

            const qrCropUrl = qrCanvas.toDataURL("image/png");
            setQrCropped(qrCropUrl);

            // ---------- Step 2: one mild sharpen (keeps brightness) ----------
            if (USE_MILD_SHARPEN) {
              const imgData = qrCtx.getImageData(0, 0, w, h);
              const sharpData = applyMildSharpen(imgData);
              qrCtx.putImageData(sharpData, 0, 0);
            }

            const qrSharpUrl = qrCanvas.toDataURL("image/png");
            setQrCroppedSharp(qrSharpUrl);

            // ---------- Step 3: center 40% (from sharpened QR) ----------
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

            const centerUrl = centerCanvas.toDataURL("image/png");
            setCenterCrop(centerUrl);

            // ---------- Step 4: optional second mild sharpen ----------
            const cData = centerCtx.getImageData(0, 0, patchSize, patchSize);
            const cSharp = applyMildSharpen(cData);
            centerCtx.putImageData(cSharp, 0, 0);

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

  // 🔦 Torch control
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

  // --- Mild sharpen that keeps brightness consistent ---
  function applyMildSharpen(imageData) {
    const { width, height, data } = imageData;
    const out = new Uint8ClampedArray(data.length);
    const stride = width * 4;

    const k = [0, -1, 0, -1, 4.1, -1, 0, -1, 0]; // mild kernel

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

          val = Math.max(0, Math.min(255, val));
          out[idx + c] = val;
        }
        out[idx + 3] = data[idx + 3];
      }
    }
    return new ImageData(out, width, height);
  }

  return (
    <div style={{ textAlign: "center", padding: "20px" }}>
      <h2>QR → CDP Extractor (Clean + Bright)</h2>

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

      {(qrCropped ||
        qrCroppedSharp ||
        centerCrop ||
        centerCropSharp) && (
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
              <h4>QR crop (raw)</h4>
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
              <h4>QR crop (mild sharpen)</h4>
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
              <h4>Center 40% (from sharpened QR)</h4>
              <img
                src={centerCrop}
                alt="Center 40%"
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
              <h4>Center 40% (mild sharpen)</h4>
              <img
                src={centerCropSharp}
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
      )}
    </div>
  );
}

export default App;
