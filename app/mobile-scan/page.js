'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import ProductPopup from '../components/ProductPopup';

function cameraErrorMessage(error) {
  switch (error.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Camera access is blocked. Allow camera access for this site in your browser or phone settings, then tap Start camera again. You can also scan a photo or enter the SKU.';
    case 'NotFoundError':
      return 'No camera was found. Scan a barcode photo or enter the SKU.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera could not start. Close other apps using it and try again, or scan a photo.';
    default:
      return 'The camera could not start. Try again, scan a photo, or enter the SKU.';
  }
}

function stopStream(stream) {
  stream?.getTracks().forEach(track => track.stop());
}

export default function MobileScanPage() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const photoRef = useRef(null);
  const cameraRef = useRef(null);
  const lookupRef = useRef(null);
  const recentScanRef = useRef(null);
  const [cameraState, setCameraState] = useState('idle');
  const [cameraError, setCameraError] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [product, setProduct] = useState(null);
  const [status, setStatus] = useState('');
  const [scanned, setScanned] = useState('');

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      stopStream(cameraRef.current?.stream);
      cameraRef.current = null;
      if (video) video.srcObject = null;
      lookupRef.current?.abort();
    };
  }, []);

  const startCamera = async () => {
    if (cameraRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Live camera is unavailable in this browser. Open this page directly in a browser over HTTPS, scan a photo, or enter the SKU.');
      return;
    }

    const camera = {};
    const video = videoRef.current;
    cameraRef.current = camera;
    setCameraError('');
    setCameraState('starting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });

      if (cameraRef.current !== camera) {
        stopStream(stream);
        return;
      }

      camera.stream = stream;
      video.srcObject = stream;
      await video.play();
      if (cameraRef.current === camera) setCameraState('ready');
    } catch (error) {
      if (cameraRef.current !== camera) return;
      stopStream(camera.stream);
      cameraRef.current = null;
      video.srcObject = null;
      setCameraState('idle');
      setCameraError(cameraErrorMessage(error));
    }
  };

  const stopCamera = () => {
    stopStream(cameraRef.current?.stream);
    cameraRef.current = null;
    videoRef.current.srcObject = null;
    setCameraState('idle');
  };

  const lookupProduct = useCallback(async (readSku) => {
    if (lookupRef.current) return;
    const request = new AbortController();
    lookupRef.current = request;
    setIsBusy(true);
    setScanned('');

    try {
      const sku = await readSku(request.signal);
      if (!sku || request.signal.aborted) return;

      setScanned(sku);
      setStatus(`Searching for "${sku}"…`);
      const response = await fetch(`/api/barcode?sku=${encodeURIComponent(sku)}`, {
        credentials: 'include',
        signal: request.signal,
      });

      if (response.ok) {
        const result = await response.json();
        if (request.signal.aborted) return;
        setProduct(result);
        setStatus('Product loaded.');
      } else if (response.status === 404) {
        setStatus(`Product "${sku}" not found.`);
      } else if (response.status === 401) {
        setStatus('Sign in to look up products.');
      } else {
        setStatus('Could not look up the product. Try again.');
      }
    } catch {
      if (!request.signal.aborted) setStatus('Could not look up the product. Try again.');
    } finally {
      lookupRef.current = null;
      if (!request.signal.aborted) setIsBusy(false);
    }
  }, []);

  const readVideoFrame = useCallback((reader) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video?.videoWidth || !video.videoHeight || video.readyState < 2 || !canvas) return '';

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return '';

    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return reader.decodeFromCanvas(canvas).getText();
    } catch {
      return '';
    }
  }, []);

  useEffect(() => {
    if (cameraState !== 'ready' || product || isBusy) return;

    const reader = new BrowserMultiFormatReader();
    const interval = window.setInterval(() => {
      if (lookupRef.current) return;
      const sku = readVideoFrame(reader);
      const now = Date.now();
      const recentScan = recentScanRef.current;
      if (!sku || (recentScan?.sku === sku && now - recentScan.time < 2000)) return;

      recentScanRef.current = { sku, time: now };
      void lookupProduct(() => sku);
    }, 200);

    return () => window.clearInterval(interval);
  }, [cameraState, isBusy, lookupProduct, product, readVideoFrame]);

  const captureNow = () => {
    const sku = readVideoFrame(new BrowserMultiFormatReader());
    if (sku) {
      recentScanRef.current = { sku, time: Date.now() };
      void lookupProduct(() => sku);
    } else {
      setStatus('No barcode found in the frame. Keep the barcode in view and try again.');
    }
  };

  const scanPhoto = (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    void lookupProduct(async (signal) => {
      setStatus('Reading barcode photo…');
      const url = URL.createObjectURL(file);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const reader = new BrowserMultiFormatReader();
        return reader.decode(image).getText();
      } catch {
        if (!signal.aborted) {
          setStatus('Could not read a barcode from this photo. Try a clear, close-up photo or enter the SKU.');
        }
        return '';
      } finally {
        URL.revokeObjectURL(url);
      }
    });
  };

  const handleManualSubmit = (event) => {
    event.preventDefault();
    if (lookupRef.current) return;
    const input = event.currentTarget.elements.sku;
    const sku = input.value.trim();
    if (!sku) {
      setStatus('Enter a SKU to search.');
      return;
    }
    input.value = '';
    void lookupProduct(() => sku);
  };

  const closePopup = () => {
    recentScanRef.current = { sku: scanned, time: Date.now() };
    setProduct(null);
    setScanned('');
    setStatus('');
  };

  const idleStatus = {
    idle: 'Start the camera, scan a photo, or enter a SKU.',
    starting: 'Waiting for camera access…',
    ready: 'Camera ready. Point it at a barcode.',
  }[cameraState];

  return (
    <div style={{ padding: '20px', maxWidth: '600px', margin: '0 auto', minHeight: '100vh' }}>
      <h1>📱 Mobile Barcode Scanner</h1>
      {cameraError && <p role="alert" style={{ marginTop: '12px' }}>{cameraError}</p>}
      <div hidden={cameraState === 'idle'} style={{ background: '#000', borderRadius: '12px', overflow: 'hidden', marginTop: '12px' }}>
        <video ref={videoRef} style={{ width: '100%', height: 'auto' }} playsInline muted autoPlay />
        <canvas ref={canvasRef} hidden />
      </div>
      <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
        {cameraState === 'idle' ? (
          <button type="button" onClick={startCamera} className="rounded-lg bg-amber-500 px-4 py-2 text-black">Start camera</button>
        ) : (
          <button type="button" onClick={stopCamera} className="rounded-lg border px-4 py-2">Stop camera</button>
        )}
        {cameraState === 'ready' && (
          <button type="button" onClick={captureNow} disabled={isBusy} className="rounded-lg bg-amber-500 px-4 py-2 text-black disabled:opacity-50">
            Capture &amp; Decode
          </button>
        )}
        <button type="button" onClick={() => photoRef.current?.click()} disabled={isBusy} className="rounded-lg border px-4 py-2 disabled:opacity-50">
          Scan a photo
        </button>
        <input ref={photoRef} type="file" accept="image/*" onChange={scanPhoto} hidden />
      </div>
      <div role="status" style={{ marginTop: '20px', padding: '16px', background: '#f9fafb', borderRadius: '8px' }}>
        <p>{status || idleStatus}</p>
        {scanned && <p><strong>Last scanned:</strong> <code>{scanned}</code></p>}
      </div>
      <form onSubmit={handleManualSubmit} style={{ marginTop: '20px' }}>
        <label htmlFor="mobile-scan-sku">Or type SKU manually:</label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            id="mobile-scan-sku"
            name="sku"
            type="text"
            placeholder="Enter SKU"
            style={{ flex: 1, minWidth: 0, padding: '10px', border: '1px solid #ccc', borderRadius: '8px' }}
          />
          <button type="submit" disabled={isBusy} className="rounded-lg bg-blue-600 px-4 py-2 text-white disabled:opacity-50">
            Search
          </button>
        </div>
      </form>
      {product && <ProductPopup product={product} onClose={closePopup} isMobile />}
    </div>
  );
}
