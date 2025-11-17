import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

const BOX_FRACTION = 0.5;
const CENTER_FRACTION = 0.4;
const PADDING_RATIO = 0.05;
const UPSCALE_FACTOR = 2;

function App() {
  const videoRef = useRef(null);
  const videoTrackRef = useRef(null);
  const streamRef = useRef(null);
  const [result, setResult] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // --- Start camera on mount ---
  useEffect(() => {
    const startCamera = async () => {
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const isAndroid = /Android/.test(navigator.userAgent);
      let currentStream = null;

      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          alert("Camera not supported in this browser.");
          return;
        }

        const videoConstraints = isIOS
          ? {
              facingMode: "environment",
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : {
              facingMode: "environment",
              width: { ideal: 2560 },
              height: { ideal: 1440 },
            };

        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
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
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      streamRef.current = null;
      videoTrackRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setTorchOn(false);
    };
  }, []);

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

  // Capture button: decode, stop camera, crop QR + CDP
  const handleCaptureBox = async () => {
    if (!videoRef.current || capturing) return;
    const v = videoRef.current;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return;

    setCapturing(true);
    setResult("");

    try {
      const frameCanvas = document.createElement("canvas");
      frameCanvas.width = vw;
      frameCanvas.height = vh;
      const frameCtx = frameCanvas.getContext("2d");
      frameCtx.drawImage(v, 0, 0, vw, vh);

      const boxSize = Math.floor(Math.min(vw, vh) * BOX_FRACTION);
      const boxX = Math.floor((vw - boxSize) / 2);
      const boxY = Math.floor((vh - boxSize) / 2);

      const roiCanvas = document.createElement("canvas");
      roiCanvas.width = boxSize;
      roiCanvas.height = boxSize;
      const roiCtx = roiCanvas.getContext("2d");
      roiCtx.drawImage(frameCanvas, boxX, boxY, boxSize, boxSize, 0, 0, boxSize, boxSize);

      const reader = new BrowserQRCodeReader();
      const qrResult = await decodeCanvasWithZXing(roiCanvas, reader);
      if (!qrResult) throw new Error("No QR detected in the box");

      const text = qrResult.getText ? qrResult.getText() : qrResult.text;
      setResult(text || "");

      stopCamera();
    } catch (err) {
      console.error(err);
      alert("Couldn’t decode a QR. Try again closer / steadier.");
    } finally {
      setCapturing(false);
    }
  };

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
  };

  return (
    <div style={{ textAlign: "center", padding: "20px" }}>
      <h2>QR → CDP Extractor</h2>
      <button
        onClick={handleCaptureBox}
        disabled={capturing || !cameraReady}
        style={{
          padding: "10px 16px",
          borderRadius: 8,
          border: "1px solid #ccc",
          cursor: capturing || !cameraReady ? "default" : "pointer",
          marginBottom: 12,
          opacity: capturing || !cameraReady ? 0.7 : 1,
        }}
      >
        {!cameraReady ? "Waiting for camera…" : capturing ? "Capturing…" : "Capture Box"}
      </button>

      <div style={{ position: "relative", display: "inline-block" }}>
        <video
          ref={videoRef}
          style={{
            width: "100%",
            maxWidth: "500px",
            border: "1px solid #ccc",
            borderRadius: "8px",
            background: "#000",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            aspectRatio: "1 / 1",
            width: `${BOX_FRACTION * 100}%`,
            border: "2px solid #00ff99",
            borderRadius: "8px",
            boxSizing: "border-box",
            pointerEvents: "none",
          }}
        />
        {torchSupported && (
          <button
            onClick={handleToggleTorch}
            style={{
              position: "absolute",
              top: "20px",
              right: "20px",
              backgroundColor: torchOn ? "#ff6f61" : "#00c853",
              color: "#fff",
              border: "none",
              padding: "10px 15px",
              borderRadius: "50%",
              fontSize: "16px",
            }}
          >
            🔦
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
    </div>
  );
}

export default App;
