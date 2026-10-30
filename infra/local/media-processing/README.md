# Local media-processing dependencies

This Compose file starts private RustFS S3-compatible object storage and RabbitMQ for local development. RustFS is configured as a single-node local service; it is not a production storage topology. The default credentials in this file are only for a machine-local development environment.

Start services from the repository root:

```powershell
docker compose -f infra/local/media-processing/compose.yaml up -d
```

Configure the API process with matching development credentials and an explicit media allowlist. For example, set `APP_MEDIA_STORAGE_ENDPOINT=http://localhost:9000`, `APP_MEDIA_STORAGE_BUCKET=meeting-media`, `APP_MEDIA_STORAGE_ACCESS_KEY=media-dev`, `APP_MEDIA_STORAGE_SECRET_KEY=media-dev-password`, `APP_MEDIA_STORAGE_CREATE_BUCKET_IF_MISSING=true`, `RABBITMQ_USERNAME=media-dev`, and `RABBITMQ_PASSWORD=media-dev-password`.

Set `APP_MEDIA_UPLOAD_ALLOWED_EXTENSIONS` and `APP_MEDIA_UPLOAD_ALLOWED_CONTENT_TYPES` to the formats approved by the project. Set `APP_MEDIA_UPLOAD_FFPROBE_PATH` to an installed `ffprobe` executable. The API rejects uploads when the format is not configured or cannot be probed. Configure `APP_MEDIA_UPLOAD_MAX_SIZE_BYTES` and `APP_MEDIA_UPLOAD_MAX_DURATION_MS` to the approved product limits.
