import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

function App() {
  const videoRef = useRef(null);
  const videoTrackRef = useRef(null);

  const [result, setResult] = useState("");
  const [snapshot, setSnapshot] = useState(null);
  const [focusSupported, setFocusSupported] = useState(false);

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
        const track = stream.getVideoTracks()[0];
        videoTrackRef.current = track;

        // Detect focus capabilities (Android Chrome usually yes, iOS Safari: maybe/limited)
        try {
          const caps = track.getCapabilities ? track.getCapabilities() : {};
          const hasPOI = !!caps.pointsOfInterest;
          const hasFocusMode =
            Array.isArray(caps.focusMode) && caps.focusMode.length > 0;
          setFocusSupported(hasPOI || hasFocusMode);
        } catch {
          setFocusSupported(false);
        }

        if (!videoRef.current) return;

        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute("playsinline", true);
        await videoRef.current.play();

        // Continuous decode until first QR
        controls = await codeReader.decodeFromVideoDevice(
          undefined,
          videoRef.current,
          (res, err) => {
            if (locked || !res) return;

            locked = true;
            const text = res.getText ? res.getText() : res.text;
            setResult(text);

            const pts =
              (res.getResultPoints && res.getResultPoints()) ||
              res.resultPoints ||
              [];

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
            } else if (videoRef.current) {
              // fallback: full frame
              const v = videoRef.current;
              const canvas = document.createElement("canvas");
              const ctx = canvas.getContext("2d");
              canvas.width = v.videoWidth;
              canvas.height = v.videoHeight;
              ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
              setSnapshot(canvas.toDataURL("image/png"));
            }

            // Stop scanning & camera
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

  // Tap-to-focus (best-effort, no crash if unsupported)
  const handleTapToFocus = async (e) => {
    const video = videoRef.current;
    const track = videoTrackRef.current;
    if (!video || !track || !track.getCapabilities || !track.applyConstraints) {
      return;
    }

    const caps = track.getCapabilities();
    const rect = video.getBoundingClientRect();

    // Normalized [0,1] coords inside video
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    const advanced = [];

    if (caps.pointsOfInterest) {
      advanced.push({
        pointsOfInterest: [{ x, y }],
      });
    }

    if (Array.isArray(caps.focusMode)) {
      const mode =
        (caps.focusMode.includes("single-shot") && "single-shot") ||
        (caps.focusMode.includes("continuous") && "continuous") ||
        null;
      if (mode) {
        advanced.push({ focusMode: mode });
      }
    }

    if (!advanced.length) return;

    try {
      await track.applyConstraints({ advanced });
    } catch (err) {
      console.warn("Tap-to-focus failed/ignored:", err);
    }
  };

  return (
    <div style={{ textAlign: "center", padding: "20px" }}>
      <h2>QR Test App</h2>

      <div style={{ position: "relative", display: "inline-block" }}>
        <video
          ref={videoRef}
          onClick={handleTapToFocus}
          style={{
            width: "100%",
            maxWidth: "500px",
            border: "1px solid #ccc",
            borderRadius: "8px",
            cursor: focusSupported ? "crosshair" : "default",
          }}
        />
        {focusSupported && (
          <div
            style={{
              position: "absolute",
              bottom: 8,
              right: 8,
              padding: "3px 6px",
              fontSize: "10px",
              background: "rgba(0,0,0,0.55)",
              color: "#fff",
              borderRadius: "4px",
            }}
          >
            Tap to focus
          </div>
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
