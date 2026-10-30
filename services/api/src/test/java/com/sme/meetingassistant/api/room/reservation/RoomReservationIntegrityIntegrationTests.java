package com.sme.meetingassistant.api.room.reservation;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.IllegalTransactionStateException;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Real PostgreSQL (not mocks). All DB writes are committed before concurrent
 * threads begin; each reservation operation gets a separate physical transaction.
 */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class RoomReservationIntegrityIntegrationTests {
    private static final OffsetDateTime NINE=OffsetDateTime.parse("2030-06-03T09:00:00Z");
    private static final OffsetDateTime TEN=OffsetDateTime.parse("2030-06-03T10:00:00Z");
    private static final OffsetDateTime ELEVEN=OffsetDateTime.parse("2030-06-03T11:00:00Z");

    @Autowired JdbcTemplate jdbc;
    @Autowired PlatformTransactionManager transactionManager;
    @Autowired RoomReservationService service;
    @Autowired RoomReservationStore store;

    private UUID actor, roomA, roomB;

    @BeforeEach void fixture() {
        actor=UUID.randomUUID();
        roomA=UUID.randomUUID(); roomB=UUID.randomUUID();
        String email="reservation-"+actor+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Reservation fixture','test-fixture','EMPLOYEE','ACTIVE')
            """,actor,email,email);
        insertRoom(roomA);
        insertRoom(roomB);
    }

    private void insertRoom(UUID id) {
        jdbc.update("INSERT INTO rooms(id,code,name) VALUES (?,?,?)",
            id,"R-"+id,"Room "+id);
    }

    private UUID meeting(UUID room, OffsetDateTime start, OffsetDateTime end, String state) {
        UUID id=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id,
                                 room_id,scheduled_start_at,scheduled_end_at,status)
            VALUES (?,'Reservation fixture',?,?,?,?,?,?)
            """,id,actor,actor,room,start,end,state);
        return id;
    }

    private TransactionTemplate tx() { return new TransactionTemplate(transactionManager); }

    private RoomReservation reserve(UUID meetingId) {
        return tx().execute(s -> service.synchronizeCommitted(meetingId).orElseThrow());
    }

    private void directInsert(UUID meetingId, UUID roomId, OffsetDateTime from, OffsetDateTime to) {
        jdbc.update("""
            INSERT INTO room_reservations(id,meeting_id,room_id,reserved_period)
            VALUES (?,?,?,tstzrange(?::timestamptz,?::timestamptz,'[)'))
            """,UUID.randomUUID(),meetingId,roomId,from,to);
    }

    private int countActive(UUID meetingId) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM room_reservations WHERE meeting_id=? AND status='ACTIVE'
            """,Integer.class,meetingId);
    }

    @Test void migrationHasRequiredGiSTAndUniqueConstraints() {
        assertThat(jdbc.queryForList("""
            SELECT version FROM flyway_schema_history WHERE success AND version IS NOT NULL
            ORDER BY installed_rank
            """,String.class)).containsExactly("1","2","3","4","5","6","7","8","9","10","11","12","13");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM pg_extension WHERE extname='btree_gist'
            """,Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM pg_constraint
            WHERE conrelid='public.room_reservations'::regclass
              AND conname='ex_room_reservations_active_overlap' AND contype='x'
            """,Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM pg_indexes WHERE tablename='room_reservations'
              AND indexname='ux_room_reservations_active_meeting'
            """,Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM pg_constraint
            WHERE conrelid='public.room_reservations'::regclass AND contype='f'
            """,Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT data_type FROM information_schema.columns
             WHERE table_name='room_reservations' AND column_name='reserved_period'
            """,String.class)).isEqualTo("tstzrange");
    }

    @Test void draftAndInactiveRoomAreNotAdmitted() {
        UUID draft=meeting(roomA,NINE,TEN,"DRAFT");
        assertThatThrownBy(()->reserve(draft)).isInstanceOf(ResponseStatusException.class)
            .satisfies(e->assertThat(((ResponseStatusException)e).getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        assertThat(countActive(draft)).isZero();

        jdbc.update("UPDATE rooms SET status='INACTIVE' WHERE id=?",roomA);
        UUID scheduled=meeting(roomA,NINE,TEN,"SCHEDULED");
        assertThatThrownBy(()->reserve(scheduled)).isInstanceOf(ResponseStatusException.class)
            .satisfies(e->assertThat(((ResponseStatusException)e).getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        assertThat(countActive(scheduled)).isZero();
    }

    @Test void roomlessMeetingNeverCreatesAReservation() {
        UUID roomless=meeting(null,NINE,TEN,"SCHEDULED");
        java.util.Optional<RoomReservation> result = tx().execute(s->service.synchronizeCommitted(roomless));
        assertThat(result).isEmpty();
        assertThat(countActive(roomless)).isZero();
    }

    @Test void reservationRequiresExistingOuterBusinessTransaction() {
        UUID scheduled=meeting(roomA,NINE,TEN,"SCHEDULED");
        assertThatThrownBy(()->service.synchronizeCommitted(scheduled))
            .isInstanceOf(IllegalTransactionStateException.class);
        assertThat(countActive(scheduled)).isZero();
    }

    @Test void repeatedCommitIsIdempotentAndCancelRetainsReleasedHistory() {
        UUID scheduled=meeting(roomA,NINE,TEN,"SCHEDULED");
        RoomReservation first=reserve(scheduled);
        RoomReservation same=reserve(scheduled);
        assertThat(same.id()).isEqualTo(first.id());
        assertThat(first.status()).isEqualTo(RoomReservation.Status.ACTIVE);
        assertThat(first.start().toInstant()).isEqualTo(NINE.toInstant());
        assertThat(first.end().toInstant()).isEqualTo(TEN.toInstant());
        assertThat(countActive(scheduled)).isEqualTo(1);

        assertThatThrownBy(()->tx().execute(s->{service.releaseCancelled(scheduled);return null;}))
            .isInstanceOf(ResponseStatusException.class);
        jdbc.update("UPDATE meetings SET status='CANCELLED',cancelled_at=clock_timestamp() WHERE id=?",scheduled);
        tx().execute(s->{service.releaseCancelled(scheduled);return null;});
        tx().execute(s->{service.releaseCancelled(scheduled);return null;});
        List<RoomReservation> history=store.history(scheduled);
        assertThat(history).hasSize(1);
        assertThat(history.getFirst().status()).isEqualTo(RoomReservation.Status.RELEASED);
        assertThat(history.getFirst().releasedAt()).isNotNull();
        assertThat(history.getFirst().version()).isEqualTo(1);
        assertThat(countActive(scheduled)).isZero();
    }

    @Test void endpointAdjacentBookingsCanCommitButTrueOverlapFailsEvenWithRawSQL() {
        UUID first=meeting(roomA,NINE,TEN,"SCHEDULED");
        UUID adjacent=meeting(roomA,TEN,ELEVEN,"SCHEDULED");
        UUID overlapping=meeting(roomA,NINE.plusMinutes(30),TEN.plusMinutes(30),"SCHEDULED");

        tx().execute(s->{directInsert(first,roomA,NINE,TEN);return null;});
        tx().execute(s->{directInsert(adjacent,roomA,TEN,ELEVEN);return null;});
        assertThatThrownBy(()->tx().execute(s->{
            directInsert(overlapping,roomA,NINE.plusMinutes(30),TEN.plusMinutes(30));
            return null;
        })).isInstanceOf(DataIntegrityViolationException.class);
        assertThat(countActive(first)).isEqualTo(1);
        assertThat(countActive(adjacent)).isEqualTo(1);
        assertThat(countActive(overlapping)).isZero();
    }

    @Test void databaseForbidsTwoActiveReservationsForOneMeetingEvenInDifferentRooms() {
        UUID meeting=meeting(roomA,NINE,TEN,"SCHEDULED");
        tx().execute(s->{directInsert(meeting,roomA,NINE,TEN);return null;});
        assertThatThrownBy(()->tx().execute(s->{
            directInsert(meeting,roomB,NINE,TEN); return null;
        })).isInstanceOf(DataIntegrityViolationException.class);
        assertThat(countActive(meeting)).isEqualTo(1);
    }

    @Test void databaseRejectsEmptyUnboundedAndInvalidReleaseState() {
        UUID first=meeting(roomA,NINE,TEN,"SCHEDULED");
        assertThatThrownBy(()->tx().execute(s->{
            directInsert(first,roomA,NINE,NINE);return null;
        })).isInstanceOf(DataIntegrityViolationException.class);

        assertThatThrownBy(()->tx().execute(s->{
            jdbc.update("""
                INSERT INTO room_reservations(id,meeting_id,room_id,reserved_period)
                VALUES (?,?,?,tstzrange(NULL,?::timestamptz,'[)'))
                """,UUID.randomUUID(),first,roomA,TEN);
            return null;
        })).isInstanceOf(DataIntegrityViolationException.class);

        assertThatThrownBy(()->tx().execute(s->{
            jdbc.update("""
                INSERT INTO room_reservations(id,meeting_id,room_id,reserved_period,status)
                VALUES (?,?,?,tstzrange(?::timestamptz,?::timestamptz,'[)'),'RELEASED')
                """,UUID.randomUUID(),first,roomA,NINE,TEN);
            return null;
        })).isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test void replacementFailureRollsBackBothOldReservationAndMeetingSchedule() {
        UUID first=meeting(roomA,NINE,TEN,"SCHEDULED");
        UUID other=meeting(roomB,NINE,TEN,"SCHEDULED");
        RoomReservation original=reserve(first);
        reserve(other);
        assertThatThrownBy(()->tx().execute(s->{
            jdbc.update("UPDATE meetings SET room_id=? WHERE id=?",roomB,first);
            service.synchronizeCommitted(first);
            return null;
        })).isInstanceOf(ResponseStatusException.class)
            .satisfies(e->assertThat(((ResponseStatusException)e).getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        assertThat(jdbc.queryForObject("SELECT room_id FROM meetings WHERE id=?",UUID.class,first))
            .isEqualTo(roomA);
        assertThat(store.history(first)).hasSize(1);
        assertThat(store.history(first).getFirst().id()).isEqualTo(original.id());
        assertThat(countActive(first)).isEqualTo(1);
    }

    @Test void replacementPreservesHistoricalRowAndOneActiveRecord() {
        UUID first=meeting(roomA,NINE,TEN,"SCHEDULED");
        RoomReservation old=reserve(first);
        tx().execute(s->{
            jdbc.update("UPDATE meetings SET room_id=?,scheduled_start_at=?,scheduled_end_at=? WHERE id=?",
                roomB,TEN,ELEVEN,first);
            service.synchronizeCommitted(first);
            return null;
        });
        List<RoomReservation> history=store.history(first);
        assertThat(history).hasSize(2);
        assertThat(history).extracting(RoomReservation::status)
            .containsExactlyInAnyOrder(RoomReservation.Status.ACTIVE,RoomReservation.Status.RELEASED);
        RoomReservation past=history.stream().filter(r->r.id().equals(old.id())).findFirst().orElseThrow();
        assertThat(past.status()).isEqualTo(RoomReservation.Status.RELEASED);
        RoomReservation now=history.stream().filter(r->r.status()==RoomReservation.Status.ACTIVE)
            .findFirst().orElseThrow();
        assertThat(now.roomId()).isEqualTo(roomB);
        assertThat(now.start().toInstant()).isEqualTo(TEN.toInstant());
        assertThat(now.end().toInstant()).isEqualTo(ELEVEN.toInstant());
    }

    @Test @Timeout(40)
    void concurrentDifferentMeetingsSameRoomOnlyOneCommitSucceeds() throws Exception {
        UUID a=meeting(roomA,NINE,TEN,"SCHEDULED");
        UUID b=meeting(roomA,NINE.plusMinutes(15),TEN.plusMinutes(15),"SCHEDULED");
        CountDownLatch ready=new CountDownLatch(2), go=new CountDownLatch(1);
        ExecutorService pool=Executors.newFixedThreadPool(2);
        try {
                // Distinct committed Meetings contend on one physical room row.
            Future<Boolean> f1=pool.submit(()->{
                ready.countDown(); if(!go.await(10,TimeUnit.SECONDS)) throw new AssertionError("gate");
                try { tx().execute(s->{service.synchronizeCommitted(a);return null;}); return true; }
                catch(ResponseStatusException ex) {
                    if(ex.getStatusCode()!=HttpStatus.CONFLICT) throw ex;
                    return false;
                }
            });
            Future<Boolean> f2=pool.submit(()->{
                ready.countDown(); if(!go.await(10,TimeUnit.SECONDS)) throw new AssertionError("gate");
                try { tx().execute(s->{service.synchronizeCommitted(b);return null;}); return true; }
                catch(ResponseStatusException ex) {
                    if(ex.getStatusCode()!=HttpStatus.CONFLICT) throw ex;
                    return false;
                }
            });
            assertThat(ready.await(10,TimeUnit.SECONDS)).isTrue();
            go.countDown();
            boolean result1=f1.get(30,TimeUnit.SECONDS), result2=f2.get(30,TimeUnit.SECONDS);
            assertThat((result1?1:0)+(result2?1:0)).isEqualTo(1);
            assertThat(countActive(a)+countActive(b)).isEqualTo(1);
        } finally {
            go.countDown(); pool.shutdownNow();
        }
    }
}
