import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const [model = 'small', directory] = process.argv.slice(2);
if (!directory || !['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'].includes(model)) throw Error('Usage: node download-whisper-model.mjs MODEL DIRECTORY');
const repository = model === 'turbo' ? 'mobiuslabsgmbh/faster-whisper-large-v3-turbo' : `Systran/faster-whisper-${model}`;
const metadata = await (await fetch(`https://huggingface.co/api/models/${repository}?blobs=true`, { signal: AbortSignal.timeout(30000) })).json();
if (!metadata.siblings) throw Error('Cannot read official Whisper model metadata');
await fs.mkdir(directory, { recursive: true });
const hash = async file => { const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); };
for (const entry of metadata.siblings.filter(entry => /^(config\.json|model\.bin|tokenizer\.json|vocabulary\..+|preprocessor_config\.json)$/.test(entry.rfilename))) {
  const target = path.join(directory, entry.rfilename);
  const size = entry.lfs?.size ?? entry.size;
  const expectedHash = entry.lfs?.sha256;
  try {
    if ((await fs.stat(target)).size === size && (!expectedHash || await hash(target) === expectedHash)) { console.log(`Already downloaded: ${entry.rfilename}`); continue; }
  } catch { /* first download */ }
  const url = `https://huggingface.co/${repository}/resolve/${metadata.sha}/${entry.rfilename}?download=true`;
  if (entry.rfilename !== 'model.bin') {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error(`Download ${entry.rfilename}: HTTP ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length !== size) throw Error(`Wrong size for ${entry.rfilename}`);
    await fs.writeFile(target, data);
    continue;
  }
  // Range requests avoid stalled Xet transfers on some Windows networks.
  // Verify each range and the complete official LFS SHA256 before activation.
  const part = target + '.download';
  const progressFile = part + '.json';
  const chunkSize = 4 * 1024 * 1024;
  const count = Math.ceil(size / chunkSize);
  let completed = new Set();
  try {
    const saved = JSON.parse(await fs.readFile(progressFile, 'utf8'));
    if (saved.sha === expectedHash && (await fs.stat(part)).size === size) completed = new Set(saved.completed);
  } catch { /* start or resume download */ }
  const file = await fs.open(part, completed.size ? 'r+' : 'w+');
  await file.truncate(size);
  let next = 0, savedSerial = Promise.resolve();
  const save = () => { savedSerial = savedSerial.then(() => fs.writeFile(progressFile, JSON.stringify({ sha: expectedHash, completed: [...completed] }))); return savedSerial; };
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, async () => {
      while (next < count) {
        const index = next++;
        if (completed.has(index)) continue;
        const start = index * chunkSize, end = Math.min(size, start + chunkSize) - 1;
        let lastError;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(120000) });
            if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${size}`) throw Error(`Unexpected range ${index}: HTTP ${response.status}`);
            let position = start;
            for await (const chunk of response.body) {
              if (position + chunk.length > end + 1) throw Error('Range exceeds its declared length');
              let offset = 0;
              while (offset < chunk.length) { const written = await file.write(chunk, offset, chunk.length - offset, position); offset += written.bytesWritten; position += written.bytesWritten; }
            }
            if (position !== end + 1) throw Error('Incomplete range');
            completed.add(index); await save();
            console.log(`Whisper ${model}: ${Math.round(completed.size / count * 100)}% (${completed.size}/${count} parts)`);
            lastError = undefined; break;
          } catch (error) { lastError = error; }
        }
        if (lastError) throw lastError;
      }
    }));
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  } finally { await savedSerial; await file.close(); }
  if (!expectedHash || await hash(part) !== expectedHash) throw Error('Whisper model SHA256 verification failed');
  await fs.rename(part, target);
  await fs.unlink(progressFile);
  console.log(`Verified SHA256: ${entry.rfilename}`);
}
