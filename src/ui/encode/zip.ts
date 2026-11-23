/**
 * A ZIP writer for several exported files in one download (Figma's desktop app asks where to
 * save each download, so twenty layers would be twenty dialogs). Files are stored as they are,
 * not compressed again: WebP, AVIF, PNG inside an ICO and PDF are compressed already. UTF-8
 * names (general purpose flag bit 11), no ZIP64: up to 65,535 files and 4 GB in all.
 *
 * Our own code from PKWARE's APPNOTE.TXT; it runs in the plugin's panel, on the user's computer.
 */

export interface ZipFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date, as ZIP keeps them (local time, two-second steps, from 1980). */
function dosTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Names made unique the way file managers do: `Frame.webp`, `Frame (2).webp`… */
export function uniqueNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++)
      candidate = `${base} (${n})${extension}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

export function zipStore(files: readonly ZipFile[], now = new Date()): Uint8Array {
  if (files.length === 0 || files.length > 0xffff)
    throw new Error('A ZIP holds 1 to 65,535 files.');
  const encoder = new TextEncoder();
  const { time, date } = dosTime(now);
  const entries = files.map((file) => ({
    name: encoder.encode(file.name),
    bytes: file.bytes,
    crc: crc32(file.bytes),
  }));
  const local = entries.reduce((sum, e) => sum + 30 + e.name.length + e.bytes.length, 0);
  const central = entries.reduce((sum, e) => sum + 46 + e.name.length, 0);
  const total = local + central + 22;
  if (total > 0xffffffff) throw new Error('The files are too large for one ZIP.');

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let at = 0;
  for (const entry of entries) {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 0x0800, true);
    // Stored.
    view.setUint16(at + 8, 0, true);
    view.setUint16(at + 10, time, true);
    view.setUint16(at + 12, date, true);
    view.setUint32(at + 14, entry.crc, true);
    view.setUint32(at + 18, entry.bytes.length, true);
    view.setUint32(at + 22, entry.bytes.length, true);
    view.setUint16(at + 26, entry.name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(entry.name, at + 30);
    out.set(entry.bytes, at + 30 + entry.name.length);
    at += 30 + entry.name.length + entry.bytes.length;
  }
  const centralStart = at;
  entries.forEach((entry, i) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, time, true);
    view.setUint16(at + 14, date, true);
    view.setUint32(at + 16, entry.crc, true);
    view.setUint32(at + 20, entry.bytes.length, true);
    view.setUint32(at + 24, entry.bytes.length, true);
    view.setUint16(at + 28, entry.name.length, true);
    // Extra field, comment, disk, internal and external attributes: none.
    view.setUint32(at + 42, offsets[i]!, true);
    out.set(entry.name, at + 46);
    at += 46 + entry.name.length;
  });
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}
