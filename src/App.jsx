import React, { useEffect, useRef, useState } from "react";

const API_URL = "https://9ahp0tc529.execute-api.ap-south-1.amazonaws.com/dev";

const IDS = [
  "79604928-2f65-4c8m",
  "79604928-2f65-4c8o",
  "79604928-2f65-4c8j",
  "79604928-2f65-4c8w",
  "79604928-2f65-4c8q",
  "79604928-2f65-4c8d",
];

function getRandomId() {
  const idx = Math.floor(Math.random() * IDS.length);
  return IDS[idx];
}

function App() {
  const videoRef = useRef(null);
  const videoTrackRef = useRef(null);
  const streamRef = useRef(null);

  const [capturing, setCapturing] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const [apiResult, setApiResult] = useState(null);
  const [capturedImageDataUrl, setCapturedImageDataUrl] = useState(null);

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

  // --- Capture full frame, send to API ---
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

    try {
      // 1) Draw full high-res frame to canvas
      const canvas = document.createElement("canvas");
      canvas.width = vw;
      canvas.height = vh;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(videoElement, 0, 0, vw, vh);

      // 2) Convert to data URL (high quality JPEG)
      const dataUrl = canvas.toDataURL("image/jpeg", 1.0); // quality 1.0
      setCapturedImageDataUrl(dataUrl);

      // 3) Strip base64 prefix: "data:image/jpeg;base64,..."
      const base64 = dataUrl.split(",")[1];

      // 4) Build payload with random id
      const payload = {
        id: getRandomId(),
        image_base64: base64,
      };

      // 5) Call API
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
        // In case API returns non-JSON
        const text = await res.text();
        resultData = { raw: text };
      }

      setApiResult(resultData);

      // Optional: stop camera after capture
      stopCamera();
    } catch (err) {
      console.error(err);
      alert("Couldn't capture or send the image. Try again.");
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
          {capturing ? "Processing..." : "Capture & Send"}
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

      {capturedImageDataUrl && (
        <div style={{ marginTop: "1rem" }}>
          <h3>Captured Image:</h3>
          <img
            src={capturedImageDataUrl}
            alt="Captured frame"
            style={{ maxWidth: "100%" }}
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
