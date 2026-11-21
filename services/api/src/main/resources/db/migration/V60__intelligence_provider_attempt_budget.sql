-- Durable, job-scoped provider-attempt accounting for the bounded MI
-- acceptance.  Reservations are never released: an uncertain provider
-- transport is conservatively charged against the physical-attempt ceiling.

CREATE TABLE processing_intelligence_budgets (
    processing_job_id UUID PRIMARY KEY REFERENCES processing_jobs(id) ON DELETE RESTRICT,
    summary_attempt_ceiling INTEGER NOT NULL,
    decision_attempt_ceiling INTEGER NOT NULL,
    action_item_attempt_ceiling INTEGER NOT NULL,
    aggregate_attempt_ceiling INTEGER NOT NULL,
    reserved_token_ceiling BIGINT NOT NULL,
    estimated_cost_ceiling_usd NUMERIC(50,24) NOT NULL,
    input_cost_per_million_usd NUMERIC(50,24) NOT NULL,
    output_cost_per_million_usd NUMERIC(50,24) NOT NULL,
    reserved_attempts INTEGER NOT NULL DEFAULT 0,
    summary_attempts INTEGER NOT NULL DEFAULT 0,
    decision_attempts INTEGER NOT NULL DEFAULT 0,
    action_item_attempts INTEGER NOT NULL DEFAULT 0,
    reserved_tokens BIGINT NOT NULL DEFAULT 0,
    estimated_cost_usd NUMERIC(50,24) NOT NULL DEFAULT 0,
    reported_cost_usd NUMERIC(50,24) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_mi_budget_positive_limits CHECK (
        summary_attempt_ceiling > 0 AND decision_attempt_ceiling > 0
        AND action_item_attempt_ceiling > 0 AND aggregate_attempt_ceiling > 0
        AND reserved_token_ceiling > 0
        AND estimated_cost_ceiling_usd >= 0
        AND input_cost_per_million_usd >= 0
        AND output_cost_per_million_usd >= 0
    ),
    CONSTRAINT ck_mi_budget_nonnegative_usage CHECK (
        reserved_attempts >= 0 AND summary_attempts >= 0
        AND decision_attempts >= 0 AND action_item_attempts >= 0
        AND reserved_tokens >= 0 AND estimated_cost_usd >= 0
        AND reported_cost_usd >= 0
    ),
    CONSTRAINT ck_mi_budget_stage_sum CHECK (
        summary_attempts + decision_attempts + action_item_attempts = reserved_attempts
    )
);

CREATE TABLE processing_intelligence_provider_attempts (
    attempt_id UUID PRIMARY KEY,
    processing_job_id UUID NOT NULL REFERENCES processing_jobs(id) ON DELETE RESTRICT,
    event_id UUID NOT NULL REFERENCES processing_intelligence_dispatches(event_id) ON DELETE RESTRICT,
    stage_run_id UUID NOT NULL,
    stage_code VARCHAR(48) NOT NULL CHECK (stage_code IN
        ('GENERATING_SUMMARY','EXTRACTING_DECISIONS','EXTRACTING_ACTION_ITEMS')),
    reserve_fingerprint CHAR(64) NOT NULL CHECK (reserve_fingerprint ~ '^[a-f0-9]{64}$'),
    reserved_input_tokens BIGINT NOT NULL,
    output_token_ceiling BIGINT NOT NULL,
    reserved_tokens BIGINT NOT NULL,
    estimated_cost_usd NUMERIC(50,24) NOT NULL,
    outcome VARCHAR(16) NOT NULL DEFAULT 'RESERVED' CHECK (outcome IN
        ('RESERVED','SUCCEEDED','FAILED')),
    input_tokens BIGINT,
    output_tokens BIGINT,
    total_tokens BIGINT,
    reasoning_tokens BIGINT,
    reported_cost_usd NUMERIC(50,24),
    report_fingerprint CHAR(64),
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reported_at TIMESTAMPTZ,
    CONSTRAINT fk_mi_attempt_stage FOREIGN KEY
        (processing_job_id,stage_run_id,stage_code)
        REFERENCES processing_stage_runs(processing_job_id,id,stage_code) ON DELETE RESTRICT,
    CONSTRAINT ck_mi_attempt_reserved_values CHECK (
        reserved_input_tokens > 0 AND output_token_ceiling > 0
        AND reserved_tokens = reserved_input_tokens + output_token_ceiling
        AND estimated_cost_usd >= 0
    ),
    CONSTRAINT ck_mi_attempt_usage_values CHECK (
        (input_tokens IS NULL OR input_tokens >= 0)
        AND (output_tokens IS NULL OR output_tokens >= 0)
        AND (total_tokens IS NULL OR total_tokens >= 0)
        AND (reasoning_tokens IS NULL OR reasoning_tokens >= 0)
        AND (reported_cost_usd IS NULL OR reported_cost_usd >= 0)
    ),
    CONSTRAINT ck_mi_attempt_report_pair CHECK (
        (report_fingerprint IS NULL) = (reported_at IS NULL)
        AND (outcome = 'RESERVED') = (reported_at IS NULL)
        AND (outcome = 'RESERVED') = (report_fingerprint IS NULL)
    )
);
CREATE INDEX ix_mi_provider_attempts_job
    ON processing_intelligence_provider_attempts(processing_job_id, stage_code, reserved_at);
CREATE UNIQUE INDEX ux_mi_provider_attempt_stage_identity
    ON processing_intelligence_provider_attempts(processing_job_id, stage_run_id, attempt_id);

CREATE FUNCTION guard_intelligence_budget() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
    IF TG_OP = 'DELETE' OR (
        TG_OP = 'UPDATE' AND (
            OLD.processing_job_id IS DISTINCT FROM NEW.processing_job_id
            OR OLD.summary_attempt_ceiling IS DISTINCT FROM NEW.summary_attempt_ceiling
            OR OLD.decision_attempt_ceiling IS DISTINCT FROM NEW.decision_attempt_ceiling
            OR OLD.action_item_attempt_ceiling IS DISTINCT FROM NEW.action_item_attempt_ceiling
            OR OLD.aggregate_attempt_ceiling IS DISTINCT FROM NEW.aggregate_attempt_ceiling
            OR OLD.reserved_token_ceiling IS DISTINCT FROM NEW.reserved_token_ceiling
            OR OLD.estimated_cost_ceiling_usd IS DISTINCT FROM NEW.estimated_cost_ceiling_usd
            OR OLD.input_cost_per_million_usd IS DISTINCT FROM NEW.input_cost_per_million_usd
            OR OLD.output_cost_per_million_usd IS DISTINCT FROM NEW.output_cost_per_million_usd
            OR NEW.reserved_attempts < OLD.reserved_attempts
            OR NEW.summary_attempts < OLD.summary_attempts
            OR NEW.decision_attempts < OLD.decision_attempts
            OR NEW.action_item_attempts < OLD.action_item_attempts
            OR NEW.reserved_tokens < OLD.reserved_tokens
            OR NEW.estimated_cost_usd < OLD.estimated_cost_usd
            OR NEW.reported_cost_usd < OLD.reported_cost_usd
        )
    ) THEN
        RAISE EXCEPTION 'Intelligence provider budget identity is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_intelligence_budget
    BEFORE UPDATE OR DELETE ON processing_intelligence_budgets
    FOR EACH ROW EXECUTE FUNCTION guard_intelligence_budget();

CREATE FUNCTION guard_intelligence_provider_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Intelligence provider attempts are immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.attempt_id IS DISTINCT FROM NEW.attempt_id
        OR OLD.processing_job_id IS DISTINCT FROM NEW.processing_job_id
        OR OLD.event_id IS DISTINCT FROM NEW.event_id
        OR OLD.stage_run_id IS DISTINCT FROM NEW.stage_run_id
        OR OLD.stage_code IS DISTINCT FROM NEW.stage_code
        OR OLD.reserve_fingerprint IS DISTINCT FROM NEW.reserve_fingerprint
        OR OLD.reserved_input_tokens IS DISTINCT FROM NEW.reserved_input_tokens
        OR OLD.output_token_ceiling IS DISTINCT FROM NEW.output_token_ceiling
        OR OLD.reserved_tokens IS DISTINCT FROM NEW.reserved_tokens
        OR OLD.estimated_cost_usd IS DISTINCT FROM NEW.estimated_cost_usd
        OR OLD.reserved_at IS DISTINCT FROM NEW.reserved_at
        OR OLD.outcome <> 'RESERVED' AND ROW(
            OLD.outcome,OLD.input_tokens,OLD.output_tokens,OLD.total_tokens,OLD.reasoning_tokens,
            OLD.reported_cost_usd,OLD.report_fingerprint,OLD.reported_at
        ) IS DISTINCT FROM ROW(
            NEW.outcome,NEW.input_tokens,NEW.output_tokens,NEW.total_tokens,NEW.reasoning_tokens,
            NEW.reported_cost_usd,NEW.report_fingerprint,NEW.reported_at
        )
        OR OLD.outcome = 'RESERVED' AND NEW.outcome NOT IN ('SUCCEEDED','FAILED')
    THEN
        RAISE EXCEPTION 'Intelligence provider attempt identity is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_intelligence_provider_attempt
    BEFORE UPDATE OR DELETE ON processing_intelligence_provider_attempts
    FOR EACH ROW EXECUTE FUNCTION guard_intelligence_provider_attempt();
