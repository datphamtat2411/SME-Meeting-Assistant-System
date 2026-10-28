package com.sme.meetingassistant.api.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

/**
 * PR #3 T06 integration checkpoint, not a production installation of the
 * separately owned PR #1 meeting module. The original meeting SQL is copied
 * byte-for-byte into test resources so the compatibility check is reproducible.
 *
 * Confirms that original meeting V1 can coexist at the table level but is NOT
 * sufficient by itself: it lacks canonical users FKs. The test applies the
 * forward-only constraints that must accompany a future composed migration,
 * without shipping a misleading conditional production migration.
 */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
@Transactional
class CrossPrMeetingSchemaIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired UserRepository users;
    @Autowired AccountSetupPasswordHasher passwordHasher;

    @Test
    void currentlyAppliedCanonicalMigrationHistoryRemainsImmutableAndUnique() {
        var versions=jdbc.queryForList("""
            SELECT version FROM flyway_schema_history
             WHERE success AND version IS NOT NULL ORDER BY installed_rank
            """,String.class);
        assertThat(versions).containsExactly("1","20","21","22","23");
        assertThat(Set.copyOf(versions)).hasSize(versions.size());
        var applied=jdbc.queryForList("""
            SELECT script FROM flyway_schema_history
             WHERE success AND version IS NOT NULL ORDER BY installed_rank
            """,String.class);
        assertThat(applied.getFirst()).contains("canonical_identity");
        assertThat(jdbc.queryForObject("SELECT to_regclass('public.user_accounts') IS NULL",
            Boolean.class)).isTrue();
    }

    private void installOriginalMeetingTables() {
        new ResourceDatabasePopulator(
            new ClassPathResource("integration/legacy-meeting-operations-v1.sql"))
            .execute(jdbc.getDataSource());
    }

    private UserEntity activeUser() {
        var user = new UserEntity("pr3-t06-"+UUID.randomUUID()+"@example.com",
            "Meeting History Owner",GlobalRole.EMPLOYEE,null);
        user.completeInitialSetup(
            passwordHasher.hash("Integration-grade fixture credential 🔏 2026"),
            OffsetDateTime.now(ZoneOffset.UTC));
        return users.saveAndFlush(user);
    }

    private boolean referencesCanonicalUsers(String table, String column) {
        Integer count=jdbc.queryForObject("""
            SELECT count(*) FROM pg_constraint c
            JOIN pg_class source ON source.oid=c.conrelid
            JOIN pg_class target ON target.oid=c.confrelid
            WHERE c.contype='f' AND source.relname=? AND target.relname='users'
                AND c.conkey @> ARRAY[(
                    SELECT attnum FROM pg_attribute
                     WHERE attrelid=source.oid AND attname=?
                )]::smallint[]
            """,Integer.class,table,column);
        return count!=null && count>0;
    }

    @Test
    void originalMeetingV1RequiresExplicitCanonicalForeignKeyReconciliation() {
        installOriginalMeetingTables();
        // The legacy PR #1 migration does not make organizer/participant user
        // identifiers referentially safe merely because the UUIDs look valid.
        assertThat(referencesCanonicalUsers("meetings","organizer_id")).isFalse();
        assertThat(referencesCanonicalUsers("meeting_participants","user_id")).isFalse();
        assertThat(jdbc.queryForObject("SELECT to_regclass('public.user_accounts') IS NULL",
            Boolean.class)).isTrue();

        // Demonstrate the forward-only contract required at integration.
        jdbc.execute("""
            ALTER TABLE meetings ADD CONSTRAINT fk_meetings_canonical_organizer
                FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE RESTRICT
            """);
        jdbc.execute("""
            ALTER TABLE meeting_participants ADD CONSTRAINT fk_participant_canonical_user
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
            """);
        assertThat(referencesCanonicalUsers("meetings","organizer_id")).isTrue();
        assertThat(referencesCanonicalUsers("meeting_participants","user_id")).isTrue();
    }

    @Test
    void deactivationPreservesHistoricalMeetingAndParticipantReferences() {
        installOriginalMeetingTables();
        jdbc.execute("""
            ALTER TABLE meetings ADD CONSTRAINT fk_meetings_canonical_organizer
                FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE RESTRICT
            """);
        jdbc.execute("""
            ALTER TABLE meeting_participants ADD CONSTRAINT fk_participant_canonical_user
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
            """);

        UserEntity owner=activeUser();
        UserEntity participant=activeUser();
        UUID meetingId=UUID.randomUUID();
        UUID participationId=UUID.randomUUID();
        jdbc.update("INSERT INTO meetings(id,title,organizer_id) VALUES (?,?,?)",
            meetingId,"Retained meeting",owner.getId());
        jdbc.update("""
            INSERT INTO meeting_participants(id,meeting_id,user_id,role,status)
                VALUES (?,?,?,'REQUIRED','ACCEPTED')
            """,participationId,meetingId,participant.getId());

        owner.deactivate(OffsetDateTime.now(ZoneOffset.UTC));
        participant.deactivate(OffsetDateTime.now(ZoneOffset.UTC));
        users.saveAndFlush(owner);
        users.saveAndFlush(participant);
        assertThat(users.findById(owner.getId()).orElseThrow().getAccountStatus())
            .isEqualTo(AccountStatus.INACTIVE);
        assertThat(jdbc.queryForObject(
            "SELECT organizer_id FROM meetings WHERE id=?",UUID.class,meetingId))
            .isEqualTo(owner.getId());
        assertThat(jdbc.queryForObject(
            "SELECT user_id FROM meeting_participants WHERE id=?",UUID.class,participationId))
            .isEqualTo(participant.getId());
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM meeting_participants WHERE meeting_id=?",
            Integer.class,meetingId)).isEqualTo(1);
    }
}
