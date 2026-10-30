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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

/** T02 replaces legacy PR #1 SQL-simulation gates with checks against actual canonical schema. */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
@Transactional
class CrossPrMeetingSchemaIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired UserRepository users;
    @Autowired AccountSetupPasswordHasher passwordHasher;

    @Test void canonicalMigrationHistoryRemainsImmutableAndUnique() {
        var versions=jdbc.queryForList("""
            SELECT version FROM flyway_schema_history WHERE success AND version IS NOT NULL
            ORDER BY installed_rank
            """,String.class);
        assertThat(versions).containsExactly("1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17");
        assertThat(Set.copyOf(versions)).hasSize(versions.size());
        var applied=jdbc.queryForList("""
            SELECT script FROM flyway_schema_history WHERE success AND version IS NOT NULL
            ORDER BY installed_rank
            """,String.class);
        assertThat(applied.getFirst()).contains("canonical_identity");
        assertThat(applied.get(4)).isEqualTo("V5__create_canonical_room_catalog.sql");
        assertThat(applied.get(5)).isEqualTo("V6__create_canonical_meeting_core.sql",
                "V7__create_canonical_room_reservations.sql");
        assertThat(jdbc.queryForObject("SELECT to_regclass('public.user_accounts') IS NULL",Boolean.class)).isTrue();
    }

    @Test void meetingAndParticipationHaveRealCanonicalForeignKeys() {
        for (String column : Set.of("organizer_user_id","created_by_user_id")) {
            assertThat(references("meetings",column,"users")).isTrue();
        }
        assertThat(references("meetings","room_id","rooms")).isTrue();
        assertThat(references("meeting_participants","meeting_id","meetings")).isTrue();
        assertThat(references("meeting_participants","user_id","users")).isTrue();
        assertThat(references("meeting_participants","added_by_user_id","users")).isTrue();
        assertThat(references("meeting_participants","removed_by_user_id","users")).isTrue();
    }

    private boolean references(String table,String column,String target) {
        Integer count=jdbc.queryForObject("""
            SELECT count(*) FROM pg_constraint c
            JOIN pg_class source ON source.oid=c.conrelid
            JOIN pg_class dest ON dest.oid=c.confrelid
            WHERE c.contype='f' AND source.relname=? AND dest.relname=?
                AND c.conkey @> ARRAY[(
                    SELECT attnum FROM pg_attribute
                    WHERE attrelid=source.oid AND attname=?
                )]::smallint[]
            """,Integer.class,table,target,column);
        return count!=null && count>0;
    }

    private UserEntity activeUser() {
        var user=new UserEntity("t02-history-"+UUID.randomUUID()+"@example.invalid",
            "Historical user",GlobalRole.EMPLOYEE,null);
        user.completeInitialSetup(passwordHasher.hash("Integration-grade fixture 🔏 credential"),
            OffsetDateTime.now(ZoneOffset.UTC));
        return users.saveAndFlush(user);
    }

    @Test void accountDeactivationNeverErasesOrganizerOrParticipantHistory() {
        UserEntity owner=activeUser(), member=activeUser();
        UUID id=UUID.randomUUID(), participationId=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,?,?,?)
            """,id,"Preserved meeting",owner.getId(),owner.getId());
        jdbc.update("""
            INSERT INTO meeting_participants(id,meeting_id,user_id,added_by_user_id)
            VALUES (?,?,?,?)
            """,participationId,id,member.getId(),owner.getId());
        owner.deactivate(OffsetDateTime.now(ZoneOffset.UTC));
        member.deactivate(OffsetDateTime.now(ZoneOffset.UTC));
        users.saveAndFlush(owner);
        users.saveAndFlush(member);
        assertThat(users.findById(owner.getId()).orElseThrow().getAccountStatus())
            .isEqualTo(AccountStatus.INACTIVE);
        assertThat(jdbc.queryForObject("SELECT organizer_user_id FROM meetings WHERE id=?",
            UUID.class,id)).isEqualTo(owner.getId());
        assertThat(jdbc.queryForObject("SELECT user_id FROM meeting_participants WHERE id=?",
            UUID.class,participationId)).isEqualTo(member.getId());
    }
}
