FROM python:3.12-slim

WORKDIR /app

ENV PIP_DEFAULT_TIMEOUT=600
ENV PIP_RETRIES=5
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV MULTI_AGENT_WEB_HOST=0.0.0.0
ENV MULTI_AGENT_WEB_PORT=8765
ENV MULTI_AGENT_RUNS_DIR=/app/runs

# 国内 ECS：apt 走阿里云镜像
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    elif [ -f /etc/apt/sources.list ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list; \
    fi

COPY pyproject.toml README.md ./
COPY multi_agent ./multi_agent
COPY apps ./apps

RUN pip install --no-cache-dir --default-timeout=600 --retries 5 . \
    && mkdir -p /app/runs /app/logs

EXPOSE 8765

HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=20s \
  CMD python -c "import sys,urllib.request; b=urllib.request.urlopen('http://127.0.0.1:8765/api/health',timeout=3).read().decode(); sys.exit(0 if 'multi-agent-web' in b else 1)"

CMD ["python", "apps/web/app.py"]
