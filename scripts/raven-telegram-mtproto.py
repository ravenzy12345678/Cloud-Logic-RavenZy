import argparse
import asyncio
import hashlib
import json
import os
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from telethon import TelegramClient, functions, types
from telethon.sessions import StringSession

MAX_BYTES = 2_147_483_647
PROGRESS_INTERVAL = 6.0


def env_required(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def post_json(url, payload):
    if not url:
        return
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    for attempt in range(3):
        try:
            request = urllib.request.Request(
                url,
                data=body,
                headers={"Content-Type": "application/json", "User-Agent": "Raven-GitHub-Builder/5.0"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=25) as response:
                if 200 <= response.status < 300:
                    return
        except Exception:
            time.sleep(1.0 * (attempt + 1))


class Callback:
    def __init__(self):
        self.url = os.environ.get("CALLBACK_URL", "").strip()
        self.secret = os.environ.get("CALLBACK_SECRET", "")
        self.job_id = os.environ.get("JOB_ID", "")
        self.run_id = os.environ.get("GITHUB_RUN_ID", "")
        self.last_report = 0.0
        self.last_percent = -1
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.lock = threading.Lock()

    def send(self, status, stage, progress=0, wait=True, **extra):
        percent = max(0, min(100, int(progress)))
        now = time.time()
        if stage.endswith("_PROGRESS"):
            with self.lock:
                if percent == self.last_percent or now - self.last_report < PROGRESS_INTERVAL:
                    return
                self.last_percent = percent
                self.last_report = now
            wait = False
        payload = {
            "jobId": self.job_id,
            "secret": self.secret,
            "status": status,
            "stage": stage,
            "progress": percent,
            "runId": self.run_id,
        }
        payload.update(extra)
        future = self.pool.submit(post_json, self.url, payload)
        if wait:
            try:
                future.result(timeout=90)
            except Exception:
                pass

    def close(self):
        self.pool.shutdown(wait=True)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(4 * 1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


async def build_client():
    api_id = int(env_required("TELEGRAM_API_ID"))
    api_hash = env_required("TELEGRAM_API_HASH")
    bot_token = env_required("TOKEN_BOT")
    last_error = None
    for attempt in range(3):
        client = TelegramClient(
            StringSession(),
            api_id,
            api_hash,
            connection_retries=5,
            request_retries=5,
            retry_delay=2,
            auto_reconnect=True,
            sequential_updates=False,
        )
        try:
            await asyncio.wait_for(client.start(bot_token=bot_token), timeout=90)
            return client
        except Exception as exc:
            last_error = exc
            try:
                await client.disconnect()
            except Exception:
                pass
            await asyncio.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Gagal login ke Telegram: {last_error}")


async def fetch_message(client, chat_id, message_id):
    message = None
    try:
        message = await asyncio.wait_for(client.get_messages(chat_id, ids=message_id), timeout=45)
    except Exception:
        message = None
    if message and getattr(message, "media", None):
        return message
    result = await asyncio.wait_for(
        client(functions.messages.GetMessagesRequest(id=[types.InputMessageID(id=message_id)])),
        timeout=45,
    )
    for item in getattr(result, "messages", []) or []:
        if getattr(item, "id", None) == message_id and getattr(item, "media", None):
            return item
    return None


async def download_source(callback):
    chat_id = int(env_required("SOURCE_CHAT_ID"))
    message_id = int(env_required("SOURCE_MESSAGE_ID"))
    target = Path(env_required("SOURCE_PATH"))
    expected_size = int(os.environ.get("SOURCE_SIZE", "0") or 0)
    if expected_size > MAX_BYTES:
        raise RuntimeError(f"Source melebihi batas {MAX_BYTES} bytes.")
    callback.send("running", "TELEGRAM_CONNECTING", 12, source_size=expected_size)
    client = await build_client()
    try:
        callback.send("running", "TELEGRAM_SESSION_READY", 13, source_size=expected_size)
        message = await fetch_message(client, chat_id, message_id)
        if not message or not getattr(message, "media", None):
            raise RuntimeError("Pesan Telegram tidak memiliki file yang dapat diunduh.")
        media_size = int(getattr(getattr(message, "file", None), "size", 0) or 0)
        if media_size > MAX_BYTES:
            raise RuntimeError(f"Source {media_size} bytes melebihi batas 2 GB.")
        total = media_size or expected_size
        callback.send("running", "SOURCE_DOWNLOAD_START", 14, source_size=total)
        written = 0
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("wb") as handle:
            async for chunk in client.iter_download(message.media, request_size=1024 * 1024):
                handle.write(chunk)
                written += len(chunk)
                pct = int((written * 100) / total) if total else 0
                callback.send(
                    "running",
                    "SOURCE_DOWNLOAD_PROGRESS",
                    pct,
                    bytes_current=int(written),
                    bytes_total=int(total),
                )
        if media_size and written != media_size:
            raise RuntimeError(f"Source tidak lengkap. Diterima {written} dari {media_size} bytes.")
        if not target.exists() or target.stat().st_size <= 0:
            raise RuntimeError("Source tidak berhasil diunduh.")
        actual = target.stat().st_size
        if actual > MAX_BYTES:
            raise RuntimeError("Source melebihi batas 2 GB setelah diunduh.")
        callback.send("running", "SOURCE_DOWNLOADED", 24, source_size=actual, source_sha256=sha256(target))
        return target
    finally:
        await client.disconnect()


async def send_file(callback):
    target_chat = int(env_required("TARGET_CHAT_ID"))
    kind = os.environ.get("OUTPUT_KIND", "apk").strip().lower()
    raw_path = os.environ.get("APK_PATH", "").strip() if kind == "apk" else os.environ.get("OUTPUT_PATH", "").strip()
    if not raw_path:
        raw_path = os.environ.get("OUTPUT_PATH", "").strip() or os.environ.get("APK_PATH", "").strip()
    if not raw_path:
        raise RuntimeError("Path output belum diset.")
    file_path = Path(raw_path).resolve()
    if not file_path.is_file():
        raise RuntimeError(f"File output tidak ditemukan: {file_path}")
    size = file_path.stat().st_size
    if size <= 0 or size > MAX_BYTES:
        raise RuntimeError("Output file tidak valid atau melebihi 2 GB.")
    caption = (os.environ.get("OUTPUT_CAPTION", "").strip() or os.environ.get("APK_CAPTION", "").strip() or "✅ Selesai")[:1000]
    if kind == "log":
        success_stage, upload_stage, size_key, filename_key = "LOG_SENT", "LOG_UPLOAD_PROGRESS", "log_size", "log_filename"
    elif kind == "zip":
        success_stage, upload_stage, size_key, filename_key = "OUTPUT_SENT", "OUTPUT_UPLOAD_PROGRESS", "output_size", "output_filename"
    else:
        success_stage, upload_stage, size_key, filename_key = "APK_SENT", "APK_UPLOAD_PROGRESS", "apk_size", "apk_filename"
    meta = {size_key: size, filename_key: file_path.name}
    if kind != "log":
        callback.send("running", "TELEGRAM_CONNECTING", 93, **meta)
    client = await build_client()
    started = time.time()
    try:
        if kind != "log":
            callback.send("running", "SENDING_APK", 95, **meta)

        def progress(current, total):
            pct = int((current * 100) / total) if total else 0
            if kind != "log":
                callback.send("running", upload_stage, pct, bytes_current=int(current), bytes_total=int(total or size), **meta)

        sent = await client.send_file(
            target_chat,
            str(file_path),
            caption=caption,
            force_document=True,
            parse_mode="html",
            part_size_kb=512,
            progress_callback=progress,
        )
        message_id = int(getattr(sent, "id", 0) or 0)
        elapsed = int(time.time() - started)
        if kind == "log":
            callback.send("running", success_stage, 95, log_sent=True, **meta)
        else:
            callback.send("success", success_stage, 100, elapsed_seconds=elapsed, output_message_id=message_id, **meta)
        return file_path
    finally:
        await client.disconnect()


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["download-source", "send-file"])
    args = parser.parse_args()
    callback = Callback()
    try:
        if args.command == "download-source":
            await download_source(callback)
        else:
            await send_file(callback)
        return 0
    except Exception as exc:
        message = str(exc).replace(os.environ.get("TOKEN_BOT", ""), "[REDACTED]")
        print(message, file=sys.stderr)
        return 1
    finally:
        callback.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
