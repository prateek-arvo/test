import React, { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

function App() {
  const videoRef = useRef(null);

  const [result, setResult] = useState("");
  const [qrNormUrl, setQrNormUrl] = useState(null);        // perspective-normalized, sharpened QR
  const [cdpUrl, setCdpUrl] = useState(null);              // center patch (sharpened) for Siamese

  useEffect(() => {
    const codeReader = new BrowserQRCodeReader();
    let currentStream = null;
    let controls = null;
    let locked = false;

    const start = async () => {
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

            // 1) Get QR corners from resultPoints
            const pts =
              (res.getResultPoints && res.getResultPoints()) ||
              res.resultPoints ||
              [];

            const corners = getQrCornersFromPoints(pts);
            if (!corners) {
              console.warn("Could not get stable QR corners; aborting normalize.");
              stopAll();
              return;
            }

            // 2) Grab full frame into canvas
            const frame = document.createElement("canvas");
            frame.width = vw;
            frame.height = vh;
            const fctx = frame.getContext("2d");
            fctx.drawImage(v, 0, 0, vw, vh);

            // 3) Warp QR → canonical square (e.g. 512x512)
            const qrSize = 512;
            const qrNormCanvas = warpToCanonical(frame, corners, qrSize);

            // 4) Sharpen normalized QR
            const qrCtx = qrNormCanvas.getContext("2d");
            let qrImg = qrCtx.getImageData(0, 0, qrSize, qrSize);
            qrImg = applySharpen(qrImg); // one-pass sharpen
            qrCtx.putImageData(qrImg, 0, 0);

            const qrNormDataUrl = qrNormCanvas.toDataURL("image/png");
            setQrNormUrl(qrNormDataUrl);

            // 5) Crop center 36% from sharpened QR
            const frac = 0.36;
            const cSize = Math.floor(qrSize * frac);
            const cx0 = Math.floor((qrSize - cSize) / 2);
            const cy0 = Math.floor((qrSize - cSize) / 2);

            const centerCanvas = document.createElement("canvas");
            centerCanvas.width = cSize;
            centerCanvas.height = cSize;
            const cctx = centerCanvas.getContext("2d");
            cctx.drawImage(
              qrNormCanvas,
              cx0,
              cy0,
              cSize,
              cSize,
              0,
              0,
              cSize,
              cSize
            );

            // 6) Sharpen center patch
            let cImg = cctx.getImageData(0, 0, cSize, cSize);
            cImg = applySharpen(cImg);
            cctx.putImageData(cImg, 0, 0);

            const cdpDataUrl = centerCanvas.toDataURL("image/png");
            setCdpUrl(cdpDataUrl);

            // 7) Cleanup camera/decoder
            stopAll();
          }
        );
      } catch (e) {
        console.error("Camera / decode error:", e);
        stopAll();
      }
    };

    const stopAll = () => {
      if (controls) controls.stop();
      if (currentStream) {
        currentStream.getTracks().forEach((t) => t.stop());
      }
    };

    start();

    return () => {
      stopAll();
    };
  }, []);

  // --- Helpers ---

  // Extract TL, TR, BL, BR from ZXing resultPoints
  function getQrCornersFromPoints(pts) {
    if (!pts || pts.length < 3) return null;

    // ZXing QR usually: [topLeft, topRight, bottomLeft]
    const p0 = toPt(pts[0]);
    const p1 = toPt(pts[1]);
    const p2 = toPt(pts[2]);

    // Quick heuristic: choose configuration that makes sense geometrically
    let tl = p0;
    let tr = p1;
    let bl = p2;

    // If needed, you could add checks here (e.g., by angles/distances)

    const br = {
      x: tr.x + (bl.x - tl.x),
      y: tr.y + (bl.y - tl.y),
    };

    return { tl, tr, bl, br };
  }

  function toPt(p) {
    return {
      x: p.getX ? p.getX() : p.x,
      y: p.getY ? p.getY() : p.y,
    };
  }

  // Compute homography that maps src[4] -> dst[4]
  function computeHomography(src, dst) {
    // We solve for h0..h7; h8 = 1
    const A = [];

    for (let i = 0; i < 4; i++) {
      const xs = src[i].x;
      const ys = src[i].y;
      const xd = dst[i].x;
      const yd = dst[i].y;

      A.push([
        xs,
        ys,
        1,
        0,
        0,
        0,
        -xs * xd,
        -ys * xd,
        xd,
      ]);
      A.push([
        0,
        0,
        0,
        xs,
        ys,
        1,
        -xs * yd,
        -ys * yd,
        yd,
      ]);
    }

    // Gaussian elimination for 8x9 to get h (last column as solution with h8=1)
    const h = gaussSolveHomography(A);
    return h; // [h0..h8]
  }

  function gaussSolveHomography(A) {
    const m = A.length;
    const n = A[0].length;

    for (let col = 0, row = 0; col < n - 1 && row < m; col++) {
      // pivot
      let sel = row;
      for (let i = row + 1; i < m; i++) {
        if (Math.abs(A[i][col]) > Math.abs(A[sel][col])) sel = i;
      }
      if (Math.abs(A[sel][col]) < 1e-9) continue;
      [A[row], A[sel]] = [A[sel], A[row]];

      const div = A[row][col];
      for (let j = col; j < n; j++) A[row][j] /= div;

      for (let i = 0; i < m; i++) {
        if (i !== row) {
          const factor = A[i][col];
          for (let j = col; j < n; j++) {
            A[i][j] -= factor * A[row][j];
          }
        }
      }
      row++;
    }

    // Last column now approximates solution (already scaled)
    const h = new Array(9);
    for (let i = 0; i < 9; i++) {
      h[i] = A[i] ? A[i][n - 1] : 0;
    }
    // Normalize so h8 = 1
    if (Math.abs(h[8]) < 1e-9) h[8] = 1;
    for (let i = 0; i < 9; i++) h[i] /= h[8];
    return h;
  }

  // Warp QR region to canonical square using homography
  function warpToCanonical(frameCanvas, corners, size) {
    const { tl, tr, br, bl } = corners;

    // Map canonical square -> QR corners
    const src = [
      { x: 0, y: 0 },
      { x: size - 1, y: 0 },
      { x: size - 1, y: size - 1 },
      { x: 0, y: size - 1 },
    ];
    const dst = [tl, tr, br, bl];

    const H = computeHomography(src, dst);

    const sCtx = frameCanvas.getContext("2d");
    const sData = sCtx.getImageData(
      0,
      0,
      frameCanvas.width,
      frameCanvas.height
    ).data;

    const outCanvas = document.createElement("canvas");
    outCanvas.width = size;
    outCanvas.height = size;
    const oCtx = outCanvas.getContext("2d");
    const oImg = oCtx.createImageData(size, size);
    const oData = oImg.data;

    const sw = frameCanvas.width;
    const sh = frameCanvas.height;

    // For each canonical pixel, map -> source via H
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;

        const denom = H[6] * x + H[7] * y + 1.0;
        const sx = (H[0] * x + H[1] * y + H[2]) / denom;
        const sy = (H[3] * x + H[4] * y + H[5]) / denom;

        const sx0 = Math.round(sx);
        const sy0 = Math.round(sy);

        if (sx0 >= 0 && sy0 >= 0 && sx0 < sw && sy0 < sh) {
          const si = (sy0 * sw + sx0) * 4;
          oData[i] = sData[si];
          oData[i + 1] = sData[si + 1];
          oData[i + 2] = sData[si + 2];
          oData[i + 3] = 255;
        } else {
          oData[i] = 255;
          oData[i + 1] = 255;
          oData[i + 2] = 255;
          oData[i + 3] = 255;
        }
      }
    }

    oCtx.putImageData(oImg, 0, 0);
    return outCanvas;
  }

  // Single-pass sharpen (unsharp-mask-style)
  function applySharpen(imageData) {
    const { width, height, data } = imageData;
    const out = new Uint8ClampedArray(data.length);
    const stride = width * 4;

    // 3x3 kernel: 0 -1 0; -1 5 -1; 0 -1 0
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
            0 * tl +
            -1 * t +
            0 * tr +
            -1 * l +
            5 * m +
            -1 * r +
            0 * bl +
            -1 * b +
            0 * br;

          if (val < 0) val = 0;
          if (val > 255) val = 255;
          out[idx + c] = val;
        }
        out[idx + 3] = data[idx + 3]; // alpha
      }
    }

    // copy border pixels unchanged
    for (let y = 0; y < height; y++) {
      for (let x of [0, width - 1]) {
        const idx = (y * width + x) * 4;
        out[idx] = data[idx];
        out[idx + 1] = data[idx + 1];
        out[idx + 2] = data[idx + 2];
        out[idx + 3] = data[idx + 3];
      }
    }
    for (let x = 0; x < width; x++) {
      for (let y of [0, height - 1]) {
        const idx = (y * width + x) * 4;
        out[idx] = data[idx];
        out[idx + 1] = data[idx + 1];
        out[idx + 2] = data[idx + 2];
        out[idx + 3] = data[idx + 3];
      }
    }

    return new ImageData(out, width, height);
  }

  return (
    <div style={{ textAlign: "center", padding: "20px" }}>
      <h2>QR → Canonical CDP Extractor</h2>

      <video
        ref={videoRef}
        style={{
          width: "100%",
          maxWidth: "480px",
          border: "1px solid #ccc",
          borderRadius: "8px",
        }}
      />

      {result && (
        <div style={{ marginTop: "16px" }}>
          <h3>Decoded QR Content</h3>
          <p
            style={{
              padding: "6px 10px",
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

      {(qrNormUrl || cdpUrl) && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: "20px",
            flexWrap: "wrap",
            marginTop: "20px",
          }}
        >
          {qrNormUrl && (
            <div>
              <h4>Normalized QR (sharpened)</h4>
              <img
                src={qrNormUrl}
                alt="Normalized QR"
                style={{
                  maxWidth: "220px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
            </div>
          )}

          {cdpUrl && (
            <div>
              <h4>CDP Patch (center, sharpened)</h4>
              <img
                src={cdpUrl}
                alt="CDP patch"
                style={{
                  maxWidth: "160px",
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                }}
              />
              <p
                style={{
                  fontSize: "11px",
                  color: "#666",
                  marginTop: "4px",
                }}
              >
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
