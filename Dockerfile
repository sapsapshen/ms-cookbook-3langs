FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . ./
ENV DATA_DIR=/mnt/workspace/purplebook
EXPOSE 7860
ENTRYPOINT ["python", "-u", "-m", "uvicorn", "app:app", "--app-dir", "/app", "--host", "0.0.0.0", "--port", "7860", "--no-access-log"]
