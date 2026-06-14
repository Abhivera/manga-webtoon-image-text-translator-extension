"""
GLM-OCR Local Server
====================
Serves zai-org/GLM-OCR via an OpenAI-compatible /v1/chat/completions endpoint.
The Chrome extension connects here for local OCR + translation.

Usage:
    python app.py
    # Server starts at http://localhost:8080

Or with custom port:
    python app.py --port 9000
"""

import argparse
import base64
import io
import os
import sys
import tempfile
import time
import uuid

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel
from typing import Any, List, Optional, Union

# ──────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────
MODEL_PATH = "zai-org/GLM-OCR"
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8080

# ──────────────────────────────────────────────
# FastAPI App
# ──────────────────────────────────────────────
app = FastAPI(
    title="GLM-OCR Server",
    description="Local server for zai-org/GLM-OCR multimodal OCR model",
    version="1.0.0",
)

# Allow CORS from Chrome extension (chrome-extension:// origins)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────
# Global model references (loaded at startup)
# ──────────────────────────────────────────────
processor = None
model = None


def load_model():
    """Load GLM-OCR model and processor."""
    global processor, model

    print(f"\n{'='*50}")
    print(f"  Loading GLM-OCR model: {MODEL_PATH}")
    print(f"  This may take a few minutes on first run...")
    print(f"{'='*50}\n")

    from transformers import AutoProcessor, AutoModelForImageTextToText

    processor = AutoProcessor.from_pretrained(MODEL_PATH)

    # Detect device
    if torch.cuda.is_available():
        print(f"  CUDA GPU detected: {torch.cuda.get_device_name(0)}")
        print(f"  VRAM: {torch.cuda.get_device_properties(0).total_mem / 1e9:.1f} GB")
        dtype = torch.bfloat16
        device_map = "auto"
    else:
        print("  No CUDA GPU found. Running on CPU (slower).")
        dtype = torch.float32
        device_map = "cpu"

    model = AutoModelForImageTextToText.from_pretrained(
        MODEL_PATH,
        torch_dtype=dtype,
        device_map=device_map,
    )

    device = next(model.parameters()).device
    print(f"\n  Model loaded on: {device}")
    print(f"  Model parameters: {sum(p.numel() for p in model.parameters()) / 1e6:.0f}M")
    print(f"  Ready to serve requests!\n")


# ──────────────────────────────────────────────
# Pydantic models (OpenAI-compatible schema)
# ──────────────────────────────────────────────
class ChatRequest(BaseModel):
    model: str = MODEL_PATH
    messages: List[dict] = []
    max_tokens: int = 4096
    temperature: float = 0.1
    stream: bool = False


# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────
def decode_base64_image(data_url: str) -> bytes:
    """Extract raw image bytes from a base64 data-URI or plain base64 string."""
    if "base64," in data_url:
        _, encoded = data_url.split("base64,", 1)
    else:
        encoded = data_url
    return base64.b64decode(encoded)


def convert_messages_for_glmocr(messages: List[dict]):
    """
    Convert OpenAI-format messages (with image_url containing base64)
    into HuggingFace GLM-OCR format (with image file paths).
    Returns (hf_messages, temp_file_paths).
    """
    hf_messages = []
    temp_files = []

    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        # Simple text message
        if isinstance(content, str):
            hf_messages.append({
                "role": role,
                "content": [{"type": "text", "text": content}],
            })
            continue

        # Multimodal message (list of parts)
        if isinstance(content, list):
            parts = []
            for part in content:
                if not isinstance(part, dict):
                    continue

                part_type = part.get("type", "")

                if part_type == "text":
                    parts.append({
                        "type": "text",
                        "text": part.get("text", ""),
                    })

                elif part_type == "image_url":
                    # OpenAI format: {"type": "image_url", "image_url": {"url": "data:..."}}
                    image_info = part.get("image_url", {})
                    url = image_info.get("url", "") if isinstance(image_info, dict) else ""

                    if url and ("base64," in url or not url.startswith("http")):
                        # Decode base64 → save temp file → reference path
                        img_bytes = decode_base64_image(url)
                        tmp_name = f"glmocr_{uuid.uuid4().hex[:8]}.png"
                        tmp_path = os.path.join(tempfile.gettempdir(), tmp_name)

                        # Ensure it's a valid image (re-encode as PNG)
                        try:
                            img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
                            img.save(tmp_path, format="PNG")
                        except Exception:
                            # If PIL can't process it, write raw bytes
                            with open(tmp_path, "wb") as f:
                                f.write(img_bytes)

                        temp_files.append(tmp_path)
                        parts.append({"type": "image", "url": tmp_path})

                    elif url:
                        # Remote URL — pass directly
                        parts.append({"type": "image", "url": url})

                elif part_type == "image":
                    # Direct HuggingFace format
                    url = part.get("url", "")
                    if url:
                        parts.append({"type": "image", "url": url})

            hf_messages.append({"role": role, "content": parts})

    return hf_messages, temp_files


# ──────────────────────────────────────────────
# API Endpoints
# ──────────────────────────────────────────────
@app.get("/")
async def root():
    return {
        "name": "GLM-OCR Server",
        "model": MODEL_PATH,
        "status": "running",
        "endpoints": ["/v1/chat/completions", "/v1/models", "/health"],
    }


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": MODEL_PATH,
        "device": str(next(model.parameters()).device) if model else "not loaded",
        "cuda_available": torch.cuda.is_available(),
    }


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": MODEL_PATH,
                "object": "model",
                "created": int(time.time()),
                "owned_by": "local",
            }
        ],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatRequest):
    """
    OpenAI-compatible chat completions endpoint.
    Accepts images as base64 data-URIs in the image_url format.
    """
    if not model or not processor:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    temp_files = []
    try:
        # Convert OpenAI messages → GLM-OCR format
        hf_messages, temp_files = convert_messages_for_glmocr(request.messages)

        if not hf_messages:
            raise HTTPException(status_code=400, detail="No valid messages provided")

        # Tokenize with processor
        inputs = processor.apply_chat_template(
            hf_messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        ).to(model.device)

        # Remove token_type_ids if present (GLM-OCR doesn't need them)
        inputs.pop("token_type_ids", None)

        # Generate
        max_new = min(request.max_tokens, 8192)
        gen_kwargs = {
            "max_new_tokens": max_new,
        }

        # Use greedy decoding for low temperature, sampling for higher
        if request.temperature <= 0.01:
            gen_kwargs["do_sample"] = False
        else:
            gen_kwargs["do_sample"] = True
            gen_kwargs["temperature"] = request.temperature

        start_time = time.time()

        with torch.no_grad():
            generated_ids = model.generate(**inputs, **gen_kwargs)

        elapsed = time.time() - start_time

        # Decode output (skip input tokens)
        input_len = inputs["input_ids"].shape[1]
        output_ids = generated_ids[0][input_len:]
        output_text = processor.decode(output_ids, skip_special_tokens=True)

        # Log for debugging
        output_tokens = len(output_ids)
        print(f"  Generated {output_tokens} tokens in {elapsed:.1f}s "
              f"({output_tokens / max(elapsed, 0.01):.1f} tok/s)")

        return {
            "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": request.model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": output_text},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": int(input_len),
                "completion_tokens": int(output_tokens),
                "total_tokens": int(input_len + output_tokens),
            },
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"  [ERROR] {type(e).__name__}: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {str(e)}")
    finally:
        # Cleanup temp image files
        for f in temp_files:
            try:
                os.unlink(f)
            except OSError:
                pass


# ──────────────────────────────────────────────
# Entrypoint
# ──────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="GLM-OCR Local Server")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"Host (default: {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Port (default: {DEFAULT_PORT})")
    parser.add_argument("--model", default=MODEL_PATH, help=f"Model path (default: {MODEL_PATH})")
    args = parser.parse_args()

    MODEL_PATH = args.model
    load_model()

    print(f"\n  Server running at http://localhost:{args.port}")
    print(f"  Extension should connect to: http://localhost:{args.port}\n")

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
