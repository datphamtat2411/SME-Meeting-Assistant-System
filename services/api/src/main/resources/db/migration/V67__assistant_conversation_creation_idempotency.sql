-- Creation intent stays bound to its conversation for the lifetime of the record.
-- Legacy clients may omit the key. A retry with a key cannot consume a second quota slot.
ALTER TABLE assistant_conversations
    ADD COLUMN creation_key_digest VARCHAR(64),
    ADD COLUMN creation_request_digest VARCHAR(64),
    ADD CONSTRAINT ck_assistant_creation_digest CHECK (
        (creation_key_digest IS NULL AND creation_request_digest IS NULL)
        OR (creation_key_digest IS NOT NULL AND creation_request_digest IS NOT NULL
            AND creation_key_digest ~ '^[a-f0-9]{64}$'
            AND creation_request_digest ~ '^[a-f0-9]{64}$')
    );

CREATE UNIQUE INDEX ux_assistant_creation_intent
    ON assistant_conversations(user_id, creation_key_digest)
    WHERE creation_key_digest IS NOT NULL;
