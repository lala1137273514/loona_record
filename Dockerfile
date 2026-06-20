FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8787

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --no-cache-dir --upgrade pip \
  && python -m pip install --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cpu \
    torch==2.8.0 \
    torchaudio==2.8.0

COPY python_wake_service/requirements.txt /app/python_wake_service/requirements.txt
RUN python -m pip install --no-cache-dir -r /app/python_wake_service/requirements.txt

COPY python_wake_service /app/python_wake_service

EXPOSE 8787

CMD ["sh", "-c", "python -m python_wake_service.server --host 0.0.0.0 --port ${PORT:-8787}"]

