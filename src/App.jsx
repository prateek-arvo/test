import React, { useState } from "react";
import jsQR from "jsqr"; // Import jsQR for QR decoding

function App() {
  const [image, setImage] = useState(null);
  const [result, setResult] = useState("");

  const handleFileChange = (event) => {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImage(reader.result); // Set image as base64 encoded URL
        decodeQR(reader.result); // Process QR from the image
      };
      reader.readAsDataURL(file);
    }
  };

  const decodeQR = (imageDataUrl) => {
    const image = new Image();
    image.src = imageDataUrl;
    image.onload = () => {
      // Create canvas to decode QR
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      canvas.width = image.width;
      canvas.height = image.height;
      ctx.drawImage(image, 0, 0);

      // Get image data and try to decode QR
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const qrResult = jsQR(imageData.data, canvas.width, canvas.height);

      if (qrResult) {
        setResult(qrResult.data); // If QR is found, display result
        cropToQRCode(qrResult);   // Optionally crop to the QR code region
      } else {
        setResult("No QR code found.");
      }
    };
  };

  // Optionally crop the image to the QR code region
  const cropToQRCode = (qrResult) => {
    const { topLeft, topRight, bottomLeft, bottomRight } = qrResult.location;

    // Calculate bounding box of QR code
    const minX = Math.min(topLeft.x, topRight.x, bottomLeft.x, bottomRight.x);
    const maxX = Math.max(topLeft.x, topRight.x, bottomLeft.x, bottomRight.x);
    const minY = Math.min(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y);
    const maxY = Math.max(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y);

    const width = maxX - minX;
    const height = maxY - minY;

    // Create a new canvas to crop the QR region
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(
      document.querySelector("img"), // Original image
      minX,
      minY,
      width,
      height,
      0,
      0,
      width,
      height
    );

    const croppedImageUrl = canvas.toDataURL();
    setImage(croppedImageUrl); // Update the displayed image with the cropped QR
  };

  return (
    <div>
      <h2>Capture Image</h2>
      <input
        type="file"
        accept="image/*"
        capture="camera"
        onChange={handleFileChange}
      />
      {image && (
        <div>
          <h3>Captured Image:</h3>
          <img src={image} alt="Captured" style={{ maxWidth: "100%" }} />
        </div>
      )}
      {result && <p>QR Code Data: {result}</p>}
    </div>
  );
}

export default App;
