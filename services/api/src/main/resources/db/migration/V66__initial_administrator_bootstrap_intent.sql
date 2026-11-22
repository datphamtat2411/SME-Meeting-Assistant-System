-- A command-only, one-time first-administrator intent.  The singleton row is
-- locked by the bootstrap transaction; it is never consulted by normal HTTP
-- startup and does not alter ordinary account-management authorization.
CREATE TABLE initial_administrator_bootstrap (
    id SMALLINT PRIMARY KEY,
    state VARCHAR(16) NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    email_normalized VARCHAR(320),
    requested_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    CONSTRAINT ck_initial_admin_bootstrap_id CHECK (id = 1),
    CONSTRAINT ck_initial_admin_bootstrap_state CHECK
        (state IN ('AVAILABLE', 'ISSUED', 'COMPLETED')),
    CONSTRAINT ck_initial_admin_bootstrap_lifecycle CHECK (
        (state = 'AVAILABLE'
            AND user_id IS NULL
            AND email_normalized IS NULL
            AND requested_at IS NULL
            AND completed_at IS NULL)
        OR
        (state = 'ISSUED'
            AND user_id IS NOT NULL
            AND email_normalized IS NOT NULL
            AND requested_at IS NOT NULL
            AND completed_at IS NULL)
        OR
        (state = 'COMPLETED'
            AND user_id IS NOT NULL
            AND email_normalized IS NOT NULL
            AND requested_at IS NOT NULL
            AND completed_at IS NOT NULL)
    ),
    CONSTRAINT ck_initial_admin_bootstrap_email CHECK
        (email_normalized IS NULL OR length(btrim(email_normalized)) BETWEEN 3 AND 320)
);

INSERT INTO initial_administrator_bootstrap(id, state)
VALUES (1, 'AVAILABLE');
