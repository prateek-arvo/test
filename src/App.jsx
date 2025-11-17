import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

const BOX_FRACTION = 0.5;        // fraction of min(videoWidth, videoHeight) for the square aim box
const CENTER_FRACTION = 0.4;     // center patch from QR crop (CDP region)
const PADDING_RATIO = 0.05;      // small padding around QR bbox

function App() {
  const videoRef = useRef(null);
  const videoTrackRef = useRef(null);
  const streamRef = useRef(null);

  const [result, setResult] = useState("");
  const [qrBase, setQrBase] = useState(null);          // QR crop
  const [centerBase, setCenterBase] = useState(null);  // CDP region

  // these were missing but are referenced in handleCaptureBox
  const [qrProcessed, setQrProcessed] = useState(null);
  const [centerProcessed, setCenterProcessed] = useState(null);

  const [capturing, setCapturing] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);

  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

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

  // Decode a canvas with ZXing
  async function decodeCanvasWithZXing(canvas, reader) {
    const src = canvas.toDataURL("image/png");
    const img = new Image();
    img.src = src;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
    try {
      const res = await reader.decodeFromImageElement(img);
      return res;
    } catch (e) {
      console.error("ZXing decode error:", e);
      return null;
    }
  }

  // --- Capture button: decode, stop camera, crop QR + CDP ---
  const handleCaptureBox = async () => {
    if (!videoRef.current || capturing) return;
    const videoElement = videoRef.current;
    const vw = videoElement.videoWidth;
    const vh = videoElement.videoHeight;

    console.log("Video Width:", vw, "Video Height:", vh); // Debugging line

    if (!vw || !vh) {
      console.warn("Video not ready / no dimensions yet.");
      return;
    }

    setCapturing(true);
    setResult("");
    setQrBase(null);
    setCenterBase(null);
    setQrProcessed(null);
    setCenterProcessed(null);

    try {
      // 1) Draw full frame to canvas
      const frameCanvas = document.createElement("canvas");
      frameCanvas.width = vw;
      frameCanvas.height = vh;
      const frameCtx = frameCanvas.getContext("2d");
      frameCtx.drawImage(videoElement, 0, 0, vw, vh);

      // 2) Square bounding box in video coords
      const boxSize = Math.floor(Math.min(vw, vh) * BOX_FRACTION);
      const boxX = Math.floor((vw - boxSize) / 2);
      const boxY = Math.floor((vh - boxSize) / 2);

      console.log("Box X:", boxX, "Box Y:", boxY, "Box Size:", boxSize); // Debugging line

      // 3) Crop bounding box into ROI canvas
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

      // 4) Decode QR from ROI
      const reader = new BrowserQRCodeReader();
      const qrResult = await decodeCanvasWithZXing(roiCanvas, reader);

      if (!qrResult) {
        throw new Error("No QR detected in the box");
      }

      const text = qrResult.getText ? qrResult.getText() : qrResult.text;
      setResult(text || "");

      // 5) Tight QR bbox in ROI space
      const pts =
        (qrResult.getResultPoints && qrResult.getResultPoints()) ||
        qrResult.resultPoints ||
        [];

      const rw = roiCanvas.width;
      const rh = roiCanvas.height;

      console.log("Result Points:", pts); // Debugging line

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
        const pad = PADDING_RATIO * Math.max(boxW, boxH);

        x = clamp(Math.floor(minX - pad), 0, rw - 1);
        y = clamp(Math.floor(minY - pad), 0, rh - 1);
        w = clamp(Math.floor(boxW + pad * 2), 1, rw - x);
        h = clamp(Math.floor(boxH + pad * 2), 1, rh - y);
      } else {
        // Fallback: center square inside ROI
        const size = Math.floor(Math.min(rw, rh) * 0.5);
        x = Math.floor((rw - size) / 2);
        y = Math.floor((rh - size) / 2);
        w = h = size;
      }

      console.log("QR bbox (x, y, w, h):", x, y, w, h); // Debugging line

      // 6) Tight QR-only crop from ROI
      const qrCanvas = document.createElement("canvas");
      qrCanvas.width = w;
      qrCanvas.height = h;
      const qrCtx = qrCanvas.getContext("2d");
      qrCtx.drawImage(roiCanvas, x, y, w, h, 0, 0, w, h);

      // 7) CDP region = center 40% of QR crop (on original QR canvas)
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

      console.log("CDP crop (px, py, patchSize):", px, py, patchSize); // Debugging line

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

      setQrBase(qrCanvas.toDataURL());
      setCenterBase(cdpCanvas.toDataURL());

      // ✅ Stop camera feed (user now sees only results)
      stopCamera();
    } catch (err) {
      console.error(err);
      alert("Couldn't capture or decode the QR code. Try again.");
    } finally {
      setCapturing(false);
    }
  };

  const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

  return (
    <div className="container">
      <video ref={videoRef} width="100%" autoPlay muted />
      <button onClick={handleCaptureBox} disabled={capturing}>
        {capturing ? "Processing..." : "Capture QR Code"}
      </button>

      {result && <div className="result">QR Code: {result}</div>}

      {qrBase && (
        <div className="cropped-qr">
          <h3>QR Crop:</h3>
          <img src={qrBase} alt="QR Region" />
        </div>
      )}

      {centerBase && (
        <div className="center-patch">
          <h3>Center Patch (CDP):</h3>
          <img src={centerBase} alt="CDP Region" />
        </div>
      )}
    </div>
  );
}

export default App;
