import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

interface QRDisplayProps {
  data: string;
  size?: number;
  className?: string;
}

export function QRDisplay({ data, size = 200, className }: QRDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !data) return;
    QRCode.toCanvas(canvasRef.current, data, {
      width: size,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
  }, [data, size]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: size, height: size }}
    />
  );
}
