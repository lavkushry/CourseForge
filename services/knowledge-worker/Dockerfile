# Living Video Knowledge ingest worker. Targets linux/arm64 and amd64 CPU.
# Do not bake large Whisper weights into the image; models download at runtime
# into a mounted volume when CF_WHISPER_MODEL is set.
FROM python:3.12.7-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      tesseract-ocr \
      tesseract-ocr-eng \
      libgl1 \
      libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt requirements-ml.txt ./
RUN pip install --no-cache-dir -r requirements-ml.txt

COPY knowledge_worker ./knowledge_worker

ENV PYTHONUNBUFFERED=1 \
    CF_KNOWLEDGE_API_URL=http://api:8090 \
    CF_QDRANT_URL=http://qdrant:6333 \
    CF_QDRANT_COLLECTION=courseforge_living_video \
    CF_WHISPER_MODEL=tiny \
    CF_WHISPER_DEVICE=cpu \
    CF_WHISPER_COMPUTE_TYPE=int8

USER nobody
CMD ["python", "-m", "knowledge_worker"]
