-- PI-02: canonical, scope-fenced Assistant conversations and durable turns.
-- Always-on provenance constraints; no runtime DDL and no AI-owned canonical writes.
CREATE TABLE assistant_conversations (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    meeting_id UUID REFERENCES meetings(id) ON DELETE RESTRICT,
    title VARCHAR(255),
    status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_assistant_conversation_status CHECK (status IN ('ACTIVE', 'ARCHIVED'))
);
CREATE INDEX ix_assistant_conversations_owner ON assistant_conversations(user_id, updated_at DESC, id DESC);
CREATE INDEX ix_assistant_conversations_meeting ON assistant_conversations(meeting_id, id);

CREATE TABLE assistant_messages (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES assistant_conversations(id) ON DELETE RESTRICT,
    role VARCHAR(24) NOT NULL,
    content TEXT NOT NULL,
    answer_status VARCHAR(32),
    model_metadata JSONB,
    answer_claims JSONB,
    answer_diagnostics JSONB,
    request_id UUID,
    scope_id UUID,
    scope_version VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_assistant_message_role CHECK (role IN ('USER','ASSISTANT','SYSTEM_EVENT')),
    CONSTRAINT ck_assistant_message_answer CHECK (
       (role='ASSISTANT' AND answer_status IN ('GROUNDED','PARTIAL','INSUFFICIENT_EVIDENCE','FAILED'))
        OR (role<>'ASSISTANT' AND answer_status IS NULL)),
    CONSTRAINT ck_assistant_message_claim_type CHECK (answer_claims IS NULL OR jsonb_typeof(answer_claims)='array'),
    CONSTRAINT ck_assistant_message_diag_type CHECK (answer_diagnostics IS NULL OR jsonb_typeof(answer_diagnostics)='object'),
    CONSTRAINT ck_assistant_message_model_type CHECK (model_metadata IS NULL OR jsonb_typeof(model_metadata)='object')
);
CREATE INDEX ix_assistant_messages_history ON assistant_messages(conversation_id, created_at, id);

CREATE TABLE assistant_turns (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES assistant_conversations(id) ON DELETE RESTRICT,
    idempotency_key VARCHAR(128) NOT NULL,
    request_sha256 CHAR(64) NOT NULL,
    user_message_id UUID NOT NULL UNIQUE REFERENCES assistant_messages(id) ON DELETE RESTRICT,
    assistant_message_id UUID UNIQUE REFERENCES assistant_messages(id) ON DELETE RESTRICT,
    state VARCHAR(24) NOT NULL,
    claim_token UUID,
    claim_expires_at TIMESTAMPTZ,
    scope_version VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ux_assistant_turn_key UNIQUE (conversation_id, idempotency_key),
    CONSTRAINT ck_assistant_turn_digest CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
    CONSTRAINT ck_assistant_turn_state CHECK (state IN ('PROCESSING','COMPLETED','FAILED')),
    CONSTRAINT ck_assistant_turn_lease CHECK (
      (state='PROCESSING' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
         AND assistant_message_id IS NULL)
      OR (state IN ('COMPLETED','FAILED') AND claim_token IS NULL AND claim_expires_at IS NULL
         AND assistant_message_id IS NOT NULL))
);
CREATE UNIQUE INDEX ux_assistant_active_turn ON assistant_turns(conversation_id) WHERE state='PROCESSING';
CREATE INDEX ix_assistant_expired_turns ON assistant_turns(claim_expires_at) WHERE state='PROCESSING';

CREATE TABLE assistant_message_sources (
    assistant_message_id UUID NOT NULL REFERENCES assistant_messages(id) ON DELETE RESTRICT,
    citation_id VARCHAR(8) NOT NULL,
    source_type VARCHAR(32) NOT NULL,
    source_id UUID NOT NULL,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    source_revision BIGINT NOT NULL,
    retrieval_chunk_id VARCHAR(128) NOT NULL,
    claim_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    citation_payload JSONB NOT NULL,
    rank INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_assistant_message_sources PRIMARY KEY (assistant_message_id,citation_id),
    CONSTRAINT ck_assistant_source_type CHECK(source_type IN ('TRANSCRIPT','SUMMARY','DECISION','ACTION_ITEM')),
    CONSTRAINT ck_assistant_source_revision CHECK(source_revision >= 0),
    CONSTRAINT ck_assistant_source_rank CHECK(rank >= 1 AND rank <= 64),
    CONSTRAINT ck_assistant_source_claim_ids CHECK(jsonb_typeof(claim_ids)='array'),
    CONSTRAINT ck_assistant_source_citation CHECK(jsonb_typeof(citation_payload)='object')
);
CREATE INDEX ix_assistant_sources_current ON assistant_message_sources(meeting_id,source_type,source_id,source_revision);
