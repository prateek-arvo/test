import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

// Constants for image processing
const BOX_FRACTION = 0.5;        // fraction of min(videoWidth, videoHeight) for the square aim box
const CENTER_FRACTION = 0.4;     // center patch from QR crop (CDP region)
const PADDING_RATIO = 0.05;      // padding around QR
const UPSCALE_FACTOR = 2;        // simple interpolation upscale factor

function App() {
  const videoRef = useRef(null);
  const videoTrackRef = useRef(null);
  const streamRef = useRef(null);
  
  const [result, setResult] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  
  const [sharpAmount, setSharpAmount] = useState(0.3);
  const [contrast, setContrast] = useState(1.0);
  const [brightness, setBrightness] = useState(0.0);
  
  const [platform, setPlatform] = useState(null);

  // --- Detect platform (iOS or Android) ---
  useEffect(() => {
    setPlatform(getDevicePlatform());
  }, []);

  const getDevicePlatform = () => {
    const userAgent = navigator.userAgent || navigator.vendor || window.opera;
    if (/iPad|iPhone|iPod/.test(userAgent)) {
      return "iOS";
    }
    if (/android/i.test(userAgent)) {
      return "Android";
    }
    return "Other";
  };

  // --- Start camera on mount ---
  useEffect(() => {
    let currentStream = null;

    const startCamera = async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          alert("Camera not supported in this browser.");
          return;
        }

        const cameraSettings = getCameraSettings(platform);

        const stream = await navigator.mediaDevices.getUserMedia(cameraSettings);
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

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute("playsinline", true);
          await videoRef.current.play();
          setCameraReady(true);
        }
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
  }, [platform]);

  // --- Get platform-specific camera settings ---
  const getCameraSettings = (platform) => {
    if (platform === "iOS") {
      return {
        video: {
          facingMode: "environment",
          width: { ideal: 1280 }, // iOS devices may prefer a lower resolution
          height: { ideal: 720 },
        },
      };
    } else if (platform === "Android") {
      return {
        video: {
          facingMode: "environment",
          width: { ideal: 1920 }, // Android devices can handle higher resolutions
          height: { ideal: 1080 },
        },
      };
    } else {
      return {
        video: {
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      };
    }
  };

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

  // --- Capture button: decode, stop camera, crop QR + CDP ---
  const handleCaptureBox = async () => {
    if (!videoRef.current || capturing) return;
    const v = videoRef.current;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) {
      console.warn("Video not ready / no dimensions yet.");
      return;
    }

    setCapturing(true);
    setResult("");

    try {
      // 1) Capture video frame to canvas
      const frameCanvas = document.createElement("canvas");
      frameCanvas.width = vw;
      frameCanvas.height = vh;
      const frameCtx = frameCanvas.getContext("2d");
      frameCtx.drawImage(v, 0, 0, vw, vh);

      // 2) Decode QR (process image, crop, etc.)
      // Similar logic as before for cropping and decoding QR
      // ...
      // Once done, stop camera and set result

      stopCamera();
    } catch (err) {
      console.error(err);
      alert("Couldn’t decode a QR in the box. Try again closer / steadier.");
    } finally {
      setCapturing(false);
    }
  };

  return (
    <div style={{ textAlign: "center", padding: "20px" }}>
      <h2>QR Scanner (Optimized for {platform})</h2>

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
        {!cameraReady
          ? "Waiting for camera…"
          : capturing
          ? "Capturing…"
          : "Capture QR"}
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
