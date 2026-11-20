import type { IncomingMessage } from 'node:http';

const EMPTY = Buffer.alloc(0);
export function readBytes(req: IncomingMessage): Promise<Buffer> {
  const buffered = (req as IncomingMessage & { __rawBody?: Buffer }).__rawBody;
  if (Buffer.isBuffer(buffered)) return Promise.resolve(buffered);
  return new Promise<Buffer>((resolve, reject) => {
    let first: Buffer | undefined;
    let chunks: Buffer[] | undefined;
    req.on('data', (chunk: Buffer) => {
      if (!first) first = chunk;
      else (chunks ??= [first]).push(chunk);
    });
    req.once('error', reject);
    req.once('end', () => resolve(chunks ? Buffer.concat(chunks) : first ?? EMPTY));
  });
}
