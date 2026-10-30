-- T02: protect accepted source media and fence concurrent finalization.
-- V11 is preserved for environments which have already applied it.
-- Legacy AVAILABLE media used client-writable object keys and cannot be declared immutable safely.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM meeting_media WHERE status = 'AVAILABLE') THEN
    RAISE EXCEPTION 'T02 migration requires verified promotion of legacy AVAILABLE media before proceeding';
  END IF;
END
$$;

ALTER TABLE meeting_media
  ADD COLUMN pending_object_key TEXT,
  ADD COLUMN finalization_token UUID,
  ADD COLUMN finalization_lease_until TIMESTAMPTZ,
  ADD COLUMN pending_cleaned_at TIMESTAMPTZ;

UPDATE meeting_media SET pending_object_key = object_key;
ALTER TABLE meeting_media ALTER COLUMN pending_object_key SET NOT NULL;
ALTER TABLE meeting_media ADD CONSTRAINT ux_meeting_media_pending_object_key UNIQUE (pending_object_key);
ALTER TABLE meeting_media ADD CONSTRAINT ck_meeting_media_finalization_lease
  CHECK ((finalization_token IS NULL) = (finalization_lease_until IS NULL));
ALTER TABLE meeting_media ADD CONSTRAINT ck_meeting_media_available_source
  CHECK (status <> 'AVAILABLE' OR object_key <> pending_object_key);

CREATE INDEX ix_meeting_media_expired_pending
  ON meeting_media(created_at, id)
  WHERE status = 'PENDING_UPLOAD';
CREATE INDEX ix_meeting_media_pending_cleanup
  ON meeting_media(created_at, id)
  WHERE pending_cleaned_at IS NULL;
