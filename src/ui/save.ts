/**
 * Saves a file from the panel: a link to the file in the panel's memory, clicked. It must run
 * inside the user's click (browsers and Figma's desktop app refuse downloads a frame starts on
 * its own), so the file is ready before the Save button shows.
 *
 * The link's file is typed `application/octet-stream`, the usual way to ask for a save rather
 * than a view (Firefox opens pictures it can show, such as WebP, in a tab); the name keeps the
 * real type.
 */
export function saveFile(doc: Document, blob: Blob, name: string): void {
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
  const link = doc.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  doc.body.appendChild(link);
  link.click();
  link.remove();
  // Long enough for the save dialog to read it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
