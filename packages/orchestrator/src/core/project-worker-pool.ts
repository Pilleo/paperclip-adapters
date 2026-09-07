export type ProjectWorkerResult<TItem, TValue> =
  | { readonly item: TItem; readonly ok: true; readonly value: TValue }
  | { readonly item: TItem; readonly ok: false; readonly error: string };

/** Run independent project work with bounded concurrency and stable ordering. */
export async function runProjectWorkerPool<TItem, TValue>(
  items: readonly TItem[],
  maxConcurrency: number,
  worker: (item: TItem) => Promise<TValue>,
): Promise<readonly ProjectWorkerResult<TItem, TValue>[]> {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(`Project worker pool concurrency must be a positive integer; received ${maxConcurrency}`);
  }

  const results: ProjectWorkerResult<TItem, TValue>[] = new Array(items.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      const item = items[index] as TItem;
      try {
        results[index] = { item, ok: true, value: await worker(item) };
      } catch (error: unknown) {
        results[index] = { item, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, items.length) }, () => runWorker()));
  return Object.freeze(results);
}
