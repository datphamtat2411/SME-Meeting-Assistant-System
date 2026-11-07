-- AI-04: Stable Meeting-owned Action Item department scope.
-- Do not backfill historical meetings from the organizer's CURRENT unit.
-- Directory management grants are not blanket Meeting/Transcript content grants.
CREATE TABLE meeting_action_item_scopes (
    meeting_id UUID PRIMARY KEY REFERENCES meetings(id) ON DELETE RESTRICT,
    org_unit_id UUID NOT NULL REFERENCES organizational_units(id) ON DELETE RESTRICT,
    recorded_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ix_meeting_ai_scope_unit ON meeting_action_item_scopes(org_unit_id, meeting_id);

CREATE FUNCTION reject_meeting_action_item_scope_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Meeting Action Item organizational scope is immutable'
        USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER trg_meeting_action_item_scope_immutable
    BEFORE UPDATE OR DELETE ON meeting_action_item_scopes
    FOR EACH ROW EXECUTE FUNCTION reject_meeting_action_item_scope_mutation();

-- Scope rows must be captured only by the Meeting creation transaction.
-- Explicit reclassification policy and a trusted audit path are future work;
-- no UPDATE and no blind historical migration is allowed.
