/**
 * Builds the Go CLI once, before any test file runs (CI fix, item AWBX43NKmEsei9JJf9cG): on a fresh
 * runner the first `go build` takes about half a minute (cold module and build cache), which used to
 * count against the first Go test's 30 s timeout. The path goes to the test workers through the
 * environment; without Go nothing is built and the Go suites skip themselves.
 */
import { GO, goBinary } from './gobin';

export default function setup() {
  if (!GO || process.env.HIVENOD_GO_BIN) return;
  const t0 = Date.now();
  process.env.HIVENOD_GO_BIN = goBinary();
  console.warn(`[go] CLI built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
