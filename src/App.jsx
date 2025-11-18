import React, { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

const API_URL = "https://9ahp0tc529.execute-api.ap-south-1.amazonaws.com/dev";

const IDS = [
  "79604928-2f65-4c8m",
  "79604928-2f65-4c8o",
  "79604928-2f65-4c8j",
  "79604928-2f65-4c8w",
  "79604928-2f65-4c8q",
  "79604928-2f65-4c8d",
];

// same as before
const BOX_FRACTION = 0.5; // fraction of min(videoWidth, videoHeight) for the square aim box
const CENTER_FRACTION = 0.36; // center patch from QR crop (36%)
const PADDING_RATIO = 0.05; // small padding around QR bbox

function getRandomId() {
  const idx = Math.floor(Math.random() * IDS.length);
  return IDS[idx];
}

const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

function App() {
  const videoRef = useRef(null);
  const videoTrackRef = useRef(null);
  const streamRef = useRef(null);

  const [capturing, setCapturing] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const [qrBase, setQrBase] = useState(null);       // QR crop image
  const [centerBase, setCenterBase] = useState(null); // 36% center crop
  const [qrText, setQrText] = useState("");         // jsQR decoded text (optional display)
  const [apiResult, setApiResult] = useState(null); // API response

  // --- Start camera on mount ---
  useEffect(() => {
    let currentStream = null;

    const startCamera = async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          alert("Camera not supported in this browser.");
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 2560 },
            height: { ideal: 1440 },
          },
        });

        currentStream = stream;
        streamRef.current = stream;
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
        setCameraReady(true);
      } catch (e) {
        console.error("Camera error:", e);
      }
    };

    startCamera();

    return () => {
      if (currentStream) {
        currentStream.getTracks().forEach((t) => t.stop());
      }
      streamRef.current = null;
      videoTrackRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setTorchOn(false);
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

  // Stop camera feed
  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
    }
    streamRef.current = null;
    videoTrackRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setTorchOn(false);
    setTorchSupported(false);
    setCameraReady(false);
  };

  // --- Capture, do ZXing-style QR crop, 36% center crop, send QR crop to API ---
  const handleCapture = async () => {
    if (!videoRef.current || capturing) return;
    const videoElement = videoRef.current;
    const vw = videoElement.videoWidth;
    const vh = videoElement.videoHeight;

    if (!vw || !vh) {
      console.warn("Video not ready / no dimensions yet.");
      return;
    }

    setCapturing(true);
    setApiResult(null);
    setQrBase(null);
    setCenterBase(null);
    setQrText("");

    try {
      // 1) Full high-res frame to canvas
      const frameCanvas = document.createElement("canvas");
      frameCanvas.width = vw;
      frameCanvas.height = vh;
      const frameCtx = frameCanvas.getContext("2d");
      frameCtx.drawImage(videoElement, 0, 0, vw, vh);

      // 2) Square ROI in center
      const boxSize = Math.floor(Math.min(vw, vh) * BOX_FRACTION);
      const boxX = Math.floor((vw - boxSize) / 2);
      const boxY = Math.floor((vh - boxSize) / 2);

      const roiCanvas = document.createElement("canvas");
      roiCanvas.width = boxSize;
      roiCanvas.height = boxSize;
      const roiCtx = roiCanvas.getContext("2d");
      roiCtx.drawImage(
        frameCanvas,
        boxX,
        boxY,
        boxSize,
        boxSize,
        0,
        0,
        boxSize,
        boxSize
      );

      const rw = roiCanvas.width;
      const rh = roiCanvas.height;

      // 3) Try jsQR on ROI first, then fallback to full frame
      let qrResult = null;
      let decodeSpace = "roi"; // "roi" or "full"

      try {
        const roiImageData = roiCtx.getImageData(0, 0, rw, rh);
        qrResult = jsQR(roiImageData.data, rw, rh, {
          inversionAttempts: "attemptBoth",
        });
        console.log("jsQR ROI result:", qrResult);
      } catch (e) {
        console.error("jsQR ROI decode error:", e);
      }

      if (!qrResult) {
        try {
          const fullImageData = frameCtx.getImageData(0, 0, vw, vh);
          qrResult = jsQR(fullImageData.data, vw, vh, {
            inversionAttempts: "attemptBoth",
          });
          decodeSpace = "full";
          console.log("jsQR FULL result:", qrResult);
        } catch (e) {
          console.error("jsQR FULL decode error:", e);
        }
      }

      if (!qrResult) {
        throw new Error("No QR detected in the ROI or full frame");
      }

      // Store decoded text (optional)
      setQrText(qrResult.data || "");

      const loc = qrResult.location;
      const corners = [
        loc.topLeftCorner,
        loc.topRightCorner,
        loc.bottomRightCorner,
        loc.bottomLeftCorner,
      ];

      let x, y, w, h;
      let sourceCanvas;
      let sourceWidth;
      let sourceHeight;

      if (decodeSpace === "roi") {
        sourceCanvas = roiCanvas;
        sourceWidth = rw;
        sourceHeight = rh;
      } else {
        sourceCanvas = frameCanvas;
        sourceWidth = vw;
        sourceHeight = vh;
      }

      if (corners && corners.length >= 3) {
        const xs = corners.map((p) => p.x);
        const ys = corners.map((p) => p.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const boxW = maxX - minX;
        const boxH = maxY - minY;
        const pad = PADDING_RATIO * Math.max(boxW, boxH);

        x = clamp(Math.floor(minX - pad), 0, sourceWidth - 1);
        y = clamp(Math.floor(minY - pad), 0, sourceHeight - 1);
        w = clamp(Math.floor(boxW + pad * 2), 1, sourceWidth - x);
        h = clamp(Math.floor(boxH + pad * 2), 1, sourceHeight - y);
      } else {
        // Fallback: center square inside decode space
        const size = Math.floor(Math.min(sourceWidth, sourceHeight) * 0.5);
        x = Math.floor((sourceWidth - size) / 2);
        y = Math.floor((sourceHeight - size) / 2);
        w = h = size;
      }

      // 4) Tight QR-only crop (ZXing-style QR crop)
      const qrCanvas = document.createElement("canvas");
      qrCanvas.width = w;
      qrCanvas.height = h;
      const qrCtx = qrCanvas.getContext("2d");
      qrCtx.drawImage(sourceCanvas, x, y, w, h, 0, 0, w, h);

      // 5) 36% center crop from QR
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

      const cdpCanvas = document.createElement("canvas");
      cdpCanvas.width = patchSize;
      cdpCanvas.height = patchSize;
      const cdpCtx = cdpCanvas.getContext("2d");
      cdpCtx.drawImage(
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

      // 6) For display on page
      const qrDataUrl = qrCanvas.toDataURL("image/jpeg", 1.0);
      const centerDataUrl = cdpCanvas.toDataURL("image/jpeg", 1.0);
      setQrBase(qrDataUrl);
      setCenterBase(centerDataUrl);

      // 7) Convert QR crop to base64 (no prefix) and call API
      const base64 = qrDataUrl.split(",")[1]; // remove "data:image/jpeg;base64,"
      const payload = {
        id: getRandomId(),
        image_base64: base64,
      };

      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      let resultData;
      try {
        resultData = await res.json();
      } catch (e) {
        const text = await res.text();
        resultData = { raw: text };
      }
      setApiResult(resultData);

      // Optional: stop camera after capture
      stopCamera();
    } catch (err) {
      console.error(err);
      alert("Couldn't capture or decode the QR code. Try again.");
    } finally {
      setCapturing(false);
    }
  };

  return (
    <div className="container">
      <div style={{ position: "relative" }}>
        <video ref={videoRef} width="100%" autoPlay muted />
      </div>

      <div style={{ marginTop: "1rem" }}>
        <button onClick={handleCapture} disabled={capturing || !cameraReady}>
          {capturing ? "Processing..." : "Capture, Crop & Send"}
        </button>

        {torchSupported && cameraReady && (
          <button
            onClick={handleToggleTorch}
            style={{ marginLeft: "0.5rem" }}
          >
            {torchOn ? "Torch Off" : "Torch On"}
          </button>
        )}
      </div>

      {qrText && (
        <div style={{ marginTop: "1rem" }}>
          <strong>Decoded QR (jsQR):</strong> {qrText}
        </div>
      )}

      {qrBase && (
        <div style={{ marginTop: "1rem" }}>
          <h3>QR Crop (for ZXing):</h3>
          <img
            src={qrBase}
            alt="QR Crop"
            style={{ maxWidth: "100%", imageRendering: "crisp-edges" }}
          />
        </div>
      )}

      {centerBase && (
        <div style={{ marginTop: "1rem" }}>
          <h3>36% Center Crop:</h3>
          <img
            src={centerBase}
            alt="Center Crop"
            style={{ maxWidth: "100%", imageRendering: "crisp-edges" }}
          />
        </div>
      )}

      {apiResult && (
        <div style={{ marginTop: "1rem" }}>
          <h3>API Result:</h3>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {JSON.stringify(apiResult, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export default App;
