// A single promise chain that serializes bridge writes. The Even Hub SDK
// forbids concurrent image sends, and a fast-tapping user can also race rapid
// text upgrades; routing every bridge call through one queue prevents both
// classes of overlap. Rejections are swallowed on the internal chain so one
// failed write doesn't poison every subsequent call — the caller still sees its
// own rejection. (Copied from House `util/serial.ts`.)

export type Serial = <T>(fn: () => Promise<T>) => Promise<T>;

export function createSerial(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn) as Promise<T>;
    tail = next.catch(() => undefined); // keep the chain alive on errors
    return next;
  };
}
