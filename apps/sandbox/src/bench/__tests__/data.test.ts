import { realisticRows, realisticRowsChunked } from '../data';

describe('realisticRowsChunked', () => {
  it('is byte-identical to a single build across chunk boundaries', async () => {
    // 25k spans three chunks (10k + 10k + 5k)
    expect(await realisticRowsChunked(25_000, 7, 3)).toBe(realisticRows(25_000, 7, 3));
  });

  it('passes small sizes straight through', async () => {
    expect(await realisticRowsChunked(100, 1, 0)).toBe(realisticRows(100, 1, 0));
  });
});

describe('realisticRows startIndex', () => {
  it('offsets rows so a slice of a big build matches a chunked build', () => {
    const whole = JSON.parse(realisticRows(30, 5, 2)) as unknown[];
    const tail = JSON.parse(realisticRows(10, 5, 2, 20)) as unknown[];
    expect(tail).toEqual(whole.slice(20));
  });
});
