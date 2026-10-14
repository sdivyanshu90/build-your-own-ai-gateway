"""Export benchmark figures. Requires matplotlib; no pandas or network access."""
import datetime
import json
import pathlib
import re
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

label = sys.argv[1]
root = pathlib.Path(__file__).resolve().parent
results = root / "results"


def load(name):
    return json.loads((results / f"{name}.json").read_text())


def at(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


def metric(sample, prefix, chat_only=False):
    return sum(
        float(line.rsplit(" ", 1)[1])
        for line in sample.get("metrics", [])
        if line.startswith(prefix)
        and (not chat_only or 'route="/v1/chat/completions"' in line)
    )


short = load(f"throughput-{label}")["steps"]
long = load(f"throughput-{label}-sustained")["steps"]
fig, axes = plt.subplots(2, 2, figsize=(13, 8), constrained_layout=True)
fig.suptitle("AI gateway — Ryzen 7 8845HS, one WSL core, 20 ms mock", fontsize=16)

for rows, name, color in [(short, "15 s per point", "#2563eb"), (long, "75 s per point", "#059669")]:
    axes[0, 0].plot([r["connections"] for r in rows], [r["rps"] for r in rows], "o-", label=name, color=color)
axes[0, 0].set(title="Completed response rate", ylabel="Requests / second", xlabel="Connections")
axes[0, 0].legend()
for field, title, color in [("p50", "p50", "#2563eb"), ("p99", "p99", "#d97706")]:
    axes[0, 1].plot([r["connections"] for r in long], [r["latencyMs"][field] for r in long], "o-", label=title, color=color)
axes[0, 1].set(title="75-second sweep latency", ylabel="Milliseconds", xlabel="Connections")
axes[0, 1].legend()
for ax in axes[0]:
    ax.set_xscale("log", base=2)
    ax.set_xticks([8, 16, 32, 64, 128, 192], ["8", "16", "32", "64", "128", "192"])
    ax.set_ylim(bottom=0)

repeats = [json.loads(p.read_text()) for p in sorted(results.glob(f"overhead-{label}*.json"))]
names, medians, low, high = [], [], [], []
for index in range(4):
    row = repeats[0]["runs"][index]
    values = sorted(r["runs"][index]["overheadMs"]["p50"] for r in repeats)
    median = values[len(values) // 2]
    names.append(f"{row['adapter'].split('-')[0]}\nc={row['connections']}")
    medians.append(median)
    low.append(median - min(values))
    high.append(max(values) - median)
axes[1, 0].bar(names, medians, yerr=[low, high], capsize=5, color="#2563eb")
axes[1, 0].set(title=f"Paired p50 overhead ({len(repeats)} runs; range whiskers)", ylabel="Gateway − direct latency, ms")

log = (results / f"run-K-{label}.log").read_text()
start = at(re.search(r"\[k6\] stress starting (\S+)", log)[1])
end = at(re.search(r"\[k6\] failover starting (\S+)", log)[1])
samples = [json.loads(line) for line in (results / f"monitor-{label}.jsonl").read_text().splitlines()]
samples = [s for s in samples if start <= at(s["at"]) <= end and s.get("metrics")]
times, rates, drops, gaps = [], [], [], []
for a, b in zip(samples, samples[1:]):
    duration = (at(b["at"]) - at(a["at"])).total_seconds()
    elapsed = (at(b["at"]) - start).total_seconds() / 60
    if duration > 30:
        rates.append(float("nan"))
        gaps.append(((at(a["at"]) - start).total_seconds() / 60, elapsed))
    else:
        rates.append((metric(b, "gateway_http_requests_total", True) - metric(a, "gateway_http_requests_total", True)) / duration)
    times.append(elapsed)
    drops.append(metric(b, "gateway_request_logs_dropped_total"))
axes[1, 1].plot(times, rates, color="#2563eb", label="Responses / second")
right = axes[1, 1].twinx()
right.plot(times, drops, color="#dc2626", label="Audit entries dropped (cumulative)")
right.set_ylabel("Cumulative audit entries dropped", color="#dc2626")
right.ticklabel_format(axis="y", style="plain")
for begin, finish in gaps:
    axes[1, 1].axvspan(begin, finish, color="#9ca3af", alpha=0.25)
axes[1, 1].set(title="Full stress schedule (shading: monitor gap)", xlabel="Elapsed wall-clock minutes", ylabel="Responses / second")
axes[1, 1].set_ylim(bottom=0)
right.set_ylim(bottom=0)
for ax in axes.flat:
    ax.grid(axis="y", alpha=0.2)
    ax.spines["top"].set_visible(False)
fig.savefig(results / f"overview-{label}.png", dpi=180)
fig.savefig(results / f"overview-{label}.svg")
print(results / f"overview-{label}.png")
