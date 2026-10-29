package com.sme.meetingassistant.api.userorganization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.*;
import com.sme.meetingassistant.api.userorganization.repository.*;
import com.sme.meetingassistant.api.userorganization.service.EmailNormalizer;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

/** Production PostgreSQL 17 + real Flyway and JPA; no H2 substitute. */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
@Transactional
class CanonicalIdentityPersistenceIntegrationTests {

    @Autowired private JdbcTemplate jdbc;
    @Autowired private UserRepository users;
    @Autowired private OrganizationalUnitRepository units;
    @Autowired private ManagerScopeUnitRepository scopes;

    @Test
    void flywayCreatesExactlyTheCanonicalIdentityTables() {
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM flyway_schema_history WHERE version = '1' AND success",
            Integer.class)).isEqualTo(1);
        assertThat(tableNames()).contains("users", "organizational_units", "manager_scope_units")
            .doesNotContain("user_accounts", "organizations", "organization_memberships");
        assertThat(columnNames("users")).contains(
            "email_normalized", "global_role", "account_status", "primary_org_unit_id",
            "credential_changed_at", "last_login_at", "deactivated_at", "version");
        assertThat(columnNames("organizational_units")).contains("parent_id", "status", "code", "version");
        assertThat(columnNames("manager_scope_units")).contains(
            "user_id", "org_unit_id", "granted_by_user_id", "created_at");
    }

    @Test
    void pendingAccountHasNullableCredentialAndSingleGlobalRole() {
        OrganizationalUnitEntity unit = units.saveAndFlush(new OrganizationalUnitEntity("ENG", "Engineering", null));
        UserEntity user = users.saveAndFlush(new UserEntity("  Ada@Example.COM ", " Ada ", GlobalRole.EMPLOYEE, unit.getId()));

        assertThat(user.getAccountStatus()).isEqualTo(AccountStatus.PENDING_SETUP);
        assertThat(user.getPasswordHash()).isNull();
        assertThat(user.getEmail()).isEqualTo("Ada@Example.COM");
        assertThat(user.getEmailNormalized()).isEqualTo("ada@example.com");
        assertThat(user.getDisplayName()).isEqualTo("Ada");
        assertThat(user.getPrimaryOrgUnitId()).isEqualTo(unit.getId());
        assertThat(user.getCreatedAt()).isNotNull();
        assertThat(users.findByLoginEmail(" ADA@EXAMPLE.com ")).contains(user);
        assertThat(users.findByPrimaryOrgUnitId(unit.getId())).contains(user);
    }

    @Test
    void emailNormalizationMatchesLookupAndRejectsCaseOnlyDuplicate() {
        users.saveAndFlush(new UserEntity("Mixed@Example.com", "One", GlobalRole.EMPLOYEE, null));
        assertThat(EmailNormalizer.normalize(" MIXED@example.COM ")).isEqualTo("mixed@example.com");
        assertThat(users.existsByLoginEmail("mixed@EXAMPLE.com")).isTrue();

        assertThatThrownBy(() -> users.saveAndFlush(
            new UserEntity("mixed@example.COM", "Two", GlobalRole.EMPLOYEE, null)))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void activeAccountRequiresCredentialsAndEnumsAreDbConstrained() {
        assertThatThrownBy(() -> jdbc.update(
            "INSERT INTO users(id,email,email_normalized,display_name,global_role,account_status) VALUES (?,?,?,?,?,?)",
            UUID.randomUUID(), "active@example.com", "active@example.com", "Active", "EMPLOYEE", "ACTIVE"))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void globalRoleCannotBeReplacedByLegacyMembershipRole() {
        assertThatThrownBy(() -> jdbc.update(
            "INSERT INTO users(id,email,email_normalized,display_name,global_role,account_status) VALUES (?,?,?,?,?,?)",
            UUID.randomUUID(), "legacy@example.com", "legacy@example.com", "Legacy", "OWNER", "PENDING_SETUP"))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void accountStatusCannotUseLegacyDisabledValue() {
        assertThatThrownBy(() -> jdbc.update(
            "INSERT INTO users(id,email,email_normalized,display_name,global_role,account_status) VALUES (?,?,?,?,?,?)",
            UUID.randomUUID(), "disabled@example.com", "disabled@example.com", "Disabled", "EMPLOYEE", "DISABLED"))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void organizationalHierarchyAndScopeUseRealForeignKeys() {
        OrganizationalUnitEntity parent = units.saveAndFlush(new OrganizationalUnitEntity("OPS", "Operations", null));
        OrganizationalUnitEntity child = units.saveAndFlush(new OrganizationalUnitEntity("OPS-01", "Operations A", parent.getId()));
        assertThat(units.findByParentId(parent.getId())).contains(child);

        UserEntity manager = users.saveAndFlush(
            new UserEntity("manager@example.com", "Manager", GlobalRole.DEPARTMENT_MANAGER, child.getId()));
        UserEntity grantor = users.saveAndFlush(
            new UserEntity("grantor@example.com", "Grantor", GlobalRole.ADMINISTRATOR, null));
        scopes.saveAndFlush(new ManagerScopeUnitEntity(manager.getId(), child.getId(), grantor.getId()));
        assertThat(scopes.existsByIdUserIdAndIdOrgUnitId(manager.getId(), child.getId())).isTrue();
        assertThat(scopes.existsByIdUserIdAndIdOrgUnitId(manager.getId(), parent.getId())).isFalse();
        assertThat(scopes.findByIdUserId(manager.getId())).hasSize(1);
    }

    @Test
    void organizationCannotBeItsOwnParent() {
        OrganizationalUnitEntity unit = units.saveAndFlush(new OrganizationalUnitEntity("SELF", "Self", null));
        assertThatThrownBy(() -> jdbc.update(
            "UPDATE organizational_units SET parent_id = id WHERE id = ?", unit.getId()))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void invalidForeignKeyCannotBecomeAnAuthoritativeManagerScope() {
        OrganizationalUnitEntity unit = units.saveAndFlush(new OrganizationalUnitEntity("FIN", "Finance", null));
        assertThatThrownBy(() -> jdbc.update(
            "INSERT INTO manager_scope_units(user_id,org_unit_id) VALUES (?,?)",
            UUID.randomUUID(), unit.getId()))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void inactiveAccountsAndUnitsRetainHistoricalForeignKeys() {
        OrganizationalUnitEntity unit = units.saveAndFlush(new OrganizationalUnitEntity("HR", "Human Resources", null));
        UserEntity manager = users.saveAndFlush(
            new UserEntity("historical@example.com", "Historical", GlobalRole.DEPARTMENT_MANAGER, unit.getId()));
        scopes.saveAndFlush(new ManagerScopeUnitEntity(manager.getId(), unit.getId(), null));
        jdbc.update("UPDATE users SET account_status = 'INACTIVE', deactivated_at = now() WHERE id = ?", manager.getId());
        jdbc.update("UPDATE organizational_units SET status = 'INACTIVE' WHERE id = ?", unit.getId());
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM manager_scope_units WHERE user_id = ? AND org_unit_id = ?",
            Integer.class, manager.getId(), unit.getId())).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM users WHERE primary_org_unit_id = ? AND account_status = 'INACTIVE'",
            Integer.class, unit.getId())).isEqualTo(1);
    }

    @Test
    void mutableCanonicalEntitiesUseOptimisticVersions() {
        UserEntity user = users.saveAndFlush(
            new UserEntity("version@example.com", "First", GlobalRole.EMPLOYEE, null));
        long startingVersion = user.getVersion();
        user.renameDisplayName("Second");
        users.flush();
        assertThat(user.getVersion()).isEqualTo(startingVersion + 1);

        OrganizationalUnitEntity unit = units.saveAndFlush(new OrganizationalUnitEntity("VERS", "First", null));
        long unitStartingVersion = unit.getVersion();
        unit.rename("Second");
        units.flush();
        assertThat(unit.getVersion()).isEqualTo(unitStartingVersion + 1);
    }

    private Set<String> tableNames() {
        return Set.copyOf(jdbc.queryForList(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
            String.class));
    }

    private Set<String> columnNames(String table) {
        return Set.copyOf(jdbc.queryForList(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?",
            String.class, table));
    }
}
