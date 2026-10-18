/** Browser-only delivery. Encoding and integrity checks belong to encodeShipPng. */
export function downloadShipPng(png: Uint8Array, width: number, height: number): void {
  // Copy the exact view so Blob never includes bytes outside a subarray or a shared buffer.
  const blob = new Blob([new Uint8Array(png)], { type: 'image/png' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  try {
    link.href = url;
    link.download = `cosmoteer-armor-${width}x${height}.ship.png`;
    document.body.appendChild(link);
    link.click();
  } finally {
    try {
      link.remove();
    }
    finally {
      // Allow the browser to consume this URL; each call schedules its own cleanup.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}
