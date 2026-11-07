package com.sme.meetingassistant.api.notification.preferences;

import com.sme.meetingassistant.api.notification.application.EmailNotificationPreferenceLookup;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalIdentityLookup;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class UserNotificationPreferencesService implements EmailNotificationPreferenceLookup {
    private final JdbcTemplate jdbc;
    private final NamedParameterJdbcTemplate namedJdbc;
    private final AuthenticatedUserId authenticatedUser;
    private final OrganizationalIdentityLookup identities;

    public UserNotificationPreferencesService(JdbcTemplate jdbc, AuthenticatedUserId authenticatedUser,
            OrganizationalIdentityLookup identities) {
        this.jdbc = jdbc;
        this.namedJdbc = new NamedParameterJdbcTemplate(jdbc);
        this.authenticatedUser = authenticatedUser;
        this.identities = identities;
    }

    // API-HTTP-001: GET must not create or touch a database row.
    @Transactional(readOnly = true)
    public UserNotificationPreferences getCurrent() {
        return find(currentActiveUser());
    }

    /**
     * Atomic, field-scoped PostgreSQL UPSERT. Competing patches to disjoint
     * fields cannot overwrite each other, including when the row is absent.
     * Identical effective updates do not change updated_at.
     */
    @Transactional
    public UserNotificationPreferences patchCurrent(PatchNotificationPreferencesRequest patch) {
        UUID userId = currentActiveUser();
        if (patch == null) throw invalid();
        var params = new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("timezonePresent", patch.timezonePresent())
                .addValue("timezone", patch.timezone())
                .addValue("localePresent", patch.localePresent())
                .addValue("locale", patch.locale())
                .addValue("meetingPresent", patch.meetingEmailPresent())
                .addValue("meetingEnabled", patch.meetingEmailPresent()
                        ? patch.meetingEmailEnabled() : true)
                .addValue("actionPresent", patch.actionItemEmailPresent())
                .addValue("actionEnabled", patch.actionItemEmailPresent()
                        ? patch.actionItemEmailEnabled() : true);

        namedJdbc.update("""
            INSERT INTO user_preferences(user_id,timezone,locale,meeting_email_enabled,
                action_item_email_enabled,created_at,updated_at)
            VALUES (:userId,:timezone,:locale,:meetingEnabled,:actionEnabled,
                clock_timestamp(),clock_timestamp())
            ON CONFLICT (user_id) DO UPDATE
               SET timezone=CASE WHEN :timezonePresent THEN EXCLUDED.timezone
                                 ELSE user_preferences.timezone END,
                   locale=CASE WHEN :localePresent THEN EXCLUDED.locale
                               ELSE user_preferences.locale END,
                   meeting_email_enabled=CASE WHEN :meetingPresent
                                              THEN EXCLUDED.meeting_email_enabled
                                              ELSE user_preferences.meeting_email_enabled END,
                   action_item_email_enabled=CASE WHEN :actionPresent
                                                  THEN EXCLUDED.action_item_email_enabled
                                                  ELSE user_preferences.action_item_email_enabled END,
                   updated_at=clock_timestamp()
             WHERE (:timezonePresent AND
                    user_preferences.timezone IS DISTINCT FROM EXCLUDED.timezone)
                OR (:localePresent AND
                    user_preferences.locale IS DISTINCT FROM EXCLUDED.locale)
                OR (:meetingPresent AND
                    user_preferences.meeting_email_enabled IS DISTINCT FROM
                        EXCLUDED.meeting_email_enabled)
                OR (:actionPresent AND
                    user_preferences.action_item_email_enabled IS DISTINCT FROM
                        EXCLUDED.action_item_email_enabled)
            """, params);
        return find(userId);
    }

    @Override
    @Transactional(readOnly = true)
    public boolean meetingEmailEnabled(UUID userId) {
        return optionalBoolean("meeting_email_enabled", userId);
    }

    @Override
    @Transactional(readOnly = true)
    public boolean actionItemEmailEnabled(UUID userId) {
        return optionalBoolean("action_item_email_enabled", userId);
    }

    private UUID currentActiveUser() {
        UUID userId = authenticatedUser.requireUserId();
        if (!identities.isActive(userId)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        }
        return userId;
    }

    private boolean optionalBoolean(String column, UUID userId) {
        if (userId == null) return false;
        // Column identifier is fixed at the two internal call sites.
        List<Boolean> rows = jdbc.query("SELECT " + column
                + " FROM user_preferences WHERE user_id=?",
                (rs, row) -> rs.getBoolean(1), userId);
        return rows.isEmpty() || rows.getFirst();
    }

    private UserNotificationPreferences find(UUID userId) {
        return jdbc.query("""
            SELECT timezone,locale,meeting_email_enabled,action_item_email_enabled
              FROM user_preferences WHERE user_id=?
            """, (rs, row) -> new UserNotificationPreferences(rs.getString("timezone"),
                rs.getString("locale"), rs.getBoolean("meeting_email_enabled"),
                rs.getBoolean("action_item_email_enabled")), userId).stream().findFirst()
            .orElseGet(() -> new UserNotificationPreferences(null, null, true, true));
    }

    private static ResponseStatusException invalid() {
        return new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                "Invalid notification preferences patch fields");
    }
}
