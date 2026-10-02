import json
import os
import sys
import time
import urllib.request

NUMERIC = {"apk_size", "output_size", "source_size", "elapsed_seconds"}
BOOLEAN = {"log_sent"}


def main():
    url = os.environ.get("CALLBACK_URL", "").strip()
    if not url or len(sys.argv) < 4:
        return 0
    payload = {
        "jobId": os.environ.get("JOB_ID", ""),
        "secret": os.environ.get("CALLBACK_SECRET", ""),
        "status": sys.argv[1],
        "stage": sys.argv[2],
        "progress": int(float(sys.argv[3] or 0)),
        "runId": os.environ.get("GITHUB_RUN_ID", ""),
    }
    for item in sys.argv[4:]:
        if "=" not in item:
            continue
        key, value = item.split("=", 1)
        if key in NUMERIC:
            try:
                payload[key] = int(float(value))
            except ValueError:
                continue
        elif key in BOOLEAN:
            payload[key] = value.strip().lower() in ("1", "true", "yes")
        else:
            payload[key] = value
    token = os.environ.get("TOKEN_BOT", "")
    if token and isinstance(payload.get("error"), str):
        payload["error"] = payload["error"].replace(token, "[REDACTED]")
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    for attempt in range(4):
        try:
            request = urllib.request.Request(
                url,
                data=body,
                headers={"Content-Type": "application/json", "User-Agent": "Raven-Worker"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=25) as response:
                response.read()
            return 0
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
