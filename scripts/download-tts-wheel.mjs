import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Official PyTorch wheels, downloaded in verified resumable ranges because a
// single multi-GB transfer can stall on Windows networks.
const [name, variant, directory, version = '2.11.0'] = process.argv.slice(2);
if (!['torch', 'torchaudio'].includes(name) || !['cu128', 'cpu'].includes(variant) || !directory || !/^\d+\.\d+\.\d+$/.test(version)) throw Error('Usage: download-tts-wheel.mjs torch|torchaudio cu128|cpu DIRECTORY [VERSION]');
const filename = `${name}-${version}+${variant}-cp312-cp312-win_amd64.whl`;
const indexUrl = `https://download.pytorch.org/whl/${variant}/${name}/`;
const index = await (await fetch(indexUrl, { signal: AbortSignal.timeout(30000) })).text();
const href = [...index.matchAll(/href="([^"]+)"/g)].map(match => match[1]).find(link => decodeURIComponent(link.split('#')[0]).endsWith('/' + filename));
if (!href) throw Error(`Official wheel unavailable: ${filename}`);
const remote = new URL(href, indexUrl);
const expectedHash = remote.hash.replace('#sha256=', ''); remote.hash = '';
if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw Error('Official wheel SHA256 missing');
const head = await fetch(remote, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
const size = Number(head.headers.get('content-length'));
if (!head.ok || !Number.isSafeInteger(size) || size <= 0) throw Error('Cannot determine official wheel size');
await fs.mkdir(directory, { recursive: true });
const target = path.join(directory, filename), part = target + '.download', progress = part + '.json';
const hash = async file => { const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); };
try { if ((await fs.stat(target)).size === size && await hash(target) === expectedHash) { console.log(`Verified ${filename}`); process.exit(0); } } catch { /* first run */ }
const chunkSize = 4 * 1024 * 1024, count = Math.ceil(size / chunkSize);
let completed = new Set();
try { const saved = JSON.parse(await fs.readFile(progress)); if (saved.hash === expectedHash && (await fs.stat(part)).size === size) completed = new Set(saved.parts); } catch { /* first run */ }
const file = await fs.open(part, completed.size ? 'r+' : 'w+'); await file.truncate(size);
let next = 0, serial = Promise.resolve();
try {
  const results = await Promise.allSettled(Array.from({ length: 16 }, async () => {
    while (next < count) {
      const index = next++; if (completed.has(index)) continue;
      const start = index * chunkSize, end = Math.min(size, start + chunkSize) - 1;
      let failure;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const mirror = process.env.TTS_WHEEL_MIRROR?.trim().replace(/\/$/, '');
          const url = mirror && attempt < 2 ? new URL(mirror + '/' + variant + '/' + encodeURIComponent(filename)) : new URL(remote);
          if (url.protocol !== 'https:') throw Error('Wheel mirror must use HTTPS');
          url.searchParams.set('part', String(index));
          const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(120000) });
          if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${size}`) throw Error(`Invalid range ${index}`);
          const data = new Uint8Array(await response.arrayBuffer()); if (data.length !== end - start + 1) throw Error('Incomplete wheel range');
          let offset = 0; while (offset < data.length) { const result = await file.write(data, offset, data.length - offset, start + offset); offset += result.bytesWritten; }
          completed.add(index);
          serial = serial.then(() => fs.writeFile(progress, JSON.stringify({ hash: expectedHash, parts: [...completed] }))); await serial;
          if (completed.size % 16 === 0 || completed.size === count) console.log(`${name}: ${Math.round(completed.size / count * 100)}% (${completed.size}/${count})`);
          failure = undefined; break;
        } catch (error) { failure = error; }
      }
      if (failure) throw failure;
    }
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
} finally { await serial; await file.close(); }
if (await hash(part) !== expectedHash) throw Error('Official wheel SHA256 verification failed');
await fs.rename(part, target); await fs.unlink(progress);
console.log(`Verified ${filename}`);
