"""Standalone microphone transcriber using Faster-Whisper.

Run from the project folder:

    python backend\\whisper_transcriber.py

This is separate from the Lilt web app. It listens continuously, detects
speech, transcribes each utterance with Whisper, and prints the text to the
terminal. The first run downloads the base.en model.
"""

import queue
import sys

import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel

SAMPLE_RATE = 16000
BLOCK_SECONDS = 0.1
BLOCK_SIZE = int(SAMPLE_RATE * BLOCK_SECONDS)
SPEECH_RMS_THRESHOLD = 0.01
SILENCE_END_SECONDS = 0.8
MIN_SPEECH_SECONDS = 0.3
MAX_UTTERANCE_SECONDS = 30
PRE_ROLL_BLOCKS = 3

model = WhisperModel("base.en", device="cpu", compute_type="int8")
audio_queue: "queue.Queue[np.ndarray]" = queue.Queue()


def on_audio(indata, frames, time_info, status):
    if status:
        print(status, file=sys.stderr)
    audio_queue.put(indata[:, 0].copy())


def transcribe(blocks: list[np.ndarray]) -> str:
    audio = np.concatenate(blocks).astype(np.float32)
    segments, _ = model.transcribe(
        audio,
        language="en",
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    return " ".join(segment.text.strip() for segment in segments).strip()


def main() -> None:
    pre_roll: list[np.ndarray] = []
    utterance: list[np.ndarray] = []
    in_speech = False
    silent_blocks = 0
    silence_limit = int(SILENCE_END_SECONDS / BLOCK_SECONDS)
    min_blocks = int(MIN_SPEECH_SECONDS / BLOCK_SECONDS)
    max_blocks = int(MAX_UTTERANCE_SECONDS / BLOCK_SECONDS)

    print("listening", file=sys.stderr)
    with sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="float32",
        blocksize=BLOCK_SIZE,
        callback=on_audio,
    ):
        try:
            while True:
                block = audio_queue.get()
                rms = float(np.sqrt(np.mean(block ** 2)))

                if not in_speech:
                    pre_roll.append(block)
                    pre_roll = pre_roll[-PRE_ROLL_BLOCKS:]
                    if rms >= SPEECH_RMS_THRESHOLD:
                        in_speech = True
                        utterance = pre_roll.copy()
                        silent_blocks = 0
                    continue

                utterance.append(block)
                silent_blocks = silent_blocks + 1 if rms < SPEECH_RMS_THRESHOLD else 0

                if silent_blocks >= silence_limit or len(utterance) >= max_blocks:
                    if len(utterance) - silent_blocks >= min_blocks:
                        text = transcribe(utterance)
                        if text:
                            print(text, flush=True)
                    utterance = []
                    pre_roll = []
                    in_speech = False
                    silent_blocks = 0
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()