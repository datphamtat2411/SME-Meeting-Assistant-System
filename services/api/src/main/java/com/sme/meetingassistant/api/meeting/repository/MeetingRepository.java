package com.sme.meetingassistant.api.meeting.repository;

import com.sme.meetingassistant.api.meeting.entity.MeetingEntity;
import com.sme.meetingassistant.api.meeting.service.MeetingActionItemRightsSql;
import java.util.UUID;
import java.util.Optional;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Meeting-owned boundaries. Action Item scope is captured once at meeting
 * creation; it must never be inferred retroactively from organizer's current
 * department after reassignment or deactivation.
 */
public interface MeetingRepository extends JpaRepository<MeetingEntity, UUID>,
        JpaSpecificationExecutor<MeetingEntity> {

    /**
     * The visibility predicate intentionally mirrors MeetingCoreService.list:
     * the actor owns the meeting or has a current, non-removed participant row.
     * Grouping makes organizer IDs distinct before pagination and retains names
     * for inactive historical accounts through the users join.
     */
    @Query(value = """
        SELECT u.id AS id, u.display_name AS name
          FROM meetings m
          JOIN users u ON u.id=m.organizer_user_id
         WHERE (m.organizer_user_id=:actorId OR EXISTS (
                   SELECT 1 FROM meeting_participants mp
                    WHERE mp.meeting_id=m.id
                      AND mp.user_id=:actorId
                      AND mp.removed_at IS NULL))
           AND (:pattern IS NULL OR lower(u.display_name) LIKE :pattern ESCAPE '\\')
         GROUP BY u.id, u.display_name
         ORDER BY lower(u.display_name) ASC, u.display_name ASC, u.id ASC
        """,
        countQuery = """
        SELECT count(*) FROM (
            SELECT u.id
              FROM meetings m
              JOIN users u ON u.id=m.organizer_user_id
             WHERE (m.organizer_user_id=:actorId OR EXISTS (
                       SELECT 1 FROM meeting_participants mp
                        WHERE mp.meeting_id=m.id
                          AND mp.user_id=:actorId
                          AND mp.removed_at IS NULL))
               AND (:pattern IS NULL OR lower(u.display_name) LIKE :pattern ESCAPE '\\')
             GROUP BY u.id, u.display_name
        ) organizer_ids
        """, nativeQuery = true)
    Page<MeetingOrganizerProjection> findAccessibleOrganizers(
            @Param("actorId") UUID actorId, @Param("pattern") String pattern, Pageable pageable);

    /** The same visibility boundary is used for deep-link label restoration. */
    @Query(value = """
        SELECT u.id AS id, u.display_name AS name
          FROM users u
         WHERE u.id=:organizerId
           AND EXISTS (
               SELECT 1 FROM meetings m
                WHERE m.organizer_user_id=u.id
                  AND (m.organizer_user_id=:actorId OR EXISTS (
                      SELECT 1 FROM meeting_participants mp
                       WHERE mp.meeting_id=m.id
                         AND mp.user_id=:actorId
                         AND mp.removed_at IS NULL)))
        """, nativeQuery = true)
    Optional<MeetingOrganizerProjection> findAccessibleOrganizer(
            @Param("actorId") UUID actorId, @Param("organizerId") UUID organizerId);

    interface MeetingOrganizerProjection {
        UUID getId();
        String getName();
    }

    /**
     * SQL is intentionally conditional: meetings created by an organizer with
     * no ACTIVE primary unit remain unscoped for department managers. Nobody
     * may invent historical department ownership during a read.
     */
    @Modifying
    @Query(value = """
        INSERT INTO meeting_action_item_scopes(meeting_id,org_unit_id,recorded_by_user_id)
        SELECT :meetingId, organizer.primary_org_unit_id, :organizerId
          FROM users organizer
          JOIN organizational_units unit ON unit.id=organizer.primary_org_unit_id
         WHERE organizer.id=:organizerId
           AND organizer.account_status='ACTIVE'
           AND unit.status='ACTIVE'
        """, nativeQuery = true)
    int captureActionItemScopeAtCreation(@Param("meetingId") UUID meetingId,
            @Param("organizerId") UUID organizerId);

    /** Single-resource admission uses the same rights as set-based discovery. */
    @Query(value = """
        SELECT rights.content_visible AS "contentVisible", rights.manageable AS "manageable"
          FROM meetings meeting
          CROSS JOIN (SELECT CAST(:actorId AS uuid) AS id) actor
        """ + MeetingActionItemRightsSql.RIGHTS_JOIN + " WHERE meeting.id=:meetingId",
        nativeQuery = true)
    Optional<ActionItemRights> findActionItemRights(@Param("meetingId") UUID meetingId,
            @Param("actorId") UUID actorId);

    interface ActionItemRights {
        boolean getContentVisible();
        boolean getManageable();
    }
}
