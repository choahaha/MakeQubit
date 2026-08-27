FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Student code runs as this user, never as root.
RUN useradd --create-home --shell /usr/sbin/nologin runner \
 && chown -R runner:runner /app
USER runner

EXPOSE 8000

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
