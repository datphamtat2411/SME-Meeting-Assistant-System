-- This unmerged PR #3 V1 replaces its former organization-membership schema.
-- Do not apply to a database that has already recorded the previous PR #3 V1 checksum.
-- Global Flyway version reconciliation with the meeting branch belongs to T06.
CREATE TABLE organizational_units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(64) NOT NULL,
    name VARCHAR(160) NOT NULL,
    parent_id UUID REFERENCES organizational_units(id) ON DELETE RESTRICT,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ux_organizational_units_code UNIQUE (code),
    CONSTRAINT ck_organizational_units_code CHECK (length(btrim(code)) > 0),
    CONSTRAINT ck_organizational_units_name CHECK (length(btrim(name)) > 0),
    CONSTRAINT ck_organizational_units_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
    CONSTRAINT ck_organizational_units_not_self_parent CHECK (parent_id IS DISTINCT FROM id)
);
CREATE INDEX ix_organizational_units_parent_id ON organizational_units(parent_id);

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(320) NOT NULL,
    email_normalized VARCHAR(320) NOT NULL,
    display_name VARCHAR(200) NOT NULL,
    password_hash TEXT,
    global_role VARCHAR(32) NOT NULL DEFAULT 'EMPLOYEE',
    account_status VARCHAR(32) NOT NULL DEFAULT 'PENDING_SETUP',
    primary_org_unit_id UUID REFERENCES organizational_units(id) ON DELETE RESTRICT,
    credential_changed_at TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    deactivated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ux_users_email_normalized UNIQUE (email_normalized),
    CONSTRAINT ck_users_email_not_blank CHECK (length(btrim(email)) > 0),
    CONSTRAINT ck_users_email_normalized_not_blank CHECK (length(btrim(email_normalized)) > 0),
    CONSTRAINT ck_users_display_name_not_blank CHECK (length(btrim(display_name)) > 0),
    CONSTRAINT ck_users_global_role CHECK (global_role IN ('EMPLOYEE', 'DEPARTMENT_MANAGER', 'ADMINISTRATOR')),
    CONSTRAINT ck_users_account_status CHECK (account_status IN ('PENDING_SETUP', 'ACTIVE', 'INACTIVE')),
    CONSTRAINT ck_users_active_requires_password CHECK (account_status <> 'ACTIVE' OR password_hash IS NOT NULL)
);
CREATE INDEX ix_users_primary_org_unit ON users(primary_org_unit_id);
CREATE INDEX ix_users_role_status ON users(global_role, account_status);

CREATE TABLE manager_scope_units (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    org_unit_id UUID NOT NULL REFERENCES organizational_units(id) ON DELETE RESTRICT,
    granted_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_manager_scope_units PRIMARY KEY (user_id, org_unit_id)
);
CREATE INDEX ix_manager_scope_units_org_unit ON manager_scope_units(org_unit_id);
CREATE INDEX ix_manager_scope_units_grantor ON manager_scope_units(granted_by_user_id);
