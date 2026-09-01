export function triggerBlobDownload(blob: Blob, filename = 'migrated_project.zip'): void {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

export function formatElapsed(ms?: number): string {
  if (!ms || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min <= 0) return `${sec}s`;
  return `${min}m ${sec.toString().padStart(2, '0')}s`;
}

/** Case-insensitive .zip check (Windows often uses .ZIP). */
export function isZipFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.zip');
}

export function isWithinUploadLimit(sizeBytes: number, maxBytes: number): boolean {
  return sizeBytes <= maxBytes;
}

