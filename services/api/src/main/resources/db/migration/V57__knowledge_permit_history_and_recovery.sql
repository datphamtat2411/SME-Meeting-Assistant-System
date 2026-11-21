-- ISSUE-01 final permit recovery correction.
--
-- A cancelled reservation proves that no external writer was started and must
-- remain available as audit history while a replacement attempt is allocated.
-- Keep the database fence on every unresolved attempt, but allow terminal and
-- cancelled history to accumulate under the same live claim.

ALTER TABLE knowledge_qdrant_write_permits
    DROP CONSTRAINT ux_knowledge_permit_attempt;

-- V53's trigger used an unqualified work table. Rebind it to the schema that
-- owns the permit row so isolated Flyway schemas retain the same protection.
CREATE OR REPLACE FUNCTION protect_knowledge_permit_binding() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    work_generation VARCHAR(128);
    work_operation VARCHAR(16);
BEGIN
    EXECUTE format(
        'SELECT index_generation_id,operation
           FROM %I.knowledge_indexing_work
          WHERE event_id=$1',
        TG_TABLE_SCHEMA
    ) INTO work_generation,work_operation USING NEW.event_id;
    IF work_generation IS NULL OR work_generation <> NEW.generation_id
       OR work_operation <> NEW.operation THEN
        RAISE EXCEPTION 'Knowledge Qdrant permit is not bound to its work event'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE UNIQUE INDEX ux_knowledge_permit_unresolved_attempt
    ON knowledge_qdrant_write_permits(event_id, claim_token_sha256, operation)
    WHERE state IN ('OPEN', 'RESERVED', 'RUNNING');

-- CURRENT_TIMESTAMP is transaction-scoped in PostgreSQL. A durable sequence
-- gives result acceptance and audit queries the actual allocation order even
-- when multiple permit attempts are created in one transaction.
CREATE SEQUENCE knowledge_qdrant_permit_attempt_seq;

ALTER TABLE knowledge_qdrant_write_permits
    ADD COLUMN attempt_sequence BIGINT;

WITH ordered_permits AS (
    SELECT permit_id,
           row_number() OVER (ORDER BY created_at, permit_id) AS sequence_number
      FROM knowledge_qdrant_write_permits
)
UPDATE knowledge_qdrant_write_permits permits
   SET attempt_sequence=ordered_permits.sequence_number
  FROM ordered_permits
 WHERE permits.permit_id=ordered_permits.permit_id;

SELECT setval(
    'knowledge_qdrant_permit_attempt_seq',
    COALESCE((SELECT max(attempt_sequence) FROM knowledge_qdrant_write_permits), 0) + 1,
    FALSE
);

ALTER TABLE knowledge_qdrant_write_permits
    ALTER COLUMN attempt_sequence SET DEFAULT nextval('knowledge_qdrant_permit_attempt_seq'),
    ALTER COLUMN attempt_sequence SET NOT NULL,
    ADD CONSTRAINT ck_knowledge_permit_attempt_sequence CHECK (attempt_sequence > 0),
    ADD CONSTRAINT ux_knowledge_permit_attempt_sequence UNIQUE (attempt_sequence);

ALTER SEQUENCE knowledge_qdrant_permit_attempt_seq
    OWNED BY knowledge_qdrant_write_permits.attempt_sequence;

-- Core reads all history for exact replay/terminal decisions and checks the
-- source-scoped unresolved set on every acquisition.
CREATE INDEX ix_knowledge_permit_attempt_history
    ON knowledge_qdrant_write_permits(
        event_id, claim_token_sha256, operation,
        attempt_sequence DESC, created_at DESC, permit_id DESC
    );

CREATE INDEX ix_knowledge_permit_source_outstanding
    ON knowledge_qdrant_write_permits(generation_id, state, event_id)
    WHERE state IN ('OPEN', 'RESERVED', 'RUNNING');
