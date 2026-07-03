FROM python:3.12-slim

WORKDIR /app

ENV PIP_DEFAULT_TIMEOUT=600
ENV PIP_RETRIES=5
# 阿里云等国内环境优先走镜像；可在 build 时覆盖：--build-arg HF_ENDPOINT=https://huggingface.co
ARG HF_ENDPOINT=https://hf-mirror.com
ENV HF_ENDPOINT=${HF_ENDPOINT}
ENV HUGGINGFACE_HUB_CACHE=/app/.cache/huggingface

ARG KB_EMBED_MODEL=BAAI/bge-small-zh-v1.5
ENV KB_EMBED_MODEL=${KB_EMBED_MODEL}

# 国内 ECS：apt 走阿里云镜像，避免 deb.debian.org 下载超时
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    elif [ -f /etc/apt/sources.list ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list; \
    fi

# Tesseract OCR（图片 OCR 本地引擎）
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-chi-sim \
        tesseract-ocr-chi-tra \
        tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --no-cache-dir --default-timeout=600 --retries 5 \
      torch --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir --default-timeout=600 --retries 5 -r requirements.txt

# 预下载 embedding 模型（失败不阻断镜像构建，运行时仍会懒加载）
RUN mkdir -p /app/.cache/huggingface \
    && (python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('${KB_EMBED_MODEL}')" \
        || echo "[build] WARN: preload ${KB_EMBED_MODEL} failed, will load at runtime")

COPY main.py .
COPY backend ./backend
COPY skills ./skills
COPY scripts/docker/backend-entrypoint.sh /app/scripts/docker/backend-entrypoint.sh
COPY schema.sql .

RUN chmod +x /app/scripts/docker/backend-entrypoint.sh

ENV PYTHONPATH=/app
EXPOSE 8000

ENTRYPOINT ["/app/scripts/docker/backend-entrypoint.sh"]
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
