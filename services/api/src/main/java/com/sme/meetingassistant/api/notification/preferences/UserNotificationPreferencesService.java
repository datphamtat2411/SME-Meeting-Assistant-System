package com.sme.meetingassistant.api.notification.preferences;

import com.sme.meetingassistant.api.notification.application.EmailNotificationPreferenceLookup;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.time.ZoneId;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class UserNotificationPreferencesService implements EmailNotificationPreferenceLookup {
    private static final Set<String> PATCH_FIELDS = Set.of(
        "timezone", "locale", "meetingEmailEnabled", "actionItemEmailEnabled");

    private final JdbcTemplate jdbc;
    private final AuthenticatedUserId authenticatedUser;

    public UserNotificationPreferencesService(JdbcTemplate jdbc, AuthenticatedUserId authenticatedUser) {
        this.jdbc = jdbc;
        this.authenticatedUser = authenticatedUser;
    }

    @Transactional
    public UserNotificationPreferences getCurrent() {
        UUID userId = authenticatedUser.requireUserId();
        ensureDefaults(userId);
        return find(userId);
    }

    @Transactional
    public UserNotificationPreferences patchCurrent(Map<String, Object> patch) {
        UUID userId = authenticatedUser.requireUserId();
        if (patch == null || patch.isEmpty() || !PATCH_FIELDS.containsAll(patch.keySet())) {
            throw invalid();
        }
        String timezone = patch.containsKey("timezone") ? optionalTimezone(patch.get("timezone")) : null;
        String locale = patch.containsKey("locale") ? optionalLocale(patch.get("locale")) : null;
        Boolean meetingEnabled = patch.containsKey("meetingEmailEnabled")
            ? requiredBoolean(patch.get("meetingEmailEnabled")) : null;
        Boolean actionItemEnabled = patch.containsKey("actionItemEmailEnabled")
            ? requiredBoolean(patch.get("actionItemEmailEnabled")) : null;

        ensureDefaults(userId);
        jdbc.update("""
            UPDATE user_preferences
               SET timezone=CASE WHEN ? THEN ? ELSE timezone END,
                   locale=CASE WHEN ? THEN ? ELSE locale END,
                   meeting_email_enabled=CASE WHEN ? THEN ? ELSE meeting_email_enabled END,
                   action_item_email_enabled=CASE WHEN ? THEN ? ELSE action_item_email_enabled END,
                   updated_at=clock_timestamp()
             WHERE user_id=?
            """, patch.containsKey("timezone"), timezone,
            patch.containsKey("locale"), locale,
            meetingEnabled != null, meetingEnabled,
            actionItemEnabled != null, actionItemEnabled, userId);
        return find(userId);
    }

    @Override
    public boolean meetingEmailEnabled(UUID userId) {
        return optionalBoolean("meeting_email_enabled", userId);
    }

    @Override
    public boolean actionItemEmailEnabled(UUID userId) {
        return optionalBoolean("action_item_email_enabled", userId);
    }

    private boolean optionalBoolean(String column, UUID userId) {
        if (userId == null) return false;
        // Column names are fixed internal constants at the two call sites.
        List<Boolean> values = jdbc.query("SELECT " + column + " FROM user_preferences WHERE user_id=?",
            (rs, row) -> rs.getBoolean(1), userId);
        return values.isEmpty() || values.getFirst();
    }

    private void ensureDefaults(UUID userId) {
        jdbc.update("""
            INSERT INTO user_preferences(user_id,meeting_email_enabled,action_item_email_enabled,
                created_at,updated_at)
            VALUES (?,true,true,clock_timestamp(),clock_timestamp())
            ON CONFLICT (user_id) DO NOTHING
            """, userId);
    }

    private UserNotificationPreferences find(UUID userId) {
        return jdbc.queryForObject("""
            SELECT timezone,locale,meeting_email_enabled,action_item_email_enabled
              FROM user_preferences WHERE user_id=?
            """, (rs, row) -> new UserNotificationPreferences(rs.getString("timezone"),
                rs.getString("locale"), rs.getBoolean("meeting_email_enabled"),
                rs.getBoolean("action_item_email_enabled")), userId);
    }

    private static String optionalTimezone(Object value) {
        if (value == null) return null;
        if (!(value instanceof String timezone) || timezone.isBlank()
                || timezone.length() > 64 || !ZoneId.getAvailableZoneIds().contains(timezone)) {
            throw invalid();
        }
        return timezone;
    }

    private static String optionalLocale(Object value) {
        if (value == null) return null;
        if (!(value instanceof String localeTag) || localeTag.isBlank()
                || localeTag.length() > 32 || localeTag.chars().anyMatch(Character::isWhitespace)) {
            throw invalid();
        }
        Locale locale = Locale.forLanguageTag(localeTag);
        if (locale.getLanguage().isBlank() || locale.toLanguageTag().equals("und")) throw invalid();
        return locale.toLanguageTag();
    }

    private static Boolean requiredBoolean(Object value) {
        if (value instanceof Boolean enabled) return enabled;
        throw invalid();
    }

    private static ResponseStatusException invalid() {
        return new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
    }
}
