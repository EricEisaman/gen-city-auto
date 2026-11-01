// GPU pass timing with the timestamp-query feature (URL flag ?prof=1).
// Every timed pass gets a begin/end timestamp pair; results are read back a
// few frames late through a small ring of mappable buffers and averaged over
// a window of frames into `averages` (ms per pass label). Without the flag the
// renderer never creates a profiler and passes carry no timestampWrites.
//
// Chrome quantizes timestamps to 100 us unless launched with
// --enable-dawn-features=allow_unsafe_apis (test/puppeteer/prof.mjs does).

const MAX_PAIRS = 96;
const RING = 4;

export class GpuProfiler {
  private device: GPUDevice;
  private querySet: GPUQuerySet;
  private resolve: GPUBuffer;
  private free: GPUBuffer[] = [];
  private labels: string[] = [];
  private active = false;
  private current: GPUBuffer | null = null;
  private sums = new Map<string, number>();
  private rawSums = new Map<string, number>();
  private frames = 0;
  /** Per-frame GPU span (first pass start .. last pass end), for medians. */
  spans: number[] = [];
  /**
   * The frame number (frames counts beginFrame calls) of each span: readbacks
   * can land many frames late under uncapped rendering, so a measurement
   * after a change must select spans by frame, not by arrival.
   */
  spanFrames: number[] = [];
  frameCount = 0;
  /** Each pass's own begin..end interval (overlaps neighbours on TBDR). */
  raw: Record<string, number> = {};
  /** Averaged GPU ms per pass label over the last window, plus `total`. */
  averages: Record<string, number> = {};
  /** Frames per averaging window. */
  window = 30;

  constructor(device: GPUDevice) {
    this.device = device;
    this.querySet = device.createQuerySet({
      label: 'prof/timestamps',
      type: 'timestamp',
      count: MAX_PAIRS * 2,
    });
    this.resolve = device.createBuffer({
      label: 'prof/resolve',
      size: MAX_PAIRS * 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    for (let i = 0; i < RING; i++)
      this.free.push(
        device.createBuffer({
          label: `prof/readback${i}`,
          size: MAX_PAIRS * 16,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
      );
  }

  /** Start a frame; timestamps are only written when a readback is free. */
  beginFrame() {
    this.frameCount++;
    this.labels = [];
    this.current = this.free.pop() ?? null;
    this.active = !!this.current;
  }

  /** timestampWrites for a pass labelled `label` (undefined when inactive). */
  writes(label: string): GPUComputePassTimestampWrites | undefined {
    if (!this.active || this.labels.length >= MAX_PAIRS) return undefined;
    const i = this.labels.length;
    this.labels.push(label);
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: i * 2,
      endOfPassWriteIndex: i * 2 + 1,
    };
  }

  /** Resolve this frame's queries (call before encoder.finish()). */
  endFrame(enc: GPUCommandEncoder) {
    if (!this.current || !this.labels.length) return;
    const n = this.labels.length * 2;
    enc.resolveQuerySet(this.querySet, 0, n, this.resolve, 0);
    enc.copyBufferToBuffer(this.resolve, 0, this.current, 0, n * 8);
  }

  /** Map the readback after submit and fold it into the running window. */
  afterSubmit() {
    const buf = this.current;
    this.current = null;
    this.active = false;
    if (!buf) return;
    const labels = this.labels;
    const frame = this.frameCount;
    if (!labels.length) {
      this.free.push(buf);
      return;
    }
    buf.mapAsync(GPUMapMode.READ).then(
      () => {
        const t = new BigInt64Array(buf.getMappedRange(), 0, labels.length * 2);
        // Apple (tile-based) GPUs overlap consecutive passes, so a pass's own
        // begin..end interval includes work of its neighbours. A pass is
        // charged its exclusive time: from the later of its start and the
        // previous passes' latest end, to its own end (0 when it finished
        // inside an earlier pass's interval). These sum to the frame span.
        let first = t[0];
        let maxEnd = t[0];
        const add = (m: Map<string, number>, k: string, v: number) =>
          m.set(k, (m.get(k) ?? 0) + v);
        let sum = 0;
        for (let i = 0; i < labels.length; i++) {
          const a = t[i * 2];
          const b = t[i * 2 + 1];
          if (a < first) first = a;
          const start = a > maxEnd ? a : maxEnd;
          const ex = b > start ? Number(b - start) / 1e6 : 0;
          if (b > maxEnd) maxEnd = b;
          add(this.sums, labels[i], ex);
          add(this.rawSums, labels[i], b > a ? Number(b - a) / 1e6 : 0);
          sum += ex;
        }
        buf.unmap();
        this.free.push(buf);
        add(this.sums, 'sum', sum);
        const span = maxEnd > first ? Number(maxEnd - first) / 1e6 : 0;
        add(this.sums, 'span', span);
        if (this.spans.length < 4096) {
          this.spans.push(span);
          this.spanFrames.push(frame);
        }
        if (++this.frames >= this.window) {
          const avg: Record<string, number> = {};
          for (const [k, s] of this.sums) avg[k] = s / this.frames;
          this.averages = avg;
          const raw: Record<string, number> = {};
          for (const [k, s] of this.rawSums) raw[k] = s / this.frames;
          this.raw = raw;
          this.sums.clear();
          this.rawSums.clear();
          this.frames = 0;
        }
      },
      () => this.free.push(buf),
    );
  }
}

/** CPU timings per subsystem (ms), averaged over the same kind of window. */
export class CpuProfiler {
  private sums = new Map<string, number>();
  private frames = 0;
  private t = 0;
  averages: Record<string, number> = {};
  window = 30;

  start() {
    this.t = performance.now();
  }

  /** Time since the previous mark (or start) is charged to `label`. */
  mark(label: string) {
    const now = performance.now();
    this.sums.set(label, (this.sums.get(label) ?? 0) + now - this.t);
    this.t = now;
  }

  endFrame(total: number) {
    this.sums.set('total', (this.sums.get('total') ?? 0) + total);
    if (++this.frames >= this.window) {
      const avg: Record<string, number> = {};
      for (const [k, s] of this.sums) avg[k] = s / this.frames;
      this.averages = avg;
      this.sums.clear();
      this.frames = 0;
    }
  }
}

/**
 * Whole-frame GPU time from one timestamp pair: the start of the frame's
 * first pass and the end of its last (the tonemap, which depends on every
 * other pass). For the dynamic render scale and the frame-time readout;
 * results arrive a few frames late.
 */
export class FrameTimer {
  private querySet: GPUQuerySet;
  private resolve: GPUBuffer;
  private free: GPUBuffer[] = [];
  private current: GPUBuffer | null = null;
  /** Latest frame span in ms (0 until the first readback). */
  ms = 0;
  /** Bumped on every readback. */
  samples = 0;

  constructor(device: GPUDevice) {
    this.querySet = device.createQuerySet({
      label: 'frame timer/timestamps',
      type: 'timestamp',
      count: 2,
    });
    this.resolve = device.createBuffer({
      label: 'frame timer/resolve',
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    for (let i = 0; i < 3; i++)
      this.free.push(
        device.createBuffer({
          label: `frame timer/readback${i}`,
          size: 16,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
      );
  }

  beginFrame() {
    this.current = this.free.pop() ?? null;
  }

  /** Timestamp writes for the frame's first / last pass (when active). */
  first(): GPUComputePassTimestampWrites | undefined {
    return this.current
      ? {querySet: this.querySet, beginningOfPassWriteIndex: 0}
      : undefined;
  }

  last(): GPURenderPassTimestampWrites | undefined {
    return this.current
      ? {querySet: this.querySet, endOfPassWriteIndex: 1}
      : undefined;
  }

  endFrame(enc: GPUCommandEncoder) {
    if (!this.current) return;
    enc.resolveQuerySet(this.querySet, 0, 2, this.resolve, 0);
    enc.copyBufferToBuffer(this.resolve, 0, this.current, 0, 16);
  }

  afterSubmit() {
    const buf = this.current;
    this.current = null;
    if (!buf) return;
    buf.mapAsync(GPUMapMode.READ).then(
      () => {
        const t = new BigInt64Array(buf.getMappedRange(), 0, 2);
        const ms = t[1] > t[0] ? Number(t[1] - t[0]) / 1e6 : 0;
        buf.unmap();
        this.free.push(buf);
        // (Ignore implausible spans: a missed write reads as 0 or garbage.)
        if (ms > 0 && ms < 1000) {
          this.ms = ms;
          this.samples++;
        }
      },
      () => this.free.push(buf),
    );
  }

  destroy() {
    this.querySet.destroy();
    this.resolve.destroy();
    for (const b of this.free) b.destroy();
  }
}
