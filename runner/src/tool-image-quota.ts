import fs from 'node:fs';
import path from 'node:path';

export type ToolImageLimits = { imageBytes: number; turnBytes: number; turnFiles: number; threadBytes: number; threadFiles: number };
export const TOOL_IMAGE_LIMITS: Readonly<ToolImageLimits> = { imageBytes: 100 * 1024 * 1024, turnBytes: 256 * 1024 * 1024, turnFiles: 64, threadBytes: 1024 * 1024 * 1024, threadFiles: 1024 };

// One context per CLI session. Disk totals are read afresh, so reconnects,
// new sessions and restarts never renew a thread's storage allowance.
export class ToolImageQuota {
  private bytes = 0;
  private files = 0;
  private dir: string;
  readonly limits: ToolImageLimits;
  constructor(dir: string, limits: ToolImageLimits = TOOL_IMAGE_LIMITS) { this.dir = dir; this.limits = limits; }

  beginTurn(): void { this.bytes = 0; this.files = 0; }

  reserve(bytes: number): (actualBytes: number) => void {
    if (this.bytes + bytes > this.limits.turnBytes || this.files + 1 > this.limits.turnFiles) throw new Error('Tool images exceed this turn’s allowance');
    this.checkStorage(bytes);
    this.bytes += bytes;
    this.files++;
    return (actualBytes) => {
      const extra = Math.max(0, actualBytes - bytes);
      if (this.bytes + extra > this.limits.turnBytes) throw new Error('Tool images exceed this turn’s allowance');
      this.checkStorage(Math.max(bytes, actualBytes));
      this.bytes += extra;
    };
  }

  private checkStorage(bytes: number): void {
    if (bytes > this.limits.threadBytes || this.limits.threadFiles < 1) throw new Error('Tool images exceed this thread’s storage allowance');
    let used = 0;
    let files = 0;
    let visited = 0;
    const scan = (dir: string): void => {
      let entries: fs.Dir;
      try { entries = fs.opendirSync(dir); }
      catch (e) { if (dir === this.dir && (e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
      try {
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        if (++visited > 4096) throw new Error('Tool image storage has too many entries');
        const child = path.join(dir, entry.name);
        const st = fs.lstatSync(child);
        // Tool images always have a flat safeName. Reviews have their own
        // asset allowances and may legitimately contain deeply nested pages.
        if (st.isDirectory()) continue;
        files++;
        if (!st.isFile() || files + 1 > this.limits.threadFiles || used + st.size + bytes > this.limits.threadBytes) throw new Error('Tool images exceed this thread’s storage allowance');
        used += st.size;
      }
      } finally { entries.closeSync(); }
    };
    scan(this.dir);
    if (bytes > this.limits.threadBytes || files + 1 > this.limits.threadFiles) throw new Error('Tool images exceed this thread’s storage allowance');
  }
}
