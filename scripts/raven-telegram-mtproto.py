#!/usr/bin/env python3
import argparse
import asyncio
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from telethon import TelegramClient
from telethon.sessions import StringSession

MAX_BYTES = 2_147_483_647


def env_required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def post_json(url: str, payload: dict) -> None:
    if not url:
        return
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "Raven-GitHub-Builder/4.0"},
        method="POST",
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                if 200 <= response.status < 300:
                    return
        except Exception:
            if attempt == 2:
                return
            time.sleep(0.5 * (attempt + 1))


class Callback:
    def __init__(self) -> None:
        self.url = os.environ.get("CALLBACK_URL", "").strip()
        self.secret = os.environ.get("CALLBACK_SECRET", "")
        self.job_id = os.environ.get("JOB_ID", "")
        self.last_percent = -1
        self.last_report = 0.0

    def send(self, status: str, stage: str, progress: int = 0, **extra) -> None:
        now = time.time()
        percent = max(0, min(100, int(progress)))
        if stage.endswith("_PROGRESS") and percent == self.last_percent and now - self.last_report < 8:
            return
        self.last_percent = percent
        self.last_report = now
        payload = {
            "jobId": self.job_id,
            "secret": self.secret,
            "status": status,
            "stage": stage,
            "progress": percent,
        }
        payload.update(extra)
        post_json(self.url, payload)



async def build_client() -> TelegramClient:
    api_id = int(env_required("TELEGRAM_API_ID"))
    api_hash = env_required("TELEGRAM_API_HASH")
    bot_token = env_required("TOKEN_BOT")
    client = TelegramClient(
        StringSession(),
        api_id,
        api_hash,
        connection_retries=2,
        request_retries=2,
        retry_delay=2,
        auto_reconnect=True,
        sequential_updates=False,
    )
    await asyncio.wait_for(client.start(bot_token=bot_token), timeout=75)
    return client


async def download_source(callback: Callback) -> Path:
    chat_id = int(env_required("SOURCE_CHAT_ID"))
    message_id = int(env_required("SOURCE_MESSAGE_ID"))
    target = Path(env_required("SOURCE_PATH"))
    expected_size = int(os.environ.get("SOURCE_SIZE", "0") or 0)
    if expected_size > MAX_BYTES:
        raise RuntimeError(f"Source exceeds {MAX_BYTES} bytes.")

    callback.send("running", "TELEGRAM_CONNECTING", 12, source_size=expected_size)
    client = await build_client()
    try:
        callback.send("running", "TELEGRAM_SESSION_READY", 13, source_size=expected_size)
        message = await asyncio.wait_for(client.get_messages(chat_id, ids=message_id), timeout=30)
        if not message or not message.file:
            raise RuntimeError("Pesan Telegram tidak memiliki file document yang dapat diunduh.")
        media_size = int(getattr(message.file, "size", 0) or 0)
        if media_size > MAX_BYTES:
            raise RuntimeError(f"Telegram source {media_size} bytes melebihi batas 2 GB.")
        callback.send("running", "SOURCE_DOWNLOAD_START", 4, source_size=media_size or expected_size)

        def progress(current: int, total: int) -> None:
            pct = int((current * 100) / total) if total else 0
            callback.send(
                "running",
                "SOURCE_DOWNLOAD_PROGRESS",
                pct,
                bytes_current=int(current),
                bytes_total=int(total or media_size or expected_size),
            )

        media = message.media
        written = 0
        with target.open('wb') as handle:
            async for chunk in client.iter_download(media, request_size=512 * 1024):
                handle.write(chunk)
                written += len(chunk)
                progress(written, media_size or expected_size)
        if media_size and written != media_size:
            raise RuntimeError(f"Source ZIP tidak lengkap. Diterima {written} dari {media_size} bytes.")
        if not target.exists() or target.stat().st_size <= 0:
            raise RuntimeError("Source ZIP tidak berhasil diunduh.")
        actual = target.stat().st_size
        if actual > MAX_BYTES:
            raise RuntimeError("Source ZIP melebihi batas 2 GB setelah diunduh.")
        callback.send("running", "SOURCE_DOWNLOADED", 24, source_size=actual, source_sha256=sha256(target))
        return target
    finally:
        await client.disconnect()


async def send_file(callback: Callback) -> Path:
    target_chat = int(env_required("TARGET_CHAT_ID"))
    kind = os.environ.get("OUTPUT_KIND", "apk").strip().lower()
    if kind == "zip":
        raw_path = os.environ.get("OUTPUT_PATH", "").strip()
    else:
        raw_path = os.environ.get("APK_PATH", "").strip()
    if not raw_path:
        raise RuntimeError("Path output belum diset.")
    file_path = Path(raw_path).resolve()
    if not file_path.is_file():
        raise RuntimeError(f"File output tidak ditemukan: {file_path}")
    size = file_path.stat().st_size
    if size <= 0 or size > MAX_BYTES:
        raise RuntimeError("Output file tidak valid atau melebihi 2 GB.")

    success_stage = "OUTPUT_SENT" if kind == "zip" else "APK_SENT"
    upload_stage = "OUTPUT_UPLOAD_PROGRESS" if kind == "zip" else "APK_UPLOAD_PROGRESS"
    size_key = "output_size" if kind == "zip" else "apk_size"
    filename_key = "output_filename" if kind == "zip" else "apk_filename"
    caption = os.environ.get("OUTPUT_CAPTION", "").strip() or os.environ.get("APK_CAPTION", "✅ APK BUILD SELESAI")
    caption = caption[:1000]

    callback.send("running", "TELEGRAM_CONNECTING", 93, **{size_key: size, filename_key: file_path.name})
    client = await build_client()
    started = time.time()
    try:
        callback.send("running", "SENDING_APK", 95, **{size_key: size, filename_key: file_path.name})

        def progress(current: int, total: int) -> None:
            pct = int((current * 100) / total) if total else 0
            callback.send(
                "running",
                upload_stage,
                pct,
                bytes_current=int(current),
                bytes_total=int(total or size),
                **{size_key: size, filename_key: file_path.name},
            )

        await client.send_file(
            target_chat,
            str(file_path),
            caption=caption,
            force_document=True,
            parse_mode="html",
            part_size_kb=512,
            progress_callback=progress,
        )
        elapsed = int(time.time() - started)
        callback.send(
            "success",
            success_stage,
            100,
            **{size_key: size, filename_key: file_path.name, "elapsed_seconds": elapsed},
        )
        return file_path
    finally:
        await client.disconnect()

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(4 * 1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


async def main() -> int:
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
        callback.send("failure", "TELEGRAM_TRANSFER_FAILED", 90, error=message[:1800])
        print(message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
