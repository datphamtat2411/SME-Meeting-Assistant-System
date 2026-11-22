-- ISSUE-02: accepted inventory cursors are durable run-scoped evidence.
-- Only canonical cursors are written by Core. The history contains no
-- Qdrant payload, source identity, transcript content, or point data.
CREATE TABLE knowledge_reconciliation_cursor_history (
    run_id UUID NOT NULL REFERENCES knowledge_reconciliation_runs(id) ON DELETE RESTRICT,
    canonical_cursor VARCHAR(36) NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_knowledge_reconciliation_cursor_history
        PRIMARY KEY (run_id, canonical_cursor),
    CONSTRAINT ck_knowledge_reconciliation_cursor_history_cursor CHECK (
        canonical_cursor ~ '^(0|[1-9][0-9]{0,19})$'
        OR canonical_cursor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
);

CREATE INDEX ix_knowledge_reconciliation_cursor_history_run
    ON knowledge_reconciliation_cursor_history(run_id, accepted_at, canonical_cursor);

-- A pre-V58 run has only its last accepted checkpoint, not its complete
-- transition history. Preserve that checkpoint as the oldest recoverable
-- history entry without changing the run row. Malformed legacy checkpoints
-- remain untouched and continue to fail closed at the Core boundary.
WITH normalized AS (
    SELECT id AS run_id,
           CASE
               WHEN vector_cursor ~ '^[0-9]+$'
                    AND length(vector_cursor) <= 20
                    AND vector_cursor::numeric <= 18446744073709551615
                   THEN COALESCE(NULLIF(ltrim(vector_cursor, '0'), ''), '0')
               WHEN vector_cursor ~ '^[0-9A-Fa-f]{32}$'
                   THEN lower(
                       substr(vector_cursor, 1, 8) || '-' ||
                       substr(vector_cursor, 9, 4) || '-' ||
                       substr(vector_cursor, 13, 4) || '-' ||
                       substr(vector_cursor, 17, 4) || '-' ||
                       substr(vector_cursor, 21, 12))
               WHEN vector_cursor ~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
                   THEN lower(vector_cursor)
               ELSE NULL
           END AS canonical_cursor
      FROM knowledge_reconciliation_runs
     WHERE vector_cursor IS NOT NULL
)
INSERT INTO knowledge_reconciliation_cursor_history(run_id, canonical_cursor)
SELECT run_id, canonical_cursor
  FROM normalized
 WHERE canonical_cursor IS NOT NULL
ON CONFLICT (run_id, canonical_cursor) DO NOTHING;
