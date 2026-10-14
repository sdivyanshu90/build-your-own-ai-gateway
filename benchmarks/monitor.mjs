// Low-frequency host and gateway snapshots for interpreting long benchmark runs.
import { appendFileSync, readFileSync } from 'node:fs';
const output = process.argv[2];
if (!output) throw new Error('Usage: node monitor.mjs <output.jsonl>');
let stopped = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopped = true;
  });
while (!stopped) {
  const sample = {
    at: new Date().toISOString(),
    loadAverage: readFileSync('/proc/loadavg', 'utf8').trim(),
    availableMemoryKiB: Number(
      /MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))[1],
    ),
  };
  try {
    const response = await fetch('http://127.0.0.1:18080/metrics', {
      signal: AbortSignal.timeout(3000),
    });
    sample.metrics = (await response.text())
      .split('\n')
      .filter((line) =>
        /^(gateway_http_requests_total|gateway_in_flight_requests|gateway_request_logs_dropped_total|gateway_provider_requests_total|process_cpu_seconds_total|process_resident_memory_bytes|nodejs_eventloop_lag_seconds|nodejs_heap_size_used_bytes)[{ ]/.test(
          line,
        ),
      );
  } catch (error) {
    sample.error = error.message;
  }
  appendFileSync(output, JSON.stringify(sample) + '\n');
  await new Promise((resolve) => setTimeout(resolve, 10000));
}
